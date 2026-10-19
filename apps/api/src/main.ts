import { AdminService, PaymentService, type UnitOfWork } from '@tef/application';
import { InMemoryUnitOfWork } from '@tef/persistence/memory';
import { createPgPool, PgUnitOfWork } from '@tef/persistence/postgres';
import { createProviderRegistry } from '@tef/provider-contract';
import { PaymentSimulator, SIMULATOR_PROVIDER_ID } from '@tef/provider-simulator';
import { DevAdminAuth } from './admin-auth.ts';
import { buildApp } from './app.ts';
import { createAuthenticator } from './auth.ts';
import { ConfigError, loadConfig } from './config.ts';
import { createLogger } from './logging.ts';

let config;
try {
  config = loadConfig(process.env);
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : 'falha ao carregar configuração');
  process.exit(1);
}

const logger = createLogger(config.LOG_LEVEL, config.NODE_ENV === 'production');

let uow: UnitOfWork;
let closeDb = async (): Promise<void> => {};
if (config.TEF_PERSISTENCE === 'postgres' && config.DATABASE_URL) {
  const pool = createPgPool({ connectionString: config.DATABASE_URL });
  // Sem este ouvinte, um erro em conexão ociosa derruba o processo e é impresso sem sanitização.
  pool.on('error', (error) => logger.error({ err: error }, 'erro em conexão ociosa do PostgreSQL'));
  uow = new PgUnitOfWork(pool);
  closeDb = () => pool.end();
} else {
  logger.warn({}, 'persistência EM MEMÓRIA: dados são perdidos ao reiniciar e não há worker (somente desenvolvimento)');
  uow = new InMemoryUnitOfWork();
}

// A API não executa operações: só as aceita (202). O worker (apps/worker) as processa.
// O simulador é registrado aqui apenas para expor identidade e capacidades.
const providers = createProviderRegistry([new PaymentSimulator()]);
logger.warn({ providerId: SIMULATOR_PROVIDER_ID }, 'provedor SIMULADOR ativo: nenhuma transação é real');

const service = new PaymentService({ uow, providers, providerTimeoutMs: config.TEF_PROVIDER_TIMEOUT_MS, logger });

const admin = config.TEF_DEV_ADMIN_TOKEN_SHA256
  ? {
      auth: new DevAdminAuth({ tokenSha256: config.TEF_DEV_ADMIN_TOKEN_SHA256 }),
      service: new AdminService({ uow, providers }),
      allowedOrigins: config.TEF_ADMIN_ALLOWED_ORIGINS,
    }
  : undefined;
if (admin) {
  logger.warn({ mode: 'DEV_LOCAL_ADMIN' }, 'painel administrativo LOCAL habilitado (somente desenvolvimento; não é autenticação de produção)');
}

const app = buildApp({
  service,
  providers,
  authenticate: createAuthenticator(config.TEF_API_CREDENTIALS),
  logger,
  ...(admin ? { admin } : {}),
});

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, 'encerrando');
  await app.close();
  await closeDb();
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  logger.fatal({ err: error }, 'falha ao iniciar a API');
  await shutdown('startup-failure');
  process.exitCode = 1;
}
