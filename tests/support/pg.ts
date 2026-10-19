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
