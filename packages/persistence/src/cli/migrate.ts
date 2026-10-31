import { EnvironmentError, resolveEnvironment } from '@tef/config';
import { redactSensitiveText } from '@tef/audit';
import { createPgPool, migrate } from '../postgres/index.ts';

// Uso: npm run db:migrate (lê TEF_OWNER_DATABASE_URL do .env).
// As migrações são executadas pelo DONO do schema (tef_owner, ADR 0020), nunca pela API.
// Em dev/test, sem TEF_OWNER_DATABASE_URL, aceita DATABASE_URL (com aviso) por compatibilidade.
let env;
try {
  env = resolveEnvironment(process.env);
} catch (error) {
  console.error(error instanceof EnvironmentError ? error.message : 'perfil de ambiente inválido');
  process.exit(1);
}

let connectionString = process.env['TEF_OWNER_DATABASE_URL'];
if (!connectionString) {
  if (env.env === 'staging' || env.env === 'prod') {
    console.error(`TEF_OWNER_DATABASE_URL não definido: em ${env.env} as migrações exigem a identidade dona do schema`);
    process.exit(1);
  }
  connectionString = process.env['DATABASE_URL'];
  if (connectionString) console.error('aviso: TEF_OWNER_DATABASE_URL ausente; usando DATABASE_URL (rode npm run dev:setup)');
}
if (!connectionString) {
  console.error('TEF_OWNER_DATABASE_URL não definido');
  process.exit(1);
}

const pool = createPgPool({ connectionString, max: 1, ...(process.env['TEF_MIGRATION_ROLE'] ? { role: process.env['TEF_MIGRATION_ROLE'] } : {}) });
try {
  const result = await migrate(pool);
  console.log(JSON.stringify({ applied: result.applied, alreadyApplied: result.alreadyApplied.length }));
} catch (error) {
  const code = (error as { code?: unknown } | null)?.code;
  console.error(
    'falha na migração:',
    error instanceof Error ? redactSensitiveText(error.message) : 'erro desconhecido',
    typeof code === 'string' ? `(código ${code})` : '',
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
