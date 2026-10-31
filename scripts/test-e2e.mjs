// Testes ponta a ponta do painel (Playwright) em ambiente CONTROLADO e descartável:
// - cria um banco PostgreSQL próprio (tef_e2e_<aleatório>) no servidor de desenvolvimento
//   (ou no de TEST_DATABASE_URL, como no CI) e o remove ao final, mesmo se os testes falharem;
// - identidades reais (ADR 0020): logins temporários membros de tef_owner (migrações),
//   tef_app (API) e tef_worker (worker), com senhas aleatórias desta execução;
// - token administrativo e chave de integração aleatórios, só para esta execução
//   (o .env do desenvolvedor não é alterado e seus segredos não vão para os processos filhos);
// - o Playwright sobe API (3100), worker (3101) e painel (5180), todos em 127.0.0.1.
// Pré-requisito: PostgreSQL de desenvolvimento ativo (npm run db:up) ou TEST_DATABASE_URL.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import pg from 'pg';
import { adoptSchema, createPgPool, DB_ROLES, ensurePlatformRoles, hardenDatabase, migrate, scramSha256Verifier } from '@tef/persistence/postgres';

let adminUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl) {
  // Lido sem carregar no process.env: nada do .env chega aos processos dos testes.
  const local = existsSync('.env') ? parseEnv(readFileSync('.env', 'utf8')) : {};
  const { POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB } = local;
  if (!POSTGRES_USER || !POSTGRES_PASSWORD || !POSTGRES_DB) {
    console.error('Defina TEST_DATABASE_URL ou crie o .env (npm run dev:setup) e rode "npm run db:up".');
    process.exit(1);
  }
  const port = local.POSTGRES_PORT ?? '55432';
  adminUrl = `postgres://${encodeURIComponent(POSTGRES_USER)}:${encodeURIComponent(POSTGRES_PASSWORD)}@127.0.0.1:${port}/${encodeURIComponent(POSTGRES_DB)}`;
}

const run = randomBytes(5).toString('hex');
const dbName = `tef_e2e_${run}`; // gerado localmente: apenas [a-z0-9_]
const urlWith = (user, password, database) => {
  const u = new URL(adminUrl);
  if (user) {
    u.username = user;
    u.password = password;
  }
  if (database) u.pathname = `/${database}`;
  return u.toString();
};

const logins = { owner: `e2e_${run}_owner`, app: `e2e_${run}_app`, worker: `e2e_${run}_worker` };
const passwords = Object.fromEntries(Object.keys(logins).map((k) => [k, randomBytes(24).toString('hex')]));
const sha = (v) => createHash('sha256').update(v).digest('hex');
const adminToken = randomBytes(32).toString('base64url');
const apiKey = randomBytes(32).toString('base64url');

const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
let status = 1;
let created = false;
try {
  await admin.query(`CREATE DATABASE ${dbName}`);
  created = true;
  const dbAdmin = createPgPool({ connectionString: urlWith(null, null, dbName), max: 1 });
  try {
    await ensurePlatformRoles(dbAdmin); // não altera senhas de papéis existentes
    await adoptSchema(dbAdmin, 'public');
    await hardenDatabase(dbAdmin);
    for (const [kind, name] of Object.entries(logins)) {
      await dbAdmin.query(`CREATE ROLE ${name} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${scramSha256Verifier(passwords[kind])}'`);
      await dbAdmin.query(`GRANT ${DB_ROLES[kind]} TO ${name}`);
    }
  } finally {
    await dbAdmin.end();
  }
  const ownerPool = createPgPool({ connectionString: urlWith(logins.owner, passwords.owner, dbName), max: 1, role: DB_ROLES.owner });
  try {
    await migrate(ownerPool);
  } finally {
    await ownerPool.end();
  }

  // Ambiente dos testes: sem segredos herdados do shell (URLs, senhas, tokens).
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/DATABASE_URL|PASSWORD|TOKEN|CREDENTIALS|SHA256|SECRET|^POSTGRES_|^E2E_/i.test(k)),
  );
  const result = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: {
      ...inherited,
      E2E_APP_DATABASE_URL: urlWith(logins.app, passwords.app, dbName),
      E2E_WORKER_DATABASE_URL: urlWith(logins.worker, passwords.worker, dbName),
      E2E_ADMIN_TOKEN: adminToken,
      E2E_ADMIN_TOKEN_SHA256: sha(adminToken),
      E2E_API_CREDENTIALS: JSON.stringify([{ keyId: 'e2e', keySha256: sha(apiKey), tenantId: 'e2e-sem-uso', merchantIds: ['e2e'] }]),
    },
  });
  status = result.status ?? 1;
} catch (error) {
  console.error('falha na preparação dos testes e2e:', error instanceof Error ? error.message.replace(/postgres(ql)?:\/\/\S+/gi, '[url]') : 'erro');
} finally {
  // Limpeza sempre, inclusive após falha: banco descartável e logins temporários.
  if (created) await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
  for (const name of Object.values(logins)) await admin.query(`DROP ROLE IF EXISTS ${name}`).catch(() => undefined);
  await admin.end();
}
process.exit(status);
