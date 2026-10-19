// Testes ponta a ponta do painel (Playwright) em ambiente CONTROLADO e descartável:
// - cria um banco PostgreSQL próprio (tef_e2e_<aleatório>) no servidor de desenvolvimento,
//   aplica as migrações e o remove ao final (mesmo se os testes falharem);
// - gera token administrativo e chave de integração aleatórios só para esta execução
//   (o .env do desenvolvedor não é alterado nem usado pelos servidores de teste);
// - o Playwright sobe API (3100), worker (3101) e painel (5180), todos em 127.0.0.1.
// Pré-requisito: PostgreSQL de desenvolvimento ativo (npm run db:up) ou TEST_DATABASE_URL.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import pg from 'pg';

let adminUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl) {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const { POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB } = process.env;
  if (!POSTGRES_USER || !POSTGRES_PASSWORD || !POSTGRES_DB) {
    console.error('Defina TEST_DATABASE_URL ou crie o .env (npm run dev:setup) e rode "npm run db:up".');
    process.exit(1);
  }
  const port = process.env.POSTGRES_PORT ?? '55432';
  adminUrl = `postgres://${encodeURIComponent(POSTGRES_USER)}:${encodeURIComponent(POSTGRES_PASSWORD)}@127.0.0.1:${port}/${encodeURIComponent(POSTGRES_DB)}`;
}

const dbName = `tef_e2e_${randomBytes(5).toString('hex')}`;
const e2eUrl = (() => {
  const u = new URL(adminUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
})();

const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
await admin.query(`CREATE DATABASE ${dbName}`); // nome gerado localmente: apenas [a-z0-9_]

const sha = (v) => createHash('sha256').update(v).digest('hex');
const adminToken = randomBytes(32).toString('base64url');
const apiKey = randomBytes(32).toString('base64url');

let status = 1;
try {
  const migrate = spawnSync(process.execPath, ['packages/persistence/src/cli/migrate.ts'], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, DATABASE_URL: e2eUrl },
  });
  if (migrate.status !== 0) throw new Error('falha ao migrar o banco de teste');

  const run = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: {
      ...process.env,
      E2E_DATABASE_URL: e2eUrl,
      E2E_ADMIN_TOKEN: adminToken,
      E2E_ADMIN_TOKEN_SHA256: sha(adminToken),
      E2E_API_CREDENTIALS: JSON.stringify([{ keyId: 'e2e', keySha256: sha(apiKey), tenantId: 'e2e-sem-uso', merchantIds: ['e2e'] }]),
    },
  });
  status = run.status ?? 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : 'falha nos testes e2e');
} finally {
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
}
process.exit(status);
