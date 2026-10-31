import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { createPgPool, DB_ROLES, ensurePlatformRoles, migrate, PgUnitOfWork, scramSha256Verifier } from '@tef/persistence/postgres';
import { seedCatalog } from './catalog.ts';

export const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
if (process.env['TEST_DATABASE_REQUIRED'] === '1' && !TEST_DATABASE_URL) {
  throw new Error('TEST_DATABASE_REQUIRED=1, mas TEST_DATABASE_URL não está definido');
}

type LoginKind = 'owner' | 'app' | 'worker' | 'service' | 'nobody';

export interface TestSchema {
  /**
   * FERRAMENTA DE TESTE (superusuário de TEST_DATABASE_URL com search_path no schema): só
   * para preparar cenários e inspecionar resultados. Nunca executa código do produto.
   */
  readonly pool: pg.Pool;
  /** Login membro de tef_owner com SET ROLE tef_owner: executou as migrações. */
  readonly ownerPool: pg.Pool;
  /** API: login membro SOMENTE de tef_app. */
  readonly appPool: pg.Pool;
  readonly uow: PgUnitOfWork;
  /** Worker: login membro SOMENTE de tef_worker. */
  readonly workerPool: pg.Pool;
  readonly workerUow: PgUnitOfWork;
  /**
   * Suítes compartilhadas que usam o MESMO PaymentService para o lado da API e o do worker:
   * login membro de tef_app e tef_worker — nunca dono nem superusuário.
   */
  readonly servicePool: pg.Pool;
  readonly serviceUow: PgUnitOfWork;
  readonly schema: string;
  /** Nome dos logins temporários (removidos no cleanup). */
  readonly logins: Readonly<Record<LoginKind, string>>;
  /** Abre um pool extra com um dos logins temporários. */
  connectAs(kind: LoginKind, options?: { max?: number; role?: string }): pg.Pool;
  cleanup(): Promise<void>;
}

const MEMBERSHIP: Readonly<Record<LoginKind, readonly string[]>> = {
  owner: [DB_ROLES.owner],
  app: [DB_ROLES.app],
  worker: [DB_ROLES.worker],
  service: [DB_ROLES.app, DB_ROLES.worker],
  nobody: [],
};

/**
 * Cria um schema isolado cujo dono é tef_owner, logins temporários membros dos papéis da
 * plataforma (ADR 0020) e aplica as migrações COMO tef_owner. Os papéis tef_* são criados
 * se faltarem (NOLOGIN; senhas locais existentes não são tocadas). Exige superusuário.
 */
export async function createTestSchema(options: { migrate?: boolean; seed?: boolean } = {}): Promise<TestSchema> {
  const baseUrl = TEST_DATABASE_URL;
  if (!baseUrl) throw new Error('TEST_DATABASE_URL ausente');
  const schema = `it_${randomBytes(6).toString('hex')}`;
  const admin = createPgPool({ connectionString: baseUrl, max: 1 });
  await ensurePlatformRoles(admin);

  const passwords = new Map<LoginKind, string>();
  const logins = {} as Record<LoginKind, string>;
  for (const kind of Object.keys(MEMBERSHIP) as LoginKind[]) {
    const name = `${schema}_${kind}`; // gerado localmente: [a-z0-9_]
    const password = randomBytes(24).toString('hex');
    passwords.set(kind, password);
    logins[kind] = name;
    await admin.query(`CREATE ROLE ${name} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${scramSha256Verifier(password)}'`);
    for (const role of MEMBERSHIP[kind]) await admin.query(`GRANT ${role} TO ${name}`);
  }
  await admin.query(`CREATE SCHEMA ${schema} AUTHORIZATION ${DB_ROLES.owner}`);

  const urlFor = (kind: LoginKind): string => {
    const u = new URL(baseUrl);
    u.username = logins[kind];
    u.password = passwords.get(kind) ?? '';
    return u.toString();
  };
  const pools: pg.Pool[] = [];
  const connectAs = (kind: LoginKind, opts: { max?: number; role?: string } = {}): pg.Pool => {
    const p = createPgPool({ connectionString: urlFor(kind), searchPath: schema, max: opts.max ?? 10, ...(opts.role ? { role: opts.role } : {}) });
    pools.push(p);
    return p;
  };

  const pool = createPgPool({ connectionString: baseUrl, searchPath: schema, max: 10 });
  const ownerPool = connectAs('owner', { max: 2, role: DB_ROLES.owner });
  const appPool = connectAs('app', { max: 20 });
  const workerPool = connectAs('worker', { max: 20 });
  const servicePool = connectAs('service', { max: 20 });
  const uow = new PgUnitOfWork(appPool);
  if (options.migrate ?? true) {
    await migrate(ownerPool);
    if (options.seed ?? true) await seedCatalog(uow);
  }
  return {
    pool,
    ownerPool,
    appPool,
    uow,
    workerPool,
    workerUow: new PgUnitOfWork(workerPool),
    servicePool,
    serviceUow: new PgUnitOfWork(servicePool),
    schema,
    logins,
    connectAs,
    async cleanup() {
      await Promise.all([...pools, pool].map((p) => p.end()));
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      for (const name of Object.values(logins)) {
        await admin.query(`DROP OWNED BY ${name}`);
        await admin.query(`DROP ROLE IF EXISTS ${name}`);
      }
      await admin.end();
    },
  };
}

/**
 * Isola a fila entre testes que compartilham o schema: tarefas ainda ativas de testes
 * anteriores são encerradas (DONE), para que o worker de um teste não as reivindique.
 * Necessário porque o relógio da fila é o do banco (ADR 0019): tarefas agendadas por um
 * teste vencem, em tempo real, durante os seguintes. Não apaga histórico.
 */
export async function quiesceQueue(pool: pg.Pool): Promise<void> {
  await pool.query(
    `UPDATE jobs SET status = 'DONE', lease_owner = NULL, lease_expires_at = NULL,
            completed_at = clock_timestamp(), updated_at = clock_timestamp(), last_error_code = 'TEST_QUIESCED'
      WHERE status IN ('PENDING', 'RUNNING')`,
  );
}

/** Executa `fn` e devolve o SQLSTATE da falha (ou `null` se o PostgreSQL permitiu). */
export async function sqlState(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? code : 'ERRO_SEM_SQLSTATE';
  }
}
