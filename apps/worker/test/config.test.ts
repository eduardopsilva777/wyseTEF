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
