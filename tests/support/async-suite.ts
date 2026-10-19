import { describe, expect, it } from 'vitest';
import type { UnitOfWork } from '@tef/application';
import { markDispatched, money, type PaymentState, type TenantId } from '@tef/domain';
import { SIMULATOR_DIRECTIVES, type SimulatorDirective } from '@tef/provider-simulator';
import { newClock, TEST_RECONCILE_DELAY_MS, testRuntime } from './async.ts';
import { createCommand, ctxA, newKey, sleep } from './harness.ts';

export interface AsyncBackend {
  readonly name: string;
  /** Unidade de trabalho; em memória, a fila usa `clock` como relógio (no PostgreSQL, o do banco). */
  readonly uow: (clock: { ms: number }) => Promise<UnitOfWork>;
  /**
   * Faz o tempo DA FILA passar `ms` (ADR 0019). Em memória: avança o relógio injetado.
   * No PostgreSQL, cujo relógio é `clock_timestamp()`, espera de verdade (e avança também
   * o relógio do processo, para os fatos de negócio continuarem coerentes).
   */
  readonly advanceQueue: (clock: { ms: number }, ms: number) => Promise<void>;
  /** Quantas vezes a operação foi marcada como enviada (auditoria). */
  readonly dispatchCount: (tenantId: TenantId, operationId: string) => Promise<number>;
  /** Quantas vezes um resultado foi registrado para a operação (auditoria). */
  readonly resultCount: (tenantId: TenantId, operationId: string) => Promise<number>;
}

/**
 * Leases curtos nos testes que fazem o lease expirar: no PostgreSQL o tempo da fila é real
 * (`clock_timestamp()`), então os prazos são de centenas de milissegundos, com folga de
 * 200 ms entre cada verificação e o vencimento.
 */
const SHORT_LEASE_MS = 600;
const PAST_SHORT_LEASE_MS = 800;
const RECONCILE_WAIT_MS = 3 * TEST_RECONCILE_DELAY_MS;

