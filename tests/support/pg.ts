import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { createPgPool, migrate, PgUnitOfWork } from '@tef/persistence/postgres';
import { seedCatalog } from './catalog.ts';

export const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];
if (process.env['TEST_DATABASE_REQUIRED'] === '1' && !TEST_DATABASE_URL) {
  throw new Error('TEST_DATABASE_REQUIRED=1, mas TEST_DATABASE_URL não está definido');
}

export interface TestSchema {
  readonly pool: pg.Pool;
  readonly uow: PgUnitOfWork;
  readonly schema: string;
  cleanup(): Promise<void>;
}

/** Cria um schema isolado, aplica as migrações e popula o cadastro de teste. */
export async function createTestSchema(): Promise<TestSchema> {
  if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL ausente');
  const schema = `it_${randomBytes(6).toString('hex')}`;
  const admin = createPgPool({ connectionString: TEST_DATABASE_URL, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`); // nome gerado localmente, validado no createPgPool
  const pool = createPgPool({ connectionString: TEST_DATABASE_URL, searchPath: schema, max: 20 });
  const uow = new PgUnitOfWork(pool);
  await migrate(pool);
  await seedCatalog(uow);
  return {
    pool,
    uow,
    schema,
    async cleanup() {
      await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    },
  };
}

/**
 * Isola a fila entre testes que compartilham o schema: tarefas ainda ativas de testes
 * anteriores são encerradas (DONE), para que o worker de um teste não as reivindique.
 * Necessário porque o relógio da fila é o do banco (ADR 0019): tarefas agendadas por um
 * teste vencem, em tempo real, durante os seguintes. Não apaga histórico.
 */
export async function quiesceQueue(pool: pg.Pool): Promise<void> {
  await pool.query(
    `UPDATE jobs SET status = 'DONE', lease_owner = NULL, lease_expires_at = NULL,
            completed_at = clock_timestamp(), updated_at = clock_timestamp(), last_error_code = 'TEST_QUIESCED'
      WHERE status IN ('PENDING', 'RUNNING')`,
  );
}
