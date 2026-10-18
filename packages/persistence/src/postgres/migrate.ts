import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type pg from 'pg';

const MIGRATIONS_DIR = new URL('../../migrations/', import.meta.url);
const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;
/** Chave fixa do advisory lock que impede dois migradores simultâneos. */
const MIGRATION_LOCK_KEY = 727_001;

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

/**
 * Aplica as migrações SQL versionadas em ordem, cada uma em sua transação.
 * Uma migração já aplicada cujo conteúdo mudou interrompe o processo
 * (migrações são imutáveis; corrija com uma nova migração).
 */
export async function migrate(pool: pg.Pool): Promise<MigrationResult> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => MIGRATION_FILE.test(f)).sort();
  const client = await pool.connect();
  const applied: string[] = [];
  const alreadyApplied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version text PRIMARY KEY, checksum char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const done = await client.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations');
    const checksums = new Map(done.rows.map((r) => [r.version, r.checksum]));

    for (const file of files) {
      const sql = await readFile(new URL(file, MIGRATIONS_DIR), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = checksums.get(file);
      if (previous !== undefined) {
        if (previous !== checksum) throw new Error(`migração ${file} foi alterada após ser aplicada`);
        alreadyApplied.push(file);
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    } finally {
      client.release();
    }
  }
  return { applied, alreadyApplied };
}
