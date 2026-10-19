import type pg from 'pg';
import { chainAuditEvent, GENESIS_HASH, type AuditRecord } from '@tef/audit';
import { createPgCatalog } from './catalog.ts';
import { createPgHeartbeats, createPgJobs, createPgTestDirectives } from './jobs.ts';
import { createPgReporting } from './reporting.ts';
import {
  ConcurrencyConflictError,
  DuplicateReferenceError,
  type IdempotencyRecord,
  type Repositories,
} from '@tef/application';
import {
  money,
  OperationInProgressError,
  type Evidence,
  type EvidenceSource,
  type MerchantId,
  type Operation,
  type OperationId,
  type OperationKind,
  type OperationStatus,
  type Payment,
  type PaymentId,
  type PaymentState,
  type ProviderId,
  type TenantId,
  type TerminalId,
} from '@tef/domain';

/**
 * Repositórios PostgreSQL. Todas as consultas são parametrizadas ($1, $2...);
 * nenhum valor externo é concatenado em SQL. Consultas de negócio sempre
 * filtram por tenant_id.
 */
type Queryable = Pick<pg.PoolClient, 'query'>;

const UNIQUE_VIOLATION = '23505';

function pgErrorInfo(error: unknown): { code?: string; constraint?: string } {
  if (error && typeof error === 'object') {
    const e = error as { code?: unknown; constraint?: unknown };
    return {
      ...(typeof e.code === 'string' ? { code: e.code } : {}),
      ...(typeof e.constraint === 'string' ? { constraint: e.constraint } : {}),
    };
  }
  return {};
}

export function toSafeInt(value: string | number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n)) throw new Error('valor inteiro fora do intervalo seguro');
  return n;
}

