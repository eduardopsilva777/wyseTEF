export { migrate, type MigrationResult } from './migrate.ts';
export { createPgRepositories, loadAuditChain } from './repositories.ts';
export { createPgSimulatorLedger } from './simulator-ledger.ts';
export { createPgPool, PgUnitOfWork, type PgPoolOptions } from './unit-of-work.ts';
export {
  adoptSchema,
  DB_ROLES,
  ensurePlatformRoles,
  hardenDatabase,
  inspectRuntimeIdentity,
  scramSha256Verifier,
  type DbRoleKey,
  type IdentityReport,
  type RuntimeRole,
} from './roles.ts';
