import type { ActorType, AuditData } from '@tef/audit';
import {
  applyOperationOutcome,
  cancelBeforeSubmission,
  CapabilityNotSupportedError,
  ConflictingEvidenceError,
  createPayment,
  EvidenceRequiredError,
  FINAL_OPERATION_STATUSES,
  markDispatched,
  planOperation,
  type Evidence,
  type ManualResolution,
  type MerchantId,
  type Money,
  type Operation,
  type OperationId,
  type OperationKind,
  type OperationOutcome,
  type Payment,
  type PaymentId,
  type ProviderId,
  type TenantId,
  type TerminalId,
} from '@tef/domain';
import type {
  PaymentProvider,
  ProviderNotification,
  ProviderOperationResult,
  ProviderRegistry,
} from '@tef/provider-contract';
import {
  IdempotencyConflictError,
  NotFoundError,
  ProviderMismatchError,
  ReconciliationRequiresManualActionError,
} from './errors.ts';
import { DEFAULT_IDEMPOTENCY_TTL_MS, requestHash } from './idempotency.ts';
import { INVALID_PROVIDER_CODE, safeProviderCode, safeProviderReference } from './provider-output.ts';
import { NOOP_LOGGER, type AppLogger, type IdempotencyRecord, type Repositories, type UnitOfWork } from './ports.ts';

export interface Actor {
  readonly type: ActorType;
  readonly id: string;
}

export interface RequestContext {
  readonly tenantId: TenantId;
  readonly actor: Actor;
  readonly correlationId: string | null;
}

export interface CreatePaymentCommand {
  readonly merchantId: MerchantId;
  readonly terminalId: TerminalId;
  readonly externalReference: string;
  readonly amount: Money;
  readonly providerId: ProviderId;
}

export interface PaymentView {
  readonly payment: Payment;
  readonly operations: readonly Operation[];
}

export interface CommandResult extends PaymentView {
  readonly replayed: boolean;
  readonly responseStatus: number;
}

export interface OperationCommandResult extends CommandResult {
  readonly operation: Operation;
}

export interface ReconciliationResult {
  readonly resolved: boolean;
  readonly payment: Payment;
  readonly operation: Operation;
}

export interface PaymentServiceDeps {
  readonly uow: UnitOfWork;
  readonly providers: ProviderRegistry;
  readonly providerTimeoutMs: number;
  readonly clock?: () => Date;
  readonly idempotencyTtlMs?: number;
  readonly logger?: AppLogger;
}

const SYSTEM_RECONCILER: Actor = { type: 'SYSTEM', id: 'reconciler' };
const SYSTEM_RECOVERY: Actor = { type: 'SYSTEM', id: 'recovery' };
const SYSTEM_NOTIFICATIONS: Actor = { type: 'SYSTEM', id: 'provider-notifications' };

/**
 * Casos de uso do ciclo de vida de pagamentos. Princípios:
 *  - a intenção é gravada (PROCESSING / IN_FLIGHT) ANTES de chamar o provedor;
 *  - falta de resposta vira UNKNOWN, nunca "falhou";
 *  - UNKNOWN nunca é reenviado automaticamente: só consulta, notificação,
 *    conciliação ou resolução manual com evidência podem resolvê-lo.
 */
export class PaymentService {
  private readonly uow: UnitOfWork;
  private readonly providers: ProviderRegistry;
  private readonly providerTimeoutMs: number;
  private readonly clock: () => Date;
  private readonly idempotencyTtlMs: number;
  private readonly logger: AppLogger;

  constructor(deps: PaymentServiceDeps) {
    this.uow = deps.uow;
    this.providers = deps.providers;
    this.providerTimeoutMs = deps.providerTimeoutMs;
    this.clock = deps.clock ?? (() => new Date());
    this.idempotencyTtlMs = deps.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS;
    this.logger = deps.logger ?? NOOP_LOGGER;
  }

  // -------------------------------------------------------------------------
  // Consultas
  // -------------------------------------------------------------------------

