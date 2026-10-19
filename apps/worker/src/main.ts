import { createLogger } from '@tef/observability';
import { createPgPool, createPgSimulatorLedger, PgUnitOfWork } from '@tef/persistence/postgres';
import { loadWorkerConfig, WorkerConfigError } from './config.ts';
import { createWorkerRuntime, startHealthServer } from './runtime.ts';

let config;
try {
  config = loadWorkerConfig(process.env);
} catch (error) {
  console.error(error instanceof WorkerConfigError ? error.message : 'falha ao carregar configuração do worker');
  process.exit(1);
}

const logger = createLogger(config.LOG_LEVEL, config.NODE_ENV === 'production', undefined, 'tef-worker');
const pool = createPgPool({ connectionString: config.DATABASE_URL, max: config.TEF_WORKER_BATCH + 4 });
pool.on('error', (error) => logger.error({ err: error }, 'erro em conexão ociosa do PostgreSQL'));
const uow = new PgUnitOfWork(pool);

const { worker, simulator } = createWorkerRuntime({
  uow,
  logger,
  workerId: config.workerId,
  providerTimeoutMs: config.TEF_PROVIDER_TIMEOUT_MS,
  leaseMs: config.TEF_WORKER_LEASE_MS,
  pollIntervalMs: config.TEF_WORKER_POLL_MS,
  batchSize: config.TEF_WORKER_BATCH,
  simulatorDelayMs: config.TEF_SIMULATOR_DELAY_MS,
  // Verdade do simulador no PostgreSQL: consultas após reinício continuam corretas.
  simulatorLedger: createPgSimulatorLedger(pool),
});

logger.warn({ workerId: config.workerId }, 'worker iniciado com o provedor SIMULADOR: nenhuma transação é real');
worker.start();
const health = startHealthServer(worker, config.TEF_WORKER_HEALTH_HOST, config.TEF_WORKER_HEALTH_PORT, Math.max(10_000, config.TEF_WORKER_POLL_MS * 20));
health.on('error', (error) => logger.error({ err: error }, 'falha no servidor de health check'));

let stopping = false;
const shutdown = async (signal: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'encerrando worker: aguardando a iteração em curso');
  await worker.stop();
  simulator.dispose();
  await new Promise<void>((resolve) => health.close(() => resolve()));
  await pool.end();
  logger.info({ signal }, 'worker encerrado');
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
