import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AdminService, PaymentService } from '@tef/application';
import { adminCookiePolicy, policyFor, type TefEnv } from '@tef/config';
import { InMemoryUnitOfWork } from '@tef/persistence/memory';
import { createProviderRegistry } from '@tef/provider-contract';
import { PaymentSimulator } from '@tef/provider-simulator';
import { DevAdminAuth } from '../src/admin-auth.ts';
import { buildApp } from '../src/app.ts';
import { createAuthenticator } from '../src/auth.ts';
import { createLogger } from '../src/logging.ts';

/**
 * Política do cookie de sessão por perfil (ADR 0020), exercitada pelas rotas reais.
 * Em staging/prod o acesso local por token é recusado na configuração; aqui o servidor é
 * montado diretamente para provar que o cookie emitido segue a política do perfil.
 */
const TOKEN = randomBytes(32).toString('base64url');
const ORIGIN = 'http://127.0.0.1:5173';

function appFor(env: TefEnv) {
  const uow = new InMemoryUnitOfWork();
  const providers = createProviderRegistry([new PaymentSimulator()]);
  return buildApp({
    service: new PaymentService({ uow, providers, providerTimeoutMs: 40 }),
    providers,
    logger: createLogger('silent', false),
    authenticate: createAuthenticator([]),
    admin: {
      auth: new DevAdminAuth({ tokenSha256: createHash('sha256').update(TOKEN).digest('hex') }),
      service: new AdminService({ uow, providers }),
      allowedOrigins: [ORIGIN],
      cookie: adminCookiePolicy(policyFor(env)),
    },
  });
}

const H = { 'x-tef-admin': '1', origin: ORIGIN };

describe('cookie da sessão administrativa por perfil (ADR 0020)', () => {
  it('dev: HttpOnly + SameSite=Strict, sem Secure (painel em http://127.0.0.1)', async () => {
    const app = appFor('dev');
    const res = await app.inject({ method: 'POST', url: '/admin/api/session', headers: H, payload: { token: TOKEN } });
    expect(String(res.headers['set-cookie'])).toMatch(/^tef_dev_admin=[A-Za-z0-9_-]{43}; Path=\/admin; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
    await app.close();
  });

  for (const env of ['staging', 'prod'] as const) {
    it(`${env}: exige Secure com prefixo __Secure-; o cookie de dev não autentica`, async () => {
      const app = appFor(env);
      const res = await app.inject({ method: 'POST', url: '/admin/api/session', headers: H, payload: { token: TOKEN } });
      const setCookie = String(res.headers['set-cookie']);
      expect(setCookie).toMatch(/^__Secure-tef_admin=[A-Za-z0-9_-]{43}; Path=\/admin; HttpOnly; SameSite=Strict; Secure; Max-Age=\d+$/);
      const id = setCookie.split(';')[0]!.split('=')[1]!;
      expect((await app.inject({ method: 'GET', url: '/admin/api/session', headers: { ...H, cookie: `__Secure-tef_admin=${id}` } })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/admin/api/session', headers: { ...H, cookie: `tef_dev_admin=${id}` } })).statusCode).toBe(401);
      const logout = await app.inject({ method: 'DELETE', url: '/admin/api/session', headers: { ...H, cookie: `__Secure-tef_admin=${id}` } });
      expect(String(logout.headers['set-cookie'])).toMatch(/^__Secure-tef_admin=; Path=\/admin; HttpOnly; SameSite=Strict; Secure; Max-Age=0$/);
      await app.close();
    });
  }
});
