// Executa os testes de integração com PostgreSQL.
// Usa TEST_DATABASE_URL, se definido; senão monta a URL a partir do .env local
// (o mesmo usado pelo docker compose em infra/dev). Nunca imprime a URL.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (!process.env.TEST_DATABASE_URL) {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const { POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB } = process.env;
  const port = process.env.POSTGRES_PORT ?? '55432';
  if (!POSTGRES_USER || !POSTGRES_PASSWORD || !POSTGRES_DB) {
    console.error('Defina TEST_DATABASE_URL ou crie o .env a partir de .env.example e rode "npm run db:up".');
    process.exit(1);
  }
  process.env.TEST_DATABASE_URL =
    `postgres://${encodeURIComponent(POSTGRES_USER)}:${encodeURIComponent(POSTGRES_PASSWORD)}@127.0.0.1:${port}/${encodeURIComponent(POSTGRES_DB)}`;
}

const result = spawnSync('npx', ['vitest', 'run', 'tests/integration'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, TEST_DATABASE_REQUIRED: '1' },
});
process.exit(result.status ?? 1);
