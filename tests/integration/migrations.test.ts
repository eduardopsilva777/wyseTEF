import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgPool, migrate } from '@tef/persistence/postgres';
import { TEST_DATABASE_URL } from '../support/pg.ts';

/**
 * Atualização de um banco que estava na 0001 (como o de desenvolvimento da F1)
 * e já tinha pagamentos sem cadastro: 0002–0004 aplicam sem perder dados e passam
 * a exigir integridade referencial apenas para linhas novas.
 */
const schema = `mig_${randomBytes(6).toString('hex')}`;
let admin: pg.Pool;
let pool: pg.Pool;

describe.skipIf(!TEST_DATABASE_URL)('migrações: atualização de banco existente', () => {
  beforeAll(async () => {
    admin = createPgPool({ connectionString: TEST_DATABASE_URL!, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = createPgPool({ connectionString: TEST_DATABASE_URL!, searchPath: schema, max: 2 });
    // Estado "F1": só a 0001 aplicada, registrada com o checksum do arquivo versionado.
    const sql0001 = await readFile(new URL('../../packages/persistence/migrations/0001_initial_schema.sql', import.meta.url), 'utf8');
    await pool.query(
      `CREATE TABLE schema_migrations (version text PRIMARY KEY, checksum char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    await pool.query(sql0001);
    await pool.query(`INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)`, [
      '0001_initial_schema.sql',
      createHash('sha256').update(sql0001).digest('hex'),
    ]);
    // Pagamento legado, sem cliente/estabelecimento/terminal cadastrados.
    await pool.query(
      `INSERT INTO payments (id, tenant_id, merchant_id, terminal_id, external_reference, provider_id, currency, amount_cents, state, state_reason, version, created_at, updated_at)
       VALUES ('pay_0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', 'tenant-legado', 'merchant-legado', 't-legado', 'legado-1', 'SIMULATOR', 'BRL', 1058, 'UNKNOWN', 'AUTHORIZATION_RESULT_UNKNOWN', 3, now(), now())`,
    );
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it('aplica 0002–0004 preservando o pagamento legado', async () => {
    const result = await migrate(pool);
    expect(result.alreadyApplied).toEqual(['0001_initial_schema.sql']);
    expect(result.applied).toEqual(['0002_catalog_jobs_outbox.sql', '0003_simulator_ledger.sql', '0004_simulator_ledger_scope.sql']);
    const legacy = await pool.query<{ state: string }>(`SELECT state FROM payments WHERE external_reference = 'legado-1'`);
    expect(legacy.rows).toEqual([{ state: 'UNKNOWN' }]);
  });

  it('novas linhas passam a exigir terminal cadastrado (FK NOT VALID)', async () => {
    await expect(
      pool.query(
        `INSERT INTO payments (id, tenant_id, merchant_id, terminal_id, external_reference, provider_id, currency, amount_cents, state, version, created_at, updated_at)
         VALUES ('pay_0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a6c', 'tenant-legado', 'merchant-legado', 't-legado', 'novo-1', 'SIMULATOR', 'BRL', 100, 'CREATED', 1, now(), now())`,
      ),
    ).rejects.toMatchObject({ code: '23503' });
    const fk = await pool.query<{ convalidated: boolean }>(`SELECT c.convalidated FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE c.conname = 'payments_terminal_fk' AND n.nspname = current_schema()`);
    expect(fk.rows).toEqual([{ convalidated: false }]);
  });

  it('o livro do simulador começa quando a 0003 foi aplicada (escopo de autoridade)', async () => {
    const res = await pool.query<{ ok: boolean }>(
      `SELECT m.started_at = s.applied_at AS ok FROM simulator_ledger_meta m, schema_migrations s WHERE s.version = '0003_simulator_ledger.sql'`,
    );
    expect(res.rows).toEqual([{ ok: true }]);
  });

  it('é idempotente e detecta migração alterada', async () => {
    expect((await migrate(pool)).applied).toEqual([]);
    await pool.query(`UPDATE schema_migrations SET checksum = $1 WHERE version = '0002_catalog_jobs_outbox.sql'`, ['0'.repeat(64)]);
    await expect(migrate(pool)).rejects.toThrow(/foi alterada/);
  });
});
