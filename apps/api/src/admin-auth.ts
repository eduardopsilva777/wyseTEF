import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { adminCookiePolicy, policyFor, type CookiePolicy } from '@tef/config';

/**
 * ACESSO ADMINISTRATIVO DE DESENVOLVIMENTO LOCAL (ver docs/decisions/0015).
 *
 * - Só existe quando TEF_DEV_ADMIN_TOKEN_SHA256 está configurado e NODE_ENV não é
 *   production (a configuração recusa a combinação) e a API escuta em loopback.
 * - O operador digita o token no painel; o servidor compara o SHA-256 em tempo
 *   constante e emite uma sessão aleatória em cookie HttpOnly + SameSite=Strict.
 * - O token nunca vai para o JavaScript do painel nem para variáveis VITE_.
 * - Não é a autenticação de produção: não há usuários, MFA nem RBAC.
 */
/** Política padrão (perfil dev): cookie sem `Secure`, pois o painel local roda em http://127.0.0.1. */
export const DEV_COOKIE_POLICY: CookiePolicy = adminCookiePolicy(policyFor('dev'));
export const ADMIN_SESSION_COOKIE = DEV_COOKIE_POLICY.name;
export const ADMIN_CSRF_HEADER = 'x-tef-admin';

export interface AdminSession {
  readonly operatorId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface DevAdminAuthOptions {
  readonly tokenSha256: string;
  readonly sessionTtlMs?: number;
  readonly maxLoginAttempts?: number;
  readonly attemptWindowMs?: number;
  readonly now?: () => number;
}

export class DevAdminAuth {
  private readonly tokenHash: Buffer;
  private readonly sessionTtlMs: number;
  private readonly maxLoginAttempts: number;
  private readonly attemptWindowMs: number;
  private readonly now: () => number;
  /** Sessões guardadas pelo hash do identificador (o identificador só existe no cookie). */
  private readonly sessions = new Map<string, AdminSession>();
  private failedAttempts: number[] = [];

  constructor(options: DevAdminAuthOptions) {
    if (!/^[0-9a-f]{64}$/.test(options.tokenSha256)) throw new Error('hash do token administrativo inválido');
    this.tokenHash = Buffer.from(options.tokenSha256, 'hex');
    this.sessionTtlMs = options.sessionTtlMs ?? 8 * 60 * 60 * 1000;
    this.maxLoginAttempts = options.maxLoginAttempts ?? 10;
    this.attemptWindowMs = options.attemptWindowMs ?? 5 * 60 * 1000;
    this.now = options.now ?? (() => Date.now());
  }

  /** Retorna o identificador da sessão (para o cookie), `null` se o token não confere, ou 'RATE_LIMITED'. */
  login(token: unknown): { sessionId: string; session: AdminSession } | null | 'RATE_LIMITED' {
    const now = this.now();
    this.failedAttempts = this.failedAttempts.filter((t) => now - t < this.attemptWindowMs);
    if (this.failedAttempts.length >= this.maxLoginAttempts) return 'RATE_LIMITED';
    const presented = typeof token === 'string' && token.length >= 16 && token.length <= 256 ? token : '';
    const digest = createHash('sha256').update(presented, 'utf8').digest();
    if (!presented || !timingSafeEqual(digest, this.tokenHash)) {
      this.failedAttempts.push(now);
      return null;
    }
    this.purgeExpired(now);
    const sessionId = randomBytes(32).toString('base64url');
    const session: AdminSession = { operatorId: 'dev-admin', createdAt: now, expiresAt: now + this.sessionTtlMs };
    this.sessions.set(hashId(sessionId), session);
    return { sessionId, session };
  }

  verify(sessionId: string | undefined): AdminSession | null {
    if (!sessionId || !/^[A-Za-z0-9_-]{43}$/.test(sessionId)) return null;
    const session = this.sessions.get(hashId(sessionId));
    if (!session) return null;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(hashId(sessionId));
      return null;
    }
    return session;
  }

  logout(sessionId: string | undefined): void {
    if (sessionId) this.sessions.delete(hashId(sessionId));
  }

  get ttlSeconds(): number {
    return Math.floor(this.sessionTtlMs / 1000);
  }

  private purgeExpired(now: number): void {
    for (const [k, s] of this.sessions) if (s.expiresAt <= now) this.sessions.delete(k);
  }
}

function hashId(sessionId: string): string {
  return createHash('sha256').update(sessionId, 'utf8').digest('hex');
}

/** Leitura mínima do cabeçalho Cookie (sem dependências). */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}

const cookieAttributes = (policy: CookiePolicy): string =>
  `Path=${policy.path}; HttpOnly; SameSite=${policy.sameSite}${policy.secure ? '; Secure' : ''}`;

/**
 * Cookie da sessão administrativa conforme o perfil (ADR 0020): em staging/prod,
 * `Secure` e prefixo `__Secure-`; `HttpOnly` e `SameSite=Strict` sempre.
 */
export function sessionCookie(sessionId: string, maxAgeSeconds: number, policy: CookiePolicy = DEV_COOKIE_POLICY): string {
  return `${policy.name}=${sessionId}; ${cookieAttributes(policy)}; Max-Age=${maxAgeSeconds}`;
}

export function clearedSessionCookie(policy: CookiePolicy = DEV_COOKIE_POLICY): string {
  return `${policy.name}=; ${cookieAttributes(policy)}; Max-Age=0`;
}
