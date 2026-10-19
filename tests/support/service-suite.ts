import { describe, expect, it } from 'vitest';
import {
  DuplicateReferenceError,
  IdempotencyConflictError,
  NotFoundError,
  ProviderMismatchError,
  ReconciliationRequiresManualActionError,
  type UnitOfWork,
} from '@tef/application';
import { AUDIT_DATA_ALLOWED_KEYS, verifyAuditChain, type AuditRecord } from '@tef/audit';
import {
  EvidenceRequiredError,
  InvalidTransitionError,
  money,
  OperationInProgressError,
  parseProviderId,
  RefundExceedsAvailableError,
  type PaymentId,
  type TenantId,
} from '@tef/domain';
import { DEFAULT_SIMULATOR_CAPABILITIES } from '@tef/provider-simulator';
import {
  ALL_SIM_CAPABILITIES,
  createCommand,
  createHarness,
  ctxA,
  ctxB,
  newKey,
  sleep,
  TENANT_A,
  type HarnessOptions,
} from './harness.ts';

export interface SuiteBackend {
  readonly name: string;
  /** Cria (ou reaproveita) a unidade de trabalho do backend. */
  readonly uow: () => UnitOfWork | Promise<UnitOfWork>;
  readonly auditFor: (tenantId: TenantId) => Promise<AuditRecord[]>;
  readonly outboxEventTypes: (paymentId: PaymentId) => Promise<string[]>;
}

/**
 * Suíte de comportamento do serviço, executada contra a persistência em memória
 * (tests/application) e contra o PostgreSQL real (tests/integration).
 */
