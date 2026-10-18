import { chainAuditEvent, type AuditRecord } from '@tef/audit';
import {
  ConcurrencyConflictError,
  DuplicateReferenceError,
  type IdempotencyRecord,
  type OutboxEvent,
  type Repositories,
  type UnitOfWork,
} from '@tef/application';
import {
  OPEN_OPERATION_STATUSES,
  OperationInProgressError,
  REFERENCE_RELEASING_STATES,
  type Operation,
  type Payment,
} from '@tef/domain';

/**
 * Implementação EM MEMÓRIA, apenas para testes unitários e desenvolvimento local.
 * Emula as restrições do esquema PostgreSQL (unicidade, versão) e serializa as
 * transações com um mutex global. NÃO prova o comportamento transacional do
 * PostgreSQL — isso é verificado nos testes de integração (tests/integration).
 */
interface State {
  payments: Map<string, Payment>;
  operations: Map<string, Operation>;
  idempotency: Map<string, IdempotencyRecord>;
  auditHeads: Map<string, { seq: number; hash: string }>;
  audit: AuditRecord[];
  outbox: OutboxEvent[];
}

function emptyState(): State {
  return {
    payments: new Map(),
    operations: new Map(),
    idempotency: new Map(),
    auditHeads: new Map(),
    audit: [],
    outbox: [],
  };
}

export class InMemoryUnitOfWork implements UnitOfWork {
  private state: State = emptyState();
  private queue: Promise<void> = Promise.resolve();

  async transaction<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.queue;
    this.queue = new Promise((resolve) => (release = resolve));
    await previous;
    try {
      const draft = structuredClone(this.state);
      const result = await work(createRepositories(draft));
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

function idempotencyKeyOf(r: Pick<IdempotencyRecord, 'tenantId' | 'merchantId' | 'scope' | 'key'>): string {
  return JSON.stringify([r.tenantId, r.merchantId, r.scope, r.key]);
}

function createRepositories(s: State): Repositories {
  return {
    payments: {
      async insert(payment) {
        const conflict = [...s.payments.values()].some(
          (p) =>
            p.tenantId === payment.tenantId &&
            p.merchantId === payment.merchantId &&
            p.externalReference === payment.externalReference &&
            !REFERENCE_RELEASING_STATES.includes(p.state),
        );
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
          .filter((o) => o.status === 'IN_FLIGHT' && o.updatedAt.getTime() < cutoff.getTime())
          .slice(0, limit);
      },
    },
    idempotency: {
      async claim(record) {
        const id = idempotencyKeyOf(record);
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
        s.outbox.push(event);
      },
    },
  };
}
