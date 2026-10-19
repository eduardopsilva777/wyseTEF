import type pg from 'pg';
import type { Job, JobKind, JobRepository, JobStatus, WorkerHeartbeatRepository, TestDirectiveRepository } from '@tef/application';
import type { OperationId, PaymentId, TenantId } from '@tef/domain';

type Queryable = Pick<pg.PoolClient, 'query'>;

interface JobRow {
  id: string; kind: string; tenant_id: string; payment_id: string; operation_id: string; status: string; attempts: number;
  max_attempts: number; available_at: Date; lease_owner: string | null; lease_expires_at: Date | null; last_error_code: string | null;
  created_at: Date; updated_at: Date; completed_at: Date | null;
}

const toJob = (r: JobRow): Job => ({
  id: Number(r.id),
  kind: r.kind as JobKind,
  tenantId: r.tenant_id as TenantId,
  paymentId: r.payment_id as PaymentId,
  operationId: r.operation_id as OperationId,
  status: r.status as JobStatus,
  attempts: r.attempts,
  maxAttempts: r.max_attempts,
  availableAt: r.available_at,
  leaseOwner: r.lease_owner,
  leaseExpiresAt: r.lease_expires_at,
  lastErrorCode: r.last_error_code,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  completedAt: r.completed_at,
});

/**
 * Fila durável em PostgreSQL. A reivindicação usa FOR UPDATE SKIP LOCKED: vários
 * workers podem consultar ao mesmo tempo sem pegar a mesma tarefa.
 *
 * Relógio (ADR 0019): toda decisão temporal da fila — disponibilidade, lease, renovação,
 * conclusão, reagendamento — usa o relógio do PostgreSQL, `clock_timestamp()`, lido UMA vez
 * por comando (CTE `clk`), para que comparação e novo prazo usem o mesmo instante. Usa-se
 * `clock_timestamp()` e não `now()` porque `now()` é o início da transação: numa transação
 * que bloqueia o pagamento e espera, o prazo ficaria no passado. O processo só informa
 * durações; relógios divergentes entre hosts não antecipam nem estendem leases.
 */
