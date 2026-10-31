import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminService, OutboxPublisher, PaymentService } from '@tef/application';
import { verifyAuditChain } from '@tef/audit';
import { markDispatched, parseMerchantId, parseTerminalId, parseTenantId } from '@tef/domain';
import { createPgRepositories, createPgSimulatorLedger, DB_ROLES, inspectRuntimeIdentity, loadAuditChain, migrate } from '@tef/persistence/postgres';
import { createProviderRegistry } from '@tef/provider-contract';
import { PaymentSimulator, SIMULATOR_PROVIDER_ID } from '@tef/provider-simulator';
import { DevAdminAuth } from '../../apps/api/src/admin-auth.ts';
import { buildApp } from '../../apps/api/src/app.ts';
import { createAuthenticator } from '../../apps/api/src/auth.ts';
import { createLogger } from '../../apps/api/src/logging.ts';
import { RecordingSink, testRuntime } from '../support/async.ts';
import { createCommand, ctxA, newKey, sleep } from '../support/harness.ts';
import { createTestSchema, quiesceQueue, sqlState, TEST_DATABASE_URL, type TestSchema } from '../support/pg.ts';

/**
 * ADR 0020 — separação real de privilégios no PostgreSQL. Cada caso NEGATIVO executa a
 * operação de verdade com a identidade restrita e confirma que o servidor a recusa
 * (SQLSTATE 42501, "insufficient_privilege", salvo indicação). Nada aqui se baseia só em
 * information_schema.
 */
const DENIED = '42501';
let db: TestSchema;