  async getPayment(ctx: RequestContext, paymentId: PaymentId): Promise<PaymentView> {
    return this.uow.transaction(async (repos) => {
      const payment = await repos.payments.findById(ctx.tenantId, paymentId);
      if (!payment) throw new NotFoundError('pagamento não encontrado');
      return { payment, operations: await repos.operations.listByPayment(ctx.tenantId, paymentId) };
    });
  }

  // -------------------------------------------------------------------------
  // Criação (sem contato com o provedor)
  // -------------------------------------------------------------------------

  async createPayment(ctx: RequestContext, command: CreatePaymentCommand, idempotencyKey: string): Promise<CommandResult> {
    const now = this.clock();
    const scope = 'payments.create';
    const hash = requestHash(scope, {
      merchantId: command.merchantId,
      terminalId: command.terminalId,
      externalReference: command.externalReference,
      amountCents: command.amount.cents,
      currency: command.amount.currency,
      providerId: command.providerId,
    });
    // Garante que o provedor existe antes de gravar qualquer coisa.
    this.providers.get(command.providerId);
    const candidate = createPayment({ tenantId: ctx.tenantId, ...command }, now);

    return this.uow.transaction(async (repos) => {
      const claim = await repos.idempotency.claim(
        this.idempotencyRecord(ctx, command.merchantId, scope, idempotencyKey, hash, 'payment', candidate.id, 201, now),
      );
      if (!claim.claimed) {
        const existing = this.assertSameRequest(claim.existing, hash);
        const payment = await repos.payments.findById(ctx.tenantId, existing.resourceId as PaymentId);
        if (!payment) throw new NotFoundError('pagamento da chave de idempotência não encontrado');
        return {
          payment,
          operations: await repos.operations.listByPayment(ctx.tenantId, payment.id),
          replayed: true,
          responseStatus: existing.responseStatus,
        };
      }

      await repos.payments.insert(candidate);
      await this.audit(repos, ctx, 'payment.created', 'payment', candidate.id, now, {
        toState: candidate.state,
        amountCents: candidate.amount.cents,
        currency: candidate.amount.currency,
        merchantId: candidate.merchantId,
        terminalId: candidate.terminalId,
        externalReference: candidate.externalReference,
        providerId: candidate.providerId,
      });
      await this.emit(repos, candidate, 'payment.created', now);
      return { payment: candidate, operations: [], replayed: false, responseStatus: 201 };
    });
  }

  /** Desistência antes de qualquer envio ao provedor (CREATED -> CANCELLED). */
  async cancelBeforeSubmission(ctx: RequestContext, paymentId: PaymentId): Promise<PaymentView> {
    const now = this.clock();
    return this.uow.transaction(async (repos) => {
      const payment = await this.lockPayment(repos, ctx.tenantId, paymentId);
      const provider = this.providers.get(payment.providerId);
      const next = cancelBeforeSubmission(payment, provider.capabilities, now);
      await repos.payments.update(next, payment.version);
      await this.auditPaymentTransition(repos, ctx, payment, next, now);
      await this.emit(repos, next, 'payment.state_changed', now);
      return { payment: next, operations: await repos.operations.listByPayment(ctx.tenantId, paymentId) };
    });
  }

  // -------------------------------------------------------------------------
  // Operações junto ao provedor
  // -------------------------------------------------------------------------

  authorize(ctx: RequestContext, paymentId: PaymentId, idempotencyKey: string): Promise<OperationCommandResult> {
    return this.executeOperation(ctx, paymentId, 'AUTHORIZATION', undefined, idempotencyKey);
  }

  confirm(ctx: RequestContext, paymentId: PaymentId, idempotencyKey: string): Promise<OperationCommandResult> {
    return this.executeOperation(ctx, paymentId, 'CONFIRMATION', undefined, idempotencyKey);
  }

