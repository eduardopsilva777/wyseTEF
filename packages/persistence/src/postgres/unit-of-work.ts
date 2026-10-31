import pg from 'pg';
import type { Repositories, UnitOfWork } from '@tef/application';
import { createPgRepositories } from './repositories.ts';

export interface PgPoolOptions {
  readonly connectionString: string;
  readonly max?: number;
  /** Apenas para testes: isola as tabelas em um schema próprio. */
  readonly searchPath?: string;
  readonly statementTimeoutMs?: number;
  /**
   * Papel assumido logo na conexão (`SET ROLE`), para quando o login é um MEMBRO do papel
   * (ex.: um DBA membro de tef_owner executando migrações: os objetos criados ficam com
   * tef_owner). O login precisa ser membro do papel; o servidor recusa caso contrário.
   */
  readonly role?: string;
}

const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export function createPgPool(options: PgPoolOptions): pg.Pool {
  if (options.searchPath !== undefined && !SCHEMA_NAME.test(options.searchPath)) {
    throw new Error('nome de schema inválido');
  }
  if (options.role !== undefined && !SCHEMA_NAME.test(options.role)) {
    throw new Error('nome de papel inválido');
  }
  const settings = [
    `-c statement_timeout=${options.statementTimeoutMs ?? 10_000}`,
    ...(options.searchPath ? [`-c search_path=${options.searchPath}`] : []),
    ...(options.role ? [`-c role=${options.role}`] : []),
  ];
  return new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    options: settings.join(' '),
    application_name: 'tef-platform',
  });
}

/**
 * Cada `transaction` usa uma conexão dedicada com BEGIN/COMMIT (READ COMMITTED).
 * A consistência sob concorrência vem de: bloqueio de linha (SELECT ... FOR UPDATE)
 * no pagamento, verificação de versão nos UPDATEs e índices únicos parciais.
 */
export class PgUnitOfWork implements UnitOfWork {
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  async transaction<T>(work: (repos: Repositories) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(createPgRepositories(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // conexão possivelmente quebrada; o erro original é o relevante
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
