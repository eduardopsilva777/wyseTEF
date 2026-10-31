import { AdminService, PaymentService, type UnitOfWork } from '@tef/application';
import { InMemoryUnitOfWork } from '@tef/persistence/memory';
import { createPgPool, DB_ROLES, inspectRuntimeIdentity, PgUnitOfWork } from '@tef/persistence/postgres';
import { createProviderRegistry } from '@tef/provider-contract';
import { PaymentSimulator, SIMULATOR_PROVIDER_ID } from '@tef/provider-simulator';
import { adminCookiePolicy } from '@tef/config';
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
logger.info({ tefEnv: config.env.env }, 'perfil de ambiente');

let uow: UnitOfWork;
let closeDb = async (): Promise<void> => {};
if (config.TEF_PERSISTENCE === 'postgres' && config.DATABASE_URL) {
  const pool = createPgPool({ connectionString: config.DATABASE_URL });
  // Sem este ouvinte, um erro em conexão ociosa derruba o processo e é impresso sem sanitização.
  pool.on('error', (error) => logger.error({ err: error }, 'erro em conexão ociosa do PostgreSQL'));
  uow = new PgUnitOfWork(pool);
  closeDb = () => pool.end();
  // Identidade restrita (ADR 0020): a API não pode rodar como dono do schema ou superusuário.
  if (config.env.identityCheck !== 'off') {
    const report = await inspectRuntimeIdentity(pool, DB_ROLES.app).catch(() => ({ user: 'desconhecido', violations: ['não foi possível verificar a identidade de banco'] }));
    if (report.violations.length > 0) {
      if (config.env.identityCheck === 'enforce') {
        logger.fatal({ tefEnv: config.env.env, violations: report.violations }, 'identidade de banco da API recusada');
        await pool.end();
        process.exit(1);
      }
      logger.warn({ tefEnv: config.env.env, violations: report.violations }, 'identidade de banco da API não é a restrita (tef_app): rode npm run dev:setup e npm run db:bootstrap');
    }
  }
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
      cookie: adminCookiePolicy(config.env),
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
