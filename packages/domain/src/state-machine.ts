import type { ProviderCapabilities } from './capabilities.ts';
import {
  CapabilityNotSupportedError,
  EvidenceRequiredError,
  InvalidTransitionError,
} from './errors.ts';
import {
  assertEvidenceWellFormed,
  PROVIDER_SOURCES,
  RESOLUTION_SOURCES,
  type Evidence,
  type EvidenceSource,
} from './evidence.ts';

/**
 * Máquina de estados explícita. TODAS as transições permitidas estão nas
 * tabelas abaixo; qualquer par (origem, destino) ausente é inválido.
 * Ver docs/TRANSACTION_LIFECYCLE.md.
 */

// ---------------------------------------------------------------------------
// Estado do pagamento (resultado financeiro da intenção de cobrança)
// ---------------------------------------------------------------------------

export const PAYMENT_STATES = [
  'CREATED',
  'PROCESSING',
  'AUTHORIZED',
  'APPROVED',
  'DECLINED',
  'UNKNOWN',
  'CANCELLED',
  'REVERSED',
] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

/** Estados finais: não aceitam nenhuma transição. */
export const TERMINAL_PAYMENT_STATES: ReadonlySet<PaymentState> = new Set(['DECLINED', 'CANCELLED', 'REVERSED']);

/**
 * Estados que LIBERAM a referência comercial para uma nova cobrança (ex.: cartão
 * recusado, cliente tenta outro cartão). Em qualquer outro estado — inclusive
 * UNKNOWN — a referência continua protegida.
 */
export const REFERENCE_RELEASING_STATES: readonly PaymentState[] = ['DECLINED', 'CANCELLED'];

// ---------------------------------------------------------------------------
// Estado de cada operação junto ao provedor
// ---------------------------------------------------------------------------

export const OPERATION_KINDS = [
  /** Autorização: pedido de aprovação da cobrança. */
  'AUTHORIZATION',
  /** Confirmação: segunda fase, quando o provedor exige. */
  'CONFIRMATION',
  /** Desfazimento: reversão técnica de autorização ainda não confirmada. */
  'UNDO',
  /** Cancelamento: anulação comercial total de transação aprovada. */
  'CANCELLATION',
  /** Estorno: devolução total ou parcial de transação aprovada. */
  'REFUND',
] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

export const OPERATION_STATUSES = [
  'PENDING',
  'IN_FLIGHT',
  'UNKNOWN',
  'SUCCEEDED',
  'REJECTED',
  'ABORTED',
  'NOT_SENT',
] as const;
export type OperationStatus = (typeof OPERATION_STATUSES)[number];

/** Operações "abertas" bloqueiam qualquer nova operação no mesmo pagamento. */
export const OPEN_OPERATION_STATUSES: ReadonlySet<OperationStatus> = new Set(['PENDING', 'IN_FLIGHT', 'UNKNOWN']);
export const FINAL_OPERATION_STATUSES: ReadonlySet<OperationStatus> = new Set([
  'SUCCEEDED',
  'REJECTED',
  'ABORTED',
  'NOT_SENT',
]);

// ---------------------------------------------------------------------------
// Regras
// ---------------------------------------------------------------------------

type CapabilityKey =
  | 'twoPhaseConfirmation'
  | 'undo'
  | 'cancellation'
  | 'query'
  | 'queryNotFoundIsDefinitive'
  | 'guaranteesNotSentOnPreSendFailure';

interface TransitionRule<S extends string> {
  readonly to: S;
  /** `null` = transição sem evidência (ex.: entrada em UNKNOWN por ausência de resposta). */
  readonly evidence: readonly EvidenceSource[] | null;
  readonly requires?: CapabilityKey;
  /** Capacidade exigida quando a evidência vem de uma fonte específica. */
  readonly sourceRequires?: Partial<Record<EvidenceSource, CapabilityKey>>;
}

/** ADAPTER_NOT_SENT só vale se o adaptador declarar essa garantia. */
const GLOBAL_SOURCE_REQUIREMENTS: Partial<Record<EvidenceSource, CapabilityKey>> = {
  ADAPTER_NOT_SENT: 'guaranteesNotSentOnPreSendFailure',
};

