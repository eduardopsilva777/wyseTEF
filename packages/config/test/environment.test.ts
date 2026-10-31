import { describe, expect, it } from 'vitest';
import { adminCookiePolicy, checkDatabaseUrl, databaseUser, EnvironmentError, policyFor, resolveEnvironment, TEF_ENVS } from '../src/index.ts';

describe('perfis de ambiente (ADR 0020)', () => {
  it('resolve TEF_ENV explícito e o NODE_ENV coerente', () => {
    expect(resolveEnvironment({ TEF_ENV: 'dev' })).toMatchObject({ env: 'dev', nodeEnv: 'development' });
    expect(resolveEnvironment({ TEF_ENV: 'test' })).toMatchObject({ env: 'test', nodeEnv: 'test' });
    expect(resolveEnvironment({ TEF_ENV: 'staging', NODE_ENV: 'production' })).toMatchObject({ env: 'staging', nodeEnv: 'production' });
    expect(resolveEnvironment({ TEF_ENV: 'prod' })).toMatchObject({ env: 'prod', nodeEnv: 'production' });
  });

  it('sem TEF_ENV: production resolve para prod (o mais restritivo); test e padrão para test/dev', () => {
    expect(resolveEnvironment({ NODE_ENV: 'production' }).env).toBe('prod');
    expect(resolveEnvironment({ NODE_ENV: 'test' }).env).toBe('test');
    expect(resolveEnvironment({}).env).toBe('dev');
  });

  it('recusa combinações contraditórias e valores desconhecidos', () => {
    expect(() => resolveEnvironment({ TEF_ENV: 'dev', NODE_ENV: 'production' })).toThrow(/contradiz/);
    expect(() => resolveEnvironment({ TEF_ENV: 'prod', NODE_ENV: 'development' })).toThrow(/contradiz/);
    expect(() => resolveEnvironment({ TEF_ENV: 'staging', NODE_ENV: 'test' })).toThrow(EnvironmentError);
    expect(() => resolveEnvironment({ TEF_ENV: 'production' })).toThrow(/TEF_ENV/);
    expect(() => resolveEnvironment({ NODE_ENV: 'prod' })).toThrow(/NODE_ENV/);
  });

  it('matriz de política: só dev/test aceitam recursos de desenvolvimento; só prod recusa o simulador', () => {
    const table = Object.fromEntries(
      TEF_ENVS.map((e) => {
        const p = policyFor(e);
        return [e, [p.allowDevAdminToken, p.allowMemoryPersistence, p.allowDevCredentials, p.allowSimulator, p.requireSecureCookies, p.identityCheck, p.minimumDbSslMode]];
      }),
    );
    expect(table).toEqual({
      dev: [true, true, true, true, false, 'warn', null],
      test: [true, true, true, true, false, 'off', null],
      staging: [false, false, false, true, true, 'enforce', 'require'],
      prod: [false, false, false, false, true, 'enforce', 'verify-full'],
    });
  });

  it('URLs do PostgreSQL: sslmode mínimo por perfil, sem ecoar a URL', () => {
    // URL fictícia montada em tempo de execução (sem literal com senha no repositório).
    const secret = ['postgres://tef_app', 'segredo-nao-ecoar@db.interno:5432/tef'].join(':');
    expect(checkDatabaseUrl('DATABASE_URL', secret, policyFor('dev'))).toEqual([]);
    const staging = checkDatabaseUrl('DATABASE_URL', secret, policyFor('staging'));
    expect(staging.join(' ')).toMatch(/sslmode=require/);
    expect(staging.join(' ')).not.toContain('segredo-nao-ecoar');
    expect(checkDatabaseUrl('DATABASE_URL', `${secret}?sslmode=require`, policyFor('staging'))).toEqual([]);
    expect(checkDatabaseUrl('DATABASE_URL', `${secret}?sslmode=require`, policyFor('prod')).join(' ')).toMatch(/verify-full/);
    expect(checkDatabaseUrl('DATABASE_URL', `${secret}?sslmode=verify-full`, policyFor('prod'))).toEqual([]);
    expect(checkDatabaseUrl('DATABASE_URL', 'mysql://x@y/z', policyFor('dev')).join(' ')).toMatch(/postgres:\/\//);
    expect(checkDatabaseUrl('DATABASE_URL', 'não é url', policyFor('dev'))).toEqual(['DATABASE_URL: URL inválida']);
    expect(databaseUser(secret)).toBe('tef_app');
  });

  it('cookie administrativo: Secure e __Secure- em staging/prod; SameSite=Strict sempre', () => {
    expect(adminCookiePolicy(policyFor('dev'))).toEqual({ name: 'tef_dev_admin', secure: false, sameSite: 'Strict', path: '/admin' });
    for (const e of ['staging', 'prod'] as const) {
      expect(adminCookiePolicy(policyFor(e))).toEqual({ name: '__Secure-tef_admin', secure: true, sameSite: 'Strict', path: '/admin' });
    }
  });
});