describe.skipIf(!TEST_DATABASE_URL)('PostgreSQL — identidades e menor privilégio (ADR 0020)', () => {
  beforeAll(async () => {
    db = await createTestSchema();
  });
  afterAll(async () => {
    await db?.cleanup();
  });
  beforeEach(async () => {
    await quiesceQueue(db.pool);
  });

  describe('1. tef_owner executa as migrações', () => {
    it('o schema e todos os objetos pertencem a tef_owner; a 0005 está aplicada', async () => {
      expect((await db.ownerPool.query<{ u: string }>('SELECT current_user AS u')).rows[0]!.u).toBe(DB_ROLES.owner);
      const owners = await db.pool.query<{ owner: string }>(
        `SELECT DISTINCT pg_get_userbyid(c.relowner) AS owner FROM pg_class c WHERE c.relnamespace = to_regnamespace(current_schema())`,
      );
      expect(owners.rows).toEqual([{ owner: DB_ROLES.owner }]);
      const versions = await db.pool.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version');
      expect(versions.rows.at(-1)?.version).toBe('0005_runtime_role_privileges.sql');
      // Reexecutar é idempotente para o dono.
      expect((await migrate(db.ownerPool)).applied).toEqual([]);
    });

    it('nem a API nem o worker conseguem executar as migrações', async () => {
      await db.pool.query(`DELETE FROM schema_migrations WHERE version = '0005_runtime_role_privileges.sql'`);
      try {
        expect(await sqlState(() => migrate(db.appPool))).toBe(DENIED);
        expect(await sqlState(() => migrate(db.workerPool))).toBe(DENIED);
      } finally {
        await migrate(db.ownerPool); // reaplica a 0005 (GRANTs idempotentes)
      }
    });
  });

  describe('2. tef_app executa as operações da API', () => {
    it('cadastro, pagamento (202), consulta, reconciliação solicitada, painel e auditoria', async () => {
      const providers = createProviderRegistry([new PaymentSimulator()]);
      const admin = new AdminService({ uow: db.uow, providers });
      const payments = new PaymentService({ uow: db.uow, providers, providerTimeoutMs: 40 });
      const actor = { type: 'OPERATOR' as const, id: 'teste-papel' };
      const code = parseTenantId(`api-${randomBytes(3).toString('hex')}`);
      await admin.createCustomer(actor, { id: code, legalName: 'Cliente da API (fictício)', tradeName: null });
      await admin.createMerchant(actor, code, { id: parseMerchantId('loja-api'), name: 'Loja API', city: null });
      await admin.createTerminal(actor, code, { id: parseTerminalId('caixa-api'), merchantId: parseMerchantId('loja-api'), label: 'Caixa API', providerId: SIMULATOR_PROVIDER_ID });
      await admin.updateTerminal(actor, code, parseTerminalId('caixa-api'), { label: 'Caixa API 2' });
      await admin.createTerminal(actor, code, { id: parseTerminalId('caixa-sem-uso'), merchantId: parseMerchantId('loja-api'), label: 'Sem uso', providerId: SIMULATOR_PROVIDER_ID });
      await admin.deleteTerminal(actor, code, parseTerminalId('caixa-sem-uso'));

      const created = await payments.createPayment(ctxA, { ...createCommand(), authorize: true, testDirective: 'APPROVE' }, newKey());
      expect(created.responseStatus).toBe(202);
      const replay = await payments.createPayment(ctxA, { ...createCommand(), authorize: true }, newKey());
      expect(replay.payment.id).not.toBe(created.payment.id);
      expect((await payments.getPayment(ctxA, created.payment.id)).payment.state).toBe('PROCESSING');
      expect((await admin.listPayments({ limit: 10 })).length).toBeGreaterThan(0);
      expect((await admin.dashboard({})).totals.payments).toBeGreaterThan(0);
      expect(await admin.systemStatus()).toHaveProperty('jobs');
      expect((await admin.verifyAudit(ctxA.tenantId)).valid).toBe(true);
    });

    it('API HTTP real (buildApp) com o painel local, usando apenas tef_app', async () => {
      const providers = createProviderRegistry([new PaymentSimulator()]);
      const token = randomBytes(24).toString('base64url');
      const app = buildApp({
        service: new PaymentService({ uow: db.uow, providers, providerTimeoutMs: 40 }),
        providers,
        authenticate: createAuthenticator([]),
        logger: createLogger('silent', false),
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
          payload: { customerId: 'tenant-a', merchantId: 'merchant-1', terminalId: 'terminal-1', amountCents: 2590, scenario: 'APPROVE' },
        });
        expect(created.statusCode).toBe(202);
        const list = await app.inject({ method: 'GET', url: '/admin/api/payments?limit=5', headers: { ...headers, cookie } });
        expect(list.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });
  });

  describe('3. tef_app não executa DDL nem desarma a auditoria', () => {
    const attempts: readonly [string, string][] = [
      ['CREATE TABLE', 'CREATE TABLE intrusa (id int)'],
      ['ALTER TABLE', 'ALTER TABLE payments ADD COLUMN intrusa text'],
      ['DROP TABLE', 'DROP TABLE payments'],
      ['TRUNCATE', 'TRUNCATE audit_events'],
      ['DISABLE TRIGGER (auditoria)', 'ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update_delete'],
      ['DISABLE TRIGGER ALL', 'ALTER TABLE audit_events DISABLE TRIGGER ALL'],
      ['DROP TRIGGER', 'DROP TRIGGER audit_events_no_update_delete ON audit_events'],
      ['DROP FUNCTION do gatilho', 'DROP FUNCTION audit_events_reject_mutation()'],
      ['CREATE OR REPLACE FUNCTION do gatilho', "CREATE OR REPLACE FUNCTION audit_events_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'"],
      ['session_replication_role (desliga gatilhos)', 'SET session_replication_role = replica'],
      ['UPDATE na auditoria', `UPDATE audit_events SET action = 'x'`],
      ['DELETE na auditoria', 'DELETE FROM audit_events'],
      ['DELETE de pagamentos', 'DELETE FROM payments'],
      ['escrita em schema_migrations', `INSERT INTO schema_migrations (version, checksum) VALUES ('9999_x.sql', repeat('0', 64))`],
      ['CREATE SCHEMA', 'CREATE SCHEMA intruso'],
      ['SET ROLE tef_owner', 'SET ROLE tef_owner'],
      ['CREATE ROLE', 'CREATE ROLE intruso'],
      ['ALTER ROLE (escalada)', 'ALTER ROLE tef_app SUPERUSER'],
      ['ALTER SCHEMA OWNER', 'ALTER TABLE payments OWNER TO tef_app'],
    ];
    for (const [label, sql] of attempts) {
      it(`nega: ${label}`, async () => {
        expect(await sqlState(() => db.appPool.query(sql))).toBe(DENIED);
      });
    }

    it('o gatilho de auditoria continua ativo e o dado continua intacto', async () => {
      const t = await db.pool.query<{ tgenabled: string }>(
        `SELECT t.tgenabled FROM pg_trigger t WHERE t.tgrelid = 'audit_events'::regclass AND t.tgname = 'audit_events_no_update_delete'`,
      );
      expect(t.rows).toEqual([{ tgenabled: 'O' }]);
      // Mesmo o dono do schema, com os privilégios da tabela, é barrado pelo gatilho.
      await expect(db.pool.query(`UPDATE audit_events SET action = 'x'`)).rejects.toThrow(/somente inserção/);
    });
  });

  describe('4. tef_app não repassa privilégios', () => {
    it('GRANT de tabela sem grant option não tem efeito: o outro papel continua sem acesso', async () => {
      const notices: string[] = [];
      const client = await db.appPool.connect();
      client.on('notice', (n) => notices.push(n.message ?? ''));
      try {
        await client.query(`GRANT SELECT ON payments TO ${db.logins.nobody}`);
      } finally {
        client.release();
      }
      expect(notices.join(' ')).toMatch(/no privileges were granted|nenhum privilégio foi concedido/i);
      // Tentativa REAL com o papel que "receberia" o privilégio. Ele recebe USAGE no schema
      // (pela ferramenta de teste) para que a única barreira restante seja a da tabela.
      await db.pool.query(`GRANT USAGE ON SCHEMA ${db.schema} TO ${db.logins.nobody}`);
      const nobody = db.connectAs('nobody', { max: 1 });
      expect(await sqlState(() => nobody.query('SELECT 1 FROM payments LIMIT 1'))).toBe(DENIED);
    });

    it('GRANT de papel (tef_app/tef_owner) a outro usuário é negado', async () => {
      expect(await sqlState(() => db.appPool.query(`GRANT tef_app TO ${db.logins.nobody}`))).toBe(DENIED);
      expect(await sqlState(() => db.appPool.query(`GRANT tef_owner TO ${db.logins.nobody}`))).toBe(DENIED);
      expect(await sqlState(() => db.workerPool.query(`GRANT tef_worker TO ${db.logins.nobody}`))).toBe(DENIED);
    });
  });

  describe('5. tef_worker executa só o necessário', () => {
    it('processa a fila, reconcilia por consulta, publica a outbox e registra batimento', async () => {
      const api = testRuntime(db.uow);
      const ledger = createPgSimulatorLedger(db.workerPool);
      const sink = new RecordingSink();
      const worker = testRuntime(db.workerUow, { workerId: `w-papel-${Date.now()}`, ledger });
      const approved = await api.service.createPayment(ctxA, { ...createCommand(), authorize: true, testDirective: 'APPROVE' }, newKey());
      const unknown = await api.service.createPayment(ctxA, { ...createCommand(), authorize: true, testDirective: 'TIMEOUT_AFTER_SEND' }, newKey());
      await worker.worker.runOnce();
      expect((await api.service.getPayment(ctxA, approved.payment.id)).payment.state).toBe('APPROVED');
      expect((await api.service.getPayment(ctxA, unknown.payment.id)).payment.state).toBe('UNKNOWN');
      await sleep(300); // reconciliação agendada (relógio do banco, ADR 0019)
      await worker.worker.runOnce();
      const resolved = await api.service.getPayment(ctxA, unknown.payment.id);
      expect(resolved.payment.state).toBe('APPROVED');
      expect(resolved.operations[0]?.evidence?.source).toBe('PROVIDER_QUERY');
      expect(worker.simulator.receivedCount()).toBe(2); // uma cobrança por pagamento; a consulta não reenvia
      // O worker publicou a outbox no próprio laço; um segundo publicador (também tef_worker)
      // não encontra pendências nem entrega em duplicidade.
      expect(worker.sink.delivered.filter((e) => e.aggregateId === approved.payment.id).length).toBeGreaterThan(0);
      await new OutboxPublisher({ uow: db.workerUow, sink }).publishOnce();
      expect(sink.delivered.filter((e) => worker.sink.delivered.some((d) => d.id === e.id))).toEqual([]);
      expect((await db.workerUow.transaction((r) => r.heartbeats.list())).length).toBeGreaterThan(0);
      expect(verifyAuditChain(await loadAuditChain(db.pool, ctxA.tenantId)).valid).toBe(true);
      worker.simulator.dispose();
    });

    it('recuperação sem reenvio funciona com tef_worker (garantia do I1)', async () => {
      const api = testRuntime(db.uow);
      const created = await api.service.createPayment(ctxA, { ...createCommand(), authorize: true }, newKey());
      const opId = created.operations[0]!.id;
      await db.workerUow.transaction((r) => r.jobs.claim('worker-que-caiu', 10, 300));
      await db.workerUow.transaction(async (r) => {
        const op = await r.operations.findById(ctxA.tenantId, opId);
        await r.operations.update(markDispatched(op!, api.simulator.capabilities, new Date()), op!.version);
      });
      await sleep(500);
      const worker = testRuntime(db.workerUow, { workerId: 'w-recupera' });
      expect((await worker.worker.runOnce()).jobs).toBe(1);
      const view = await api.service.getPayment(ctxA, created.payment.id);
      expect(view.operations[0]).toMatchObject({ status: 'UNKNOWN', resultCode: 'WORKER_INTERRUPTED_AFTER_DISPATCH' });
      expect(worker.simulator.receivedCount()).toBe(0);
      expect(await worker.service.recoverStaleInFlight(0)).toBe(0); // já resolvida como UNKNOWN
    });

    const workerDenied: readonly [string, string][] = [
      ['criar pagamentos', `INSERT INTO payments (id) VALUES ('x')`],
      ['criar operações', `INSERT INTO payment_operations (id) VALUES ('x')`],
      ['ler ou gravar idempotência', 'SELECT 1 FROM idempotency_keys'],
      ['alterar cadastro', `UPDATE customers SET legal_name = 'x'`],
      ['ler cadastro', 'SELECT 1 FROM customers'],
      ['gravar diretivas de teste', `INSERT INTO provider_test_directives (payment_id) VALUES ('x')`],
      ['apagar tarefas', 'DELETE FROM jobs'],
      ['apagar outbox', 'DELETE FROM outbox_events'],
      ['alterar o livro do simulador', `UPDATE simulator_ledger SET outcome = 'SUCCEEDED'`],
      ['alterar o início do livro', 'UPDATE simulator_ledger_meta SET started_at = now()'],
      ['DDL', 'CREATE TABLE intrusa (id int)'],
      ['DISABLE TRIGGER', 'ALTER TABLE audit_events DISABLE TRIGGER ALL'],
      ['TRUNCATE', 'TRUNCATE jobs'],
    ];
    for (const [label, sql] of workerDenied) {
      it(`nega ao worker: ${label}`, async () => {
        expect(await sqlState(() => db.workerPool.query(sql))).toBe(DENIED);
      });
    }

    it('API não usa privilégios do worker: não altera o livro do simulador nem a outbox publicada', async () => {
      expect(await sqlState(() => db.appPool.query('SELECT 1 FROM simulator_ledger'))).toBe(DENIED);
      expect(await sqlState(() => db.appPool.query('UPDATE outbox_events SET published_at = now()'))).toBe(DENIED);
      expect(await sqlState(() => db.appPool.query(`INSERT INTO worker_heartbeats (worker_id) VALUES ('x')`))).toBe(DENIED);
    });
  });

  describe('6. verificação de identidade na inicialização', () => {
    it('aceita tef_app e tef_worker; recusa dono, superusuário e papel trocado', async () => {
      expect((await inspectRuntimeIdentity(db.appPool, DB_ROLES.app)).violations).toEqual([]);
      expect((await inspectRuntimeIdentity(db.workerPool, DB_ROLES.worker)).violations).toEqual([]);
      const asOwner = await inspectRuntimeIdentity(db.ownerPool, DB_ROLES.app);
      expect(asOwner.violations.join(' ')).toMatch(/tef_owner|dona de objetos|criar objetos/);
      const asSuper = await inspectRuntimeIdentity(db.pool, DB_ROLES.app);
      expect(asSuper.violations.join(' ')).toMatch(/SUPERUSUÁRIO/);
      const swapped = await inspectRuntimeIdentity(db.workerPool, DB_ROLES.app);
      expect(swapped.violations.join(' ')).toMatch(/não pertence ao papel tef_app/);
    });
  });

  describe('7. repositórios do produto com a identidade da API', () => {
    it('isolamento por tenant e SQL parametrizado seguem válidos com tef_app', async () => {
      const repos = createPgRepositories(db.appPool);
      expect(await repos.payments.findById(parseTenantId('tenant-b'), 'pay_00000000-0000-7000-8000-000000000000' as never)).toBeNull();
    });
  });
});
