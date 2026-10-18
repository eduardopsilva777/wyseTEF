import { redactSensitiveText } from '@tef/audit';
import { createPgPool, migrate } from '../postgres/index.ts';

// Uso: DATABASE_URL=... npm run db:migrate
const connectionString = process.env['DATABASE_URL'];
if (!connectionString) {
  console.error('DATABASE_URL não definido');
  process.exit(1);
}

const pool = createPgPool({ connectionString, max: 1 });
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