export interface PaymentRow {
  id: string;
  tenant_id: string;
  merchant_id: string;
  terminal_id: string;
  external_reference: string;
  provider_id: string;
  currency: string;
  amount_cents: string;
  reversed_cents: string;
  state: string;
  state_reason: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface OperationRow {
  id: string;
  payment_id: string;
  tenant_id: string;
  kind: string;
  status: string;
  amount_cents: string;
  currency: string;
  provider_reference: string | null;
  result_code: string | null;
  requires_confirmation: boolean | null;
  evidence: StoredEvidence | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface StoredEvidence {
  source: string;
  observedAt: string;
  providerReference?: string;
  manual?: { resolvedBy: string; approvedBy: string; justification: string; supportingDocumentRef: string };
}

export function toPayment(r: PaymentRow): Payment {
  return {
    id: r.id as PaymentId,
    tenantId: r.tenant_id as TenantId,
    merchantId: r.merchant_id as MerchantId,
    terminalId: r.terminal_id as TerminalId,
    externalReference: r.external_reference,
    providerId: r.provider_id as ProviderId,
    amount: money(toSafeInt(r.amount_cents), r.currency.trim()),
    reversedAmount: money(toSafeInt(r.reversed_cents), r.currency.trim()),
    state: r.state as PaymentState,
    stateReason: r.state_reason,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toEvidence(stored: StoredEvidence | null): Evidence | null {
  if (!stored) return null;
  return {
    source: stored.source as EvidenceSource,
    observedAt: new Date(stored.observedAt),
    ...(stored.providerReference ? { providerReference: stored.providerReference } : {}),
    ...(stored.manual ? { manual: stored.manual } : {}),
  };
}

function fromEvidence(evidence: Evidence | null): string | null {
  if (!evidence) return null;
  const stored: StoredEvidence = {
    source: evidence.source,
    observedAt: evidence.observedAt.toISOString(),
    ...(evidence.providerReference ? { providerReference: evidence.providerReference } : {}),
    ...(evidence.manual ? { manual: { ...evidence.manual } } : {}),
  };
  return JSON.stringify(stored);
}

export function toOperation(r: OperationRow): Operation {
  return {
    id: r.id as OperationId,
    paymentId: r.payment_id as PaymentId,
    tenantId: r.tenant_id as TenantId,
    kind: r.kind as OperationKind,
    status: r.status as OperationStatus,
    amount: money(toSafeInt(r.amount_cents), r.currency.trim()),
    providerReference: r.provider_reference,
    resultCode: r.result_code,
    requiresConfirmation: r.requires_confirmation,
    evidence: toEvidence(r.evidence),
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

interface IdempotencyRow {
  tenant_id: string;
  merchant_id: string;
  scope: string;
  idem_key: string;
  request_hash: string;
  resource_type: 'payment' | 'operation';
  resource_id: string;
  response_status: number;
  created_at: Date;
  expires_at: Date;
}

function toIdempotency(r: IdempotencyRow): IdempotencyRecord {
  return {
    tenantId: r.tenant_id as TenantId,
    merchantId: r.merchant_id as MerchantId,
    scope: r.scope,
    key: r.idem_key,
    requestHash: r.request_hash,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    responseStatus: r.response_status,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  };
}

const PAYMENT_COLUMNS =
  'id, tenant_id, merchant_id, terminal_id, external_reference, provider_id, currency, amount_cents, reversed_cents, state, state_reason, version, created_at, updated_at';
const OPERATION_COLUMNS =
  'id, payment_id, tenant_id, kind, status, amount_cents, currency, provider_reference, result_code, requires_confirmation, evidence, version, created_at, updated_at';

export function createPgRepositories(db: Queryable): Repositories {
  return {
    payments: {
      async insert(p) {
        try {
          await db.query(
            `INSERT INTO payments (${PAYMENT_COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [
              p.id, p.tenantId, p.merchantId, p.terminalId, p.externalReference, p.providerId, p.amount.currency,
              p.amount.cents, p.reversedAmount.cents, p.state, p.stateReason, p.version, p.createdAt, p.updatedAt,
            ],
          );
        } catch (error) {
          const info = pgErrorInfo(error);
          if (info.code === UNIQUE_VIOLATION && info.constraint === 'payments_protected_reference_uq') {
            throw new DuplicateReferenceError('já existe cobrança protegida para esta referência comercial');
          }
          throw error;
        }
      },
      async findById(tenantId, id) {
        const res = await db.query<PaymentRow>(`SELECT ${PAYMENT_COLUMNS} FROM payments WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
        const row = res.rows[0];
        return row ? toPayment(row) : null;
      },
      async lockById(tenantId, id) {
        const res = await db.query<PaymentRow>(
          `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
          [tenantId, id],
        );
        const row = res.rows[0];
        return row ? toPayment(row) : null;
      },
      async update(p, expectedVersion) {
        const res = await db.query(
          `UPDATE payments
              SET state = $1, state_reason = $2, reversed_cents = $3, version = $4, updated_at = $5
            WHERE tenant_id = $6 AND id = $7 AND version = $8`,
          [p.state, p.stateReason, p.reversedAmount.cents, p.version, p.updatedAt, p.tenantId, p.id, expectedVersion],
        );
        if (res.rowCount !== 1 || p.version !== expectedVersion + 1) {
          throw new ConcurrencyConflictError('versão do pagamento mudou');
        }
      },
    },
    operations: {
      async insert(o) {
        try {
          await db.query(
            `INSERT INTO payment_operations (${OPERATION_COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [
              o.id, o.paymentId, o.tenantId, o.kind, o.status, o.amount.cents, o.amount.currency, o.providerReference,
              o.resultCode, o.requiresConfirmation, fromEvidence(o.evidence), o.version, o.createdAt, o.updatedAt,
            ],
          );
        } catch (error) {
          const info = pgErrorInfo(error);
          if (
            info.code === UNIQUE_VIOLATION &&
            (info.constraint === 'payment_operations_one_open_uq' || info.constraint === 'payment_operations_one_authorization_uq')
          ) {
            throw new OperationInProgressError('já existe operação aberta (ou autorização) para este pagamento');
          }
          throw error;
        }
      },
      async findById(tenantId, id) {
        const res = await db.query<OperationRow>(
          `SELECT ${OPERATION_COLUMNS} FROM payment_operations WHERE tenant_id = $1 AND id = $2`,
          [tenantId, id],
        );
        const row = res.rows[0];
        return row ? toOperation(row) : null;
      },
      async findByIdForSystem(id) {
        const res = await db.query<OperationRow>(`SELECT ${OPERATION_COLUMNS} FROM payment_operations WHERE id = $1`, [id]);
        const row = res.rows[0];
        return row ? toOperation(row) : null;
      },
      async listByPayment(tenantId, paymentId) {
        const res = await db.query<OperationRow>(
          `SELECT ${OPERATION_COLUMNS} FROM payment_operations WHERE tenant_id = $1 AND payment_id = $2 ORDER BY created_at, id`,
          [tenantId, paymentId],
        );
        return res.rows.map(toOperation);
      },
      async update(o, expectedVersion) {
        const res = await db.query(
          `UPDATE payment_operations
              SET status = $1, provider_reference = $2, result_code = $3, requires_confirmation = $4,
                  evidence = $5, version = $6, updated_at = $7
            WHERE tenant_id = $8 AND id = $9 AND version = $10`,
          [
            o.status, o.providerReference, o.resultCode, o.requiresConfirmation, fromEvidence(o.evidence),
            o.version, o.updatedAt, o.tenantId, o.id, expectedVersion,
          ],
        );
        if (res.rowCount !== 1 || o.version !== expectedVersion + 1) {
          throw new ConcurrencyConflictError('versão da operação mudou');
        }
      },
      async listInFlightUpdatedBefore(cutoff, limit) {
        const res = await db.query<OperationRow>(
          `SELECT ${OPERATION_COLUMNS} FROM payment_operations
            WHERE status = 'IN_FLIGHT' AND updated_at < $1 ORDER BY updated_at LIMIT $2`,
          [cutoff, limit],
        );
        return res.rows.map(toOperation);
      },
    },
    idempotency: {
      async claim(r) {
        // Sob concorrência, o INSERT espera a transação concorrente terminar; se ela
        // confirmar, o conflito é detectado e o registro existente é lido abaixo.
        const inserted = await db.query(
          `INSERT INTO idempotency_keys
             (tenant_id, merchant_id, scope, idem_key, request_hash, resource_type, resource_id, response_status, created_at, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (tenant_id, merchant_id, scope, idem_key) DO NOTHING`,
          [r.tenantId, r.merchantId, r.scope, r.key, r.requestHash, r.resourceType, r.resourceId, r.responseStatus, r.createdAt, r.expiresAt],
        );
        if (inserted.rowCount === 1) return { claimed: true };
        const res = await db.query<IdempotencyRow>(
          `SELECT tenant_id, merchant_id, scope, idem_key, request_hash, resource_type, resource_id, response_status, created_at, expires_at
             FROM idempotency_keys WHERE tenant_id = $1 AND merchant_id = $2 AND scope = $3 AND idem_key = $4`,
          [r.tenantId, r.merchantId, r.scope, r.key],
        );
        const row = res.rows[0];
        if (!row) throw new ConcurrencyConflictError('chave de idempotência em disputa; tente novamente');
        return { claimed: false, existing: toIdempotency(row) };
      },
    },
    audit: {
      async append(event): Promise<AuditRecord> {
        await db.query(
          `INSERT INTO audit_chain_heads (tenant_id, last_seq, last_hash) VALUES ($1, 0, $2) ON CONFLICT (tenant_id) DO NOTHING`,
          [event.tenantId, GENESIS_HASH],
        );
        // Bloqueio da cabeça da cadeia: serializa as inserções de auditoria do tenant.
        const head = await db.query<{ last_seq: string; last_hash: string }>(
          `SELECT last_seq, last_hash FROM audit_chain_heads WHERE tenant_id = $1 FOR UPDATE`,
          [event.tenantId],
        );
        const row = head.rows[0];
        if (!row) throw new Error('cabeça da cadeia de auditoria ausente');
        const seq = toSafeInt(row.last_seq);
        const record = chainAuditEvent(seq === 0 ? null : { seq, hash: row.last_hash }, event);
        await db.query(
          `INSERT INTO audit_events
             (tenant_id, seq, occurred_at, actor_type, actor_id, action, resource_type, resource_id, correlation_id, data, prev_hash, hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            record.tenantId, record.seq, record.occurredAt, record.actorType, record.actorId, record.action,
            record.resourceType, record.resourceId, record.correlationId, JSON.stringify(record.data), record.prevHash, record.hash,
          ],
        );
        await db.query(`UPDATE audit_chain_heads SET last_seq = $1, last_hash = $2 WHERE tenant_id = $3`, [
          record.seq,
          record.hash,
          record.tenantId,
        ]);
        return record;
      },
    },
    outbox: {
      async add(e) {
        await db.query(
          `INSERT INTO outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, occurred_at)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [e.tenantId, e.aggregateType, e.aggregateId, e.eventType, JSON.stringify(e.payload), e.occurredAt],
        );
      },
      async claimUnpublished(limit, now) {
        const res = await db.query<{
          id: string; tenant_id: string; aggregate_type: 'payment'; aggregate_id: string; event_type: string;
          payload: Record<string, string | number | boolean | null>; occurred_at: Date; delivery_attempts: number;
        }>(
          `SELECT id, tenant_id, aggregate_type, aggregate_id, event_type, payload, occurred_at, delivery_attempts
             FROM outbox_events
            WHERE published_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= $1)
            ORDER BY id LIMIT $2
            FOR UPDATE SKIP LOCKED`,
          [now, limit],
        );
        return res.rows.map((r) => ({
          id: toSafeInt(r.id),
          tenantId: r.tenant_id as TenantId,
          aggregateType: r.aggregate_type,
          aggregateId: r.aggregate_id as PaymentId,
          eventType: r.event_type,
          payload: r.payload,
          occurredAt: r.occurred_at,
          deliveryAttempts: r.delivery_attempts,
        }));
      },
      async markPublished(id, now) {
        await db.query(`UPDATE outbox_events SET published_at = $1, delivery_attempts = delivery_attempts + 1 WHERE id = $2`, [now, id]);
      },
      async markDeliveryFailed(id, nextAttemptAt, errorCode) {
        await db.query(
          `UPDATE outbox_events SET delivery_attempts = delivery_attempts + 1, next_attempt_at = $1, last_error_code = $2 WHERE id = $3`,
          [nextAttemptAt, errorCode, id],
        );
      },
      async countUnpublished() {
        const res = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM outbox_events WHERE published_at IS NULL`);
        return res.rows[0]?.n ?? 0;
      },
    },
    jobs: createPgJobs(db),
    catalog: createPgCatalog(db),
    reporting: createPgReporting(db),
    testDirectives: createPgTestDirectives(db),
    heartbeats: createPgHeartbeats(db),
  };
}

export interface AuditRow {
  tenant_id: string; seq: string; occurred_at: Date; actor_type: AuditRecord['actorType']; actor_id: string;
  action: string; resource_type: AuditRecord['resourceType']; resource_id: string; correlation_id: string | null;
  data: AuditRecord['data']; prev_hash: string; hash: string;
}

export const AUDIT_COLUMNS =
  'tenant_id, seq, occurred_at, actor_type, actor_id, action, resource_type, resource_id, correlation_id, data, prev_hash, hash';

export function toAuditRecord(r: AuditRow): AuditRecord {
  return {
    tenantId: r.tenant_id,
    seq: toSafeInt(r.seq),
    occurredAt: r.occurred_at,
    actorType: r.actor_type,
    actorId: r.actor_id,
    action: r.action,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    correlationId: r.correlation_id,
    data: r.data,
    prevHash: r.prev_hash,
    hash: r.hash,
  };
}

/** Leitura da cadeia de auditoria de um tenant, para verificação. */
export async function loadAuditChain(db: Queryable, tenantId: string): Promise<AuditRecord[]> {
  const res = await db.query<AuditRow>(`SELECT ${AUDIT_COLUMNS} FROM audit_events WHERE tenant_id = $1 ORDER BY seq`, [tenantId]);
  return res.rows.map(toAuditRecord);
}
