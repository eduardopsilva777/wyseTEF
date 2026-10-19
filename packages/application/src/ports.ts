import type { AuditEventInput, AuditRecord } from '@tef/audit';
import type {
  Customer,
  Merchant,
  MerchantId,
  Operation,
  OperationId,
  Payment,
  PaymentId,
  PaymentState,
  ProviderId,
  TenantId,
  Terminal,
  TerminalId,
} from '@tef/domain';

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
  /**
   * Operações IN_FLIGHT com `updated_at` (instante do envio, fato de negócio) anterior a
   * `cutoff` e SEM tarefa ativa: nenhuma tarefa PENDING nem RUNNING com lease ainda válido
   * pelo relógio da fila (no PostgreSQL, `clock_timestamp()`). Enquanto um worker detém o
   * lease, a operação não é considerada abandonada, qualquer que seja o relógio de quem varre.
   */
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

export interface StoredOutboxEvent extends OutboxEvent {
  readonly id: number;
  readonly deliveryAttempts: number;
}

export interface OutboxRepository {
  add(event: OutboxEvent): Promise<void>;
  /**
   * Reivindica eventos ainda não publicados e vencidos, bloqueando-os até o fim da
   * transação (FOR UPDATE SKIP LOCKED): dois publicadores nunca pegam o mesmo evento.
   */
  claimUnpublished(limit: number, now: Date): Promise<StoredOutboxEvent[]>;
  markPublished(id: number, now: Date): Promise<void>;
  markDeliveryFailed(id: number, nextAttemptAt: Date, errorCode: string): Promise<void>;
  countUnpublished(): Promise<number>;
}

// ---------------------------------------------------------------------------
// Fila durável de tarefas
// ---------------------------------------------------------------------------
//
// Relógio da fila (ADR 0019): disponibilidade, reivindicação, lease, conclusão e
// reagendamento são decididos pelo relógio do REPOSITÓRIO — no PostgreSQL,
// `clock_timestamp()`; em memória, o relógio injetado. Os chamadores informam
// DURAÇÕES (atraso, lease), nunca instantes absolutos calculados no processo.

export type JobKind = 'EXECUTE_OPERATION' | 'RECONCILE_OPERATION';
export type JobStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED';

export interface Job {
  readonly id: number;
  readonly kind: JobKind;
  readonly tenantId: TenantId;
  readonly paymentId: PaymentId;
  readonly operationId: OperationId;
  readonly status: JobStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly availableAt: Date;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly lastErrorCode: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt: Date | null;
}

export interface NewJob {
  readonly kind: JobKind;
  readonly tenantId: TenantId;
  readonly paymentId: PaymentId;
  readonly operationId: OperationId;
  /** Atraso até a tarefa ficar disponível, contado pelo relógio da fila (0 = já). */
  readonly delayMs: number;
  readonly maxAttempts: number;
}

export type RetryResult = 'RESCHEDULED' | 'FAILED' | 'LOST_LEASE';

export interface JobRepository {
  /** Não duplica: se já houver tarefa ativa do mesmo tipo para a operação, retorna `false`. */
  enqueue(job: NewJob): Promise<boolean>;
  /**
   * Reivindica tarefas PENDING vencidas ou RUNNING com lease expirado (worker que caiu),
   * com FOR UPDATE SKIP LOCKED, e concede um lease de `leaseMs` a partir do relógio da fila.
   */
  claim(workerId: string, limit: number, leaseMs: number): Promise<Job[]>;
  /**
   * Fencing + renovação: estende o lease por `leaseMs` a partir do relógio da fila SOMENTE se
   * a tarefa ainda está RUNNING, pertence ao worker e o lease não expirou (não ressuscita lease
   * vencido). Executada na mesma transação que age sobre a operação, garante que um worker
   * que perdeu a posse não envie nada.
   */
  renewLease(jobId: number, workerId: string, leaseMs: number): Promise<boolean>;
  /** Conclui a tarefa; `false` se o worker já não detém um lease válido (fencing). */
  complete(jobId: number, workerId: string): Promise<boolean>;
  /**
   * Reagenda para daqui a `delayMs` (relógio da fila), ou marca FAILED ao atingir o máximo de
   * tentativas; `LOST_LEASE` se o worker já não detém um lease válido.
   */
  retryLater(jobId: number, workerId: string, delayMs: number, errorCode: string): Promise<RetryResult>;
  /** Antecipa uma tarefa PENDING (ex.: "reconciliar agora" no painel). `false` se não houver. */
  makeAvailableNow(operationId: OperationId, kind: JobKind): Promise<boolean>;
  countByStatus(): Promise<Record<JobStatus, number>>;
  listByPayment(tenantId: TenantId, paymentId: PaymentId): Promise<Job[]>;
}

