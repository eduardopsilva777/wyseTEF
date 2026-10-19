import { chainAuditEvent, type AuditRecord } from '@tef/audit';
import {
  ConcurrencyConflictError,
  DuplicateCodeError,
  DuplicateReferenceError,
  saoPauloDay,
  type DailyBucket,
  type IdempotencyRecord,
  type Job,
  type JobStatus,
  type OutboxEvent,
  type Repositories,
  type StateTotals,
  type UnitOfWork,
  type WorkerHeartbeat,
} from '@tef/application';
import {
  OPEN_OPERATION_STATUSES,
  OperationInProgressError,
  PAYMENT_STATES,
  REFERENCE_RELEASING_STATES,
  type Customer,
  type Merchant,
  type Operation,
  type Payment,
  type PaymentState,
  type Terminal,
} from '@tef/domain';

/**
 * Implementação EM MEMÓRIA, apenas para testes unitários e desenvolvimento local.
 * Emula as restrições do esquema PostgreSQL (unicidade, versão, fila com lease) e
 * serializa as transações com um mutex global. NÃO prova o comportamento
 * transacional do PostgreSQL — isso é verificado nos testes de integração.
 */
interface StoredOutbox extends OutboxEvent {
  id: number;
  deliveryAttempts: number;
  publishedAt: Date | null;
  nextAttemptAt: Date | null;
  lastErrorCode: string | null;
}

interface State {
  payments: Map<string, Payment>;
  operations: Map<string, Operation>;
  idempotency: Map<string, IdempotencyRecord>;
  auditHeads: Map<string, { seq: number; hash: string }>;
  audit: AuditRecord[];
  outbox: StoredOutbox[];
  customers: Map<string, Customer>;
  merchants: Map<string, Merchant>;
  terminals: Map<string, Terminal>;
  jobs: Job[];
  directives: Map<string, string>;
  heartbeats: Map<string, WorkerHeartbeat>;
  sequence: number;
}

function emptyState(): State {
  return {
    payments: new Map(),
    operations: new Map(),
    idempotency: new Map(),
    auditHeads: new Map(),
    audit: [],
    outbox: [],
    customers: new Map(),
    merchants: new Map(),
    terminals: new Map(),
    jobs: [],
    directives: new Map(),
    heartbeats: new Map(),
    sequence: 0,
  };
}

export interface InMemoryOptions {
  /**
   * Relógio da fila (equivale ao `clock_timestamp()` do PostgreSQL, ADR 0019). Injetável
   * para testes determinísticos; padrão: relógio do processo.
   */
  readonly clock?: () => Date;
}

export class InMemoryUnitOfWork implements UnitOfWork {
  private state: State = emptyState();
  private queue: Promise<void> = Promise.resolve();
  private readonly clock: () => Date;

  constructor(options: InMemoryOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
  }

  async transaction<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.queue;
    this.queue = new Promise((resolve) => (release = resolve));
    await previous;
    try {
      const draft = structuredClone(this.state);
      const result = await work(createRepositories(draft, this.clock));
      this.state = draft; // "commit"
      return result;
    } finally {
      release();
    }
  }

  /** Inspeção para testes. */
  snapshot(): Readonly<State> {
    return structuredClone(this.state);
  }
}

const key = (...parts: string[]): string => JSON.stringify(parts);

function matches(q: string | undefined, ...fields: (string | null)[]): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return fields.some((f) => f?.toLowerCase().includes(needle));
}

function inPeriod(date: Date, from?: Date, to?: Date): boolean {
  return (!from || date.getTime() >= from.getTime()) && (!to || date.getTime() <= to.getTime());
}

