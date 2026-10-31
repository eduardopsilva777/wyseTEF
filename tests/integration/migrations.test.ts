import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adoptSchema, migrate } from '@tef/persistence/postgres';
import { createTestSchema, TEST_DATABASE_URL, type TestSchema } from '../support/pg.ts';

/**
 * Atualização de um banco que estava na 0001 (como o de desenvolvimento da F1), com
 * objetos criados pelo SUPERUSUÁRIO e pagamentos sem cadastro: o bootstrap (`adoptSchema`)
 * transfere a propriedade para tef_owner e as migrações 0002–0005 aplicam, COMO tef_owner,
 * sem perder dados; a integridade referencial vale apenas para linhas novas (ADR 0020).
 */
let db: TestSchema;
let pool: pg.Pool;

describe.skipIf(!TEST_DATABASE_URL)('migrações: atualização de banco existente', () => {
  beforeAll(async () => {
    db = await createTestSchema({ migrate: false });
    pool = db.pool; // superusuário: monta o estado legado como era na F1
    await pool.query(`ALTER SCHEMA ${db.schema} OWNER TO CURRENT_USER`);
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
    await db?.cleanup();
  });

  it('sem o bootstrap, tef_owner não consegue migrar o schema do superusuário', async () => {
    // Sem USAGE/CREATE no schema, o PostgreSQL nem o seleciona para criar objetos (3F000).
    await expect(migrate(db.ownerPool)).rejects.toMatchObject({ code: '3F000' });
    await db.pool.query(`GRANT USAGE ON SCHEMA ${db.schema} TO tef_owner`);
    try {
      // Com USAGE mas sem CREATE nem propriedade: privilégio insuficiente (42501).
      await expect(migrate(db.ownerPool)).rejects.toMatchObject({ code: '42501' });
    } finally {
      await db.pool.query(`REVOKE USAGE ON SCHEMA ${db.schema} FROM tef_owner`);
    }
  });

  it('bootstrap transfere a propriedade e 0002–0005 aplicam como tef_owner, preservando o pagamento legado', async () => {
    const before = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM payments`);
    const { transferred } = await adoptSchema(pool, db.schema);
    expect(transferred).toBeGreaterThan(0);
    const result = await migrate(db.ownerPool);
    expect(result.alreadyApplied).toEqual(['0001_initial_schema.sql']);
    expect(result.applied).toEqual([
      '0002_catalog_jobs_outbox.sql',
      '0003_simulator_ledger.sql',
      '0004_simulator_ledger_scope.sql',
      '0005_runtime_role_privileges.sql',
    ]);
    expect((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM payments`)).rows[0]!.n).toBe(before.rows[0]!.n);
    // Tudo no schema pertence a tef_owner, inclusive o que existia antes do bootstrap.
    const owners = await pool.query<{ owner: string }>(
      `SELECT DISTINCT pg_get_userbyid(c.relowner) AS owner FROM pg_class c WHERE c.relnamespace = to_regnamespace(current_schema()) AND c.relkind IN ('r', 'S')`,
    );
    expect(owners.rows).toEqual([{ owner: 'tef_owner' }]);
    // O checksum da 0001 aplicada continua o do arquivo versionado (migrações imutáveis).
    const sql0001 = await readFile(new URL('../../packages/persistence/migrations/0001_initial_schema.sql', import.meta.url), 'utf8');
    const stored = await pool.query<{ checksum: string }>(`SELECT checksum FROM schema_migrations WHERE version = '0001_initial_schema.sql'`);
    expect(stored.rows[0]!.checksum).toBe(createHash('sha256').update(sql0001).digest('hex'));
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
    expect((await migrate(db.ownerPool)).applied).toEqual([]);
    await pool.query(`UPDATE schema_migrations SET checksum = $1 WHERE version = '0002_catalog_jobs_outbox.sql'`, ['0'.repeat(64)]);
    await expect(migrate(db.ownerPool)).rejects.toThrow(/foi alterada/);
  });
});
