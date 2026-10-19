import type { ProviderCapabilities } from './capabilities.ts';
import {
  CapabilityNotSupportedError,
  ConflictingEvidenceError,
  InvalidTransitionError,
  InvariantViolationError,
  OperationInProgressError,
  RefundExceedsAvailableError,
} from './errors.ts';
import type { Evidence } from './evidence.ts';
import {
  newOperationId,
  newPaymentId,
  type MerchantId,
  type OperationId,
  type PaymentId,
  type ProviderId,
  type TenantId,
  type TerminalId,
} from './ids.ts';
import { add, equals, money, subtract, type Money } from './money.ts';
import {
  assertOperationTransition,
  assertPaymentTransition,
  FINAL_OPERATION_STATUSES,
  OPEN_OPERATION_STATUSES,
  type OperationKind,
  type OperationStatus,
  type PaymentState,
} from './state-machine.ts';

export interface Payment {
  readonly id: PaymentId;
  readonly tenantId: TenantId;
  readonly merchantId: MerchantId;
  readonly terminalId: TerminalId;
  readonly externalReference: string;
  readonly providerId: ProviderId;
  readonly amount: Money;
  /** Soma das operações de reversão (desfazimento, cancelamento, estorno) concluídas. */
  readonly reversedAmount: Money;
  readonly state: PaymentState;
  /** Código curto do motivo do estado atual. Nunca contém dados sensíveis. */
  readonly stateReason: string | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface Operation {
  readonly id: OperationId;
  readonly paymentId: PaymentId;
  readonly tenantId: TenantId;
  readonly kind: OperationKind;
  readonly status: OperationStatus;
  readonly amount: Money;
  readonly providerReference: string | null;
  /** Código de resultado normalizado (ex.: motivo da recusa). */
  readonly resultCode: string | null;
  /** Apenas para autorização: o provedor exige confirmação (duas fases). */
  readonly requiresConfirmation: boolean | null;
  readonly evidence: Evidence | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Resultado de uma operação, como relatado pelo adaptador ou pela reconciliação. */
export type OperationOutcome =
  | {
      readonly status: 'SUCCEEDED';
      readonly evidence: Evidence;
      readonly providerReference?: string;
      readonly resultCode?: string;
      readonly requiresConfirmation?: boolean;
    }
  | {
      readonly status: 'REJECTED' | 'ABORTED' | 'NOT_SENT';
      readonly evidence: Evidence;
      readonly providerReference?: string;
      readonly resultCode?: string;
    }
  | { readonly status: 'UNKNOWN'; readonly reason: string };

export interface CreatePaymentInput {
  /** ID gerado previamente (ex.: para reservar a chave de idempotência antes da validação). */
  readonly id?: PaymentId;
  readonly tenantId: TenantId;
  readonly merchantId: MerchantId;
  readonly terminalId: TerminalId;
  readonly externalReference: string;
  readonly providerId: ProviderId;
  readonly amount: Money;
}

export function createPayment(input: CreatePaymentInput, now: Date): Payment {
  if (input.amount.cents <= 0) {
    throw new InvariantViolationError('pagamento exige valor positivo');
  }
  const { id, ...rest } = input;
  return {
    id: id ?? newPaymentId(),
    ...rest,
    reversedAmount: money(0, input.amount.currency),
    state: 'CREATED',
    stateReason: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function transitionPayment(
  payment: Payment,
  to: PaymentState,
  reason: string,
  capabilities: ProviderCapabilities,
  evidence: Evidence | null,
  now: Date,
): Payment {
  assertPaymentTransition(payment.state, to, { capabilities, evidence });
  return { ...payment, state: to, stateReason: reason, version: payment.version + 1, updatedAt: now };
}

/** Desistência antes de qualquer contato com o provedor. */
export function cancelBeforeSubmission(
  payment: Payment,
  capabilities: ProviderCapabilities,
  now: Date,
): Payment {
  return transitionPayment(
    payment,
    'CANCELLED',
    'CANCELLED_BEFORE_SUBMISSION',
    capabilities,
    { source: 'LOCAL_NO_CONTACT', observedAt: now },
    now,
  );
}

export function availableForReversal(payment: Payment): Money {
  return subtract(payment.amount, payment.reversedAmount);
}

export function findOpenOperation(operations: readonly Operation[]): Operation | undefined {
  return operations.find((op) => OPEN_OPERATION_STATUSES.has(op.status));
}

export interface PlanOperationInput {
  readonly payment: Payment;
  /** Todas as operações já registradas para este pagamento. */
  readonly operations: readonly Operation[];
  readonly kind: OperationKind;
  /** Obrigatório para estorno; ignorado nos demais tipos (valor derivado do pagamento). */
  readonly amount?: Money;
  readonly capabilities: ProviderCapabilities;
  readonly now: Date;
}

/**
 * Registra a intenção de uma nova operação (status PENDING) e, para autorização,
 * move o pagamento para PROCESSING. Regras:
 *  - no máximo UMA operação aberta (PENDING/IN_FLIGHT/UNKNOWN) por pagamento;
 *  - cada tipo só é aceito no estado correto e com a capacidade declarada.
 * Em particular, um pagamento UNKNOWN não aceita nova autorização: ele precisa
 * ser reconciliado antes de qualquer tentativa conflitante.
 */
export function planOperation(input: PlanOperationInput): { payment: Payment; operation: Operation } {
  const { payment, operations, kind, capabilities, now } = input;

  const open = findOpenOperation(operations);
  if (open) {
    throw new OperationInProgressError(
      `o pagamento já possui operação ${open.kind} com status ${open.status}; resolva-a antes de iniciar outra`,
    );
  }

  let amount: Money;
  let nextPayment = payment;

  switch (kind) {
    case 'AUTHORIZATION': {
      if (operations.some((op) => op.kind === 'AUTHORIZATION')) {
        throw new InvalidTransitionError('payment', payment.state, 'PROCESSING', 'pagamento já teve autorização');
      }
      nextPayment = transitionPayment(payment, 'PROCESSING', 'AUTHORIZATION_STARTED', capabilities, null, now);
      amount = payment.amount;
      break;
    }
    case 'CONFIRMATION':
    case 'UNDO': {
      if (payment.state !== 'AUTHORIZED') {
        throw new InvalidTransitionError('payment', payment.state, kind, 'exige pagamento AUTHORIZED');
      }
      if (kind === 'CONFIRMATION' && !capabilities.twoPhaseConfirmation) {
        throw new CapabilityNotSupportedError('twoPhaseConfirmation');
      }
      if (kind === 'UNDO' && !capabilities.undo) throw new CapabilityNotSupportedError('undo');
      amount = payment.amount;
      break;
    }
    case 'CANCELLATION': {
      if (payment.state !== 'APPROVED') {
        throw new InvalidTransitionError('payment', payment.state, kind, 'exige pagamento APPROVED');
      }
      if (!capabilities.cancellation) throw new CapabilityNotSupportedError('cancellation');
      if (payment.reversedAmount.cents !== 0) {
        throw new InvalidTransitionError('payment', payment.state, kind, 'cancelamento é sempre total; já há estornos');
      }
      amount = payment.amount;
      break;
    }
    case 'REFUND': {
      if (payment.state !== 'APPROVED') {
        throw new InvalidTransitionError('payment', payment.state, kind, 'exige pagamento APPROVED');
      }
      const requested = input.amount;
      if (!requested || requested.cents <= 0) {
        throw new InvariantViolationError('estorno exige valor positivo');
      }
      const available = availableForReversal(payment);
      if (requested.currency !== payment.amount.currency || requested.cents > available.cents) {
        throw new RefundExceedsAvailableError('valor do estorno excede o saldo aprovado disponível');
      }
      const isFull = payment.reversedAmount.cents === 0 && equals(requested, payment.amount);
      if (isFull && !capabilities.refund.full) throw new CapabilityNotSupportedError('refund.full');
      if (!isFull && !capabilities.refund.partial) throw new CapabilityNotSupportedError('refund.partial');
      amount = requested;
      break;
    }
  }

  const operation: Operation = {
    id: newOperationId(),
    paymentId: payment.id,
    tenantId: payment.tenantId,
    kind,
    status: 'PENDING',
    amount,
    providerReference: null,
    resultCode: null,
    requiresConfirmation: null,
    evidence: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  return { payment: nextPayment, operation };
}

/** Marca a operação como enviada (ou possivelmente enviada). Deve ser persistido ANTES da chamada ao provedor. */
export function markDispatched(operation: Operation, capabilities: ProviderCapabilities, now: Date): Operation {
  assertOperationTransition(operation.status, 'IN_FLIGHT', { capabilities });
  return { ...operation, status: 'IN_FLIGHT', version: operation.version + 1, updatedAt: now };
}

interface PaymentEffect {
  readonly to: PaymentState | null;
  readonly reason: string;
  readonly reversal?: Money;
}

const NO_EFFECT: PaymentEffect = { to: null, reason: '' };

function paymentEffect(payment: Payment, operation: Operation, outcome: OperationOutcome): PaymentEffect {
  const status = outcome.status;
  switch (operation.kind) {
    case 'AUTHORIZATION':
      switch (status) {
        case 'SUCCEEDED':
          return outcome.requiresConfirmation
            ? { to: 'AUTHORIZED', reason: 'AUTHORIZED_PENDING_CONFIRMATION' }
            : { to: 'APPROVED', reason: 'PROVIDER_APPROVED' };
        case 'REJECTED':
          return { to: 'DECLINED', reason: 'PROVIDER_DECLINED' };
        case 'ABORTED':
          return { to: 'CANCELLED', reason: 'ABORTED_AT_PROVIDER' };
        case 'NOT_SENT':
          return { to: 'CANCELLED', reason: 'NOT_SENT_TO_PROVIDER' };
        case 'UNKNOWN':
          return { to: 'UNKNOWN', reason: 'AUTHORIZATION_RESULT_UNKNOWN' };
      }
      break;
    case 'CONFIRMATION':
      switch (status) {
        case 'SUCCEEDED':
          return { to: 'APPROVED', reason: 'CONFIRMED' };
        case 'NOT_SENT':
          return NO_EFFECT; // continua AUTHORIZED; a confirmação pode ser tentada de novo
        case 'REJECTED':
        case 'ABORTED':
        case 'UNKNOWN':
          // Recusa/abandono/incerteza na confirmação não provam o resultado financeiro.
          return { to: 'UNKNOWN', reason: 'CONFIRMATION_RESULT_UNCERTAIN' };
      }
      break;
    case 'UNDO':
      switch (status) {
        case 'SUCCEEDED':
          return { to: 'REVERSED', reason: 'UNDONE', reversal: availableForReversal(payment) };
        case 'NOT_SENT':
          return NO_EFFECT;
        case 'REJECTED':
        case 'ABORTED':
        case 'UNKNOWN':
          return { to: 'UNKNOWN', reason: 'UNDO_RESULT_UNCERTAIN' };
      }
      break;
    case 'CANCELLATION':
    case 'REFUND': {
      if (status !== 'SUCCEEDED') return NO_EFFECT; // operação aberta (UNKNOWN) continua bloqueando novas operações
      const remaining = subtract(availableForReversal(payment), operation.amount);
      return remaining.cents === 0
        ? { to: 'REVERSED', reason: operation.kind === 'CANCELLATION' ? 'CANCELLED_BY_MERCHANT' : 'FULLY_REFUNDED', reversal: operation.amount }
        : { to: null, reason: 'PARTIALLY_REFUNDED', reversal: operation.amount };
    }
  }
  return NO_EFFECT;
}

export interface ApplyOutcomeResult {
  readonly payment: Payment;
  readonly operation: Operation;
  /** `false` quando o mesmo resultado já estava registrado (resposta duplicada). */
  readonly changed: boolean;
}

/**
 * Aplica o resultado de uma operação ao par (operação, pagamento), de forma
 * idempotente: o mesmo resultado aplicado duas vezes não altera nada; um
 * resultado definitivo diferente do já registrado é rejeitado.
 */
export function applyOperationOutcome(input: {
  readonly payment: Payment;
  readonly operation: Operation;
  readonly outcome: OperationOutcome;
  readonly capabilities: ProviderCapabilities;
  readonly now: Date;
}): ApplyOutcomeResult {
  const { payment, operation, outcome, capabilities, now } = input;

  if (operation.paymentId !== payment.id) {
    throw new InvariantViolationError('a operação não pertence ao pagamento informado');
  }

  if (FINAL_OPERATION_STATUSES.has(operation.status)) {
    const same =
      outcome.status === operation.status &&
      (outcome.status !== 'SUCCEEDED' || (outcome.requiresConfirmation ?? false) === (operation.requiresConfirmation ?? false));
    if (same) return { payment, operation, changed: false };
    if (outcome.status === 'UNKNOWN') return { payment, operation, changed: false }; // ausência de resposta não apaga evidência
    throw new ConflictingEvidenceError(
      `operação já finalizada como ${operation.status}; novo resultado ${outcome.status} exige investigação`,
    );
  }

  if (operation.status === 'UNKNOWN' && outcome.status === 'UNKNOWN') {
    return { payment, operation, changed: false };
  }

  const evidence = outcome.status === 'UNKNOWN' ? null : outcome.evidence;
  assertOperationTransition(operation.status, outcome.status, { capabilities, evidence });

  const nextOperation: Operation = {
    ...operation,
    status: outcome.status,
    evidence,
    providerReference:
      outcome.status !== 'UNKNOWN' && outcome.providerReference ? outcome.providerReference : operation.providerReference,
    resultCode:
      outcome.status === 'UNKNOWN' ? outcome.reason : (outcome.resultCode ?? operation.resultCode),
    requiresConfirmation:
      operation.kind === 'AUTHORIZATION' && outcome.status === 'SUCCEEDED'
        ? (outcome.requiresConfirmation ?? false)
        : operation.requiresConfirmation,
    version: operation.version + 1,
    updatedAt: now,
  };

  const effect = paymentEffect(payment, operation, outcome);
  let nextPayment = payment;
  if (effect.to !== null && effect.to !== payment.state) {
    nextPayment = transitionPayment(payment, effect.to, effect.reason, capabilities, evidence, now);
  } else if (effect.to === null && effect.reversal) {
    nextPayment = { ...payment, stateReason: effect.reason, version: payment.version + 1, updatedAt: now };
  }
  if (effect.reversal) {
    nextPayment = { ...nextPayment, reversedAmount: add(nextPayment.reversedAmount, effect.reversal) };
    if (nextPayment.reversedAmount.cents > nextPayment.amount.cents) {
      throw new InvariantViolationError('total revertido excede o valor do pagamento');
    }
  }

  return { payment: nextPayment, operation: nextOperation, changed: true };
}
