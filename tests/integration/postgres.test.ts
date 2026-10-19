import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyAuditChain } from '@tef/audit';
import { createPgPool, createPgRepositories, loadAuditChain, migrate, PgUnitOfWork } from '@tef/persistence/postgres';
import { createCommand, createHarness, ctxA, newKey, TENANT_A, TENANT_B } from '../support/harness.ts';
import { seedCatalog } from '../support/catalog.ts';
import { describePaymentServiceSuite } from '../support/service-suite.ts';

/**
 * Testes de integração com PostgreSQL REAL. Sem TEST_DATABASE_URL, são pulados
 * (e o resumo do Vitest mostra "skipped"); `npm run test:db` os torna obrigatórios.
 * Cada execução usa um schema próprio, removido ao final.
 */
const url = process.env['TEST_DATABASE_URL'];
const required = process.env['TEST_DATABASE_REQUIRED'] === '1';

if (required && !url) throw new Error('TEST_DATABASE_REQUIRED=1, mas TEST_DATABASE_URL não está definido');

const schema = `it_${randomBytes(6).toString('hex')}`;
let admin: pg.Pool;
let pool: pg.Pool;
let uow: PgUnitOfWork;

describe.skipIf(!url)('PostgreSQL', () => {
  beforeAll(async () => {
    admin = createPgPool({ connectionString: url!, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`); // nome gerado localmente e validado pelo padrão do createPgPool
    pool = createPgPool({ connectionString: url!, searchPath: schema, max: 10 });
    uow = new PgUnitOfWork(pool);
    const result = await migrate(pool);
    expect(result.applied).toEqual(['0001_initial_schema.sql', '0002_catalog_jobs_outbox.sql', '0003_simulator_ledger.sql', '0004_simulator_ledger_scope.sql']);
    await seedCatalog(uow);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  describe('migrações', () => {
    it('são idempotentes', async () => {
      const again = await migrate(pool);
      expect(again.applied).toEqual([]);
      expect(again.alreadyApplied).toEqual(['0001_initial_schema.sql', '0002_catalog_jobs_outbox.sql', '0003_simulator_ledger.sql', '0004_simulator_ledger_scope.sql']);
    });

    it('detectam migração alterada depois de aplicada', async () => {
      const original = await pool.query<{ checksum: string }>(`SELECT checksum FROM schema_migrations WHERE version = $1`, ['0001_initial_schema.sql']);
      await pool.query(`UPDATE schema_migrations SET checksum = $1 WHERE version = $2`, ['f'.repeat(64), '0001_initial_schema.sql']);
      await expect(migrate(pool)).rejects.toThrow(/foi alterada/);
      await pool.query(`UPDATE schema_migrations SET checksum = $1 WHERE version = $2`, [original.rows[0]!.checksum, '0001_initial_schema.sql']);
    });
  });

  describePaymentServiceSuite({
    name: 'postgres',
    uow: () => uow,
    auditFor: (tenantId) => loadAuditChain(pool, tenantId),
    outboxEventTypes: async (paymentId) =>
      (await pool.query<{ event_type: string }>(`SELECT event_type FROM outbox_events WHERE aggregate_id = $1 ORDER BY id`, [paymentId]))
        .rows.map((r) => r.event_type),
  });

  describe('garantias do esquema', () => {
    async function approvedPayment() {
      const h = createHarness({ uow });
      const { payment } = await h.service.createPayment(ctxA, createCommand(), newKey());
      const result = await h.service.authorize(ctxA, payment.id, newKey());
      return result;
    }

    it('auditoria rejeita UPDATE, DELETE e TRUNCATE', async () => {
      await approvedPayment();
      await expect(pool.query(`UPDATE audit_events SET action = 'x' WHERE tenant_id = $1`, [TENANT_A])).rejects.toThrow(/somente inserção/);
      await expect(pool.query(`DELETE FROM audit_events WHERE tenant_id = $1`, [TENANT_A])).rejects.toThrow(/somente inserção/);
      await expect(pool.query(`TRUNCATE audit_events`)).rejects.toThrow(/somente inserção/);
    });

    it('cadeia de auditoria persistida é verificável', async () => {
      await approvedPayment();
      expect(verifyAuditChain(await loadAuditChain(pool, TENANT_A)).valid).toBe(true);
    });

    it('banco impede duas operações abertas no mesmo pagamento, mesmo sem passar pelo domínio', async () => {
      const { payment, operation } = await approvedPayment();
      const insert = (id: string) =>
        pool.query(
          `INSERT INTO payment_operations (id, payment_id, tenant_id, kind, status, amount_cents, currency, version, created_at, updated_at)
           VALUES ($1, $2, $3, 'REFUND', 'IN_FLIGHT', 100, 'BRL', 1, now(), now())`,
          [id, payment.id, payment.tenantId],
        );
      const id1 = operation.id.replace(/^op_.{8}/, 'op_aaaaaaaa');
      const id2 = operation.id.replace(/^op_.{8}/, 'op_bbbbbbbb');
      await insert(id1);
      await expect(insert(id2)).rejects.toMatchObject({ code: '23505', constraint: 'payment_operations_one_open_uq' });
    });

    it('banco exige evidência para resultado definitivo', async () => {
      const { operation } = await approvedPayment();
      await expect(pool.query(`UPDATE payment_operations SET evidence = NULL WHERE id = $1`, [operation.id]))
        .rejects.toMatchObject({ code: '23514' });
    });

    it('banco impede REVERSED com saldo inconsistente e estorno acima do valor', async () => {
      const { payment } = await approvedPayment();
      await expect(pool.query(`UPDATE payments SET state = 'REVERSED' WHERE id = $1`, [payment.id])).rejects.toMatchObject({ code: '23514' });
      await expect(pool.query(`UPDATE payments SET reversed_cents = amount_cents + 1 WHERE id = $1`, [payment.id]))
        .rejects.toMatchObject({ code: '23514' });
    });

    it('consultas parametrizadas: entrada maliciosa não altera a consulta', async () => {
      const { payment } = await approvedPayment();
      const repos = createPgRepositories(pool);
      expect(await repos.payments.findById(TENANT_A, `${payment.id}' OR '1'='1` as never)).toBeNull();
      expect(await repos.payments.findById(`${TENANT_A}' OR '1'='1` as never, payment.id)).toBeNull();
    });

    it('isolamento por tenant na camada SQL', async () => {
      const { payment } = await approvedPayment();
      const repos = createPgRepositories(pool);
      expect(await repos.payments.findById(TENANT_B, payment.id)).toBeNull();
      expect(await repos.operations.listByPayment(TENANT_B, payment.id)).toEqual([]);
    });

    it('UNKNOWN persiste e é lido por outro pool (outra "instância")', async () => {
      const h = createHarness({ uow, providerTimeoutMs: 20 });
      h.scenario = { type: 'TIMEOUT_AFTER_SEND', hiddenOutcome: 'SUCCEEDED' };
      const { payment } = await h.service.createPayment(ctxA, createCommand(), newKey());
      await h.service.authorize(ctxA, payment.id, newKey());
      const otherPool = createPgPool({ connectionString: url!, searchPath: schema, max: 1 });
      try {
        const repos = createPgRepositories(otherPool);
        expect((await repos.payments.findById(TENANT_A, payment.id))?.state).toBe('UNKNOWN');
        const [op] = await repos.operations.listByPayment(TENANT_A, payment.id);
        expect(op?.status).toBe('UNKNOWN');
      } finally {
        await otherPool.end();
      }
    });

    it('concorrência alta: 30 criações com a mesma chave e 30 autorizações geram um pagamento e um envio', async () => {
      const h = createHarness({ uow });
      const key = newKey();
      const command = createCommand();
      const created = await Promise.all(Array.from({ length: 30 }, () => h.service.createPayment(ctxA, command, key)));
      expect(new Set(created.map((r) => r.payment.id)).size).toBe(1);
      const paymentId = created[0]!.payment.id;
      const results = await Promise.allSettled(Array.from({ length: 30 }, () => h.service.authorize(ctxA, paymentId, newKey())));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(h.simulator.receivedCount()).toBe(1);
      const ops = await pool.query(`SELECT count(*)::int AS n FROM payment_operations WHERE payment_id = $1`, [paymentId]);
      expect(ops.rows[0]).toEqual({ n: 1 });

      // Auditoria e outbox continuam consistentes sob concorrência real.
      expect(verifyAuditChain(await loadAuditChain(pool, TENANT_A)).valid).toBe(true);
      const created1 = await pool.query(
        `SELECT count(*)::int AS n FROM audit_events WHERE resource_id = $1 AND action = 'payment.created'`,
        [paymentId],
      );
      expect(created1.rows[0]).toEqual({ n: 1 });
      const outbox = await pool.query<{ event_type: string }>(
        `SELECT event_type FROM outbox_events WHERE aggregate_id = $1 ORDER BY id`,
        [paymentId],
      );
      expect(outbox.rows.map((r) => r.event_type)).toEqual(['payment.created', 'payment.state_changed', 'payment.state_changed']);
    });

    it('concorrência entre pagamentos de tenants diferentes não corrompe as cadeias de auditoria', async () => {
      const h = createHarness({ uow });
      const ctxOther = { tenantId: TENANT_B, actor: { type: 'API_CLIENT' as const, id: 'key-b' }, correlationId: null };
      await Promise.all(
        Array.from({ length: 20 }, (_, i) => h.service.createPayment(i % 2 === 0 ? ctxA : ctxOther, createCommand(), newKey())),
      );
      expect(verifyAuditChain(await loadAuditChain(pool, TENANT_A)).valid).toBe(true);
      expect(verifyAuditChain(await loadAuditChain(pool, TENANT_B)).valid).toBe(true);
    });

    it('recuperação e resposta tardia concorrentes não geram estado inconsistente', async () => {
      const h = createHarness({ uow, providerTimeoutMs: 400 });
      h.scenario = { type: 'DELAYED_RESPONSE', delayMs: 60, outcome: 'SUCCEEDED' };
      const { payment } = await h.service.createPayment(ctxA, createCommand(), newKey());
      const inFlight = h.service.authorize(ctxA, payment.id, newKey());
      await new Promise((r) => setTimeout(r, 20));
      h.clockMs += 120_000;
      // A recuperação (prematura) marca UNKNOWN; a resposta real do provedor chega depois e resolve.
      await h.service.recoverStaleInFlight(60_000);
      const result = await inFlight;
      expect(result.payment.state).toBe('APPROVED');
      expect(result.operation.evidence?.source).toBe('PROVIDER_RESPONSE');
      expect(h.simulator.receivedCount()).toBe(1);
      expect(verifyAuditChain(await loadAuditChain(pool, TENANT_A)).valid).toBe(true);
    });
  });
});
