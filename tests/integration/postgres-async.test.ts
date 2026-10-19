import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminService, HasDependenciesError, DuplicateCodeError, OutboxPublisher, PaymentService } from '@tef/application';
import { parseMerchantId, parseTenantId, parseTerminalId } from '@tef/domain';
import { createProviderRegistry } from '@tef/provider-contract';
import { PaymentSimulator, SIMULATOR_PROVIDER_ID } from '@tef/provider-simulator';
import { createPgSimulatorLedger } from '@tef/persistence/postgres';
import { DevAdminAuth } from '../../apps/api/src/admin-auth.ts';
import { buildApp } from '../../apps/api/src/app.ts';
import { createAuthenticator } from '../../apps/api/src/auth.ts';
import { createLogger } from '../../apps/api/src/logging.ts';
import { RecordingSink, testRuntime } from '../support/async.ts';
import { describeAsyncSuite } from '../support/async-suite.ts';
import { createCommand, ctxA, newKey } from '../support/harness.ts';
import { createTestSchema, TEST_DATABASE_URL, type TestSchema } from '../support/pg.ts';

/**
 * Modelo assíncrono contra PostgreSQL REAL: fila com SKIP LOCKED e lease, outbox,
 * cadastro com integridade referencial e API + worker em conjunto.
 */
let db: TestSchema;

