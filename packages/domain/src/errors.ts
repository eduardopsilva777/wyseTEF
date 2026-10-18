/**
 * Erros de domínio tipados. Cada erro tem um `code` estável que as camadas
 * externas mapeiam para respostas (HTTP, logs, auditoria) sem depender de texto.
 * As mensagens nunca devem conter dados sensíveis.
 */
export type DomainErrorCode =
  | 'INVALID_AMOUNT'
  | 'INVALID_IDENTIFIER'
  | 'INVALID_TRANSITION'
  | 'EVIDENCE_REQUIRED'
  | 'CAPABILITY_NOT_SUPPORTED'
  | 'OPERATION_IN_PROGRESS'
  | 'REFUND_EXCEEDS_AVAILABLE'
  | 'CONFLICTING_EVIDENCE'
  | 'INVARIANT_VIOLATION';

export abstract class DomainError extends Error {
  abstract readonly code: DomainErrorCode;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidAmountError extends DomainError {
  readonly code = 'INVALID_AMOUNT';
}

export class InvalidIdentifierError extends DomainError {
  readonly code = 'INVALID_IDENTIFIER';
}

export class InvalidTransitionError extends DomainError {
  readonly code = 'INVALID_TRANSITION';
  readonly entity: 'payment' | 'operation';
  readonly from: string;
  readonly to: string;

  constructor(entity: 'payment' | 'operation', from: string, to: string, detail?: string) {
    super(`transição inválida de ${entity}: ${from} -> ${to}${detail ? ` (${detail})` : ''}`);
    this.entity = entity;
    this.from = from;
    this.to = to;
  }
}

export class EvidenceRequiredError extends DomainError {
  readonly code = 'EVIDENCE_REQUIRED';
}

export class CapabilityNotSupportedError extends DomainError {
  readonly code = 'CAPABILITY_NOT_SUPPORTED';
  readonly capability: string;

  constructor(capability: string) {
    super(`o provedor não declara a capacidade: ${capability}`);
    this.capability = capability;
  }
}

/** Já existe operação pendente, em andamento ou com resultado desconhecido. */
export class OperationInProgressError extends DomainError {
  readonly code = 'OPERATION_IN_PROGRESS';
}

export class RefundExceedsAvailableError extends DomainError {
  readonly code = 'REFUND_EXCEEDS_AVAILABLE';
}

/** Uma nova evidência contradiz um resultado definitivo já registrado. */
export class ConflictingEvidenceError extends DomainError {
  readonly code = 'CONFLICTING_EVIDENCE';
}

export class InvariantViolationError extends DomainError {
  readonly code = 'INVARIANT_VIOLATION';
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
