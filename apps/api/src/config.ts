import { checkDatabaseUrl, EnvironmentError, resolveEnvironment, type EnvironmentPolicy } from '@tef/config';
import { z } from 'zod';

/**
 * Configuração por ambiente, validada na inicialização. Segredos (DATABASE_URL,
 * hashes de chaves) vêm de variáveis de ambiente ou de um cofre; nunca do código.
 * Mensagens de erro de configuração NUNCA ecoam os valores recebidos.
 */
const credentialSchema = z.object({
  keyId: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
  keySha256: z.string().regex(/^[0-9a-f]{64}$/),
  tenantId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/),
  merchantIds: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/)).min(1),
});

export type ApiCredential = z.infer<typeof credentialSchema>;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const LOCAL_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}$/;

/** keyId gerado pelo dev:setup e convenção para credenciais de desenvolvimento. */
const DEV_KEY_ID = /^dev[-_]/i;
const VERBOSE_LEVELS = new Set(['debug', 'trace']);

const buildSchema = (policy: EnvironmentPolicy) =>
  z
  .object({
    TEF_ENV: z.enum(['dev', 'test', 'staging', 'prod']).optional(),
    NODE_ENV: z.enum(['development', 'test', 'production']).optional(),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    TEF_PERSISTENCE: z.enum(['memory', 'postgres']).default('postgres'),
    DATABASE_URL: z.string().min(1).optional(),
    TEF_PROVIDER: z.literal('simulator').default('simulator'),
    TEF_PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(100).max(300_000).default(5_000),
    TEF_API_CREDENTIALS: z
      .string()
      .min(2)
      .transform((raw, ctx) => {
        try {
          return JSON.parse(raw) as unknown;
        } catch {
          ctx.addIssue({ code: 'custom', message: 'JSON inválido' });
          return z.NEVER;
        }
      })
      .pipe(z.array(credentialSchema).min(1)),
    /**
     * Acesso administrativo do PAINEL LOCAL (somente desenvolvimento). Guarde apenas o
     * SHA-256 do token; o token é digitado no painel e nunca vai para o JavaScript.
     */
    TEF_DEV_ADMIN_TOKEN_SHA256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    TEF_ADMIN_ALLOWED_ORIGINS: z
      .string()
      .default('http://127.0.0.1:5173,http://localhost:5173')
      .transform((v) => v.split(',').map((o) => o.trim()).filter(Boolean)),
  })
  .superRefine((env, ctx) => {
    if (env.TEF_PERSISTENCE === 'postgres' && !env.DATABASE_URL) {
      ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: 'obrigatório com TEF_PERSISTENCE=postgres' });
    }
    const where = policy.env === 'prod' ? 'produção' : policy.env;
    if (env.TEF_PERSISTENCE === 'memory' && !policy.allowMemoryPersistence) {
      ctx.addIssue({ code: 'custom', path: ['TEF_PERSISTENCE'], message: `memória não é permitida em ${where}` });
    }
    if (env.TEF_DEV_ADMIN_TOKEN_SHA256 && !policy.allowDevAdminToken) {
      ctx.addIssue({ code: 'custom', path: ['TEF_DEV_ADMIN_TOKEN_SHA256'], message: `o acesso administrativo local não é permitido em ${where}` });
    }
    if (env.TEF_PROVIDER === 'simulator' && !policy.allowSimulator) {
      ctx.addIssue({ code: 'custom', path: ['TEF_PROVIDER'], message: `o simulador não é permitido em ${where}` });
    }
    if (VERBOSE_LEVELS.has(env.LOG_LEVEL) && !policy.allowVerboseLogs) {
      ctx.addIssue({ code: 'custom', path: ['LOG_LEVEL'], message: `debug/trace não são permitidos em ${where}` });
    }
    if (env.DATABASE_URL) {
      for (const message of checkDatabaseUrl('DATABASE_URL', env.DATABASE_URL, policy)) ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message });
    }
    if (!policy.allowDevCredentials && env.TEF_API_CREDENTIALS.some((c) => DEV_KEY_ID.test(c.keyId))) {
      ctx.addIssue({ code: 'custom', path: ['TEF_API_CREDENTIALS'], message: `credencial de desenvolvimento (keyId dev-…) não é permitida em ${where}` });
    }
    // F1: sem autenticação definitiva nem limite de taxa, a API só escuta em loopback.
    if (!LOOPBACK_HOSTS.has(env.HOST)) {
      ctx.addIssue({ code: 'custom', path: ['HOST'], message: 'nesta fase a API só pode escutar em loopback (127.0.0.1, ::1, localhost)' });
    }
    for (const origin of env.TEF_ADMIN_ALLOWED_ORIGINS) {
      if (!LOCAL_ORIGIN.test(origin)) {
        ctx.addIssue({ code: 'custom', path: ['TEF_ADMIN_ALLOWED_ORIGINS'], message: 'apenas origens locais (loopback) são aceitas nesta fase' });
      }
    }
    const ids = env.TEF_API_CREDENTIALS.map((c) => c.keyId);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', path: ['TEF_API_CREDENTIALS'], message: 'keyId duplicado' });
    }
  });

export type AppConfig = z.infer<ReturnType<typeof buildSchema>> & {
  /** Perfil resolvido (TEF_ENV) e sua política. */
  readonly env: EnvironmentPolicy;
  readonly NODE_ENV: EnvironmentPolicy['nodeEnv'];
};

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`configuração inválida: ${issues.join('; ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  let policy: EnvironmentPolicy;
  try {
    policy = resolveEnvironment(env);
  } catch (error) {
    throw new ConfigError(error instanceof EnvironmentError ? error.issues : ['perfil de ambiente inválido']);
  }
  const parsed = buildSchema(policy).safeParse(env);
  if (!parsed.success) {
    // Apenas caminho e mensagem — nunca o valor recebido.
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`));
  }
  return { ...parsed.data, env: policy, NODE_ENV: policy.nodeEnv };
}
