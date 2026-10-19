import type pg from 'pg';
import { uuidv7Timestamp, type OperationId, type OperationKind } from '@tef/domain';
import type { LedgerEntry, SimulatedOutcome, SimulatorLedger } from '@tef/provider-simulator';

interface LedgerRow {
  kind: OperationKind;
  outcome: SimulatedOutcome;
  provider_reference: string;
  requires_confirmation: boolean;
}

const toEntry = (r: LedgerRow): LedgerEntry => ({
  kind: r.kind,
  outcome: r.outcome,
  providerReference: r.provider_reference,
  requiresConfirmation: r.requires_confirmation,
});

/** Livro do SIMULADOR em PostgreSQL (somente desenvolvimento/testes; dados fictícios). */
export function createPgSimulatorLedger(pool: Pick<pg.Pool, 'query'>): SimulatorLedger {
  return {
    async isAuthoritativeFor(clientReference) {
      const created = uuidv7Timestamp(clientReference);
      if (created === null) return false;
      const res = await pool.query<{ started_at: Date }>('SELECT started_at FROM simulator_ledger_meta');
      const startedAt = res.rows[0]?.started_at;
      return startedAt !== undefined && created >= startedAt.getTime();
    },
    async recordIfAbsent(clientReference: OperationId, entry) {
      await pool.query(
        `INSERT INTO simulator_ledger (client_reference, kind, outcome, provider_reference, requires_confirmation)
         VALUES ($1, $2, $3, 'SIM-' || lpad(nextval('simulator_ledger_seq')::text, 8, '0'), $4)
         ON CONFLICT (client_reference) DO NOTHING`,
        [clientReference, entry.kind, entry.outcome, entry.requiresConfirmation],
      );
      const res = await pool.query<LedgerRow>(
        `SELECT kind, outcome, provider_reference, requires_confirmation FROM simulator_ledger WHERE client_reference = $1`,
        [clientReference],
      );
      if (!res.rows[0]) throw new Error('registro do simulador ausente após gravação');
      return toEntry(res.rows[0]);
    },
    async find(clientReference) {
      const res = await pool.query<LedgerRow>(
        `SELECT kind, outcome, provider_reference, requires_confirmation FROM simulator_ledger WHERE client_reference = $1`,
        [clientReference],
      );
      return res.rows[0] ? toEntry(res.rows[0]) : null;
    },
  };
}