function createRepositories(s: State, clock: () => Date): Repositories {
  /** Tarefa ativa: PENDING, ou RUNNING com lease ainda válido pelo relógio da fila. */
  const activeJobFor = (operationId: string, t: number): boolean =>
    s.jobs.some(
      (j) => j.operationId === operationId && (j.status === 'PENDING' || (j.status === 'RUNNING' && (j.leaseExpiresAt?.getTime() ?? 0) > t)),
    );
  /** Mesma regra de posse do PostgreSQL: RUNNING, do worker e com lease não expirado. */
  const ownedIndex = (jobId: number, workerId: string, t: number): number =>
    s.jobs.findIndex((j) => j.id === jobId && j.status === 'RUNNING' && j.leaseOwner === workerId && (j.leaseExpiresAt?.getTime() ?? 0) > t);

  const paymentsOf = (pred: (p: Payment) => boolean): Payment[] => [...s.payments.values()].filter(pred);
  return {
    payments: {
      async insert(payment) {
        const conflict = paymentsOf(
          (p) =>
            p.tenantId === payment.tenantId &&
            p.merchantId === payment.merchantId &&
            p.externalReference === payment.externalReference &&
            !REFERENCE_RELEASING_STATES.includes(p.state),
        ).length > 0;
        if (conflict) throw new DuplicateReferenceError('já existe cobrança protegida para esta referência comercial');
        s.payments.set(payment.id, payment);
      },
      async findById(tenantId, id) {
        const p = s.payments.get(id);
        return p && p.tenantId === tenantId ? p : null;
      },
      async lockById(tenantId, id) {
        const p = s.payments.get(id);
        return p && p.tenantId === tenantId ? p : null;
      },
      async update(payment, expectedVersion) {
        const current = s.payments.get(payment.id);
        if (!current || current.version !== expectedVersion || payment.version !== expectedVersion + 1) {
          throw new ConcurrencyConflictError('versão do pagamento mudou');
        }
        s.payments.set(payment.id, payment);
      },
    },
    operations: {
      async insert(operation) {
        const ops = [...s.operations.values()].filter((o) => o.paymentId === operation.paymentId);
        if (OPEN_OPERATION_STATUSES.has(operation.status) && ops.some((o) => OPEN_OPERATION_STATUSES.has(o.status))) {
          throw new OperationInProgressError('já existe operação aberta para este pagamento');
        }
        if (operation.kind === 'AUTHORIZATION' && ops.some((o) => o.kind === 'AUTHORIZATION')) {
          throw new OperationInProgressError('pagamento já possui autorização');
        }
        s.operations.set(operation.id, operation);
      },
      async findById(tenantId, id) {
        const o = s.operations.get(id);
        return o && o.tenantId === tenantId ? o : null;
      },
      async findByIdForSystem(id) {
        return s.operations.get(id) ?? null;
      },
      async listByPayment(tenantId, paymentId) {
        return [...s.operations.values()]
          .filter((o) => o.tenantId === tenantId && o.paymentId === paymentId)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
      },
      async update(operation, expectedVersion) {
        const current = s.operations.get(operation.id);
        if (!current || current.version !== expectedVersion || operation.version !== expectedVersion + 1) {
          throw new ConcurrencyConflictError('versão da operação mudou');
        }
        s.operations.set(operation.id, operation);
      },
      async listInFlightUpdatedBefore(cutoff, limit) {
        return [...s.operations.values()]
          .filter((o) => o.status === 'IN_FLIGHT' && o.updatedAt.getTime() < cutoff.getTime() && !activeJobFor(o.id, clock().getTime()))
          .slice(0, limit);
      },
    },
    idempotency: {
      async claim(record) {
        const id = key(record.tenantId, record.merchantId, record.scope, record.key);
        const existing = s.idempotency.get(id);
        if (existing) return { claimed: false, existing };
        s.idempotency.set(id, record);
        return { claimed: true };
      },
    },
    audit: {
      async append(event) {
        const head = s.auditHeads.get(event.tenantId) ?? null;
        const record = chainAuditEvent(head, event);
        s.auditHeads.set(event.tenantId, { seq: record.seq, hash: record.hash });
        s.audit.push(record);
        return record;
      },
    },
    outbox: {
      async add(event) {
        s.outbox.push({ ...event, id: ++s.sequence, deliveryAttempts: 0, publishedAt: null, nextAttemptAt: null, lastErrorCode: null });
      },
      async claimUnpublished(limit, now) {
        return s.outbox
          .filter((e) => e.publishedAt === null && (!e.nextAttemptAt || e.nextAttemptAt.getTime() <= now.getTime()))
          .slice(0, limit)
          .map((e) => ({ ...e }));
      },
      async markPublished(id, now) {
        const e = s.outbox.find((x) => x.id === id);
        if (e) {
          e.publishedAt = now;
          e.deliveryAttempts++;
        }
      },
      async markDeliveryFailed(id, nextAttemptAt, errorCode) {
        const e = s.outbox.find((x) => x.id === id);
        if (e) {
          e.deliveryAttempts++;
          e.nextAttemptAt = nextAttemptAt;
          e.lastErrorCode = errorCode;
        }
      },
      async countUnpublished() {
        return s.outbox.filter((e) => e.publishedAt === null).length;
      },
    },
    jobs: {
      async enqueue(job) {
        const active = s.jobs.some(
          (j) => j.operationId === job.operationId && j.kind === job.kind && (j.status === 'PENDING' || j.status === 'RUNNING'),
        );
        if (active) return false;
        const now = clock();
        const { delayMs, ...rest } = job;
        s.jobs.push({
          ...rest,
          id: ++s.sequence,
          status: 'PENDING',
          attempts: 0,
          availableAt: new Date(now.getTime() + Math.max(0, delayMs)),
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: null,
          createdAt: now,
          updatedAt: now,
          completedAt: null,
        });
        return true;
      },
      async claim(workerId, limit, leaseMs) {
        const now = clock();
        const t = now.getTime();
        const claimable = s.jobs
          .filter(
            (j) =>
              (j.status === 'PENDING' && j.availableAt.getTime() <= t) ||
              (j.status === 'RUNNING' && j.leaseExpiresAt !== null && j.leaseExpiresAt.getTime() < t),
          )
          .sort((a, b) => a.id - b.id)
          .slice(0, limit);
        const claimed: Job[] = [];
        for (const job of claimable) {
          const next: Job = {
            ...job,
            status: 'RUNNING',
            attempts: job.attempts + 1,
            leaseOwner: workerId,
            leaseExpiresAt: new Date(t + leaseMs),
            updatedAt: now,
          };
          s.jobs[s.jobs.indexOf(job)] = next;
          claimed.push(next);
        }
        return claimed;
      },
      async renewLease(jobId, workerId, leaseMs) {
        const now = clock();
        const i = ownedIndex(jobId, workerId, now.getTime());
        if (i < 0) return false;
        s.jobs[i] = { ...s.jobs[i]!, leaseExpiresAt: new Date(now.getTime() + leaseMs), updatedAt: now };
        return true;
      },
      async complete(jobId, workerId) {
        const now = clock();
        const i = ownedIndex(jobId, workerId, now.getTime());
        if (i < 0) return false;
        s.jobs[i] = { ...s.jobs[i]!, status: 'DONE', leaseOwner: null, leaseExpiresAt: null, completedAt: now, updatedAt: now };
        return true;
      },
      async retryLater(jobId, workerId, delayMs, errorCode) {
        const now = clock();
        const i = ownedIndex(jobId, workerId, now.getTime());
        if (i < 0) return 'LOST_LEASE';
        const job = s.jobs[i]!;
        const failed = job.attempts >= job.maxAttempts;
        s.jobs[i] = {
          ...job,
          status: failed ? 'FAILED' : 'PENDING',
          availableAt: new Date(now.getTime() + Math.max(0, delayMs)),
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: errorCode,
          updatedAt: now,
          completedAt: failed ? now : null,
        };
        return failed ? 'FAILED' : 'RESCHEDULED';
      },
      async makeAvailableNow(operationId, kind) {
        const now = clock();
        let changed = false;
        s.jobs = s.jobs.map((j) => {
          if (j.operationId !== operationId || j.kind !== kind || j.status !== 'PENDING') return j;
          changed = true;
          return { ...j, availableAt: now, updatedAt: now };
        });
        return changed;
      },
      async countByStatus() {
        const counts: Record<JobStatus, number> = { PENDING: 0, RUNNING: 0, DONE: 0, FAILED: 0 };
        for (const j of s.jobs) counts[j.status]++;
        return counts;
      },
      async listByPayment(tenantId, paymentId) {
        return s.jobs.filter((j) => j.tenantId === tenantId && j.paymentId === paymentId);
      },
    },
    catalog: {
      async insertCustomer(c) {
        if (s.customers.has(c.id)) throw new DuplicateCodeError('código de cliente já utilizado');
        s.customers.set(c.id, c);
      },
      async findCustomer(id) {
        return s.customers.get(id) ?? null;
      },
      async listCustomers(f) {
        return [...s.customers.values()]
          .filter((c) => (!f.status || c.status === f.status) && matches(f.q, c.id, c.legalName, c.tradeName))
          .sort((a, b) => a.legalName.localeCompare(b.legalName))
          .slice(0, f.limit);
      },
      async updateCustomer(c, expectedVersion) {
        const current = s.customers.get(c.id);
        if (current?.version !== expectedVersion) throw new ConcurrencyConflictError('cadastro alterado por outra operação');
        s.customers.set(c.id, c);
      },
      async deleteCustomer(id) {
        s.customers.delete(id);
      },
      async customerDependents(id) {
        return {
          merchants: [...s.merchants.values()].filter((m) => m.customerId === id).length,
          terminals: [...s.terminals.values()].filter((t) => t.customerId === id).length,
          payments: paymentsOf((p) => p.tenantId === id).length,
        };
      },
      async insertMerchant(m) {
        const k = key(m.customerId, m.id);
        if (s.merchants.has(k)) throw new DuplicateCodeError('código de estabelecimento já utilizado neste cliente');
        s.merchants.set(k, m);
      },
      async findMerchant(customerId, id) {
        return s.merchants.get(key(customerId, id)) ?? null;
      },
      async listMerchants(f) {
        return [...s.merchants.values()]
          .filter((m) => (!f.customerId || m.customerId === f.customerId) && (!f.status || m.status === f.status) && matches(f.q, m.id, m.name, m.city))
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, f.limit);
      },
      async updateMerchant(m, expectedVersion) {
        const k = key(m.customerId, m.id);
        if (s.merchants.get(k)?.version !== expectedVersion) throw new ConcurrencyConflictError('cadastro alterado por outra operação');
        s.merchants.set(k, m);
      },
      async deleteMerchant(customerId, id) {
        s.merchants.delete(key(customerId, id));
      },
      async merchantDependents(customerId, id) {
        return {
          merchants: 0,
          terminals: [...s.terminals.values()].filter((t) => t.customerId === customerId && t.merchantId === id).length,
          payments: paymentsOf((p) => p.tenantId === customerId && p.merchantId === id).length,
        };
      },
      async insertTerminal(t) {
        const k = key(t.customerId, t.id);
        if (s.terminals.has(k)) throw new DuplicateCodeError('código de terminal já utilizado neste cliente');
        s.terminals.set(k, t);
      },
      async findTerminal(customerId, id) {
        return s.terminals.get(key(customerId, id)) ?? null;
      },
      async listTerminals(f) {
        return [...s.terminals.values()]
          .filter(
            (t) =>
              (!f.customerId || t.customerId === f.customerId) &&
              (!f.merchantId || t.merchantId === f.merchantId) &&
              (!f.status || t.status === f.status) &&
              matches(f.q, t.id, t.label, t.merchantId),
          )
          .sort((a, b) => a.label.localeCompare(b.label))
          .slice(0, f.limit);
      },
      async updateTerminal(t, expectedVersion) {
        const k = key(t.customerId, t.id);
        if (s.terminals.get(k)?.version !== expectedVersion) throw new ConcurrencyConflictError('cadastro alterado por outra operação');
        s.terminals.set(k, t);
      },
      async deleteTerminal(customerId, id) {
        s.terminals.delete(key(customerId, id));
      },
      async terminalDependents(customerId, id) {
        return { merchants: 0, terminals: 0, payments: paymentsOf((p) => p.tenantId === customerId && p.terminalId === id).length };
      },
    },
    reporting: {
      async dashboard(filter, window) {
        const scoped = paymentsOf((p) => (!filter.customerId || p.tenantId === filter.customerId) && inPeriod(p.createdAt, filter.from, filter.to));
        const byState = Object.fromEntries(
          PAYMENT_STATES.map((st) => [st, { count: 0, amountCents: 0, reversedCents: 0 } satisfies StateTotals]),
        ) as Record<PaymentState, { count: number; amountCents: number; reversedCents: number }>;
        for (const p of scoped) {
          byState[p.state].count++;
          byState[p.state].amountCents += p.amount.cents;
          byState[p.state].reversedCents += p.reversedAmount.cents;
        }
        const buckets = new Map<string, { day: string; approved: number; declined: number; other: number }>();
        for (const p of paymentsOf((x) => (!filter.customerId || x.tenantId === filter.customerId) && inPeriod(x.createdAt, window.from, window.to))) {
          const day = saoPauloDay(p.createdAt);
          const b = buckets.get(day) ?? { day, approved: 0, declined: 0, other: 0 };
          if (p.state === 'APPROVED' || p.state === 'REVERSED') b.approved++;
          else if (p.state === 'DECLINED') b.declined++;
          else b.other++;
          buckets.set(day, b);
        }
        const scopedIds = new Set<string>(scoped.map((p) => p.id));
        const unknownOperations = [...s.operations.values()].filter((o) => o.status === 'UNKNOWN' && scopedIds.has(o.paymentId)).length;
        const daily: DailyBucket[] = [...buckets.values()].sort((a, b) => a.day.localeCompare(b.day));
        return { byState, unknownOperations, daily };
      },
      async listPayments(f) {
        return paymentsOf(
          (p) =>
            (!f.customerId || p.tenantId === f.customerId) &&
            (!f.merchantId || p.merchantId === f.merchantId) &&
            (!f.state || p.state === f.state) &&
            inPeriod(p.createdAt, f.from, f.to) &&
            matches(f.q, p.id, p.externalReference, p.terminalId),
        )
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
          .slice(0, f.limit);
      },
      async listAudit(f) {
        return s.audit
          .filter(
            (r) =>
              (!f.tenantId || r.tenantId === f.tenantId) &&
              (!f.resourceType || r.resourceType === f.resourceType) &&
              (!f.resourceId || r.resourceId === f.resourceId),
          )
          .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || b.seq - a.seq)
          .slice(0, f.limit);
      },
      async auditChain(tenantId) {
        return s.audit.filter((r) => r.tenantId === tenantId).sort((a, b) => a.seq - b.seq);
      },
      async listUnknownOperations(limit) {
        return [...s.operations.values()].filter((o) => o.status === 'UNKNOWN').slice(0, limit);
      },
    },
    testDirectives: {
      async set(paymentId, _providerId, directive) {
        s.directives.set(paymentId, directive);
      },
      async get(paymentId) {
        return s.directives.get(paymentId) ?? null;
      },
    },
    heartbeats: {
      async beat(h) {
        s.heartbeats.set(h.workerId, h);
      },
      async list() {
        return [...s.heartbeats.values()];
      },
    },
  };
}
