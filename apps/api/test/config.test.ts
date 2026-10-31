import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.ts';

const credentials = JSON.stringify([
  { keyId: 'k1', keySha256: 'a'.repeat(64), tenantId: 'tenant-a', merchantIds: ['merchant-1'] },
]);
// URL fictícia montada em tempo de execução (evita literal com senha no repositório).
const SECRET_URL = ['postgres://usuario', 'senha-super-secreta@db.local:5432/tef'].join(':');

describe('configuração', () => {
  it('carrega configuração de desenvolvimento válida', () => {
    const config = loadConfig({ TEF_PERSISTENCE: 'memory', TEF_API_CREDENTIALS: credentials });
    expect(config.HOST).toBe('127.0.0.1');
    expect(config.TEF_PROVIDER).toBe('simulator');
  });

  it('recusa o simulador e a persistência em memória em produção', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', TEF_PERSISTENCE: 'memory', TEF_API_CREDENTIALS: credentials }))
      .toThrow(/simulador não é permitido em produção/);
    expect(() => loadConfig({ NODE_ENV: 'production', TEF_PERSISTENCE: 'memory', TEF_API_CREDENTIALS: credentials }))
      .toThrow(/memória não é permitida/);
  });

  it('recusa escutar fora de loopback nesta fase', () => {
    for (const HOST of ['0.0.0.0', '::', '192.168.0.10']) {
      expect(() => loadConfig({ HOST, TEF_PERSISTENCE: 'memory', TEF_API_CREDENTIALS: credentials })).toThrow(/loopback/);
    }
    expect(loadConfig({ HOST: '::1', TEF_PERSISTENCE: 'memory', TEF_API_CREDENTIALS: credentials }).HOST).toBe('::1');
  });

  it('exige DATABASE_URL com PostgreSQL', () => {
    expect(() => loadConfig({ TEF_PERSISTENCE: 'postgres', TEF_API_CREDENTIALS: credentials })).toThrow(ConfigError);
  });

  it('mensagens de erro não ecoam valores secretos', () => {
    try {
      loadConfig({ DATABASE_URL: SECRET_URL, PORT: 'abc', TEF_API_CREDENTIALS: '[{"keyId":"x","keySha256":"senha-super-secreta"}]' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).not.toContain('senha-super-secreta');
    }
  });

  it('rejeita credencial com hash inválido e keyId duplicado', () => {
    expect(() => loadConfig({ TEF_PERSISTENCE: 'memory', TEF_API_CREDENTIALS: '[{"keyId":"x","keySha256":"123","tenantId":"t","merchantIds":["m"]}]' }))
      .toThrow(ConfigError);
    const dup = JSON.stringify([
      { keyId: 'k1', keySha256: 'a'.repeat(64), tenantId: 't', merchantIds: ['m'] },
      { keyId: 'k1', keySha256: 'b'.repeat(64), tenantId: 't', merchantIds: ['m'] },
    ]);
    expect(() => loadConfig({ TEF_PERSISTENCE: 'memory', TEF_API_CREDENTIALS: dup })).toThrow(/keyId duplicado/);
  });
});

describe('perfis de ambiente na API (ADR 0020)', () => {
  // URLs fictícias montadas em tempo de execução.
  const url = (user: string, query = '') => [`postgres://${user}`, `senha-ficticia@db.interno:5432/tef${query}`].join(':');
  const prodCreds = JSON.stringify([{ keyId: 'cliente-1', keySha256: 'b'.repeat(64), tenantId: 'tenant-a', merchantIds: ['merchant-1'] }]);
  const devCreds = JSON.stringify([{ keyId: 'dev-local', keySha256: 'c'.repeat(64), tenantId: 'tenant-a', merchantIds: ['merchant-1'] }]);
  const staging = { TEF_ENV: 'staging', DATABASE_URL: url('tef_app', '?sslmode=require'), TEF_API_CREDENTIALS: prodCreds };

  it('dev e test: aceitam memória, token do painel e credenciais dev-*', () => {
    for (const TEF_ENV of ['dev', 'test']) {
      const c = loadConfig({ TEF_ENV, TEF_PERSISTENCE: 'memory', TEF_API_CREDENTIALS: devCreds, TEF_DEV_ADMIN_TOKEN_SHA256: 'd'.repeat(64) });
      expect(c.env.env).toBe(TEF_ENV);
    }
  });

  it('staging válido: PostgreSQL com TLS, sem recursos de desenvolvimento, simulador permitido', () => {
    const c = loadConfig(staging);
    expect(c).toMatchObject({ NODE_ENV: 'production', TEF_PROVIDER: 'simulator' });
    expect(c.env).toMatchObject({ env: 'staging', requireSecureCookies: true, identityCheck: 'enforce' });
  });

  it.each([
    ['token do painel local', { TEF_DEV_ADMIN_TOKEN_SHA256: 'd'.repeat(64) }, /acesso administrativo local não é permitido em staging/],
    ['persistência em memória', { TEF_PERSISTENCE: 'memory' }, /memória não é permitida em staging/],
    ['credencial dev-*', { TEF_API_CREDENTIALS: devCreds }, /credencial de desenvolvimento/],
    ['banco sem TLS', { DATABASE_URL: url('tef_app') }, /sslmode=require/],
    ['log debug', { LOG_LEVEL: 'debug' }, /debug\/trace não são permitidos/],
    ['NODE_ENV contraditório', { NODE_ENV: 'development' }, /contradiz/],
    ['escuta fora de loopback', { HOST: '0.0.0.0' }, /loopback/],
  ])('staging recusa %s', (_label, override, message) => {
    expect(() => loadConfig({ ...staging, ...override })).toThrow(message);
  });

  it('prod recusa o simulador (único provedor desta fase): não há configuração de prod válida ainda', () => {
    const prod = { TEF_ENV: 'prod', DATABASE_URL: url('tef_app', '?sslmode=verify-full'), TEF_API_CREDENTIALS: prodCreds };
    expect(() => loadConfig(prod)).toThrow(/o simulador não é permitido em produção/);
    expect(() => loadConfig({ ...prod, DATABASE_URL: url('tef_app', '?sslmode=require') })).toThrow(/verify-full/);
    expect(() => loadConfig({ ...prod, TEF_DEV_ADMIN_TOKEN_SHA256: 'd'.repeat(64) })).toThrow(/acesso administrativo local não é permitido em produção/);
  });

  it('erros de perfil não ecoam valores', () => {
    try {
      loadConfig({ ...staging, DATABASE_URL: url('tef_app') });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain('senha-ficticia');
    }
  });
});
