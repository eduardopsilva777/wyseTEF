/**
 * Perfis de ambiente da plataforma (ADR 0020): `dev`, `test`, `staging` e `prod`.
 *
 * O perfil é escolhido por `TEF_ENV` e governa o que cada processo aceita na
 * inicialização. Ele restringe, mas não habilita: `TEF_ENV=prod` sozinho não torna
 * a aplicação pronta para produção — só impede que recursos de desenvolvimento
 * sejam ativados por engano. Mensagens nunca ecoam valores recebidos.
 */
export const TEF_ENVS = ['dev', 'test', 'staging', 'prod'] as const;
export type TefEnv = (typeof TEF_ENVS)[number];
export type NodeEnv = 'development' | 'test' | 'production';

/** Grau de exigência da verificação da identidade de banco na inicialização. */
export type IdentityCheck = 'enforce' | 'warn' | 'off';

export interface EnvironmentPolicy {
  readonly env: TefEnv;
  /** NODE_ENV coerente com o perfil (bibliotecas o consultam). */
  readonly nodeEnv: NodeEnv;
  /** Persistência em memória (perde dados, sem worker). */
  readonly allowMemoryPersistence: boolean;
  /** Provedor SIMULATOR (nenhuma transação real). */
  readonly allowSimulator: boolean;
  /** Acesso administrativo de desenvolvimento (TEF_DEV_ADMIN_TOKEN_SHA256, ADR 0015). */
  readonly allowDevAdminToken: boolean;
  /** Credenciais de integração com keyId de desenvolvimento ("dev-…"). */
  readonly allowDevCredentials: boolean;
  /** Cookies de sessão exigem `Secure` (e, portanto, HTTPS). */
  readonly requireSecureCookies: boolean;
  /** `sslmode` mínimo exigido nas URLs do PostgreSQL; `null` = não exigido. */
  readonly minimumDbSslMode: 'require' | 'verify-full' | null;
  /** A API e o worker precisam usar identidades distintas e restritas (tef_app / tef_worker). */
  readonly identityCheck: IdentityCheck;
  /** Níveis de log que podem registrar detalhes demais. */
  readonly allowVerboseLogs: boolean;
}

const POLICIES: Readonly<Record<TefEnv, EnvironmentPolicy>> = {
  dev: {
    env: 'dev',
    nodeEnv: 'development',
    allowMemoryPersistence: true,
    allowSimulator: true,
    allowDevAdminToken: true,
    allowDevCredentials: true,
    requireSecureCookies: false,
    minimumDbSslMode: null,
    identityCheck: 'warn',
    allowVerboseLogs: true,
  },
  test: {
    env: 'test',
    nodeEnv: 'test',
    allowMemoryPersistence: true,
    allowSimulator: true,
    allowDevAdminToken: true,
    allowDevCredentials: true,
    requireSecureCookies: false,
    minimumDbSslMode: null,
    identityCheck: 'off',
    allowVerboseLogs: true,
  },
  // Homologação: sem recursos de desenvolvimento; o simulador continua permitido
  // porque ainda não há provedor real (as respostas marcam `simulated: true`).
  staging: {
    env: 'staging',
    nodeEnv: 'production',
    allowMemoryPersistence: false,
    allowSimulator: true,
    allowDevAdminToken: false,
    allowDevCredentials: false,
    requireSecureCookies: true,
    minimumDbSslMode: 'require',
    identityCheck: 'enforce',
    allowVerboseLogs: false,
  },
  prod: {
    env: 'prod',
    nodeEnv: 'production',
    allowMemoryPersistence: false,
    allowSimulator: false,
    allowDevAdminToken: false,
    allowDevCredentials: false,
    requireSecureCookies: true,
    minimumDbSslMode: 'verify-full',
    identityCheck: 'enforce',
    allowVerboseLogs: false,
  },
};

