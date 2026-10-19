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

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
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
    if (env.NODE_ENV === 'production') {
      if (env.TEF_PERSISTENCE === 'memory') {
        ctx.addIssue({ code: 'custom', path: ['TEF_PERSISTENCE'], message: 'memória não é permitida em produção' });
      }
      if (env.TEF_DEV_ADMIN_TOKEN_SHA256) {
        ctx.addIssue({ code: 'custom', path: ['TEF_DEV_ADMIN_TOKEN_SHA256'], message: 'o acesso administrativo local não é permitido em produção' });
      }
      if (env.TEF_PROVIDER === 'simulator') {
        ctx.addIssue({ code: 'custom', path: ['TEF_PROVIDER'], message: 'o simulador não é permitido em produção' });
      }
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

export type AppConfig = z.infer<typeof envSchema>;

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`configuração inválida: ${issues.join('; ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // Apenas caminho e mensagem — nunca o valor recebido.
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`));
  }
  return parsed.data;
}