const PAYMENT_RULES: Readonly<Record<PaymentState, readonly TransitionRule<PaymentState>[]>> = {
  CREATED: [
    { to: 'PROCESSING', evidence: null },
    { to: 'CANCELLED', evidence: ['LOCAL_NO_CONTACT'] },
  ],
  PROCESSING: [
    { to: 'AUTHORIZED', evidence: PROVIDER_SOURCES, requires: 'twoPhaseConfirmation' },
    { to: 'APPROVED', evidence: PROVIDER_SOURCES },
    { to: 'DECLINED', evidence: PROVIDER_SOURCES },
    { to: 'CANCELLED', evidence: [...PROVIDER_SOURCES, 'ADAPTER_NOT_SENT'] },
    { to: 'UNKNOWN', evidence: null },
  ],
  AUTHORIZED: [
    { to: 'APPROVED', evidence: PROVIDER_SOURCES, requires: 'twoPhaseConfirmation' },
    { to: 'REVERSED', evidence: PROVIDER_SOURCES, requires: 'undo' },
    { to: 'UNKNOWN', evidence: null },
  ],
  UNKNOWN: [
    { to: 'AUTHORIZED', evidence: RESOLUTION_SOURCES, requires: 'twoPhaseConfirmation' },
    { to: 'APPROVED', evidence: RESOLUTION_SOURCES },
    { to: 'DECLINED', evidence: RESOLUTION_SOURCES },
    { to: 'CANCELLED', evidence: RESOLUTION_SOURCES },
    { to: 'REVERSED', evidence: RESOLUTION_SOURCES },
  ],
  APPROVED: [{ to: 'REVERSED', evidence: RESOLUTION_SOURCES }],
  DECLINED: [],
  CANCELLED: [],
  REVERSED: [],
};

const OPERATION_RULES: Readonly<Record<OperationStatus, readonly TransitionRule<OperationStatus>[]>> = {
  PENDING: [
    { to: 'IN_FLIGHT', evidence: null },
    { to: 'NOT_SENT', evidence: ['LOCAL_NO_CONTACT'] },
  ],
  IN_FLIGHT: [
    { to: 'SUCCEEDED', evidence: PROVIDER_SOURCES },
    { to: 'REJECTED', evidence: PROVIDER_SOURCES },
    { to: 'ABORTED', evidence: PROVIDER_SOURCES },
    { to: 'NOT_SENT', evidence: ['ADAPTER_NOT_SENT'] },
    { to: 'UNKNOWN', evidence: null },
  ],
  UNKNOWN: [
    { to: 'SUCCEEDED', evidence: RESOLUTION_SOURCES },
    { to: 'REJECTED', evidence: RESOLUTION_SOURCES },
    { to: 'ABORTED', evidence: RESOLUTION_SOURCES },
    {
      to: 'NOT_SENT',
      evidence: ['PROVIDER_QUERY', 'RECONCILIATION_FILE', 'MANUAL_RESOLUTION'],
      sourceRequires: { PROVIDER_QUERY: 'queryNotFoundIsDefinitive' },
    },
  ],
  SUCCEEDED: [],
  REJECTED: [],
  ABORTED: [],
  NOT_SENT: [],
};

export interface TransitionContext {
  readonly capabilities: ProviderCapabilities;
  readonly evidence?: Evidence | null;
}

function assertTransition<S extends string>(
  entity: 'payment' | 'operation',
  rules: Readonly<Record<S, readonly TransitionRule<S>[]>>,
  from: S,
  to: S,
  ctx: TransitionContext,
): void {
  const rule = rules[from].find((r) => r.to === to);
  if (!rule) throw new InvalidTransitionError(entity, from, to);

  if (rule.requires && !ctx.capabilities[rule.requires]) {
    throw new CapabilityNotSupportedError(rule.requires);
  }

  if (rule.evidence === null) return;

  const evidence = ctx.evidence;
  if (!evidence) {
    throw new EvidenceRequiredError(`${entity} ${from} -> ${to} exige evidência`);
  }
  assertEvidenceWellFormed(evidence);
  if (!rule.evidence.includes(evidence.source)) {
    throw new EvidenceRequiredError(`${entity} ${from} -> ${to} não aceita evidência do tipo ${evidence.source}`);
  }
  const sourceCapability = rule.sourceRequires?.[evidence.source] ?? GLOBAL_SOURCE_REQUIREMENTS[evidence.source];
  if (sourceCapability && !ctx.capabilities[sourceCapability]) {
    throw new CapabilityNotSupportedError(sourceCapability);
  }
}

export function assertPaymentTransition(from: PaymentState, to: PaymentState, ctx: TransitionContext): void {
  assertTransition('payment', PAYMENT_RULES, from, to, ctx);
}

export function assertOperationTransition(from: OperationStatus, to: OperationStatus, ctx: TransitionContext): void {
  assertTransition('operation', OPERATION_RULES, from, to, ctx);
}

/** Destinos possíveis a partir de um estado (sem considerar evidência/capacidade). */
export function allowedPaymentTargets(from: PaymentState): readonly PaymentState[] {
  return PAYMENT_RULES[from].map((r) => r.to);
}

export function allowedOperationTargets(from: OperationStatus): readonly OperationStatus[] {
  return OPERATION_RULES[from].map((r) => r.to);
}
