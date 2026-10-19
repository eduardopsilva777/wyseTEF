import type pg from 'pg';
import { ConcurrencyConflictError, DuplicateCodeError, HasDependenciesError, type CatalogRepository, type Dependents } from '@tef/application';
import type {
  Customer,
  CustomerStatus,
  Merchant,
  MerchantId,
  MerchantStatus,
  ProviderId,
  TenantId,
  Terminal,
  TerminalId,
  TerminalStatus,
} from '@tef/domain';

type Queryable = Pick<pg.PoolClient, 'query'>;

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
/** ON DELETE RESTRICT gera restrict_violation (23001), não 23503. */
const RESTRICT_VIOLATION = '23001';

function pgCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** Busca textual: o termo vai como parâmetro; curingas do usuário são escapados. */
function likePattern(q: string | undefined): string | null {
  if (!q?.trim()) return null;
  return `%${q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

interface CustomerRow { id: string; legal_name: string; trade_name: string | null; status: string; version: number; created_at: Date; updated_at: Date }
interface MerchantRow { customer_id: string; id: string; name: string; city: string | null; status: string; version: number; created_at: Date; updated_at: Date }
interface TerminalRow {
  customer_id: string; id: string; merchant_id: string; label: string; provider_id: string; mode: string; status: string;
  version: number; created_at: Date; updated_at: Date;
}

const toCustomer = (r: CustomerRow): Customer => ({
  id: r.id as TenantId, legalName: r.legal_name, tradeName: r.trade_name, status: r.status as CustomerStatus,
  version: r.version, createdAt: r.created_at, updatedAt: r.updated_at,
});
const toMerchant = (r: MerchantRow): Merchant => ({
  customerId: r.customer_id as TenantId, id: r.id as MerchantId, name: r.name, city: r.city, status: r.status as MerchantStatus,
  version: r.version, createdAt: r.created_at, updatedAt: r.updated_at,
});
const toTerminal = (r: TerminalRow): Terminal => ({
  customerId: r.customer_id as TenantId, id: r.id as TerminalId, merchantId: r.merchant_id as MerchantId, label: r.label,
  providerId: r.provider_id as ProviderId, mode: 'SIMULATED', status: r.status as TerminalStatus,
  version: r.version, createdAt: r.created_at, updatedAt: r.updated_at,
});

async function count(db: Queryable, sql: string, params: unknown[]): Promise<number> {
  const res = await db.query<{ n: number }>(sql, params);
  return res.rows[0]?.n ?? 0;
}

async function insertOrDuplicate(db: Queryable, sql: string, params: unknown[], message: string): Promise<void> {
  try {
    await db.query(sql, params);
  } catch (error) {
    if (pgCode(error) === UNIQUE_VIOLATION) throw new DuplicateCodeError(message);
    throw error;
  }
}

async function deleteOrDependents(db: Queryable, sql: string, params: unknown[]): Promise<void> {
  try {
    await db.query(sql, params);
  } catch (error) {
    // Barreira final do banco (ON DELETE RESTRICT), caso um dependente surja em paralelo.
    const code = pgCode(error);
    if (code === FOREIGN_KEY_VIOLATION || code === RESTRICT_VIOLATION) {
      throw new HasDependenciesError('registro possui dependentes; desative em vez de excluir');
    }
    throw error;
  }
}

function assertUpdated(rowCount: number | null): void {
  if (rowCount !== 1) throw new ConcurrencyConflictError('cadastro alterado por outra operação');
}

export function createPgCatalog(db: Queryable): CatalogRepository {
  return {
    async insertCustomer(c) {
      await insertOrDuplicate(
        db,
        `INSERT INTO customers (id, legal_name, trade_name, status, version, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [c.id, c.legalName, c.tradeName, c.status, c.version, c.createdAt, c.updatedAt],
        'código de cliente já utilizado',
      );
    },
    async findCustomer(id) {
      const res = await db.query<CustomerRow>(`SELECT * FROM customers WHERE id = $1`, [id]);
      return res.rows[0] ? toCustomer(res.rows[0]) : null;
    },
    async listCustomers(f) {
      const res = await db.query<CustomerRow>(
        `SELECT * FROM customers
          WHERE ($1::text IS NULL OR status = $1)
            AND ($2::text IS NULL OR id ILIKE $2 OR legal_name ILIKE $2 OR trade_name ILIKE $2)
          ORDER BY legal_name, id LIMIT $3`,
        [f.status ?? null, likePattern(f.q), f.limit],
      );
      return res.rows.map(toCustomer);
    },
    async updateCustomer(c, expectedVersion) {
      const res = await db.query(
        `UPDATE customers SET legal_name = $1, trade_name = $2, status = $3, version = $4, updated_at = $5 WHERE id = $6 AND version = $7`,
        [c.legalName, c.tradeName, c.status, c.version, c.updatedAt, c.id, expectedVersion],
      );
      assertUpdated(res.rowCount);
    },
    async deleteCustomer(id) {
      await deleteOrDependents(db, `DELETE FROM customers WHERE id = $1`, [id]);
    },
    async customerDependents(id): Promise<Dependents> {
      return {
        merchants: await count(db, `SELECT count(*)::int AS n FROM merchants WHERE customer_id = $1`, [id]),
        terminals: await count(db, `SELECT count(*)::int AS n FROM terminals WHERE customer_id = $1`, [id]),
        payments: await count(db, `SELECT count(*)::int AS n FROM payments WHERE tenant_id = $1`, [id]),
      };
    },

    async insertMerchant(m) {
      await insertOrDuplicate(
        db,
        `INSERT INTO merchants (customer_id, id, name, city, status, version, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [m.customerId, m.id, m.name, m.city, m.status, m.version, m.createdAt, m.updatedAt],
        'código de estabelecimento já utilizado neste cliente',
      );
    },
    async findMerchant(customerId, id) {
      const res = await db.query<MerchantRow>(`SELECT * FROM merchants WHERE customer_id = $1 AND id = $2`, [customerId, id]);
      return res.rows[0] ? toMerchant(res.rows[0]) : null;
    },
    async listMerchants(f) {
      const res = await db.query<MerchantRow>(
        `SELECT * FROM merchants
          WHERE ($1::text IS NULL OR customer_id = $1)
            AND ($2::text IS NULL OR status = $2)
            AND ($3::text IS NULL OR id ILIKE $3 OR name ILIKE $3 OR city ILIKE $3)
          ORDER BY name, customer_id, id LIMIT $4`,
        [f.customerId ?? null, f.status ?? null, likePattern(f.q), f.limit],
      );
      return res.rows.map(toMerchant);
    },
    async updateMerchant(m, expectedVersion) {
      const res = await db.query(
        `UPDATE merchants SET name = $1, city = $2, status = $3, version = $4, updated_at = $5
          WHERE customer_id = $6 AND id = $7 AND version = $8`,
        [m.name, m.city, m.status, m.version, m.updatedAt, m.customerId, m.id, expectedVersion],
      );
      assertUpdated(res.rowCount);
    },
    async deleteMerchant(customerId, id) {
      await deleteOrDependents(db, `DELETE FROM merchants WHERE customer_id = $1 AND id = $2`, [customerId, id]);
    },
    async merchantDependents(customerId, id) {
      return {
        merchants: 0,
        terminals: await count(db, `SELECT count(*)::int AS n FROM terminals WHERE customer_id = $1 AND merchant_id = $2`, [customerId, id]),
        payments: await count(db, `SELECT count(*)::int AS n FROM payments WHERE tenant_id = $1 AND merchant_id = $2`, [customerId, id]),
      };
    },

    async insertTerminal(t) {
      await insertOrDuplicate(
        db,
        `INSERT INTO terminals (customer_id, id, merchant_id, label, provider_id, mode, status, version, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [t.customerId, t.id, t.merchantId, t.label, t.providerId, t.mode, t.status, t.version, t.createdAt, t.updatedAt],
        'código de terminal já utilizado neste cliente',
      );
    },
    async findTerminal(customerId, id) {
      const res = await db.query<TerminalRow>(`SELECT * FROM terminals WHERE customer_id = $1 AND id = $2`, [customerId, id]);
      return res.rows[0] ? toTerminal(res.rows[0]) : null;
    },
    async listTerminals(f) {
      const res = await db.query<TerminalRow>(
        `SELECT * FROM terminals
          WHERE ($1::text IS NULL OR customer_id = $1)
            AND ($2::text IS NULL OR merchant_id = $2)
            AND ($3::text IS NULL OR status = $3)
            AND ($4::text IS NULL OR id ILIKE $4 OR label ILIKE $4 OR merchant_id ILIKE $4)
          ORDER BY label, customer_id, id LIMIT $5`,
        [f.customerId ?? null, f.merchantId ?? null, f.status ?? null, likePattern(f.q), f.limit],
      );
      return res.rows.map(toTerminal);
    },
    async updateTerminal(t, expectedVersion) {
      const res = await db.query(
        `UPDATE terminals SET label = $1, status = $2, version = $3, updated_at = $4
          WHERE customer_id = $5 AND id = $6 AND version = $7`,
        [t.label, t.status, t.version, t.updatedAt, t.customerId, t.id, expectedVersion],
      );
      assertUpdated(res.rowCount);
    },
    async deleteTerminal(customerId, id) {
      await deleteOrDependents(db, `DELETE FROM terminals WHERE customer_id = $1 AND id = $2`, [customerId, id]);
    },
    async terminalDependents(customerId, id) {
      return {
        merchants: 0,
        terminals: 0,
        payments: await count(db, `SELECT count(*)::int AS n FROM payments WHERE tenant_id = $1 AND terminal_id = $2`, [customerId, id]),
      };
    },
  };
}