// ---------------------------------------------------------------------------
// Cadastro
// ---------------------------------------------------------------------------

export interface CatalogListFilter {
  readonly q?: string;
  readonly status?: string;
  readonly limit: number;
}

export interface Dependents {
  readonly merchants: number;
  readonly terminals: number;
  readonly payments: number;
}

export interface CatalogRepository {
  /** Lança DuplicateCodeError se o código já existir. */
  insertCustomer(customer: Customer): Promise<void>;
  findCustomer(id: TenantId): Promise<Customer | null>;
  listCustomers(filter: CatalogListFilter): Promise<Customer[]>;
  updateCustomer(customer: Customer, expectedVersion: number): Promise<void>;
  deleteCustomer(id: TenantId): Promise<void>;
  customerDependents(id: TenantId): Promise<Dependents>;

  insertMerchant(merchant: Merchant): Promise<void>;
  findMerchant(customerId: TenantId, id: MerchantId): Promise<Merchant | null>;
  listMerchants(filter: CatalogListFilter & { readonly customerId?: TenantId }): Promise<Merchant[]>;
  updateMerchant(merchant: Merchant, expectedVersion: number): Promise<void>;
  deleteMerchant(customerId: TenantId, id: MerchantId): Promise<void>;
  merchantDependents(customerId: TenantId, id: MerchantId): Promise<Dependents>;

  insertTerminal(terminal: Terminal): Promise<void>;
  findTerminal(customerId: TenantId, id: TerminalId): Promise<Terminal | null>;
  listTerminals(filter: CatalogListFilter & { readonly customerId?: TenantId; readonly merchantId?: MerchantId }): Promise<Terminal[]>;
  updateTerminal(terminal: Terminal, expectedVersion: number): Promise<void>;
  deleteTerminal(customerId: TenantId, id: TerminalId): Promise<void>;
  terminalDependents(customerId: TenantId, id: TerminalId): Promise<Dependents>;
}

// ---------------------------------------------------------------------------
// Leituras do painel administrativo
// ---------------------------------------------------------------------------

export interface PeriodFilter {
  readonly from?: Date;
  readonly to?: Date;
  readonly customerId?: TenantId;
}

export interface StateTotals {
  readonly count: number;
  readonly amountCents: number;
  readonly reversedCents: number;
}

export interface DashboardData {
  readonly byState: Readonly<Record<PaymentState, StateTotals>>;
  readonly unknownOperations: number;
  /** Somente os dias com pagamentos, chave AAAA-MM-DD no fuso America/Sao_Paulo. */
  readonly daily: readonly DailyBucket[];
}

export interface DailyBucket {
  readonly day: string;
  readonly approved: number;
  readonly declined: number;
  readonly other: number;
}

export interface PaymentListFilter extends PeriodFilter {
  readonly merchantId?: MerchantId;
  readonly state?: PaymentState;
  readonly q?: string;
  readonly limit: number;
}

export interface AuditListFilter {
  readonly tenantId?: TenantId;
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly limit: number;
}

export interface ReportingRepository {
  dashboard(filter: PeriodFilter, dailyWindow: { readonly from: Date; readonly to: Date }): Promise<DashboardData>;
  listPayments(filter: PaymentListFilter): Promise<Payment[]>;
  listAudit(filter: AuditListFilter): Promise<AuditRecord[]>;
  auditChain(tenantId: TenantId): Promise<AuditRecord[]>;
  listUnknownOperations(limit: number): Promise<Operation[]>;
}

/** Diretiva de cenário para o simulador (somente dados fictícios de teste). */
export interface TestDirectiveRepository {
  set(paymentId: PaymentId, providerId: ProviderId, directive: string, now: Date): Promise<void>;
  get(paymentId: PaymentId): Promise<string | null>;
}

export interface WorkerHeartbeat {
  readonly workerId: string;
  readonly startedAt: Date;
  readonly lastBeatAt: Date;
  readonly status: 'RUNNING' | 'STOPPING' | 'STOPPED';
}

export interface WorkerHeartbeatRepository {
  beat(heartbeat: WorkerHeartbeat): Promise<void>;
  list(): Promise<WorkerHeartbeat[]>;
}

export interface Repositories {
  readonly payments: PaymentRepository;
  readonly operations: OperationRepository;
  readonly idempotency: IdempotencyRepository;
  readonly audit: AuditRepository;
  readonly outbox: OutboxRepository;
  readonly jobs: JobRepository;
  readonly catalog: CatalogRepository;
  readonly reporting: ReportingRepository;
  readonly testDirectives: TestDirectiveRepository;
  readonly heartbeats: WorkerHeartbeatRepository;
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
