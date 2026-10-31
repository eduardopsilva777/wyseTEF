import { describe, expect, it } from 'vitest';
import { loadWorkerConfig, WorkerConfigError } from '../src/config.ts';

const base = { DATABASE_URL: ['postgres://u', 'senha-teste@127.0.0.1:55432/db'].join(':') };

describe('configuração do worker', () => {
  it('carrega padrões seguros em desenvolvimento', () => {
    const c = loadWorkerConfig(base);
    expect(c).toMatchObject({ TEF_WORKER_HEALTH_HOST: '127.0.0.1', TEF_WORKER_LEASE_MS: 30_000, TEF_PROVIDER: 'simulator' });
    expect(c.workerId).toMatch(/^worker-/);
  });

  it('recusa o simulador em produção', () => {
    expect(() => loadWorkerConfig({ ...base, NODE_ENV: 'production' })).toThrow(/simulador não é permitido em produção/);
  });

  it('recusa health check fora de loopback', () => {
    expect(() => loadWorkerConfig({ ...base, TEF_WORKER_HEALTH_HOST: '0.0.0.0' })).toThrow(/loopback/);
  });

  it('recusa lease menor que 2x o timeout do provedor + 1s', () => {
    expect(() => loadWorkerConfig({ ...base, TEF_PROVIDER_TIMEOUT_MS: '5000', TEF_WORKER_LEASE_MS: '10000' })).toThrow(/TEF_WORKER_LEASE_MS/);
    expect(loadWorkerConfig({ ...base, TEF_PROVIDER_TIMEOUT_MS: '5000', TEF_WORKER_LEASE_MS: '11000' }).TEF_WORKER_LEASE_MS).toBe(11_000);
  });

  it('exige DATABASE_URL e não ecoa valores nas mensagens', () => {
    expect(() => loadWorkerConfig({})).toThrow(WorkerConfigError);
    try {
      loadWorkerConfig({ ...base, TEF_WORKER_LEASE_MS: 'abc' });
    } catch (error) {
      expect((error as Error).message).not.toContain('senha-teste');
    }
  });
});

describe('perfis de ambiente no worker (ADR 0020)', () => {
  const url = (user: string, query = '') => [`postgres://${user}`, `senha-ficticia@db.interno:5432/tef${query}`].join(':');

  it('dev/test aceitam DATABASE_URL como identidade do worker (compatibilidade), preferindo TEF_WORKER_DATABASE_URL', () => {
    expect(loadWorkerConfig({ TEF_ENV: 'dev', DATABASE_URL: url('tef_app') }).databaseUrl).toBe(url('tef_app'));
    expect(loadWorkerConfig({ TEF_ENV: 'test', DATABASE_URL: url('tef_app'), TEF_WORKER_DATABASE_URL: url('tef_worker') }).databaseUrl).toBe(url('tef_worker'));
  });

  it('staging válido exige TEF_WORKER_DATABASE_URL com TLS e identidade distinta da API', () => {
    const ok = loadWorkerConfig({ TEF_ENV: 'staging', TEF_WORKER_DATABASE_URL: url('tef_worker', '?sslmode=require'), DATABASE_URL: url('tef_app', '?sslmode=require') });
    expect(ok.env.env).toBe('staging');
    expect(() => loadWorkerConfig({ TEF_ENV: 'staging', DATABASE_URL: url('tef_app', '?sslmode=require') })).toThrow(/TEF_WORKER_DATABASE_URL: obrigatório em staging/);
    expect(() => loadWorkerConfig({ TEF_ENV: 'staging', TEF_WORKER_DATABASE_URL: url('tef_worker') })).toThrow(/sslmode=require/);
    expect(() =>
      loadWorkerConfig({ TEF_ENV: 'staging', TEF_WORKER_DATABASE_URL: url('tef_app', '?sslmode=require'), DATABASE_URL: url('tef_app', '?sslmode=require') }),
    ).toThrow(/identidade de banco distinta/);
    expect(() => loadWorkerConfig({ TEF_ENV: 'staging', TEF_WORKER_DATABASE_URL: url('tef_worker', '?sslmode=require'), LOG_LEVEL: 'trace' })).toThrow(/debug\/trace/);
  });

  it('prod recusa o simulador e NODE_ENV contraditório', () => {
    expect(() => loadWorkerConfig({ TEF_ENV: 'prod', TEF_WORKER_DATABASE_URL: url('tef_worker', '?sslmode=verify-full') })).toThrow(/simulador não é permitido em produção/);
    expect(() => loadWorkerConfig({ TEF_ENV: 'dev', NODE_ENV: 'production', DATABASE_URL: url('tef_app') })).toThrow(/contradiz/);
  });
});