export function createPgJobs(db: Queryable): JobRepository {
  return {
    async enqueue(job) {
      const res = await db.query(
        `WITH clk AS (SELECT clock_timestamp() AS now)
         INSERT INTO jobs (kind, tenant_id, payment_id, operation_id, status, max_attempts, available_at, created_at, updated_at)
         SELECT $1, $2, $3, $4, 'PENDING', $5, clk.now + make_interval(secs => $6::double precision / 1000), clk.now, clk.now FROM clk
         ON CONFLICT (operation_id, kind) WHERE status IN ('PENDING', 'RUNNING') DO NOTHING`,
        [job.kind, job.tenantId, job.paymentId, job.operationId, job.maxAttempts, Math.max(0, job.delayMs)],
      );
      return res.rowCount === 1;
    },
    async claim(workerId, limit, leaseMs) {
      const res = await db.query<JobRow>(
        `WITH clk AS (SELECT clock_timestamp() AS now)
         UPDATE jobs j
            SET status = 'RUNNING', lease_owner = $1, lease_expires_at = clk.now + make_interval(secs => $2::double precision / 1000),
                attempts = j.attempts + 1, updated_at = clk.now
           FROM clk
          WHERE j.id IN (
            SELECT q.id FROM jobs q, clk
             WHERE (q.status = 'PENDING' AND q.available_at <= clk.now)
                OR (q.status = 'RUNNING' AND q.lease_expires_at < clk.now)
             ORDER BY q.id
             LIMIT $3
             FOR UPDATE OF q SKIP LOCKED)
          RETURNING j.*`,
        [workerId, leaseMs, limit],
      );
      return res.rows.map(toJob).sort((a, b) => a.id - b.id);
    },
    async renewLease(jobId, workerId, leaseMs) {
      const res = await db.query(
        `WITH clk AS (SELECT clock_timestamp() AS now)
         UPDATE jobs SET lease_expires_at = clk.now + make_interval(secs => $3::double precision / 1000), updated_at = clk.now
           FROM clk
          WHERE id = $1 AND status = 'RUNNING' AND lease_owner = $2 AND lease_expires_at > clk.now`,
        [jobId, workerId, leaseMs],
      );
      return res.rowCount === 1;
    },
    async complete(jobId, workerId) {
      const res = await db.query(
        `WITH clk AS (SELECT clock_timestamp() AS now)
         UPDATE jobs SET status = 'DONE', lease_owner = NULL, lease_expires_at = NULL, completed_at = clk.now, updated_at = clk.now
           FROM clk
          WHERE id = $1 AND status = 'RUNNING' AND lease_owner = $2 AND lease_expires_at > clk.now`,
        [jobId, workerId],
      );
      return res.rowCount === 1;
    },
    async retryLater(jobId, workerId, delayMs, errorCode) {
      const res = await db.query<{ status: string }>(
        `WITH clk AS (SELECT clock_timestamp() AS now)
         UPDATE jobs
            SET status = CASE WHEN attempts >= max_attempts THEN 'FAILED' ELSE 'PENDING' END,
                available_at = clk.now + make_interval(secs => $3::double precision / 1000),
                lease_owner = NULL, lease_expires_at = NULL, last_error_code = $4, updated_at = clk.now,
                completed_at = CASE WHEN attempts >= max_attempts THEN clk.now ELSE NULL END
           FROM clk
          WHERE id = $1 AND status = 'RUNNING' AND lease_owner = $2 AND lease_expires_at > clk.now
          RETURNING status`,
        [jobId, workerId, Math.max(0, delayMs), errorCode],
      );
      const row = res.rows[0];
      if (!row) return 'LOST_LEASE';
      return row.status === 'FAILED' ? 'FAILED' : 'RESCHEDULED';
    },
    async makeAvailableNow(operationId, kind) {
      const res = await db.query(
        `WITH clk AS (SELECT clock_timestamp() AS now)
         UPDATE jobs SET available_at = clk.now, updated_at = clk.now
           FROM clk
          WHERE operation_id = $1 AND kind = $2 AND status = 'PENDING'`,
        [operationId, kind],
      );
      return (res.rowCount ?? 0) > 0;
    },
    async countByStatus() {
      const res = await db.query<{ status: JobStatus; n: number }>(`SELECT status, count(*)::int AS n FROM jobs GROUP BY status`);
      const counts: Record<JobStatus, number> = { PENDING: 0, RUNNING: 0, DONE: 0, FAILED: 0 };
      for (const r of res.rows) counts[r.status] = r.n;
      return counts;
    },
    async listByPayment(tenantId, paymentId) {
      const res = await db.query<JobRow>(`SELECT * FROM jobs WHERE tenant_id = $1 AND payment_id = $2 ORDER BY id`, [tenantId, paymentId]);
      return res.rows.map(toJob);
    },
  };
}

export function createPgTestDirectives(db: Queryable): TestDirectiveRepository {
  return {
    async set(paymentId, providerId, directive, now) {
      await db.query(
        `INSERT INTO provider_test_directives (payment_id, provider_id, directive, created_at) VALUES ($1, $2, $3, $4)`,
        [paymentId, providerId, directive, now],
      );
    },
    async get(paymentId) {
      const res = await db.query<{ directive: string }>(`SELECT directive FROM provider_test_directives WHERE payment_id = $1`, [paymentId]);
      return res.rows[0]?.directive ?? null;
    },
  };
}

export function createPgHeartbeats(db: Queryable): WorkerHeartbeatRepository {
  return {
    async beat(h) {
      await db.query(
        `INSERT INTO worker_heartbeats (worker_id, started_at, last_beat_at, status) VALUES ($1, $2, $3, $4)
         ON CONFLICT (worker_id) DO UPDATE SET started_at = EXCLUDED.started_at, last_beat_at = EXCLUDED.last_beat_at, status = EXCLUDED.status`,
        [h.workerId, h.startedAt, h.lastBeatAt, h.status],
      );
    },
    async list() {
      const res = await db.query<{ worker_id: string; started_at: Date; last_beat_at: Date; status: 'RUNNING' | 'STOPPING' | 'STOPPED' }>(
        `SELECT worker_id, started_at, last_beat_at, status FROM worker_heartbeats ORDER BY last_beat_at DESC LIMIT 20`,
      );
      return res.rows.map((r) => ({ workerId: r.worker_id, startedAt: r.started_at, lastBeatAt: r.last_beat_at, status: r.status }));
    },
  };
}
