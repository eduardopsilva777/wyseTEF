import type { AuditEventInput, AuditRecord } from '@tef/audit';
import type { MerchantId, Operation, OperationId, Payment, PaymentId, TenantId } from '@tef/domain';

/**
 * Portas de persistência. Regras que TODA implementação deve garantir (e que
 * os testes de integração verificam no PostgreSQL):
 *  - `transaction` é atômica: ou tudo é gravado, ou nada;
 *  - `lockById` bloqueia o pagamento até o fim da transação; toda mudança em um
 *    pagamento ou em suas operações acontece com esse bloqueio;
 *  - `update` falha com ConcurrencyConflictError se a versão não confere;
 *  - consultas com `tenantId` nunca retornam dados de outro tenant.
 */
export interface PaymentRepository {
  /** Lança DuplicateReferenceError se a referência comercial estiver protegida. */
  insert(payment: Payment): Promise<void>;
  findById(tenantId: TenantId, id: PaymentId): Promise<Payment | null>;
  lockById(tenantId: TenantId, id: PaymentId): Promise<Payment | null>;
  update(payment: Payment, expectedVersion: number): Promise<void>;
}

export interface OperationRepository {
  /** Lança OperationInProgressError se já houver operação aberta no pagamento. */
  insert(operation: Operation): Promise<void>;
  findById(tenantId: TenantId, id: OperationId): Promise<Operation | null>;
  /** Uso exclusivo de processos de sistema (notificações, reconciliação, recuperação). */
  findByIdForSystem(id: OperationId): Promise<Operation | null>;
  listByPayment(tenantId: TenantId, paymentId: PaymentId): Promise<Operation[]>;
  update(operation: Operation, expectedVersion: number): Promise<void>;
  listInFlightUpdatedBefore(cutoff: Date, limit: number): Promise<Operation[]>;
}

export interface IdempotencyRecord {
  readonly tenantId: TenantId;
  readonly merchantId: MerchantId;
  readonly scope: string;
  readonly key: string;
  readonly requestHash: string;
  readonly resourceType: 'payment' | 'operation';
  readonly resourceId: string;
  readonly responseStatus: number;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export type ClaimResult = { readonly claimed: true } | { readonly claimed: false; readonly existing: IdempotencyRecord };

export interface IdempotencyRepository {
  /**
   * Reserva a chave (tenant, estabelecimento, escopo, chave). Se ela já existir,
   * devolve o registro existente. Sob concorrência, só uma transação consegue
   * reservar; as demais recebem o registro depois que a primeira confirmar.
   */
  claim(record: IdempotencyRecord): Promise<ClaimResult>;
}

export interface AuditRepository {
  append(event: AuditEventInput): Promise<AuditRecord>;
}

export interface OutboxEvent {
  readonly tenantId: TenantId;
  readonly aggregateType: 'payment';
  readonly aggregateId: PaymentId;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, string | number | boolean | null>>;
  readonly occurredAt: Date;
}

export interface OutboxRepository {
  add(event: OutboxEvent): Promise<void>;
}

export interface Repositories {
  readonly payments: PaymentRepository;
  readonly operations: OperationRepository;
  readonly idempotency: IdempotencyRepository;
  readonly audit: AuditRepository;
  readonly outbox: OutboxRepository;
}

export interface UnitOfWork {
  transaction<T>(work: (repos: Repositories) => Promise<T>): Promise<T>;
}

/** Subconjunto de logger estruturado usado pela aplicação (compatível com pino). */
export interface AppLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export const NOOP_LOGGER: AppLogger = { info() {}, warn() {}, error() {} };
