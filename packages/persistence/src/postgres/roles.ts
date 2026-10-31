import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import type pg from 'pg';

/**
 * Identidades do PostgreSQL (ADR 0020). Papéis são objetos do CLUSTER: são criados pelo
 * bootstrap (nunca por migração); a migração 0005 só concede os privilégios.
 *
 * - tef_owner : dono do schema; executa as migrações. Sem SUPERUSER/CREATEROLE/CREATEDB.
 * - tef_app   : identidade da API. Só DML específico; sem DDL, sem dono, sem GRANT.
 * - tef_worker: identidade do worker. Só o que fila, outbox, reconciliação e livro do
 *               simulador exigem.
 */
export const DB_ROLES = { owner: 'tef_owner', app: 'tef_app', worker: 'tef_worker' } as const;
export type DbRoleKey = keyof typeof DB_ROLES;
export type RuntimeRole = (typeof DB_ROLES)['app' | 'worker'];

type Queryable = Pick<pg.PoolClient, 'query'>;

/** Atributos impostos a todo papel da plataforma, novo ou existente. */
const SAFE_ATTRIBUTES = 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';
/** Chave do advisory lock que serializa a criação dos papéis (bootstrap e testes em paralelo). */
const ROLES_LOCK_KEY = 727_002;

/**
 * Verificador SCRAM-SHA-256 (RFC 5802/7677) no formato aceito pelo PostgreSQL. A senha em
 * texto puro nunca é enviada ao servidor nem aparece em logs de comandos: só o verificador.
 */
