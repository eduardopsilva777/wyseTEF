export type ApplicationErrorCode =
  | 'NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'DUPLICATE_REFERENCE'
  | 'CONCURRENCY_CONFLICT'
  | 'RECONCILIATION_REQUIRES_MANUAL_ACTION'
  | 'PROVIDER_MISMATCH'
  | 'REFERENCE_INVALID'
  | 'DUPLICATE_CODE'
  | 'HAS_DEPENDENCIES'
  | 'TEST_DIRECTIVE_NOT_ALLOWED'
  | 'NOTHING_TO_RECONCILE';

export abstract class ApplicationError extends Error {
  abstract readonly code: ApplicationErrorCode;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends ApplicationError {
  readonly code = 'NOT_FOUND';
}

/** Mesma chave de idempotência reutilizada com conteúdo diferente. */
export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
}

/** Já existe cobrança protegida para o mesmo estabelecimento e referência comercial. */
export class DuplicateReferenceError extends ApplicationError {
  readonly code = 'DUPLICATE_REFERENCE';
}

/** A versão do registro mudou entre a leitura e a gravação. */
export class ConcurrencyConflictError extends ApplicationError {
  readonly code = 'CONCURRENCY_CONFLICT';
}

/** O provedor não oferece consulta; a operação precisa de conciliação manual ou por arquivo. */
export class ReconciliationRequiresManualActionError extends ApplicationError {
  readonly code = 'RECONCILIATION_REQUIRES_MANUAL_ACTION';
}

/** Notificação recebida de um provedor diferente do que processou a operação. */
export class ProviderMismatchError extends ApplicationError {
  readonly code = 'PROVIDER_MISMATCH';
}

/** Estabelecimento/terminal inexistente, inativo ou de outro cliente (mensagem não revela qual). */
export class ReferenceInvalidError extends ApplicationError {
  readonly code = 'REFERENCE_INVALID';
}

/** Código de cadastro já utilizado. */
export class DuplicateCodeError extends ApplicationError {
  readonly code = 'DUPLICATE_CODE';
}

/** Registro com dependentes (ou histórico financeiro) não pode ser excluído; desative-o. */
export class HasDependenciesError extends ApplicationError {
  readonly code = 'HAS_DEPENDENCIES';
}

/** Diretiva de teste só é aceita para o provedor SIMULATOR. */
export class TestDirectiveNotAllowedError extends ApplicationError {
  readonly code = 'TEST_DIRECTIVE_NOT_ALLOWED';
}

/** O pagamento não tem operação com resultado desconhecido. */
export class NothingToReconcileError extends ApplicationError {
  readonly code = 'NOTHING_TO_RECONCILE';
}

export function isApplicationError(error: unknown): error is ApplicationError {
  return error instanceof ApplicationError;
}
