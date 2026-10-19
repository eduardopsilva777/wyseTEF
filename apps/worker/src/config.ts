import { hostname } from 'node:os';
import { z } from 'zod';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/** Configuração do worker. O worker exige PostgreSQL: a fila precisa ser durável. */
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    DATABASE_URL: z.string().min(1),
    TEF_PROVIDER: z.literal('simulator').default('simulator'),
    TEF_PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(100).max(300_000).default(5_000),
    TEF_WORKER_ID: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/).optional(),
    TEF_WORKER_LEASE_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(30_000),
    TEF_WORKER_POLL_MS: z.coerce.number().int().min(50).max(60_000).default(500),
    TEF_WORKER_BATCH: z.coerce.number().int().min(1).max(100).default(10),
    TEF_WORKER_HEALTH_HOST: z.string().default('127.0.0.1'),
    TEF_WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    /** Atraso do cenário DELAYED_RESPONSE do simulador (precisa ser maior que o timeout para gerar UNKNOWN). */
    TEF_SIMULATOR_DELAY_MS: z.coerce.number().int().min(0).max(120_000).default(8_000),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.TEF_PROVIDER === 'simulator') {
      ctx.addIssue({ code: 'custom', path: ['TEF_PROVIDER'], message: 'o simulador não é permitido em produção' });
    }
    if (!LOOPBACK_HOSTS.has(env.TEF_WORKER_HEALTH_HOST)) {
      ctx.addIssue({ code: 'custom', path: ['TEF_WORKER_HEALTH_HOST'], message: 'o health check só pode escutar em loopback' });
    }
    if (env.TEF_WORKER_LEASE_MS < env.TEF_PROVIDER_TIMEOUT_MS * 2 + 1_000) {
      ctx.addIssue({ code: 'custom', path: ['TEF_WORKER_LEASE_MS'], message: 'deve ser >= 2x TEF_PROVIDER_TIMEOUT_MS + 1000' });
    }
  });

export type WorkerConfig = z.infer<typeof envSchema> & { readonly workerId: string };

export class WorkerConfigError extends Error {
  constructor(issues: readonly string[]) {
    super(`configuração inválida do worker: ${issues.join('; ')}`);
    this.name = 'WorkerConfigError';
  }
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new WorkerConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`));
  }
  const fallbackId = `worker-${hostname().replace(/[^A-Za-z0-9_.:-]/g, '-').slice(0, 40)}-${process.pid}`;
  return { ...parsed.data, workerId: parsed.data.TEF_WORKER_ID ?? fallbackId };
}