/** Comportamento do modelo assíncrono (API aceita, worker executa), em memória e no PostgreSQL. */
export function describeAsyncSuite(backend: AsyncBackend): void {
  describe(`[${backend.name}] criação assíncrona e worker`, () => {
    it('criação com autorização grava pagamento, operação PENDING e tarefa; nada vai ao provedor antes do worker', async () => {
      const clock = newClock();
      const uow = await backend.uow(clock);
      const rt = testRuntime(uow, { clock });
      const created = await rt.service.createPayment(ctxA, { ...createCommand(), authorize: true }, newKey());
      expect(created.responseStatus).toBe(202);
      expect(created.payment.state).toBe('PROCESSING');
      expect(created.operations[0]?.status).toBe('PENDING');
      expect(rt.simulator.receivedCount()).toBe(0);
      const jobs = await uow.transaction((r) => r.jobs.listByPayment(ctxA.tenantId, created.payment.id));
      expect(jobs).toMatchObject([{ kind: 'EXECUTE_OPERATION', status: 'PENDING' }]);

      const run = await rt.worker.runOnce();
      expect(run.jobs).toBe(1);
      const view = await rt.service.getPayment(ctxA, created.payment.id);
      expect(view.payment.state).toBe('APPROVED');
      expect(rt.simulator.receivedCount()).toBe(1);
      const after = await uow.transaction((r) => r.jobs.listByPayment(ctxA.tenantId, created.payment.id));
      expect(after[0]?.status).toBe('DONE');
      expect(await backend.dispatchCount(ctxA.tenantId, view.operations[0]!.id)).toBe(1);
    });

    it('repetição da criação (mesma chave) não cria segunda tarefa nem segundo envio', async () => {
      const clock = newClock();
      const uow = await backend.uow(clock);
      const rt = testRuntime(uow, { clock });
      const key = newKey();
      const command = { ...createCommand(), authorize: true };
      const first = await rt.service.createPayment(ctxA, command, key);
      const again = await rt.service.createPayment(ctxA, command, key);
      expect(again.replayed).toBe(true);
      expect(again.responseStatus).toBe(202);
      expect(await uow.transaction((r) => r.jobs.listByPayment(ctxA.tenantId, first.payment.id))).toHaveLength(1);
      await rt.worker.runOnce();
      expect(rt.simulator.receivedCount()).toBe(1);
    });

    it('tarefa entregue duas vezes: a segunda execução não reenvia', async () => {
      const clock = newClock();
      const uow = await backend.uow(clock);
      const rt = testRuntime(uow, { clock });
      const created = await rt.service.createPayment(ctxA, { ...createCommand(), authorize: true }, newKey());
      const [job] = await uow.transaction((r) => r.jobs.claim('worker-a', 10, 5_000));
      expect(job).toBeDefined();
      const actor = { type: 'SYSTEM' as const, id: 'test' };
      const lease = { workerId: 'worker-a', leaseMs: 5_000 };
      expect(await rt.service.processJob(job!, actor, lease)).toMatchObject({ kind: 'DONE', detail: 'SUCCEEDED' });
      expect(await rt.service.processJob(job!, actor, lease)).toMatchObject({ kind: 'DONE', detail: 'ALREADY_SUCCEEDED' });
      expect(rt.simulator.receivedCount()).toBe(1);
      expect((await rt.service.getPayment(ctxA, created.payment.id)).payment.state).toBe('APPROVED');
    });

    it('worker cai ANTES do envio: o lease expira, outro worker assume e envia uma única vez', async () => {
      const clock = newClock();
      const uow = await backend.uow(clock);
      const a = testRuntime(uow, { workerId: 'worker-a', clock });
      const b = testRuntime(uow, { workerId: 'worker-b', clock });
      const created = await a.service.createPayment(ctxA, { ...createCommand(), authorize: true }, newKey());
      const claimed = await uow.transaction((r) => r.jobs.claim('worker-a', 10, SHORT_LEASE_MS));
      expect(claimed).toHaveLength(1);
      // worker-a "morre" aqui. Antes do lease expirar, ninguém pega a tarefa:
      expect((await b.worker.runOnce()).jobs).toBe(0);
      await backend.advanceQueue(clock, PAST_SHORT_LEASE_MS);
      expect((await b.worker.runOnce()).jobs).toBe(1);
      expect((await b.service.getPayment(ctxA, created.payment.id)).payment.state).toBe('APPROVED');
      expect(a.simulator.receivedCount() + b.simulator.receivedCount()).toBe(1);
      const [job] = await uow.transaction((r) => r.jobs.listByPayment(ctxA.tenantId, created.payment.id));
      expect(job).toMatchObject({ status: 'DONE', attempts: 2 });
      // Fencing: o worker antigo não consegue concluir uma tarefa que já não é dele.
      expect(await uow.transaction((r) => r.jobs.complete(job!.id, 'worker-a'))).toBe(false);
    });

    it('fencing: worker com lease expirado e tarefa reassumida não envia nem altera a operação', async () => {
      const clock = newClock();
      const uow = await backend.uow(clock);
      const a = testRuntime(uow, { workerId: 'worker-a', clock });
      const b = testRuntime(uow, { workerId: 'worker-b', clock });
      const created = await a.service.createPayment(ctxA, { ...createCommand(), authorize: true }, newKey());
      const [jobA] = await uow.transaction((r) => r.jobs.claim('worker-a', 10, SHORT_LEASE_MS));
      // worker-a "congela"; o lease expira e worker-b reassume a tarefa.
      await backend.advanceQueue(clock, PAST_SHORT_LEASE_MS);
      const [jobB] = await uow.transaction((r) => r.jobs.claim('worker-b', 10, 2_000));
      expect(jobB?.id).toBe(jobA?.id);

      // worker-a volta: não pode enviar nem marcar nada.
      const stale = await a.service.processJob(jobA!, { type: 'SYSTEM', id: 'worker:worker-a' }, { workerId: 'worker-a', leaseMs: 2_000 });
      expect(stale).toEqual({ kind: 'LOST_LEASE' });
      expect(a.simulator.receivedCount()).toBe(0);
      expect((await a.service.getPayment(ctxA, created.payment.id)).operations[0]?.status).toBe('PENDING');

      // O dono atual processa normalmente: um único envio.
      const owner = await b.service.processJob(jobB!, { type: 'SYSTEM', id: 'worker:worker-b' }, { workerId: 'worker-b', leaseMs: 2_000 });
      expect(owner).toMatchObject({ kind: 'DONE', detail: 'SUCCEEDED' });
      expect(a.simulator.receivedCount() + b.simulator.receivedCount()).toBe(1);
      expect(await backend.dispatchCount(ctxA.tenantId, created.operations[0]!.id)).toBe(1);
    });

    it('lease é renovado no início do processamento (posse estendida a partir de agora)', async () => {
      const clock = newClock();
      const uow = await backend.uow(clock);
      const rt = testRuntime(uow, { workerId: 'worker-r', clock });
      await rt.service.createPayment(ctxA, { ...createCommand(), authorize: true }, newKey());
      const [job] = await uow.transaction((r) => r.jobs.claim('worker-r', 10, SHORT_LEASE_MS));
      await backend.advanceQueue(clock, 300); // ainda dentro do lease original (600)
      expect(await uow.transaction((r) => r.jobs.renewLease(job!.id, 'worker-r', SHORT_LEASE_MS))).toBe(true); // vence em ~900
      await backend.advanceQueue(clock, 400); // ~700: passaria do lease original, mas não do renovado
      expect(await uow.transaction((r) => r.jobs.claim('intruso', 10, 2_000))).toHaveLength(0);
      await backend.advanceQueue(clock, 400); // ~1100: agora expirou
      // Renovação não ressuscita lease vencido, e conclusão após o vencimento é recusada.
      expect(await uow.transaction((r) => r.jobs.renewLease(job!.id, 'worker-r', SHORT_LEASE_MS))).toBe(false);
      expect(await uow.transaction((r) => r.jobs.complete(job!.id, 'worker-r'))).toBe(false);
      // Limpeza: o lease expirado é retomado e a tarefa é processada (não deixa trabalho para outros testes).
      await rt.worker.runOnce();
    });

    it('worker cai DEPOIS do envio: operação vira UNKNOWN, nunca é reenviada, e a consulta resolve', async () => {
      const clock = newClock();
      const uow = await backend.uow(clock);
      const rt = testRuntime(uow, { workerId: 'worker-b', clock });
      const created = await rt.service.createPayment(ctxA, { ...createCommand(), authorize: true }, newKey());
      // Simula o worker-a: reivindica, marca IN_FLIGHT e cai antes de registrar o resultado.
      await uow.transaction((r) => r.jobs.claim('worker-a', 10, SHORT_LEASE_MS));
      await uow.transaction(async (r) => {
        const op = await r.operations.findById(ctxA.tenantId, created.operations[0]!.id);
        await r.operations.update(markDispatched(op!, rt.simulator.capabilities, new Date(clock.ms)), op!.version);
      });
      await backend.advanceQueue(clock, PAST_SHORT_LEASE_MS);
      await rt.worker.runOnce();
      let view = await rt.service.getPayment(ctxA, created.payment.id);
      expect(view.payment.state).toBe('UNKNOWN');
      expect(view.operations[0]?.resultCode).toBe('WORKER_INTERRUPTED_AFTER_DISPATCH');
      // Não reenviou ESTA operação (o envio simulado do worker-a não passou pelo serviço, logo não há registro de despacho).
      expect(await backend.dispatchCount(ctxA.tenantId, created.operations[0]!.id)).toBe(0);
      const jobs = await uow.transaction((r) => r.jobs.listByPayment(ctxA.tenantId, created.payment.id));
      expect(jobs.map((j) => `${j.kind}:${j.status}`)).toEqual(['EXECUTE_OPERATION:DONE', 'RECONCILE_OPERATION:PENDING']);

      // Reconciliação: o provedor (simulado) nunca recebeu -> "não encontrado" definitivo -> CANCELLED.
      await backend.advanceQueue(clock, RECONCILE_WAIT_MS);
      await rt.worker.runOnce();
      view = await rt.service.getPayment(ctxA, created.payment.id);
      expect(view.payment.state).toBe('CANCELLED');
      expect(view.operations[0]?.evidence?.source).toBe('PROVIDER_QUERY');
      expect(await backend.dispatchCount(ctxA.tenantId, created.operations[0]!.id)).toBe(0);
    });

    it('UNKNOWN após envio: o worker só consulta (sem nova cobrança) até resolver', async () => {
      const clock = newClock();
      const uow = await backend.uow(clock);
      const rt = testRuntime(uow, { clock });
      const created = await rt.service.createPayment(ctxA, { ...createCommand(), authorize: true, testDirective: 'TIMEOUT_AFTER_SEND' }, newKey());
      await rt.worker.runOnce();
      expect((await rt.service.getPayment(ctxA, created.payment.id)).payment.state).toBe('UNKNOWN');
      // Uma nova autorização conflitante é recusada enquanto houver UNKNOWN.
      await expect(rt.service.requestOperation(ctxA, created.payment.id, 'AUTHORIZATION', undefined, newKey())).rejects.toMatchObject({
        code: 'OPERATION_IN_PROGRESS',
      });
      await backend.advanceQueue(rt.clock, RECONCILE_WAIT_MS);
      await rt.worker.runOnce();
      const view = await rt.service.getPayment(ctxA, created.payment.id);
      expect(view.payment.state).toBe('APPROVED');
      expect(view.operations).toHaveLength(1);
      expect(rt.simulator.receivedCount()).toBe(1);
    });

    it('reconciliação e resposta original concorrentes: um único resultado registrado, sem conflito', async () => {
      const clock = newClock();
      const uow = await backend.uow(clock);
      const rt = testRuntime(uow, { clock });
      const created = await rt.service.createPayment(ctxA, { ...createCommand(), authorize: true, testDirective: 'UNKNOWN_THEN_RECONCILED' }, newKey());
      await rt.worker.runOnce();
      const view = await rt.service.getPayment(ctxA, created.payment.id);
      const op = view.operations[0]!;
      expect(op.status).toBe('UNKNOWN');
      const ledger = await rt.simulator.query!({ kind: 'AUTHORIZATION', clientReference: op.id, terminalId: view.payment.terminalId }, new AbortController().signal);
      if (ledger.status !== 'FOUND') throw new Error('livro do simulador deveria conhecer a operação');
      const late = { providerId: view.payment.providerId, clientReference: op.id, result: { status: 'SUCCEEDED' as const, providerReference: ledger.providerReference } };
      const results = await Promise.allSettled([
        rt.service.reconcileOperation(op.id),
        rt.service.handleProviderNotification(late),
        rt.service.handleProviderNotification(late),
      ]);
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      const final = await rt.service.getPayment(ctxA, created.payment.id);
      expect(final.payment.state).toBe('APPROVED');
      // dispatch + UNKNOWN + um único resultado definitivo
      expect(await backend.resultCount(ctxA.tenantId, op.id)).toBe(2);
      expect(rt.simulator.receivedCount()).toBe(1);
    });

    it('operações solicitadas pela API (estorno, cancelamento) também passam pela fila', async () => {
      const clock = newClock();
      const uow = await backend.uow(clock);
      const rt = testRuntime(uow, { clock });
      const created = await rt.service.createPayment(ctxA, { ...createCommand(10_000), authorize: true }, newKey());
      await rt.worker.runOnce();
      const refund = await rt.service.requestOperation(ctxA, created.payment.id, 'REFUND', money(4_000), newKey());
      expect(refund).toMatchObject({ responseStatus: 202, operation: { kind: 'REFUND', status: 'PENDING' } });
      await rt.worker.runOnce();
      let view = await rt.service.getPayment(ctxA, created.payment.id);
      expect(view.payment).toMatchObject({ state: 'APPROVED', reversedAmount: { cents: 4_000 } });
      await expect(rt.service.requestOperation(ctxA, created.payment.id, 'CANCELLATION', undefined, newKey())).rejects.toMatchObject({
        code: 'INVALID_TRANSITION',
      });
      await rt.service.requestOperation(ctxA, created.payment.id, 'REFUND', money(6_000), newKey());
      await rt.worker.runOnce();
      view = await rt.service.getPayment(ctxA, created.payment.id);
      expect(view.payment.state).toBe('REVERSED');
    });

    it('outbox: publica cada evento uma vez; falha do destino agenda nova tentativa sem perder o evento', async () => {
      const clock = newClock();
      const uow = await backend.uow(clock);
      const rt = testRuntime(uow, { clock });
      const created = await rt.service.createPayment(ctxA, { ...createCommand(), authorize: true }, newKey());
      rt.sink.failNext = 1;
      await rt.worker.runOnce();
      const mine = () => rt.sink.delivered.filter((e) => e.aggregateId === created.payment.id).map((e) => e.eventType);
      const firstPass = mine();
      // Um evento falhou e continua pendente.
      rt.clock.ms += 60_000;
      await rt.worker.runOnce();
      await rt.worker.runOnce();
      const all = mine();
      expect(all.length).toBeGreaterThan(firstPass.length);
      expect(all.filter((t) => t === 'payment.created')).toHaveLength(1);
      expect(new Set(rt.sink.delivered.map((e) => e.id)).size).toBe(rt.sink.delivered.length);
      expect(await uow.transaction((r) => r.outbox.countUnpublished())).toBe(0);
    });

    it('encerramento gracioso registra STOPPED no batimento', async () => {
      const clock = newClock();
      const uow = await backend.uow(clock);
      const rt = testRuntime(uow, { workerId: `worker-stop-${Date.now()}`, clock });
      rt.worker.start();
      await sleep(30);
      await rt.worker.stop();
      const beats = await uow.transaction((r) => r.heartbeats.list());
      expect(beats.find((b) => b.workerId === rt.worker.health().workerId)?.status).toBe('STOPPED');
      expect(rt.worker.health().status).toBe('STOPPED');
    });
  });

  describe(`[${backend.name}] cenários do simulador (dados fictícios) ponta a ponta`, () => {
    const expected: Record<SimulatorDirective, { first: PaymentState; final: PaymentState; sent: number }> = {
      APPROVE: { first: 'APPROVED', final: 'APPROVED', sent: 1 },
      DECLINE: { first: 'DECLINED', final: 'DECLINED', sent: 1 },
      ABORT_AT_TERMINAL: { first: 'CANCELLED', final: 'CANCELLED', sent: 1 },
      TIMEOUT_BEFORE_SEND: { first: 'CANCELLED', final: 'CANCELLED', sent: 0 },
      TIMEOUT_AFTER_SEND: { first: 'UNKNOWN', final: 'APPROVED', sent: 1 },
      COMMUNICATION_FAILURE: { first: 'UNKNOWN', final: 'DECLINED', sent: 1 },
      DELAYED_RESPONSE: { first: 'UNKNOWN', final: 'APPROVED', sent: 1 },
      DUPLICATE_RESPONSE: { first: 'APPROVED', final: 'APPROVED', sent: 1 },
      UNKNOWN_THEN_RECONCILED: { first: 'UNKNOWN', final: 'APPROVED', sent: 1 },
    };

    it('o catálogo de cenários testados cobre todas as diretivas', () => {
      expect(Object.keys(expected).sort()).toEqual(Object.keys(SIMULATOR_DIRECTIVES).sort());
    });

    for (const directive of Object.keys(expected) as SimulatorDirective[]) {
      it(`${directive}: ${SIMULATOR_DIRECTIVES[directive].expected}`, async () => {
        const clock = newClock();
        const uow = await backend.uow(clock);
        const rt = testRuntime(uow, { clock });
        const created = await rt.service.createPayment(ctxA, { ...createCommand(), authorize: true, testDirective: directive }, newKey());
        await rt.worker.runOnce();
        const first = await rt.service.getPayment(ctxA, created.payment.id);
        expect(first.payment.state).toBe(expected[directive].first);

        // Deixa notificações atrasadas chegarem e roda a reconciliação agendada.
        await sleep(250);
        await backend.advanceQueue(rt.clock, RECONCILE_WAIT_MS);
        await rt.worker.runOnce();
        const final = await rt.service.getPayment(ctxA, created.payment.id);
        expect(final.payment.state).toBe(expected[directive].final);
        expect(final.operations).toHaveLength(1); // nenhuma operação extra: sem cobrança duplicada
        expect(rt.simulator.receivedCount()).toBe(expected[directive].sent);
        expect(await backend.dispatchCount(ctxA.tenantId, final.operations[0]!.id)).toBe(1);
        rt.simulator.dispose();
      });
    }
  });
}
