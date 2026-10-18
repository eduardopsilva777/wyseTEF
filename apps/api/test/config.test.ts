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