  undo(ctx: RequestContext, paymentId: PaymentId, idempotencyKey: string): Promise<OperationCommandResult> {
    return this.executeOperation(ctx, paymentId, 'UNDO', undefined, idempotencyKey);
  }

  cancel(ctx: RequestContext, paymentId: PaymentId, idempotencyKey: string): Promise<OperationCommandResult> {
    return this.executeOperation(ctx, paymentId, 'CANCELLATION', undefined, idempotencyKey);
  }

  refund(ctx: RequestContext, paymentId: PaymentId, amount: Money, idempotencyKey: string): Promise<OperationCommandResult> {
    return this.executeOperation(ctx, paymentId, 'REFUND', amount, idempotencyKey);
  }

  private async executeOperation(
    ctx: RequestContext,
    paymentId: PaymentId,
    kind: OperationKind,
    amount: Money | undefined,
    idempotencyKey: string,
  ): Promise<OperationCommandResult> {
    const now = this.clock();
    const scope = `payments.operation.${kind}`;
    const hash = requestHash(scope, {
      paymentId,
      amountCents: amount?.cents ?? null,
      currency: amount?.currency ?? null,
    });

    // Fase 1 (transação): reservar a chave e gravar a intenção ANTES do envio.
    const prepared = await this.uow.transaction(async (repos) => {
      const payment = await this.lockPayment(repos, ctx.tenantId, paymentId);
      const provider = this.providers.get(payment.providerId);
      const operations = await repos.operations.listByPayment(ctx.tenantId, paymentId);

      // A chave é verificada antes das regras de domínio: uma repetição legítima
      // deve devolver o resultado original mesmo que o estado já tenha mudado.
      const planned = (() => {
        try {
          return { ok: true as const, value: planOperation({ payment, operations, kind, ...(amount ? { amount } : {}), capabilities: provider.capabilities, now }) };
        } catch (error) {
          return { ok: false as const, error };
        }
      })();

      const resourceId = planned.ok ? planned.value.operation.id : 'rejected';
      const claim = await repos.idempotency.claim(
        this.idempotencyRecord(ctx, payment.merchantId, scope, idempotencyKey, hash, 'operation', resourceId, 200, now),
      );
      if (!claim.claimed) {
        const existing = this.assertSameRequest(claim.existing, hash);
        const operation = operations.find((op) => op.id === existing.resourceId);
        if (!operation) throw new NotFoundError('operação da chave de idempotência não encontrada');
        return { replay: true as const, payment, operations, operation, responseStatus: existing.responseStatus };
      }
      if (!planned.ok) throw planned.error; // desfaz a reserva junto com a transação

      const dispatched = markDispatched(planned.value.operation, provider.capabilities, now);
      if (planned.value.payment !== payment) {
        await repos.payments.update(planned.value.payment, payment.version);
        await this.auditPaymentTransition(repos, ctx, payment, planned.value.payment, now);
        await this.emit(repos, planned.value.payment, 'payment.state_changed', now);
      }
      await repos.operations.insert(dispatched);
      await this.audit(repos, ctx, 'operation.dispatched', 'operation', dispatched.id, now, {
        operationKind: dispatched.kind,
        operationStatus: dispatched.status,
        amountCents: dispatched.amount.cents,
        providerId: payment.providerId,
        providerKind: provider.kind,
      });
      return { replay: false as const, payment: planned.value.payment, operation: dispatched, provider, operations };
    });

    if (prepared.replay) {
      return {
        payment: prepared.payment,
        operations: prepared.operations,
        operation: prepared.operation,
        replayed: true,
        responseStatus: prepared.responseStatus,
      };
    }

    // Fase 2: chamada ao provedor, fora de transação, com limite de tempo.
    const original = prepared.operations.find((op) => op.kind === 'AUTHORIZATION' && op.status === 'SUCCEEDED');
    const outcome = await this.callProvider(prepared.provider, prepared.payment, prepared.operation, original?.providerReference ?? null);

    // Fase 3 (transação): registrar o resultado.
    const applied = await this.recordOutcome(prepared.operation.id, outcome, ctx.actor, ctx.correlationId);
    const view = await this.getPayment(ctx, paymentId);
    return { ...view, operation: applied.operation, replayed: false, responseStatus: 200 };
  }

