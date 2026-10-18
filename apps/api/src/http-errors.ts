import { isApplicationError, type ApplicationErrorCode } from '@tef/application';
import { isDomainError, type DomainErrorCode } from '@tef/domain';

export interface HttpErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly correlationId: string;
    readonly issues?: readonly { readonly path: string; readonly code: string }[];
  };
}

/** Erro de entrada já validado (o detalhe NUNCA inclui o valor recebido). */
export class RequestValidationError extends Error {
  readonly code = 'VALIDATION_ERROR';
  readonly issues: readonly { path: string; code: string }[];

  constructor(issues: readonly { path: string; code: string }[]) {
    super('requisição inválida');
    this.issues = issues;
  }
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const DOMAIN_STATUS: Record<DomainErrorCode, number> = {
  INVALID_AMOUNT: 400,
  INVALID_IDENTIFIER: 400,
  INVALID_TRANSITION: 409,
  OPERATION_IN_PROGRESS: 409,
  CONFLICTING_EVIDENCE: 409,
  CAPABILITY_NOT_SUPPORTED: 422,
  REFUND_EXCEEDS_AVAILABLE: 422,
  EVIDENCE_REQUIRED: 422,
  INVARIANT_VIOLATION: 422,
};

const APPLICATION_STATUS: Record<ApplicationErrorCode, number> = {
  NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
  DUPLICATE_REFERENCE: 409,
  CONCURRENCY_CONFLICT: 409,
  RECONCILIATION_REQUIRES_MANUAL_ACTION: 409,
  PROVIDER_MISMATCH: 422,
};

/** Converte qualquer erro em resposta segura. Erros inesperados viram 500 genérico. */
export function toHttpError(error: unknown, correlationId: string): { status: number; body: HttpErrorBody; expected: boolean } {
  const body = (code: string, message: string, extra: Partial<HttpErrorBody['error']> = {}): HttpErrorBody => ({
    error: { code, message, correlationId, ...extra },
  });

  if (error instanceof RequestValidationError) {
    return { status: 400, body: body(error.code, error.message, { issues: error.issues }), expected: true };
  }
  if (error instanceof HttpError) {
    return { status: error.status, body: body(error.code, error.message), expected: true };
  }
  if (isDomainError(error)) {
    return { status: DOMAIN_STATUS[error.code], body: body(error.code, error.message), expected: true };
  }
  if (isApplicationError(error)) {
    return { status: APPLICATION_STATUS[error.code], body: body(error.code, error.message), expected: true };
  }
  const fastifyStatus = (error as { statusCode?: unknown } | null)?.statusCode;
  if (typeof fastifyStatus === 'number' && fastifyStatus >= 400 && fastifyStatus < 500) {
    return { status: fastifyStatus, body: body('BAD_REQUEST', 'requisição inválida'), expected: true };
  }
  return { status: 500, body: body('INTERNAL_ERROR', 'erro interno; informe o correlationId ao suporte'), expected: false };
}