export function scramSha256Verifier(password: string, iterations = 4096, salt: Buffer = randomBytes(16)): string {
  const salted = pbkdf2Sync(password.normalize('NFKC'), salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

const VERIFIER = /^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/;
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

const ident = (name: string): string => {
  if (!IDENTIFIER.test(name)) throw new Error('identificador de papel inválido');
  return name;
};

/** Cria um papel se não existir (tolerante a corrida) e impõe os atributos seguros. */
async function ensureRole(db: Queryable, name: string): Promise<void> {
  const role = ident(name);
  await db.query(
    `DO $$ BEGIN
       IF to_regrole('${role}') IS NULL THEN
         CREATE ROLE ${role} NOLOGIN ${SAFE_ATTRIBUTES};
       END IF;
     EXCEPTION WHEN duplicate_object THEN NULL;
     END $$`,
  );
  await db.query(`ALTER ROLE ${role} ${SAFE_ATTRIBUTES}`);
}

export interface EnsureRolesOptions {
  /**
   * Senhas de login por papel. Papel com senha recebe LOGIN e o verificador SCRAM; sem
   * senha, o papel existente fica como está (os testes não alteram credenciais locais).
   */
  readonly passwords?: Partial<Record<DbRoleKey, string>>;
}

/**
 * Garante os três papéis da plataforma. Exige CREATEROLE (superusuário do ambiente local
 * ou de testes). Nunca concede privilégios de dados: isso é papel da migração 0005.
 */
export async function ensurePlatformRoles(db: Queryable, options: EnsureRolesOptions = {}): Promise<void> {
  await db.query('SELECT pg_advisory_lock($1)', [ROLES_LOCK_KEY]);
  try {
    for (const key of Object.keys(DB_ROLES) as DbRoleKey[]) {
      await ensureRole(db, DB_ROLES[key]);
      const password = options.passwords?.[key];
      if (password !== undefined) {
        if (password.length < 16) throw new Error(`senha do papel ${DB_ROLES[key]} curta demais (mínimo 16)`);
        const verifier = scramSha256Verifier(password);
        if (!VERIFIER.test(verifier)) throw new Error('verificador SCRAM inesperado');
        await db.query(`ALTER ROLE ${ident(DB_ROLES[key])} LOGIN PASSWORD '${verifier}'`);
      }
    }
  } finally {
    await db.query('SELECT pg_advisory_unlock($1)', [ROLES_LOCK_KEY]);
  }
}

/**
 * Prepara um schema JÁ EXISTENTE (ex.: `public` do banco de desenvolvimento, criado antes
 * da F2B) para ser administrado por tef_owner: transfere a propriedade das tabelas,
 * sequências e funções, concede USAGE/CREATE ao dono e USAGE às identidades de execução,
 * e retira CREATE de PUBLIC. Não altera dados. Exige superusuário.
 */
export async function adoptSchema(db: Queryable, schema: string): Promise<{ transferred: number }> {
  const s = ident(schema);
  const { owner, app, worker } = DB_ROLES;
  await db.query(`GRANT USAGE, CREATE ON SCHEMA ${s} TO ${owner}`);
  await db.query(`GRANT USAGE ON SCHEMA ${s} TO ${app}, ${worker}`);
  await db.query(`REVOKE CREATE ON SCHEMA ${s} FROM PUBLIC`);
  // Sequências ligadas a colunas (identity/serial) acompanham a tabela.
  const objects = await db.query<{ kind: string; name: string }>(
    `SELECT CASE c.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END AS kind,
            format('%I.%I', n.nspname, c.relname) AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
        AND pg_get_userbyid(c.relowner) <> $2
        AND NOT (c.relkind = 'S' AND EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('a', 'i')))
      ORDER BY c.relkind DESC, c.relname`,
    [s, owner],
  );
  const functions = await db.query<{ name: string }>(
    `SELECT p.oid::regprocedure::text AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1 AND pg_get_userbyid(p.proowner) <> $2`,
    [s, owner],
  );
  for (const o of objects.rows) await db.query(`ALTER ${o.kind} ${o.name} OWNER TO ${owner}`);
  for (const f of functions.rows) await db.query(`ALTER FUNCTION ${f.name} OWNER TO ${owner}`);
  return { transferred: objects.rows.length + functions.rows.length };
}

/**
 * Endurecimento do banco local: só os papéis da plataforma criam objetos temporários ou
 * schemas. PUBLIC mantém apenas CONNECT. Exige superusuário.
 */
export async function hardenDatabase(db: Queryable): Promise<void> {
  const name = (await db.query<{ db: string }>('SELECT current_database() AS db')).rows[0]!.db;
  const quoted = `"${name.replace(/"/g, '""')}"`;
  await db.query(`REVOKE CREATE, TEMPORARY ON DATABASE ${quoted} FROM PUBLIC`);
  await db.query(`GRANT CONNECT ON DATABASE ${quoted} TO ${DB_ROLES.owner}, ${DB_ROLES.app}, ${DB_ROLES.worker}`);
}

export interface IdentityReport {
  readonly user: string;
  readonly violations: readonly string[];
}

/**
 * Verificação, na inicialização, de que o processo usa a identidade restrita esperada:
 * não é superusuário, não tem atributos administrativos, não é membro de tef_owner, não é
 * dono de objetos do schema, não pode criar objetos nele e pertence ao papel esperado.
 */
export async function inspectRuntimeIdentity(db: Queryable, expected: RuntimeRole): Promise<IdentityReport> {
  const res = await db.query<{
    user: string;
    rolsuper: boolean;
    admin_attrs: boolean;
    expected_exists: boolean;
    member_expected: boolean;
    member_owner: boolean;
    can_create: boolean;
    owns: number;
  }>(
    `SELECT current_user AS user, r.rolsuper,
            (r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls) AS admin_attrs,
            to_regrole($1) IS NOT NULL AS expected_exists,
            to_regrole($1) IS NOT NULL AND pg_has_role(current_user, $1, 'USAGE') AS member_expected,
            to_regrole($2) IS NOT NULL AND pg_has_role(current_user, $2, 'MEMBER') AS member_owner,
            has_schema_privilege(current_schema(), 'CREATE') AS can_create,
            (SELECT count(*)::int FROM pg_class c
              WHERE c.relnamespace = to_regnamespace(current_schema()) AND pg_has_role(current_user, c.relowner, 'MEMBER')) AS owns
       FROM pg_roles r WHERE r.rolname = current_user`,
    [expected, DB_ROLES.owner],
  );
  const row = res.rows[0];
  if (!row) return { user: 'desconhecido', violations: ['identidade de banco não encontrada'] };
  const violations: string[] = [];
  if (row.rolsuper) violations.push('a conexão usa um SUPERUSUÁRIO');
  if (row.admin_attrs) violations.push('a identidade tem atributos administrativos (CREATEROLE/CREATEDB/REPLICATION/BYPASSRLS)');
  if (row.member_owner) violations.push(`a identidade é membro de ${DB_ROLES.owner} (dono do schema)`);
  if (row.owns > 0) violations.push('a identidade é dona de objetos do schema');
  if (row.can_create) violations.push('a identidade pode criar objetos no schema (DDL)');
  if (!row.expected_exists) violations.push(`o papel ${expected} não existe (rode o bootstrap de papéis)`);
  else if (!row.member_expected) violations.push(`a identidade não pertence ao papel ${expected}`);
  return { user: row.user, violations };
}