  private async callProvider(
    provider: PaymentProvider,
    payment: Payment,
    operation: Operation,
    originalProviderReference: string | null,
  ): Promise<OperationOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.providerTimeoutMs);
    try {
      const result = await provider.execute(
        {
          kind: operation.kind,
          clientReference: operation.id,
          paymentId: payment.id,
          terminalId: payment.terminalId,
          amount: operation.amount,
          originalProviderReference,
        },
        controller.signal,
      );
      return this.toOutcome(provider, result, 'PROVIDER_RESPONSE');
    } catch (error) {
      const reason = controller.signal.aborted ? 'PROVIDER_TIMEOUT' : 'PROVIDER_CALL_FAILED';
      this.logger.warn(
        { operationId: operation.id, providerId: provider.id, reason, errorName: error instanceof Error ? error.name : 'unknown' },
        'resultado da operação desconhecido após possível envio',
      );
      return { status: 'UNKNOWN', reason };
    } finally {
      clearTimeout(timer);
    }
  }

  private toOutcome(
    provider: PaymentProvider,
    result: ProviderOperationResult,
    source: 'PROVIDER_RESPONSE' | 'PROVIDER_NOTIFICATION',
  ): OperationOutcome {
    const observedAt = this.clock();
    const resultCode = safeProviderCode(result.resultCode);
    const providerReference = result.status === 'NOT_SENT' || result.status === 'UNKNOWN'
      ? undefined
      : safeProviderReference(result.providerReference);
    const evidence: Evidence = providerReference ? { source, observedAt, providerReference } : { source, observedAt };
    const extras = {
      ...(providerReference ? { providerReference } : {}),
      ...(resultCode ? { resultCode } : {}),
    };
    switch (result.status) {
      case 'SUCCEEDED':
        return { status: 'SUCCEEDED', evidence, ...extras, requiresConfirmation: result.requiresConfirmation ?? false };
      case 'REJECTED':
      case 'ABORTED':
        return { status: result.status, evidence, ...extras };
      case 'NOT_SENT':
        // Só é aceito se o adaptador declarar a garantia; caso contrário, é tratado como incerto.
        if (!provider.capabilities.guaranteesNotSentOnPreSendFailure) {
          return { status: 'UNKNOWN', reason: 'NOT_SENT_UNVERIFIED' };
        }
        return { status: 'NOT_SENT', evidence: { source: 'ADAPTER_NOT_SENT', observedAt }, ...extras };
      case 'UNKNOWN':
        return { status: 'UNKNOWN', reason: resultCode ?? INVALID_PROVIDER_CODE };
    }
  }

  // -------------------------------------------------------------------------
  // Registro de resultado (resposta, notificação, consulta, recuperação, manual)
  // -------------------------------------------------------------------------

  private async recordOutcome(
    operationId: OperationId,
    outcome: OperationOutcome,
    actor: Actor,
    correlationId: string | null,
  ): Promise<{ payment: Payment; operation: Operation; changed: boolean }> {
    try {
      return await this.uow.transaction((repos) => this.applyInTransaction(repos, operationId, outcome, actor, correlationId));
    } catch (error) {
      if (error instanceof ConflictingEvidenceError) {
        await this.recordConflict(operationId, outcome, actor, correlationId);
        throw error;
      }
      // Resultado do provedor incompatível com as capacidades declaradas: não confiar nele.
      if (
        outcome.status !== 'UNKNOWN' &&
        outcome.evidence.source !== 'MANUAL_RESOLUTION' &&
        (error instanceof CapabilityNotSupportedError || error instanceof EvidenceRequiredError)
      ) {
        this.logger.error({ operationId, code: error.code }, 'resultado do provedor inconsistente com o contrato; registrado como UNKNOWN');
        return this.uow.transaction((repos) =>
          this.applyInTransaction(repos, operationId, { status: 'UNKNOWN', reason: 'INCONSISTENT_PROVIDER_RESULT' }, actor, correlationId),
        );
      }
      throw error;
    }
  }

  private async applyInTransaction(
    repos: Repositories,
    operationId: OperationId,
    outcome: OperationOutcome,
    actor: Actor,
    correlationId: string | null,
  ): Promise<{ payment: Payment; operation: Operation; changed: boolean }> {
    const now = this.clock();
    const located = await repos.operations.findByIdForSystem(operationId);
    if (!located) throw new NotFoundError('operação não encontrada');
    // Bloqueia o pagamento primeiro; só então relê a operação (ordem fixa de bloqueio).
    const payment = await this.lockPayment(repos, located.tenantId, located.paymentId);
    const operation = await repos.operations.findById(located.tenantId, operationId);
    if (!operation) throw new NotFoundError('operação não encontrada');
    const provider = this.providers.get(payment.providerId);

    const result = applyOperationOutcome({ payment, operation, outcome, capabilities: provider.capabilities, now });
    if (!result.changed) {
      this.logger.info({ operationId, status: operation.status }, 'resultado repetido ignorado (idempotente)');
      return result;
    }

    const ctx: RequestContext = { tenantId: payment.tenantId, actor, correlationId };
    await repos.operations.update(result.operation, operation.version);
    await this.audit(repos, ctx, 'operation.result_recorded', 'operation', operation.id, now, {
      operationKind: operation.kind,
      fromOperationStatus: operation.status,
      operationStatus: result.operation.status,
      providerReference: result.operation.providerReference,
      resultCode: result.operation.resultCode,
      evidenceSource: result.operation.evidence?.source ?? null,
      resolvedBy: result.operation.evidence?.manual?.resolvedBy ?? null,
      approvedBy: result.operation.evidence?.manual?.approvedBy ?? null,
      supportingDocumentRef: result.operation.evidence?.manual?.supportingDocumentRef ?? null,
    });
    if (result.payment !== payment) {
      await repos.payments.update(result.payment, payment.version);
      await this.auditPaymentTransition(repos, ctx, payment, result.payment, now);
      await this.emit(repos, result.payment, 'payment.state_changed', now, result.operation);
    }
    return result;
  }

  private async recordConflict(operationId: OperationId, outcome: OperationOutcome, actor: Actor, correlationId: string | null): Promise<void> {
    const now = this.clock();
    await this.uow.transaction(async (repos) => {
      const operation = await repos.operations.findByIdForSystem(operationId);
      if (!operation) return;
      const ctx: RequestContext = { tenantId: operation.tenantId, actor, correlationId };
      await this.audit(repos, ctx, 'operation.conflicting_evidence', 'operation', operationId, now, {
        operationKind: operation.kind,
        operationStatus: operation.status,
        reason: `novo resultado: ${outcome.status}`,
        evidenceSource: outcome.status === 'UNKNOWN' ? null : outcome.evidence.source,
      });
    });
    this.logger.error({ operationId, recorded: 'conflict' }, 'evidência conflitante para operação já finalizada');
  }

  /** Notificação assíncrona e autenticada do provedor (equivalente a webhook). Idempotente. */
  async handleProviderNotification(notification: ProviderNotification): Promise<{ changed: boolean }> {
    const operation = await this.uow.transaction((repos) => repos.operations.findByIdForSystem(notification.clientReference));
    if (!operation) throw new NotFoundError('operação da notificação não encontrada');
    const view = await this.uow.transaction((repos) => repos.payments.findById(operation.tenantId, operation.paymentId));
    if (!view) throw new NotFoundError('pagamento da notificação não encontrado');
    if (view.providerId !== notification.providerId) {
      throw new ProviderMismatchError('notificação de provedor diferente do que processou a operação');
    }
    const provider = this.providers.get(view.providerId);
    const outcome = this.toOutcome(provider, notification.result, 'PROVIDER_NOTIFICATION');
    const result = await this.recordOutcome(operation.id, outcome, SYSTEM_NOTIFICATIONS, null);
    return { changed: result.changed };
  }

  /**
   * Recuperação após falha do processo: operações que ficaram IN_FLIGHT (o
   * processo caiu entre o envio e o registro do resultado) passam a UNKNOWN.
   * NUNCA reenvia a operação.
   */
  async recoverStaleInFlight(olderThanMs: number, limit = 100): Promise<number> {
    const cutoff = new Date(this.clock().getTime() - olderThanMs);
    const stale = await this.uow.transaction((repos) => repos.operations.listInFlightUpdatedBefore(cutoff, limit));
    let recovered = 0;
    for (const op of stale) {
      const result = await this.recordOutcome(op.id, { status: 'UNKNOWN', reason: 'STALE_IN_FLIGHT_RECOVERED' }, SYSTEM_RECOVERY, null);
      if (result.changed) recovered++;
    }
    return recovered;
  }

  /**
   * Reconciliação de UMA operação UNKNOWN por consulta ao provedor. Se o provedor
   * não oferece consulta, exige ação manual ou arquivo de conciliação.
   */
  async reconcileOperation(operationId: OperationId): Promise<ReconciliationResult> {
    const located = await this.uow.transaction(async (repos) => {
      const operation = await repos.operations.findByIdForSystem(operationId);
      if (!operation) throw new NotFoundError('operação não encontrada');
      const payment = await repos.payments.findById(operation.tenantId, operation.paymentId);
      if (!payment) throw new NotFoundError('pagamento não encontrado');
      return { operation, payment };
    });
    if (located.operation.status !== 'UNKNOWN') {
      return { resolved: FINAL_OPERATION_STATUSES.has(located.operation.status), ...located };
    }

    const provider = this.providers.get(located.payment.providerId);
    if (!provider.capabilities.query || !provider.query) {
      throw new ReconciliationRequiresManualActionError('o provedor não oferece consulta; use conciliação por arquivo ou resolução manual');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.providerTimeoutMs);
    let outcome: OperationOutcome | null = null;
    try {
      const result = await provider.query(
        { kind: located.operation.kind, clientReference: located.operation.id, terminalId: located.payment.terminalId },
        controller.signal,
      );
      const observedAt = this.clock();
      if (result.status === 'FOUND') {
        const providerReference = safeProviderReference(result.providerReference);
        const resultCode = safeProviderCode(result.resultCode);
        const evidence: Evidence = providerReference
          ? { source: 'PROVIDER_QUERY', observedAt, providerReference }
          : { source: 'PROVIDER_QUERY', observedAt };
        const extras = {
          ...(providerReference ? { providerReference } : {}),
          ...(resultCode ? { resultCode } : {}),
        };
        outcome =
          result.outcome === 'SUCCEEDED'
            ? { status: 'SUCCEEDED', evidence, ...extras, requiresConfirmation: result.requiresConfirmation ?? false }
            : { status: result.outcome, evidence, ...extras };
      } else if (result.status === 'NOT_FOUND' && provider.capabilities.queryNotFoundIsDefinitive) {
        outcome = { status: 'NOT_SENT', evidence: { source: 'PROVIDER_QUERY', observedAt }, resultCode: 'NOT_FOUND_AT_PROVIDER' };
      }
    } catch (error) {
      this.logger.warn(
        { operationId, errorName: error instanceof Error ? error.name : 'unknown' },
        'consulta ao provedor falhou; operação continua UNKNOWN',
      );
    } finally {
      clearTimeout(timer);
    }

    if (!outcome) return { resolved: false, ...located };
    const applied = await this.recordOutcome(operationId, outcome, SYSTEM_RECONCILER, null);
    return { resolved: true, payment: applied.payment, operation: applied.operation };
  }

  /** Resolução manual de operação UNKNOWN: exige dupla aprovação e documento de suporte. */
  async resolveManually(
    ctx: RequestContext,
    operationId: OperationId,
    status: 'SUCCEEDED' | 'REJECTED' | 'ABORTED' | 'NOT_SENT',
    manual: ManualResolution,
    providerReference?: string,
  ): Promise<ReconciliationResult> {
    const operation = await this.uow.transaction((repos) => repos.operations.findById(ctx.tenantId, operationId));
    if (!operation) throw new NotFoundError('operação não encontrada');
    const evidence: Evidence = {
      source: 'MANUAL_RESOLUTION',
      observedAt: this.clock(),
      manual,
      ...(providerReference ? { providerReference } : {}),
    };
    const outcome: OperationOutcome =
      status === 'SUCCEEDED'
        ? { status, evidence, ...(providerReference ? { providerReference } : {}), resultCode: 'MANUAL_RESOLUTION' }
        : { status, evidence, ...(providerReference ? { providerReference } : {}), resultCode: 'MANUAL_RESOLUTION' };
    const applied = await this.recordOutcome(operationId, outcome, ctx.actor, ctx.correlationId);
    return { resolved: true, payment: applied.payment, operation: applied.operation };
  }

  // -------------------------------------------------------------------------
  // Auxiliares
  // -------------------------------------------------------------------------

  private async lockPayment(repos: Repositories, tenantId: TenantId, paymentId: PaymentId): Promise<Payment> {
    const payment = await repos.payments.lockById(tenantId, paymentId);
    if (!payment) throw new NotFoundError('pagamento não encontrado');
    return payment;
  }

  private idempotencyRecord(
    ctx: RequestContext,
    merchantId: MerchantId,
    scope: string,
    key: string,
    hash: string,
    resourceType: 'payment' | 'operation',
    resourceId: string,
    responseStatus: number,
    now: Date,
  ): IdempotencyRecord {
    return {
      tenantId: ctx.tenantId,
      merchantId,
      scope,
      key,
      requestHash: hash,
      resourceType,
      resourceId,
      responseStatus,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.idempotencyTtlMs),
    };
  }

  private assertSameRequest(existing: IdempotencyRecord, hash: string): IdempotencyRecord {
    if (existing.requestHash !== hash) {
      throw new IdempotencyConflictError('a chave de idempotência já foi usada com outro conteúdo');
    }
    return existing;
  }

  private async audit(
    repos: Repositories,
    ctx: RequestContext,
    action: string,
    resourceType: 'payment' | 'operation',
    resourceId: string,
    now: Date,
    data: AuditData,
  ): Promise<void> {
    await repos.audit.append({
      tenantId: ctx.tenantId,
      occurredAt: now,
      actorType: ctx.actor.type,
      actorId: ctx.actor.id,
      action,
      resourceType,
      resourceId,
      correlationId: ctx.correlationId,
      data,
    });
  }

  private auditPaymentTransition(repos: Repositories, ctx: RequestContext, before: Payment, after: Payment, now: Date): Promise<void> {
    // Estorno parcial altera o saldo sem mudar o estado.
    const action = before.state === after.state ? 'payment.balance_changed' : 'payment.state_changed';
    return this.audit(repos, ctx, action, 'payment', after.id, now, {
      fromState: before.state,
      toState: after.state,
      stateReason: after.stateReason,
      reversedCents: after.reversedAmount.cents,
    });
  }

  private emit(repos: Repositories, payment: Payment, eventType: string, now: Date, operation?: Operation): Promise<void> {
    return repos.outbox.add({
      tenantId: payment.tenantId,
      aggregateType: 'payment',
      aggregateId: payment.id,
      eventType,
      occurredAt: now,
      payload: {
        paymentId: payment.id,
        state: payment.state,
        stateReason: payment.stateReason,
        reversedCents: payment.reversedAmount.cents,
        operationId: operation?.id ?? null,
        operationKind: operation?.kind ?? null,
        operationStatus: operation?.status ?? null,
      },
    });
  }
}
