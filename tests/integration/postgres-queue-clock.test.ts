import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { verifyAuditChain } from '@tef/audit';
import { markDispatched, type TenantId } from '@tef/domain';
import { createPgSimulatorLedger, loadAuditChain } from '@tef/persistence/postgres';
import { testRuntime, TEST_RECONCILE_DELAY_MS } from '../support/async.ts';
import { createCommand, ctxA, newKey, sleep } from '../support/harness.ts';
import { createTestSchema, quiesceQueue, TEST_DATABASE_URL, type TestSchema } from '../support/pg.ts';

/**
 * ADR 0019 — o relógio do PostgreSQL é a autoridade temporal da fila. Cada processo de
 * teste recebe um relógio próprio, artificialmente divergente (±1 h); o relógio do sistema
 * operacional não é alterado. As garantias valem com concorrência real no PostgreSQL.
 */
const HOUR = 3_600_000;
const LEASE_MS = 600;
const PAST_LEASE_MS = 800;
const skewed = (offsetMs: number) => ({ ms: Date.now() + offsetMs });
const SYSTEM = { type: 'SYSTEM' as const, id: 'teste-relogio' };

let db: TestSchema;

describe.skipIf(!TEST_DATABASE_URL)('PostgreSQL — relógio do banco na fila e nos leases (ADR 0019)', () => {
  beforeAll(async () => {
    db = await createTestSchema();
  });
  afterAll(async () => {
    await db?.cleanup();
  });
  beforeEach(async () => {
    await quiesceQueue(db.pool);
  });

  const count = async (tenantId: TenantId, operationId: string, action: string): Promise<number> =>
    (
      await db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND resource_id = $2 AND action = $3`, [
        tenantId,
        operationId,
        action,
      ])
    ).rows[0]!.n;
  /** Prazo restante do lease medido pelo relógio do banco (ms). */
  const leaseRemainingMs = async (jobId: number): Promise<number> =>
    (await db.pool.query<{ ms: number }>(`SELECT (extract(epoch FROM lease_expires_at - clock_timestamp()) * 1000)::float8 AS ms FROM jobs WHERE id = $1`, [jobId]))
      .rows[0]!.ms;
  const jobOf = async (operationId: string, kind = 'EXECUTE_OPERATION') =>
    (await db.pool.query<{ id: string; status: string; attempts: number; lease_owner: string | null }>(
      `SELECT id, status, attempts, lease_owner FROM jobs WHERE operation_id = $1 AND kind = $2 ORDER BY id DESC LIMIT 1`,
      [operationId, kind],
    )).rows[0]!;

  it('1. relógios divergentes: tarefa criada por processo adiantado fica disponível já para um worker atrasado', async () => {
    const api = testRuntime(db.uow, { workerId: 'api-adiantada', clock: skewed(+HOUR) });
    const late = testRuntime(db.uow, { workerId: 'worker-atrasado', clock: skewed(-HOUR) });
    const created = await api.service.createPayment(ctxA, { ...createCommand(), authorize: true }, newKey());

    // available_at vem do banco, não do relógio (+1 h) de quem enfileirou.
    const skew = await db.pool.query<{ ms: number }>(
      `SELECT (abs(extract(epoch FROM available_at - clock_timestamp())) * 1000)::float8 AS ms FROM jobs WHERE operation_id = $1`,
      [created.operations[0]!.id],
    );
    expect(skew.rows[0]!.ms).toBeLessThan(5_000);

    // Com o relógio da aplicação, o worker atrasado só veria a tarefa daqui a 2 h.
    expect((await late.worker.runOnce()).jobs).toBe(1);
    expect((await late.service.getPayment(ctxA, created.payment.id)).payment.state).toBe('APPROVED');
    expect(api.simulator.receivedCount() + late.simulator.receivedCount()).toBe(1);
  });

  it('2. lease não é antecipado por um worker com relógio adiantado e vence pelo relógio do banco', async () => {
    const owner = testRuntime(db.uow, { workerId: 'dono-atrasado', clock: skewed(-HOUR) });
    const thief = testRuntime(db.uow, { workerId: 'intruso-adiantado', clock: skewed(+HOUR) });
    const created = await owner.service.createPayment(ctxA, { ...createCommand(), authorize: true }, newKey());
    const [job] = await db.uow.transaction((r) => r.jobs.claim('dono-atrasado', 10, LEASE_MS));
    expect(job).toBeDefined();

    // O prazo concedido é medido pelo banco, independentemente do relógio (−1 h) do dono.
    const remaining = await leaseRemainingMs(job!.id);
    expect(remaining).toBeGreaterThan(LEASE_MS - 250);
    expect(remaining).toBeLessThanOrEqual(LEASE_MS);

    // Com o relógio da aplicação (+1 h), o intruso tomaria a tarefa imediatamente.
    for (let i = 0; i < 3; i++) expect((await thief.worker.runOnce()).jobs).toBe(0);
    expect(await jobOf(created.operations[0]!.id)).toMatchObject({ status: 'RUNNING', lease_owner: 'dono-atrasado' });

    await sleep(PAST_LEASE_MS);
    expect((await thief.worker.runOnce()).jobs).toBe(1);
    expect(await jobOf(created.operations[0]!.id)).toMatchObject({ status: 'DONE', attempts: 2 });
    expect(owner.simulator.receivedCount() + thief.simulator.receivedCount()).toBe(1);
    expect(await count(ctxA.tenantId, created.operations[0]!.id, 'operation.dispatched')).toBe(1);
  });

  it('3. renovação e conclusão respeitam a posse; lease vencido não é ressuscitado', async () => {
    const rt = testRuntime(db.uow, { workerId: 'w-posse', clock: skewed(+HOUR) });
    const created = await rt.service.createPayment(ctxA, { ...createCommand(), authorize: true }, newKey());
    const [job] = await db.uow.transaction((r) => r.jobs.claim('dono', 10, LEASE_MS));
    const id = job!.id;

    // Quem não é dono não renova, não conclui e não reagenda.
    expect(await db.uow.transaction((r) => r.jobs.renewLease(id, 'outro', LEASE_MS))).toBe(false);
    expect(await db.uow.transaction((r) => r.jobs.complete(id, 'outro'))).toBe(false);
    expect(await db.uow.transaction((r) => r.jobs.retryLater(id, 'outro', 0, 'X'))).toBe('LOST_LEASE');

    // O dono renova dentro do prazo: novo prazo contado a partir do relógio do banco.
    await sleep(300);
    expect(await db.uow.transaction((r) => r.jobs.renewLease(id, 'dono', LEASE_MS))).toBe(true);
    expect(await leaseRemainingMs(id)).toBeGreaterThan(LEASE_MS - 250);

    // Depois do vencimento, nem o antigo dono renova, conclui ou reagenda.
    await sleep(PAST_LEASE_MS);
    expect(await db.uow.transaction((r) => r.jobs.renewLease(id, 'dono', LEASE_MS))).toBe(false);
    expect(await db.uow.transaction((r) => r.jobs.complete(id, 'dono'))).toBe(false);
    expect(await db.uow.transaction((r) => r.jobs.retryLater(id, 'dono', 0, 'X'))).toBe('LOST_LEASE');

    // Outro worker reassume; só ele conclui.
    const [again] = await db.uow.transaction((r) => r.jobs.claim('sucessor', 10, LEASE_MS));
    expect(again).toMatchObject({ id, attempts: 2, leaseOwner: 'sucessor' });
    const outcome = await rt.service.processJob(again!, SYSTEM, { workerId: 'sucessor', leaseMs: LEASE_MS });
    expect(outcome).toMatchObject({ kind: 'DONE', detail: 'SUCCEEDED' });
    expect(await db.uow.transaction((r) => r.jobs.complete(id, 'dono'))).toBe(false);
    expect(await db.uow.transaction((r) => r.jobs.complete(id, 'sucessor'))).toBe(true);
    expect(await count(ctxA.tenantId, created.operations[0]!.id, 'operation.dispatched')).toBe(1);
  });

  it('4. worker que parou de renovar após o envio: recuperação marca UNKNOWN e NÃO reenvia', async () => {
    const recoverer = testRuntime(db.uow, { workerId: 'recuperador-atrasado', clock: skewed(-HOUR) });
    const sweeper = testRuntime(db.uow, { workerId: 'varredor-adiantado', clock: skewed(+HOUR) });
    const created = await recoverer.service.createPayment(ctxA, { ...createCommand(), authorize: true }, newKey());
    const opId = created.operations[0]!.id;

    // O worker original reivindica, marca IN_FLIGHT (possível envio) e para de renovar.
    await db.uow.transaction((r) => r.jobs.claim('original-parado', 10, LEASE_MS));
    await db.uow.transaction(async (r) => {
      const op = await r.operations.findById(ctxA.tenantId, opId);
      await r.operations.update(markDispatched(op!, recoverer.simulator.capabilities, new Date()), op!.version);
    });

    // Enquanto o lease vale pelo banco: o worker atrasado não reassume e a varredura com
    // relógio adiantado (+1 h) NÃO considera a operação abandonada.
    expect((await recoverer.worker.runOnce()).jobs).toBe(0);
    expect(await sweeper.service.recoverStaleInFlight(60_000)).toBe(0);
    expect((await recoverer.service.getPayment(ctxA, created.payment.id)).operations[0]?.status).toBe('IN_FLIGHT');

    // Vencido o lease, o worker atrasado (−1 h) reassume — com o relógio da aplicação ele
    // esperaria mais 1 h — e marca UNKNOWN sem reenviar.
    await sleep(PAST_LEASE_MS);
    expect((await recoverer.worker.runOnce()).jobs).toBe(1);
    const view = await recoverer.service.getPayment(ctxA, created.payment.id);
    expect(view.payment.state).toBe('UNKNOWN');
    expect(view.operations).toHaveLength(1);
    expect(view.operations[0]).toMatchObject({ status: 'UNKNOWN', resultCode: 'WORKER_INTERRUPTED_AFTER_DISPATCH' });
    expect(recoverer.simulator.receivedCount() + sweeper.simulator.receivedCount()).toBe(0);
    expect(await count(ctxA.tenantId, opId, 'operation.dispatched')).toBe(0);
    // O que fica agendado é CONSULTA, nunca nova execução.
    const jobs = await db.uow.transaction((r) => r.jobs.listByPayment(ctxA.tenantId, created.payment.id));
    expect(jobs.map((j) => `${j.kind}:${j.status}`)).toEqual(['EXECUTE_OPERATION:DONE', 'RECONCILE_OPERATION:PENDING']);
  });

  it('5. corrida entre recuperação e resposta original: um único envio e estado coerente', async () => {
    const ledger = createPgSimulatorLedger(db.pool);
    // Dono lento: a resposta do provedor chega (1,5 s) depois do lease vencer (0,6 s).
    const slow = testRuntime(db.uow, { workerId: 'dono-lento', clock: skewed(-HOUR), providerTimeoutMs: 2_500, simulatorDelayMs: 1_500, ledger });
    const recoverer = testRuntime(db.uow, { workerId: 'recuperador', clock: skewed(+HOUR), ledger });
    const created = await slow.service.createPayment(ctxA, { ...createCommand(), authorize: true, testDirective: 'DELAYED_RESPONSE' }, newKey());
    const opId = created.operations[0]!.id;
    const [job] = await db.uow.transaction((r) => r.jobs.claim('dono-lento', 10, LEASE_MS));

    const original = slow.service.processJob(job!, SYSTEM, { workerId: 'dono-lento', leaseMs: LEASE_MS });
    await sleep(900); // lease vencido; resposta original ainda pendente
    const [reclaim, swept] = await Promise.all([recoverer.worker.runOnce(), recoverer.service.recoverStaleInFlight(0)]);
    expect(reclaim.jobs + swept).toBeGreaterThanOrEqual(1);
    expect((await recoverer.service.getPayment(ctxA, created.payment.id)).payment.state).toBe('UNKNOWN');

    // A resposta original chega e resolve o UNKNOWN com evidência do provedor.
    await original;
    await sleep(100);
    const view = await recoverer.service.getPayment(ctxA, created.payment.id);
    expect(view.payment.state).toBe('APPROVED');
    expect(view.operations).toHaveLength(1);
    expect(['PROVIDER_RESPONSE', 'PROVIDER_NOTIFICATION']).toContain(view.operations[0]?.evidence?.source);
    // Um único envio ao provedor; a recuperação nunca reenviou.
    expect(slow.simulator.receivedCount() + recoverer.simulator.receivedCount()).toBe(1);
    expect(await count(ctxA.tenantId, opId, 'operation.dispatched')).toBe(1);
    // O dono lento perdeu a posse: não conclui a tarefa.
    expect(await db.uow.transaction((r) => r.jobs.complete(job!.id, 'dono-lento'))).toBe(false);
    expect(verifyAuditChain(await loadAuditChain(db.pool, ctxA.tenantId)).valid).toBe(true);
    slow.simulator.dispose();
    recoverer.simulator.dispose();
  });

  it('6. UNKNOWN: tarefa de consulta expirada é recuperada por outro worker, sem reenvio da cobrança', async () => {
    const ledger = createPgSimulatorLedger(db.pool);
    const first = testRuntime(db.uow, { workerId: 'primeiro', clock: skewed(+HOUR), ledger });
    const created = await first.service.createPayment(ctxA, { ...createCommand(), authorize: true, testDirective: 'TIMEOUT_AFTER_SEND' }, newKey());
    const opId = created.operations[0]!.id;
    await first.worker.runOnce();
    expect((await first.service.getPayment(ctxA, created.payment.id)).payment.state).toBe('UNKNOWN');

    // Um worker reivindica a CONSULTA e morre sem renovar.
    await sleep(2 * TEST_RECONCILE_DELAY_MS);
    const [reconcile] = await db.uow.transaction((r) => r.jobs.claim('consulta-morta', 10, LEASE_MS));
    expect(reconcile).toMatchObject({ kind: 'RECONCILE_OPERATION', operationId: opId });
    await sleep(PAST_LEASE_MS);

    // Outro worker, com relógio atrasado, recupera a tarefa vencida e resolve por consulta.
    const second = testRuntime(db.uow, { workerId: 'segundo-atrasado', clock: skewed(-HOUR), ledger });
    expect((await second.worker.runOnce()).jobs).toBe(1);
    const view = await second.service.getPayment(ctxA, created.payment.id);
    expect(view.payment.state).toBe('APPROVED');
    expect(view.operations).toHaveLength(1);
    expect(view.operations[0]?.evidence?.source).toBe('PROVIDER_QUERY');
    expect(await jobOf(opId, 'RECONCILE_OPERATION')).toMatchObject({ status: 'DONE', attempts: 2 });
    // A cobrança foi enviada uma única vez, pelo primeiro worker.
    expect(first.simulator.receivedCount() + second.simulator.receivedCount()).toBe(1);
    expect(await count(ctxA.tenantId, opId, 'operation.dispatched')).toBe(1);
    first.simulator.dispose();
    second.simulator.dispose();
  });
});