export class EnvironmentError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`perfil de ambiente inválido: ${issues.join('; ')}`);
    this.name = 'EnvironmentError';
    this.issues = issues;
  }
}

/**
 * Resolve o perfil a partir de `TEF_ENV` e `NODE_ENV`.
 * - Sem `TEF_ENV`: `NODE_ENV=production` resolve para `prod` (o mais restritivo, por
 *   segurança); `test` para `test`; qualquer outro valor para `dev`.
 * - Com ambos definidos, combinações contraditórias são recusadas (ex.: `TEF_ENV=dev`
 *   com `NODE_ENV=production`).
 */
export function resolveEnvironment(env: Readonly<Record<string, string | undefined>>): EnvironmentPolicy {
  const rawTef = env['TEF_ENV'];
  const rawNode = env['NODE_ENV'];
  const issues: string[] = [];
  if (rawTef !== undefined && !(TEF_ENVS as readonly string[]).includes(rawTef)) issues.push(`TEF_ENV: use ${TEF_ENVS.join(', ')}`);
  if (rawNode !== undefined && !['development', 'test', 'production'].includes(rawNode)) issues.push('NODE_ENV: use development, test ou production');
  if (issues.length) throw new EnvironmentError(issues);

  const tef: TefEnv = (rawTef as TefEnv | undefined) ?? (rawNode === 'production' ? 'prod' : rawNode === 'test' ? 'test' : 'dev');
  const policy = POLICIES[tef];
  if (rawNode !== undefined && rawNode !== policy.nodeEnv) {
    throw new EnvironmentError([`NODE_ENV=${rawNode} contradiz TEF_ENV=${tef} (esperado ${policy.nodeEnv})`]);
  }
  return policy;
}

export function policyFor(env: TefEnv): EnvironmentPolicy {
  return POLICIES[env];
}

const SSL_STRENGTH: Readonly<Record<string, number>> = { disable: 0, allow: 1, prefer: 2, require: 3, 'verify-ca': 4, 'verify-full': 5 };

/**
 * Verifica uma URL do PostgreSQL contra o perfil (sem ecoar a URL): protocolo e
 * `sslmode` mínimo. Retorna as violações encontradas.
 */
export function checkDatabaseUrl(name: string, url: string, policy: EnvironmentPolicy): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [`${name}: URL inválida`];
  }
  const issues: string[] = [];
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') issues.push(`${name}: use postgres://`);
  if (!parsed.username) issues.push(`${name}: informe o usuário (identidade de banco)`);
  if (policy.minimumDbSslMode) {
    const mode = parsed.searchParams.get('sslmode') ?? 'disable';
    if ((SSL_STRENGTH[mode] ?? -1) < SSL_STRENGTH[policy.minimumDbSslMode]!) {
      issues.push(`${name}: em ${policy.env} exige sslmode=${policy.minimumDbSslMode} ou mais forte`);
    }
  }
  return issues;
}

/** Usuário da URL (para comparar identidades sem expor senhas). */
export function databaseUser(url: string): string | null {
  try {
    return decodeURIComponent(new URL(url).username) || null;
  } catch {
    return null;
  }
}

export interface CookiePolicy {
  readonly name: string;
  readonly secure: boolean;
  readonly sameSite: 'Strict';
  readonly path: string;
}

/**
 * Política do cookie de sessão administrativa. Em `staging` e `prod`, `Secure` é
 * obrigatório e o nome usa o prefixo `__Secure-` (o navegador recusa o cookie fora
 * de HTTPS). `SameSite=Strict` e `HttpOnly` valem em todos os perfis.
 */
export function adminCookiePolicy(policy: EnvironmentPolicy): CookiePolicy {
  return policy.requireSecureCookies
    ? { name: '__Secure-tef_admin', secure: true, sameSite: 'Strict', path: '/admin' }
    : { name: 'tef_dev_admin', secure: false, sameSite: 'Strict', path: '/admin' };
}