describe.skipIf(!TEST_DATABASE_URL)('PostgreSQL — modelo assíncrono', () => {
  beforeAll(async () => {
    db = await createTestSchema();
  });
  afterAll(async () => {
    await db?.cleanup();
  });

  describeAsyncSuite({
    name: 'postgres',
    uow: () => Promise.resolve(db.uow),
    resultCount: async (tenantId, operationId) =>
      (
        await db.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND resource_id = $2 AND action = 'operation.result_recorded'`,
          [tenantId, operationId],
        )
      ).rows[0]!.n,
    dispatchCount: async (tenantId, operationId) =>
      (
        await db.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND resource_id = $2 AND action = 'operation.dispatched'`,
          [tenantId, operationId],
        )
      ).rows[0]!.n,
  });

  describe('concorrência real', () => {
    it('três workers simultâneos: cada tarefa é executada uma única vez', async () => {
      const clock = { ms: Date.parse('2026-10-18T12:00:00.000Z') };
      const workers = ['w1', 'w2', 'w3'].map((id) => testRuntime(db.uow, { workerId: `${id}-${Date.now()}`, clock }));
      const ids: string[] = [];
      for (let i = 0; i < 12; i++) {
        const r = await workers[0]!.service.createPayment(ctxA, { ...createCommand(), authorize: true }, newKey());
        ids.push(r.payment.id);
      }
      for (let round = 0; round < 4; round++) await Promise.all(workers.map((w) => w.worker.runOnce()));
      const sent = workers.reduce((acc, w) => acc + w.simulator.receivedCount(), 0);
      expect(sent).toBe(12);
      const states = await db.pool.query<{ state: string; n: number }>(
        `SELECT state, count(*)::int AS n FROM payments WHERE id = ANY($1) GROUP BY state`,
        [ids],
      );
      expect(states.rows).toEqual([{ state: 'APPROVED', n: 12 }]);
      const dispatches = await db.pool.query<{ n: number }>(
        `SELECT max(c)::int AS n FROM (SELECT count(*) AS c FROM audit_events a JOIN payment_operations o ON o.id = a.resource_id
           WHERE o.payment_id = ANY($1) AND a.action = 'operation.dispatched' GROUP BY a.resource_id) t`,
        [ids],
      );
      expect(dispatches.rows[0]!.n).toBe(1);
    });

    it('dois publicadores simultâneos não entregam o mesmo evento duas vezes', async () => {
      const rt = testRuntime(db.uow);
      for (let i = 0; i < 5; i++) await rt.service.createPayment(ctxA, createCommand(), newKey());
      const sinks = [new RecordingSink(), new RecordingSink()];
      const publishers = sinks.map((sink) => new OutboxPublisher({ uow: db.uow, sink, batchSize: 3 }));
      for (let round = 0; round < 10; round++) await Promise.all(publishers.map((p) => p.publishOnce()));
      const delivered = sinks.flatMap((s) => s.delivered.map((e) => e.id));
      expect(new Set(delivered).size).toBe(delivered.length);
      expect(await db.uow.transaction((r) => r.outbox.countUnpublished())).toBe(0);
    });

    it('reinício do worker: a reconciliação usa o livro durável do simulador e chega ao resultado real', async () => {
      const ledger = createPgSimulatorLedger(db.pool);
      const clock = { ms: Date.parse('2026-10-18T12:00:00.000Z') };
      const before = testRuntime(db.uow, { workerId: 'w-antes', clock, ledger });
      const created = await before.service.createPayment(ctxA, { ...createCommand(), authorize: true, testDirective: 'COMMUNICATION_FAILURE' }, newKey());
      await before.worker.runOnce();
      expect((await before.service.getPayment(ctxA, created.payment.id)).payment.state).toBe('UNKNOWN');
      before.simulator.dispose();

      // Novo processo (outra instância, memória vazia), mesmo banco.
      const after = testRuntime(db.uow, { workerId: 'w-depois', clock, ledger: createPgSimulatorLedger(db.pool) });
      clock.ms += 10_000;
      await after.worker.runOnce();
      const view = await after.service.getPayment(ctxA, created.payment.id);
      expect(view.payment.state).toBe('DECLINED'); // não CANCELLED: o simulador sabe que processou
      expect(view.operations[0]?.evidence?.source).toBe('PROVIDER_QUERY');
      expect(after.simulator.receivedCount()).toBe(0); // consultou, não reenviou
      void ledger;
    });

    it('pagamento legado (anterior ao livro durável): reconciliação NÃO conclui "não enviado"; continua UNKNOWN', async () => {
      // Reproduz o pagamento legado da F1: processado por um simulador com livro em memória
      // (perdido), anterior ao início do livro durável.
      const legacy = testRuntime(db.uow, { workerId: 'w-legado' }); // livro em memória, como na F1
      const created = await legacy.service.createPayment(ctxA, { ...createCommand(), authorize: true, testDirective: 'UNKNOWN_THEN_RECONCILED' }, newKey());
      await legacy.worker.runOnce();
      expect((await legacy.service.getPayment(ctxA, created.payment.id)).payment.state).toBe('UNKNOWN');
      legacy.simulator.dispose();
      // O livro durável "começou" depois desta operação.
      const original = await db.pool.query<{ started_at: Date }>('SELECT started_at FROM simulator_ledger_meta');
      await db.pool.query(`UPDATE simulator_ledger_meta SET started_at = now() + interval '1 day'`);
      try {
        const current = testRuntime(db.uow, { workerId: 'w-atual', ledger: createPgSimulatorLedger(db.pool) });
        const result = await current.service.reconcileOperation(created.operations[0]!.id);
        expect(result.resolved).toBe(false);
        expect(result.payment.state).toBe('UNKNOWN'); // não vira CANCELLED por falta de registro
      } finally {
        await db.pool.query('UPDATE simulator_ledger_meta SET started_at = $1', [original.rows[0]!.started_at]);
      }
    });

    it('banco impede tarefa ativa duplicada para a mesma operação', async () => {
      const rt = testRuntime(db.uow);
      const created = await rt.service.createPayment(ctxA, { ...createCommand(), authorize: true }, newKey());
      const op = created.operations[0]!;
      const again = await db.uow.transaction((r) =>
        r.jobs.enqueue(
          { kind: 'EXECUTE_OPERATION', tenantId: ctxA.tenantId, paymentId: created.payment.id, operationId: op.id, availableAt: new Date(), maxAttempts: 5 },
          new Date(),
        ),
      );
      expect(again).toBe(false);
      const count = await db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE operation_id = $1`, [op.id]);
      expect(count.rows[0]!.n).toBe(1);
    });
  });

  describe('cadastro com integridade referencial', () => {
    const admin = () => new AdminService({ uow: db.uow, providers: createProviderRegistry([new PaymentSimulator()]) });
    const actor = { type: 'OPERATOR' as const, id: 'dev-admin' };

    it('CRUD de cliente, busca com curingas tratados como texto e código duplicado', async () => {
      const code = parseTenantId(`cli-${randomBytes(4).toString('hex')}`);
      await admin().createCustomer(actor, { id: code, legalName: 'Comércio 100% Fictício Ltda' });
      await expect(admin().createCustomer(actor, { id: code, legalName: 'Outro' })).rejects.toBeInstanceOf(DuplicateCodeError);
      expect((await admin().listCustomers({ q: '100%', limit: 50 })).map((c) => c.id)).toContain(code);
      expect((await admin().listCustomers({ q: '%', limit: 50 })).map((c) => c.id)).toEqual([code]);
      const updated = await admin().updateCustomer(actor, code, { tradeName: 'Fictício', status: 'INACTIVE' });
      expect(updated).toMatchObject({ status: 'INACTIVE', tradeName: 'Fictício', version: 2 });
      await admin().deleteCustomer(actor, code);
      expect(await db.uow.transaction((r) => r.catalog.findCustomer(code))).toBeNull();
    });

    it('não exclui cadastro com histórico financeiro; banco também impede (RESTRICT)', async () => {
      const rt = testRuntime(db.uow);
      await rt.service.createPayment(ctxA, createCommand(), newKey());
      await expect(admin().deleteTerminal(actor, ctxA.tenantId, parseTerminalId('terminal-1'))).rejects.toBeInstanceOf(HasDependenciesError);
      await expect(db.pool.query(`DELETE FROM terminals WHERE customer_id = 'tenant-a' AND id = 'terminal-1'`)).rejects.toMatchObject({ code: '23001' });
      // Mesmo se a verificação da aplicação for contornada (corrida), o repositório traduz a recusa do banco.
      await expect(db.uow.transaction((r) => r.catalog.deleteTerminal(ctxA.tenantId, parseTerminalId('terminal-1')))).rejects.toBeInstanceOf(
        HasDependenciesError,
      );
    });

    it('banco recusa pagamento com terminal inexistente ou de outro estabelecimento', async () => {
      await expect(
        db.pool.query(
          `INSERT INTO payments (id, tenant_id, merchant_id, terminal_id, external_reference, provider_id, currency, amount_cents, state, version, created_at, updated_at)
           VALUES ('pay_0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', 'tenant-a', 'merchant-2', 'terminal-1', 'x', 'SIMULATOR', 'BRL', 100, 'CREATED', 1, now(), now())`,
        ),
      ).rejects.toMatchObject({ code: '23503' });
    });

    it('terminal só pode ser criado para estabelecimento do mesmo cliente', async () => {
      await expect(
        admin().createTerminal(actor, parseTenantId('tenant-b'), {
          id: parseTerminalId(`t-${randomBytes(3).toString('hex')}`),
          merchantId: parseMerchantId('merchant-2'), // existe apenas em tenant-a
          label: 'x',
          providerId: SIMULATOR_PROVIDER_ID,
        }),
      ).rejects.toMatchObject({ code: 'REFERENCE_INVALID' });
    });

    it('diretiva de teste só é aceita para o provedor SIMULATOR (restrição do banco)', async () => {
      const rt = testRuntime(db.uow);
      const created = await rt.service.createPayment(ctxA, createCommand(), newKey());
      await expect(
        db.pool.query(`INSERT INTO provider_test_directives (payment_id, provider_id, directive, created_at) VALUES ($1, 'REAL', 'APPROVE', now())`, [
          created.payment.id,
        ]),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('dashboard agrega dados reais do banco por cliente', async () => {
      const customer = parseTenantId(`dash-${randomBytes(3).toString('hex')}`);
      const a = admin();
      await a.createCustomer(actor, { id: customer, legalName: 'Cliente Dashboard Fictício' });
      await a.createMerchant(actor, customer, { id: parseMerchantId('m1'), name: 'Loja 1' });
      await a.createTerminal(actor, customer, { id: parseTerminalId('t1'), merchantId: parseMerchantId('m1'), label: 'Caixa 1', providerId: SIMULATOR_PROVIDER_ID });
      const empty = await a.dashboard({ customerId: customer });
      expect(empty.totals).toMatchObject({ payments: 0, approvalRate: null });
      expect(empty.daily.length).toBeGreaterThanOrEqual(14);

      const rt = testRuntime(db.uow);
      const ctx = { ...ctxA, tenantId: customer };
      const base = { merchantId: parseMerchantId('m1'), terminalId: parseTerminalId('t1') };
      await rt.service.createPayment(ctx, { ...createCommand(1_000), ...base, authorize: true, testDirective: 'APPROVE' }, newKey());
      await rt.service.createPayment(ctx, { ...createCommand(2_000), ...base, authorize: true, testDirective: 'DECLINE' }, newKey());
      await rt.service.createPayment(ctx, { ...createCommand(3_000), ...base, authorize: true, testDirective: 'UNKNOWN_THEN_RECONCILED' }, newKey());
      await rt.worker.runOnce();
      const d = await a.dashboard({ customerId: customer });
      expect(d.totals).toMatchObject({ payments: 3, approvedCount: 1, declinedCount: 1, unknownCount: 1, approvalRate: 0.5 });
      expect(d.amounts).toMatchObject({ approvedCents: 1_000, declinedCents: 2_000, unknownCents: 3_000 });
      expect(d.unknownOperations).toBe(1);
      expect(d.daily.reduce((acc, b) => acc + b.approved + b.declined + b.other, 0)).toBe(3);
    });
  });

  describe('API + worker em conjunto (PostgreSQL)', () => {
    it('painel cria pagamento simulado (202), worker processa e o detalhe reflete o estado real', async () => {
      const token = randomBytes(32).toString('base64url');
      const providers = createProviderRegistry([new PaymentSimulator()]);
      const logger = createLogger('silent', false);
      const service = new PaymentService({ uow: db.uow, providers, providerTimeoutMs: 40, logger });
      const app = buildApp({
        service,
        providers,
        logger,
        authenticate: createAuthenticator([
          { keyId: 'k', keySha256: createHash('sha256').update(randomBytes(32)).digest('hex'), tenantId: 'tenant-a', merchantIds: ['merchant-1'] },
        ]),
        admin: {
          auth: new DevAdminAuth({ tokenSha256: createHash('sha256').update(token).digest('hex') }),
          service: new AdminService({ uow: db.uow, providers }),
          allowedOrigins: ['http://127.0.0.1:5173'],
        },
      });
      try {
        const headers = { 'x-tef-admin': '1' };
        const login = await app.inject({ method: 'POST', url: '/admin/api/session', headers, payload: { token } });
        expect(login.statusCode).toBe(200);
        const cookie = String(login.headers['set-cookie']).split(';')[0]!;
        const created = await app.inject({
          method: 'POST',
          url: '/admin/api/simulator/payments',
          headers: { ...headers, cookie, 'idempotency-key': newKey() },
          payload: { customerId: 'tenant-a', merchantId: 'merchant-1', terminalId: 'terminal-1', amountCents: 4_321, scenario: 'COMMUNICATION_FAILURE' },
        });
        expect(created.statusCode).toBe(202);
        const id = created.json<{ id: string }>().id;

        // Mesmo relógio real da API (os componentes reais compartilham o relógio da máquina).
        const rt = testRuntime(db.uow, { clock: { ms: Date.now() }, ledger: createPgSimulatorLedger(db.pool) });
        await rt.worker.runOnce();
        const detail1 = await app.inject({ method: 'GET', url: `/admin/api/customers/tenant-a/payments/${id}`, headers: { ...headers, cookie } });
        expect(detail1.json()).toMatchObject({ payment: { state: 'UNKNOWN' }, testDirective: 'COMMUNICATION_FAILURE' });

        // "Reconciliar agora" só agenda; o worker (com o livro do simulador no banco) consulta.
        const reconcile = await app.inject({ method: 'POST', url: `/admin/api/customers/tenant-a/payments/${id}/reconcile`, headers: { ...headers, cookie } });
        expect(reconcile.statusCode).toBe(202);
        expect(reconcile.json()).toMatchObject({ scheduled: 'EXPEDITED', operation: { status: 'UNKNOWN' } });
        rt.clock.ms = Date.now();
        await rt.worker.runOnce();
        const detail2 = await app.inject({ method: 'GET', url: `/admin/api/customers/tenant-a/payments/${id}`, headers: { ...headers, cookie } });
        const body = detail2.json<{ payment: { state: string; operations: unknown[] }; jobs: { kind: string }[]; audit: unknown[] }>();
        expect(body.payment.state).toBe('DECLINED');
        expect(body.payment.operations).toHaveLength(1);
        expect(body.jobs.map((j) => j.kind)).toContain('EXECUTE_OPERATION');
        expect(body.audit.length).toBeGreaterThan(3);
        expect(detail2.body).not.toContain(token);
      } finally {
        await app.close();
      }
    });
  });
});
