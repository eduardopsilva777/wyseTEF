import { databaseUser, EnvironmentError, resolveEnvironment } from '@tef/config';
import { redactSensitiveText } from '@tef/audit';
import { adoptSchema, createPgPool, DB_ROLES, ensurePlatformRoles, hardenDatabase, type DbRoleKey } from '../postgres/index.ts';

/**
 * Bootstrap LOCAL dos papéis do PostgreSQL (ADR 0020) — somente TEF_ENV=dev ou test.
 * Em staging/prod, os papéis e senhas são provisionados pela infraestrutura (DBA/IaC);
 * este comando recusa executar.
 *
 * Uso: npm run db:bootstrap   (lê o .env; idempotente; não apaga dados)
 * - Conecta como o superusuário do contêiner local (POSTGRES_USER/POSTGRES_PASSWORD) ou
 *   por TEF_DB_ADMIN_URL.
 * - Senhas: extraídas das URLs TEF_OWNER_DATABASE_URL, DATABASE_URL (API) e
 *   TEF_WORKER_DATABASE_URL; enviadas ao servidor apenas como verificador SCRAM.
 * - Nada sensível é impresso: só o resumo.
 */
const fail = (message: string): never => {
  console.error(`bootstrap: ${message}`);
  process.exit(1);
};

const tefEnv = (() => {
  try {
    return resolveEnvironment(process.env).env;
  } catch (error) {
    return fail(error instanceof EnvironmentError ? error.message : 'perfil de ambiente inválido');
  }
})();
if (tefEnv !== 'dev' && tefEnv !== 'test') {
  fail(`recusado em ${tefEnv}: provisione os papéis pela infraestrutura (ver docs/OPERATIONS.md)`);
}

const adminUrl = (() => {
  if (process.env['TEF_DB_ADMIN_URL']) return process.env['TEF_DB_ADMIN_URL'];
  const { POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB } = process.env;
  if (!POSTGRES_USER || !POSTGRES_PASSWORD || !POSTGRES_DB) return fail('defina POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB (npm run dev:setup) ou TEF_DB_ADMIN_URL');
  const port = process.env['POSTGRES_PORT'] ?? '55432';
  return `postgres://${encodeURIComponent(POSTGRES_USER)}:${encodeURIComponent(POSTGRES_PASSWORD)}@127.0.0.1:${port}/${encodeURIComponent(POSTGRES_DB)}`;
})();

const SOURCES: Record<DbRoleKey, string> = { owner: 'TEF_OWNER_DATABASE_URL', app: 'DATABASE_URL', worker: 'TEF_WORKER_DATABASE_URL' };
const passwords: Partial<Record<DbRoleKey, string>> = {};
for (const key of Object.keys(SOURCES) as DbRoleKey[]) {
  const name = SOURCES[key];
  const url = process.env[name] ?? fail(`${name} ausente (rode npm run dev:setup)`);
  if (databaseUser(url) !== DB_ROLES[key]) fail(`${name} precisa usar o usuário ${DB_ROLES[key]} (rode npm run dev:setup para atualizar o .env)`);
  const password = decodeURIComponent(new URL(url).password);
  if (password.length < 16) fail(`${name}: senha ausente ou curta (rode npm run dev:setup)`);
  passwords[key] = password;
}

const pool = createPgPool({ connectionString: adminUrl, max: 1 });
try {
  const who = await pool.query<{ rolsuper: boolean }>('SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
  if (!who.rows[0]?.rolsuper) fail('a conexão administrativa precisa ser de superusuário (somente no ambiente local)');
  await ensurePlatformRoles(pool, { passwords });
  const { transferred } = await adoptSchema(pool, 'public');
  await hardenDatabase(pool);
  console.log(JSON.stringify({ roles: Object.values(DB_ROLES), schema: 'public', ownershipTransferred: transferred }));
} catch (error) {
  const code = (error as { code?: unknown } | null)?.code;
  console.error('bootstrap: falha', error instanceof Error ? redactSensitiveText(error.message) : 'erro desconhecido', typeof code === 'string' ? `(código ${code})` : '');
  process.exitCode = 1;
} finally {
  await pool.end();
}
