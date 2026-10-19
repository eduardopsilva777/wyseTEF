import type pg from 'pg';
import type { DailyBucket, ReportingRepository, StateTotals } from '@tef/application';
import { PAYMENT_STATES, type PaymentState } from '@tef/domain';
import { AUDIT_COLUMNS, toAuditRecord, toOperation, toPayment, toSafeInt, type AuditRow, type OperationRow, type PaymentRow } from './repositories.ts';

type Queryable = Pick<pg.PoolClient, 'query'>;

function likePattern(q: string | undefined): string | null {
  if (!q?.trim()) return null;
  return `%${q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const PAYMENT_COLUMNS =
  'id, tenant_id, merchant_id, terminal_id, external_reference, provider_id, currency, amount_cents, reversed_cents, state, state_reason, version, created_at, updated_at';

/** Consultas de leitura do painel. Todas parametrizadas; filtros opcionais via `$n IS NULL OR ...`. */
export function createPgReporting(db: Queryable): ReportingRepository {
  return {
    async dashboard(filter, window) {
      const params = [filter.customerId ?? null, filter.from ?? null, filter.to ?? null];
      const scope = `($1::text IS NULL OR p.tenant_id = $1)
                 AND ($2::timestamptz IS NULL OR p.created_at >= $2)
                 AND ($3::timestamptz IS NULL OR p.created_at <= $3)`;
      const states = await db.query<{ state: PaymentState; n: number; amount: string; reversed: string }>(
        `SELECT p.state, count(*)::int AS n, coalesce(sum(p.amount_cents), 0)::text AS amount, coalesce(sum(p.reversed_cents), 0)::text AS reversed
           FROM payments p WHERE ${scope} GROUP BY p.state`,
        params,
      );
      const byState = Object.fromEntries(
        PAYMENT_STATES.map((st) => [st, { count: 0, amountCents: 0, reversedCents: 0 } satisfies StateTotals]),
      ) as Record<PaymentState, StateTotals>;
      for (const r of states.rows) {
        byState[r.state] = { count: r.n, amountCents: toSafeInt(r.amount), reversedCents: toSafeInt(r.reversed) };
      }
      const unknown = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM payment_operations o JOIN payments p ON p.id = o.payment_id
          WHERE o.status = 'UNKNOWN' AND ${scope}`,
        params,
      );
      const daily = await db.query<DailyBucket>(
        `SELECT to_char((p.created_at AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD') AS day,
                count(*) FILTER (WHERE p.state IN ('APPROVED', 'REVERSED'))::int AS approved,
                count(*) FILTER (WHERE p.state = 'DECLINED')::int AS declined,
                count(*) FILTER (WHERE p.state NOT IN ('APPROVED', 'REVERSED', 'DECLINED'))::int AS other
           FROM payments p
          WHERE ($1::text IS NULL OR p.tenant_id = $1) AND p.created_at >= $2 AND p.created_at <= $3
          GROUP BY 1 ORDER BY 1`,
        [filter.customerId ?? null, window.from, window.to],
      );
      return { byState, unknownOperations: unknown.rows[0]?.n ?? 0, daily: daily.rows };
    },
    async listPayments(f) {
      const res = await db.query<PaymentRow>(
        `SELECT ${PAYMENT_COLUMNS} FROM payments
          WHERE ($1::text IS NULL OR tenant_id = $1)
            AND ($2::text IS NULL OR merchant_id = $2)
            AND ($3::text IS NULL OR state = $3)
            AND ($4::timestamptz IS NULL OR created_at >= $4)
            AND ($5::timestamptz IS NULL OR created_at <= $5)
            AND ($6::text IS NULL OR id ILIKE $6 OR external_reference ILIKE $6 OR terminal_id ILIKE $6)
          ORDER BY created_at DESC, id DESC LIMIT $7`,
        [f.customerId ?? null, f.merchantId ?? null, f.state ?? null, f.from ?? null, f.to ?? null, likePattern(f.q), f.limit],
      );
      return res.rows.map(toPayment);
    },
    async listAudit(f) {
      const res = await db.query<AuditRow>(
        `SELECT ${AUDIT_COLUMNS} FROM audit_events
          WHERE ($1::text IS NULL OR tenant_id = $1)
            AND ($2::text IS NULL OR resource_type = $2)
            AND ($3::text IS NULL OR resource_id = $3)
          ORDER BY occurred_at DESC, seq DESC LIMIT $4`,
        [f.tenantId ?? null, f.resourceType ?? null, f.resourceId ?? null, f.limit],
      );
      return res.rows.map(toAuditRecord);
    },
    async auditChain(tenantId) {
      const res = await db.query<AuditRow>(`SELECT ${AUDIT_COLUMNS} FROM audit_events WHERE tenant_id = $1 ORDER BY seq`, [tenantId]);
      return res.rows.map(toAuditRecord);
    },
    async listUnknownOperations(limit) {
      const res = await db.query<OperationRow>(
        `SELECT id, payment_id, tenant_id, kind, status, amount_cents, currency, provider_reference, result_code, requires_confirmation,
                evidence, version, created_at, updated_at
           FROM payment_operations WHERE status = 'UNKNOWN' ORDER BY updated_at LIMIT $1`,
        [limit],
      );
      return res.rows.map(toOperation);
    },
  };
}