export function describePaymentServiceSuite(backend: SuiteBackend): void {
  const harness = async (options: Omit<HarnessOptions, 'uow'> = {}) => createHarness({ ...options, uow: await backend.uow() });

  describe(`[${backend.name}] criação e idempotência`, () => {
    it('cria pagamento em CREATED com auditoria e evento no outbox', async () => {
      const h = await harness();
      const result = await h.service.createPayment(ctxA, createCommand(), newKey());
      expect(result.payment.state).toBe('CREATED');
      expect(result.replayed).toBe(false);
      const audit = await backend.auditFor(TENANT_A);
      expect(audit.some((r) => r.action === 'payment.created' && r.resourceId === result.payment.id)).toBe(true);
      expect(await backend.outboxEventTypes(result.payment.id)).toEqual(['payment.created']);
    });

    it('mesma chave e mesmo conteúdo: devolve o existente sem criar outro', async () => {
      const h = await harness();
      const key = newKey();
      const command = createCommand();
      const first = await h.service.createPayment(ctxA, command, key);
      const second = await h.service.createPayment(ctxA, { ...command }, key);
      expect(second.replayed).toBe(true);
      expect(second.payment.id).toBe(first.payment.id);
      expect(second.responseStatus).toBe(201);
      const audit = await backend.auditFor(TENANT_A);
      expect(audit.filter((r) => r.action === 'payment.created' && r.resourceId === first.payment.id)).toHaveLength(1);
    });

    it('mesma chave e conteúdo diferente: conflito', async () => {
      const h = await harness();
      const key = newKey();
      const command = createCommand(10_000);
      await h.service.createPayment(ctxA, command, key);
      await expect(h.service.createPayment(ctxA, { ...command, amount: money(10_001) }, key)).rejects.toBeInstanceOf(IdempotencyConflictError);
    });

    it('a chave é escopada por tenant', async () => {
      const h = await harness();
      const key = newKey();
      const a = await h.service.createPayment(ctxA, createCommand(), key);
      const b = await h.service.createPayment(ctxB, createCommand(), key);
      expect(a.payment.id).not.toBe(b.payment.id);
      expect(b.replayed).toBe(false);
    });

    it('mesma referência comercial com outra chave: bloqueada', async () => {
      const h = await harness();
      const command = createCommand();
      await h.service.createPayment(ctxA, command, newKey());
      await expect(h.service.createPayment(ctxA, command, newKey())).rejects.toBeInstanceOf(DuplicateReferenceError);
    });

    it('referência é liberada após recusa, mas continua protegida enquanto UNKNOWN', async () => {
      const h = await harness();
      h.scenario = { type: 'DECLINE' };
      const declinedCmd = createCommand();
      const declined = await h.service.createPayment(ctxA, declinedCmd, newKey());
      await h.service.authorize(ctxA, declined.payment.id, newKey());
      const retry = await h.service.createPayment(ctxA, declinedCmd, newKey());
      expect(retry.payment.id).not.toBe(declined.payment.id);

      h.scenario = { type: 'UNKNOWN_THEN_RECONCILED', hiddenOutcome: 'SUCCEEDED' };
      const unknownCmd = createCommand();
      const unknown = await h.service.createPayment(ctxA, unknownCmd, newKey());
      await h.service.authorize(ctxA, unknown.payment.id, newKey());
      await expect(h.service.createPayment(ctxA, unknownCmd, newKey())).rejects.toBeInstanceOf(DuplicateReferenceError);
    });

    it('concorrência: N criações simultâneas com a mesma chave geram UM pagamento', async () => {
      const h = await harness();
      const key = newKey();
      const command = createCommand();
      const results = await Promise.all(Array.from({ length: 10 }, () => h.service.createPayment(ctxA, command, key)));
      const ids = new Set(results.map((r) => r.payment.id));
      expect(ids.size).toBe(1);
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    });

    it('concorrência: N criações simultâneas com chaves diferentes e mesma referência geram UM pagamento', async () => {
      const h = await harness();
      const command = createCommand();
      const results = await Promise.allSettled(Array.from({ length: 10 }, () => h.service.createPayment(ctxA, command, newKey())));
      const ok = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(ok).toHaveLength(1);
      expect(rejected.every((r) => r.reason instanceof DuplicateReferenceError)).toBe(true);
    });
  });

  describe(`[${backend.name}] autorização e falhas`, () => {
    it('aprovação registra evidência da resposta do provedor', async () => {
      const h = await harness();
      const { payment } = await h.service.createPayment(ctxA, createCommand(), newKey());
      const result = await h.service.authorize(ctxA, payment.id, newKey());
      expect(result.payment.state).toBe('APPROVED');
      expect(result.operation.status).toBe('SUCCEEDED');
      expect(result.operation.evidence?.source).toBe('PROVIDER_RESPONSE');
      expect(result.operation.providerReference).toMatch(/^SIM-/);
    });

    it('recusa -> DECLINED', async () => {
      const h = await harness();
      h.scenario = { type: 'DECLINE' };
      const { payment } = await h.service.createPayment(ctxA, createCommand(), newKey());
      expect((await h.service.authorize(ctxA, payment.id, newKey())).payment.state).toBe('DECLINED');
    });

    it('timeout antes do envio -> CANCELLED (NOT_SENT) e nada chegou ao provedor', async () => {
      const h = await harness();
      h.scenario = { type: 'TIMEOUT_BEFORE_SEND' };
      const { payment } = await h.service.createPayment(ctxA, createCommand(), newKey());
      const result = await h.service.authorize(ctxA, payment.id, newKey());
      expect(result.payment.state).toBe('CANCELLED');
      expect(result.payment.stateReason).toBe('NOT_SENT_TO_PROVIDER');
      expect(h.simulator.receivedCount()).toBe(0);
    });

    it('timeout após envio -> UNKNOWN persistido; sem nova cobrança; reconciliação esclarece', async () => {
      const h = await harness({ providerTimeoutMs: 20 });
      h.scenario = { type: 'TIMEOUT_AFTER_SEND', hiddenOutcome: 'SUCCEEDED' };
      const command = createCommand();
      const { payment } = await h.service.createPayment(ctxA, command, newKey());
      const result = await h.service.authorize(ctxA, payment.id, newKey());
      expect(result.payment.state).toBe('UNKNOWN');
      expect(result.operation.status).toBe('UNKNOWN');
      expect(result.operation.resultCode).toBe('PROVIDER_TIMEOUT');

      // Persistido: uma nova leitura continua UNKNOWN.
      const reloaded = await h.service.getPayment(ctxA, payment.id);
      expect(reloaded.payment.state).toBe('UNKNOWN');

      // Proibido repetir a cobrança: nem nova autorização, nem novo pagamento para a mesma referência.
      h.scenario = { type: 'APPROVE' };
      await expect(h.service.authorize(ctxA, payment.id, newKey())).rejects.toBeInstanceOf(OperationInProgressError);
      await expect(h.service.createPayment(ctxA, command, newKey())).rejects.toBeInstanceOf(DuplicateReferenceError);
      expect(h.simulator.receivedCount()).toBe(1);

      const reconciled = await h.service.reconcileOperation(result.operation.id);
      expect(reconciled.resolved).toBe(true);
      expect(reconciled.payment.state).toBe('APPROVED');
      expect(reconciled.operation.evidence?.source).toBe('PROVIDER_QUERY');
      expect(h.simulator.receivedCount()).toBe(1);
    });

    it('falha de comunicação -> UNKNOWN; consulta revela recusa', async () => {
      const h = await harness();
      h.scenario = { type: 'COMMUNICATION_FAILURE', hiddenOutcome: 'REJECTED' };
      const { payment } = await h.service.createPayment(ctxA, createCommand(), newKey());
      const result = await h.service.authorize(ctxA, payment.id, newKey());
      expect(result.payment.state).toBe('UNKNOWN');
      expect(result.operation.resultCode).toBe('PROVIDER_CALL_FAILED');
      expect((await h.service.reconcileOperation(result.operation.id)).payment.state).toBe('DECLINED');
    });

    it('resposta atrasada (após o timeout) -> UNKNOWN, depois resolvido pela notificação', async () => {
      const h = await harness({ providerTimeoutMs: 20, forwardNotifications: true });
      h.scenario = { type: 'DELAYED_RESPONSE', delayMs: 80, outcome: 'SUCCEEDED' };
      const { payment } = await h.service.createPayment(ctxA, createCommand(), newKey());
      const result = await h.service.authorize(ctxA, payment.id, newKey());
      expect(result.payment.state).toBe('UNKNOWN');
      await sleep(250);
      const view = await h.service.getPayment(ctxA, payment.id);
      expect(view.payment.state).toBe('APPROVED');
      expect(view.operations[0]?.evidence?.source).toBe('PROVIDER_NOTIFICATION');
    });

    it('resposta duplicada não altera nada na segunda e terceira entrega', async () => {
      const h = await harness();
      h.scenario = { type: 'DUPLICATE_RESPONSE' };
      const { payment } = await h.service.createPayment(ctxA, createCommand(), newKey());
      const result = await h.service.authorize(ctxA, payment.id, newKey());
      expect(result.payment.state).toBe('APPROVED');
      const auditBefore = (await backend.auditFor(TENANT_A)).length;
      const notification = {
        providerId: result.payment.providerId,
        clientReference: result.operation.id,
        result: { status: 'SUCCEEDED' as const, providerReference: result.operation.providerReference!, requiresConfirmation: false },
      };
      expect(await h.service.handleProviderNotification(notification)).toEqual({ changed: false });
      expect(await h.service.handleProviderNotification(notification)).toEqual({ changed: false });
      expect((await backend.auditFor(TENANT_A)).length).toBe(auditBefore);
    });

    it('notificação contraditória é rejeitada e auditada', async () => {
      const h = await harness();
      const { payment } = await h.service.createPayment(ctxA, createCommand(), newKey());
      const result = await h.service.authorize(ctxA, payment.id, newKey());
      await expect(
        h.service.handleProviderNotification({
          providerId: result.payment.providerId,
          clientReference: result.operation.id,
          result: { status: 'REJECTED', resultCode: 'X' },
        }),
      ).rejects.toMatchObject({ code: 'CONFLICTING_EVIDENCE' });
      const audit = await backend.auditFor(TENANT_A);
      expect(audit.some((r) => r.action === 'operation.conflicting_evidence' && r.resourceId === result.operation.id)).toBe(true);
      expect((await h.service.getPayment(ctxA, payment.id)).payment.state).toBe('APPROVED');
    });

    it('notificação de outro provedor é rejeitada', async () => {
      const h = await harness();
      h.scenario = { type: 'UNKNOWN_THEN_RECONCILED', hiddenOutcome: 'SUCCEEDED' };
      const { payment } = await h.service.createPayment(ctxA, createCommand(), newKey());
      const result = await h.service.authorize(ctxA, payment.id, newKey());
      await expect(
        h.service.handleProviderNotification({
          providerId: parseProviderId('OUTRO-PROVEDOR'),
          clientReference: result.operation.id,
          result: { status: 'SUCCEEDED', providerReference: 'X' },
        }),
      ).rejects.toBeInstanceOf(ProviderMismatchError);
    });

    it('reconciliação: "não encontrado" definitivo cancela; não definitivo mantém UNKNOWN', async () => {
      const definitive = await harness({ capabilities: { ...DEFAULT_SIMULATOR_CAPABILITIES, guaranteesNotSentOnPreSendFailure: false } });
      definitive.scenario = { type: 'TIMEOUT_BEFORE_SEND' };
      const a = await definitive.service.createPayment(ctxA, createCommand(), newKey());
      const ra = await definitive.service.authorize(ctxA, a.payment.id, newKey());
      expect(ra.payment.state).toBe('UNKNOWN');
      const resolved = await definitive.service.reconcileOperation(ra.operation.id);
      expect(resolved.payment.state).toBe('CANCELLED');
      expect(resolved.operation.status).toBe('NOT_SENT');

      const notDefinitive = await harness({
        capabilities: { ...DEFAULT_SIMULATOR_CAPABILITIES, guaranteesNotSentOnPreSendFailure: false, queryNotFoundIsDefinitive: false },
      });
      notDefinitive.scenario = { type: 'TIMEOUT_BEFORE_SEND' };
      const b = await notDefinitive.service.createPayment(ctxA, createCommand(), newKey());
      const rb = await notDefinitive.service.authorize(ctxA, b.payment.id, newKey());
      const still = await notDefinitive.service.reconcileOperation(rb.operation.id);
      expect(still.resolved).toBe(false);
      expect(still.payment.state).toBe('UNKNOWN');
    });

    it('sem consulta: exige ação manual; resolução manual exige dupla aprovação', async () => {
      const h = await harness({ capabilities: { ...DEFAULT_SIMULATOR_CAPABILITIES, query: false, queryNotFoundIsDefinitive: false } });
      h.scenario = { type: 'UNKNOWN_THEN_RECONCILED', hiddenOutcome: 'SUCCEEDED' };
      const { payment } = await h.service.createPayment(ctxA, createCommand(), newKey());
      const result = await h.service.authorize(ctxA, payment.id, newKey());
      await expect(h.service.reconcileOperation(result.operation.id)).rejects.toBeInstanceOf(ReconciliationRequiresManualActionError);

      const operator = { ...ctxA, actor: { type: 'OPERATOR' as const, id: 'operador-a' } };
      await expect(
        h.service.resolveManually(operator, result.operation.id, 'SUCCEEDED', {
          resolvedBy: 'operador-a', approvedBy: 'operador-a', justification: 'extrato', supportingDocumentRef: 'CH-1',
        }),
      ).rejects.toBeInstanceOf(EvidenceRequiredError);

      const resolved = await h.service.resolveManually(operator, result.operation.id, 'SUCCEEDED', {
        resolvedBy: 'operador-a', approvedBy: 'operador-b', justification: 'extrato conferido', supportingDocumentRef: 'CH-1',
      });
      expect(resolved.payment.state).toBe('APPROVED');
      expect(resolved.operation.evidence?.source).toBe('MANUAL_RESOLUTION');
      const audit = await backend.auditFor(TENANT_A);
      const entry = audit.find((r) => r.resourceId === result.operation.id && r.data.evidenceSource === 'MANUAL_RESOLUTION');
      expect(entry?.data).toMatchObject({ resolvedBy: 'operador-a', approvedBy: 'operador-b', supportingDocumentRef: 'CH-1' });
    });

    it('autorização idempotente: mesma chave não reenvia ao provedor', async () => {
      const h = await harness();
      const { payment } = await h.service.createPayment(ctxA, createCommand(), newKey());
      const key = newKey();
      const first = await h.service.authorize(ctxA, payment.id, key);
      const second = await h.service.authorize(ctxA, payment.id, key);
      expect(second.replayed).toBe(true);
      expect(second.operation.id).toBe(first.operation.id);
      expect(h.simulator.receivedCount()).toBe(1);
    });

    it('concorrência: autorizações simultâneas geram UMA operação e UM envio', async () => {
      const h = await harness();
      const { payment } = await h.service.createPayment(ctxA, createCommand(), newKey());
      const sameKey = newKey();
      const results = await Promise.allSettled([
        ...Array.from({ length: 5 }, () => h.service.authorize(ctxA, payment.id, sameKey)),
        ...Array.from({ length: 5 }, () => h.service.authorize(ctxA, payment.id, newKey())),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(new Set(fulfilled.map((r) => r.operation.id)).size).toBe(1);
      expect(rejected.every((r) => r.reason instanceof OperationInProgressError || r.reason instanceof InvalidTransitionError)).toBe(true);
      expect(h.simulator.receivedCount()).toBe(1);
      expect((await h.service.getPayment(ctxA, payment.id)).operations).toHaveLength(1);
    });

    it('queda do processo durante o envio: recuperação marca UNKNOWN e não reenvia', async () => {
      const h = await harness({ providerTimeoutMs: 300 });
      h.scenario = { type: 'TIMEOUT_AFTER_SEND', hiddenOutcome: 'SUCCEEDED' };
      const { payment } = await h.service.createPayment(ctxA, createCommand(), newKey());
      const inFlight = h.service.authorize(ctxA, payment.id, newKey());
      await sleep(30);
      const during = await h.service.getPayment(ctxA, payment.id);
      expect(during.payment.state).toBe('PROCESSING');
      expect(during.operations[0]?.status).toBe('IN_FLIGHT');

      // Simula a retomada após a queda: outra instância roda a recuperação.
      h.clockMs += 120_000;
      expect(await h.service.recoverStaleInFlight(60_000)).toBe(1);
      expect((await h.service.getPayment(ctxA, payment.id)).payment.state).toBe('UNKNOWN');

      // A chamada original termina por timeout; o resultado UNKNOWN repetido não muda nada.
      const late = await inFlight;
      expect(late.payment.state).toBe('UNKNOWN');
      expect(h.simulator.receivedCount()).toBe(1);
    });

    it('resultado incompatível com as capacidades declaradas é tratado como UNKNOWN', async () => {
      const h = await harness(); // sem duas fases
      h.scenario = { type: 'APPROVE', requiresConfirmation: true };
      const { payment } = await h.service.createPayment(ctxA, createCommand(), newKey());
      const result = await h.service.authorize(ctxA, payment.id, newKey());
      expect(result.payment.state).toBe('UNKNOWN');
      expect(result.operation.resultCode).toBe('INCONSISTENT_PROVIDER_RESULT');
    });

    it('desistência antes do envio', async () => {
      const h = await harness();
      const { payment } = await h.service.createPayment(ctxA, createCommand(), newKey());
      expect((await h.service.cancelBeforeSubmission(ctxA, payment.id)).payment.state).toBe('CANCELLED');
      await expect(h.service.authorize(ctxA, payment.id, newKey())).rejects.toBeInstanceOf(InvalidTransitionError);
    });
  });

  describe(`[${backend.name}] confirmação, desfazimento, cancelamento e estornos`, () => {
    it('duas fases: AUTHORIZED -> confirmação -> APPROVED', async () => {
      const h = await harness({ capabilities: ALL_SIM_CAPABILITIES });
      h.scenario = { type: 'APPROVE', requiresConfirmation: true };
      const { payment } = await h.service.createPayment(ctxA, createCommand(), newKey());
      expect((await h.service.authorize(ctxA, payment.id, newKey())).payment.state).toBe('AUTHORIZED');
      h.scenario = { type: 'APPROVE' };
      const confirmed = await h.service.confirm(ctxA, payment.id, newKey());
      expect(confirmed.payment.state).toBe('APPROVED');
      expect(confirmed.operation.kind).toBe('CONFIRMATION');
    });

    it('duas fases: AUTHORIZED -> desfazimento -> REVERSED', async () => {
      const h = await harness({ capabilities: ALL_SIM_CAPABILITIES });
      h.scenario = { type: 'APPROVE', requiresConfirmation: true };
      const { payment } = await h.service.createPayment(ctxA, createCommand(), newKey());
      await h.service.authorize(ctxA, payment.id, newKey());
      h.scenario = { type: 'APPROVE' };
      const undone = await h.service.undo(ctxA, payment.id, newKey());
      expect(undone.payment.state).toBe('REVERSED');
      expect(undone.operation.kind).toBe('UNDO');
    });

    it('cancelamento total -> REVERSED', async () => {
      const h = await harness();
      const { payment } = await h.service.createPayment(ctxA, createCommand(), newKey());
      await h.service.authorize(ctxA, payment.id, newKey());
      const cancelled = await h.service.cancel(ctxA, payment.id, newKey());
      expect(cancelled.payment.state).toBe('REVERSED');
      expect(cancelled.operation.kind).toBe('CANCELLATION');
      expect(cancelled.payment.reversedAmount.cents).toBe(10_000);
    });

    it('estornos parciais e total, com saldo contabilizado', async () => {
      const h = await harness();
      const { payment } = await h.service.createPayment(ctxA, createCommand(10_000), newKey());
      await h.service.authorize(ctxA, payment.id, newKey());
      const r1 = await h.service.refund(ctxA, payment.id, money(3_000), newKey());
      expect(r1.payment.state).toBe('APPROVED');
      expect(r1.payment.reversedAmount.cents).toBe(3_000);
      await expect(h.service.refund(ctxA, payment.id, money(7_001), newKey())).rejects.toBeInstanceOf(RefundExceedsAvailableError);
      const r2 = await h.service.refund(ctxA, payment.id, money(7_000), newKey());
      expect(r2.payment.state).toBe('REVERSED');
      expect(r2.operations.filter((o) => o.kind === 'REFUND')).toHaveLength(2);
    });

    it('estorno idempotente pela chave', async () => {
      const h = await harness();
      const { payment } = await h.service.createPayment(ctxA, createCommand(10_000), newKey());
      await h.service.authorize(ctxA, payment.id, newKey());
      const key = newKey();
      await h.service.refund(ctxA, payment.id, money(1_000), key);
      const replay = await h.service.refund(ctxA, payment.id, money(1_000), key);
      expect(replay.replayed).toBe(true);
      expect(replay.payment.reversedAmount.cents).toBe(1_000);
      await expect(h.service.refund(ctxA, payment.id, money(2_000), key)).rejects.toBeInstanceOf(IdempotencyConflictError);
    });

    it('estorno com resultado desconhecido bloqueia o próximo até a reconciliação', async () => {
      const h = await harness();
      const { payment } = await h.service.createPayment(ctxA, createCommand(10_000), newKey());
      await h.service.authorize(ctxA, payment.id, newKey());
      h.scenario = { type: 'UNKNOWN_THEN_RECONCILED', hiddenOutcome: 'SUCCEEDED' };
      const r1 = await h.service.refund(ctxA, payment.id, money(1_000), newKey());
      expect(r1.operation.status).toBe('UNKNOWN');
      expect(r1.payment.reversedAmount.cents).toBe(0);
      h.scenario = { type: 'APPROVE' };
      await expect(h.service.refund(ctxA, payment.id, money(1_000), newKey())).rejects.toBeInstanceOf(OperationInProgressError);
      const reconciled = await h.service.reconcileOperation(r1.operation.id);
      expect(reconciled.payment.reversedAmount.cents).toBe(1_000);
      expect((await h.service.refund(ctxA, payment.id, money(1_000), newKey())).payment.reversedAmount.cents).toBe(2_000);
    });
  });

  describe(`[${backend.name}] isolamento e auditoria`, () => {
    it('outro tenant não lê nem opera o pagamento', async () => {
      const h = await harness();
      const { payment } = await h.service.createPayment(ctxA, createCommand(), newKey());
      await expect(h.service.getPayment(ctxB, payment.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(h.service.authorize(ctxB, payment.id, newKey())).rejects.toBeInstanceOf(NotFoundError);
      await expect(h.service.refund(ctxB, payment.id, money(1), newKey())).rejects.toBeInstanceOf(NotFoundError);
      expect(h.simulator.receivedCount()).toBe(0);
    });

    it('a cadeia de auditoria do tenant é válida e não contém dados sensíveis', async () => {
      const h = await harness();
      const { payment } = await h.service.createPayment(ctxA, createCommand(), newKey());
      await h.service.authorize(ctxA, payment.id, newKey());
      await h.service.refund(ctxA, payment.id, money(500), newKey());
      const audit = await backend.auditFor(TENANT_A);
      expect(verifyAuditChain(audit).valid).toBe(true);
      const serialized = JSON.stringify(audit.map((r) => r.data));
      expect(serialized).not.toMatch(/\b\d{13,19}\b/);
      const keys = new Set(audit.flatMap((r) => Object.keys(r.data)));
      for (const key of keys) expect(AUDIT_DATA_ALLOWED_KEYS).toContain(key);
      expect(audit.some((r) => r.action === 'payment.balance_changed')).toBe(true);
      expect(await backend.outboxEventTypes(payment.id)).toContain('payment.state_changed');
    });
  });
}
