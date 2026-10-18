import { createHash, randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PaymentService, type UnitOfWork } from '@tef/application';
import { InMemoryUnitOfWork } from '@tef/persistence/memory';
import { createProviderRegistry, type PaymentProvider } from '@tef/provider-contract';
import { PaymentSimulator, SIMULATOR_PROVIDER_ID } from '@tef/provider-simulator';
import { buildApp } from '../src/app.ts';
import { createAuthenticator } from '../src/auth.ts';
import { createLogger } from '../src/logging.ts';

/**
 * Regressões da auditoria pré-commit da F1: nenhum segredo de teste presente em
 * mensagens de erro, erros de banco ou respostas de provedor pode chegar aos
 * logs ou às respostas HTTP. Todos os "segredos" são gerados em tempo de execução.
 */
const KEY_A = randomBytes(32).toString('base64url'); // tenant-a, merchant-1 e merchant-2
const KEY_C = randomBytes(32).toString('base64url'); // tenant-a, somente merchant-1
const sha = (k: string) => createHash('sha256').update(k).digest('hex');
const TEST_PAN = ['4111', '1111', '1111', '1111'].join('');
const DB_PASSWORD = `senha-${randomBytes(8).toString('hex')}`;
const DB_URL = ['postgres://app_user', `${DB_PASSWORD}@db.interno.local:5432/tef`].join(':');
const SECRETS = () => [KEY_A, KEY_C, sha(KEY_A), DB_PASSWORD, TEST_PAN];

interface Ctx {
  app: FastifyInstance;
  logs: string[];
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

function setup(options: { uow?: UnitOfWork; providers?: PaymentProvider[]; production?: boolean } = {}): Ctx {
  const logs: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      logs.push(chunk.toString('utf8'));
      cb();
    },
  });
  const providerList = options.providers ?? [new PaymentSimulator()];
  const providers = createProviderRegistry(providerList);
  const logger = createLogger('debug', options.production ?? false, stream);
  const service = new PaymentService({ uow: options.uow ?? new InMemoryUnitOfWork(), providers, providerTimeoutMs: 50, logger });
  const app = buildApp({
    service,
    providers,
    defaultProviderId: providerList[0]!.id,
    logger,
    authenticate: createAuthenticator([
      { keyId: 'key-a', keySha256: sha(KEY_A), tenantId: 'tenant-a', merchantIds: ['merchant-1', 'merchant-2'] },
      { keyId: 'key-c', keySha256: sha(KEY_C), tenantId: 'tenant-a', merchantIds: ['merchant-1'] },
    ]),
  });
  apps.push(app);
  return { app, logs };
}

function expectNoSecrets(text: string): void {
  for (const secret of SECRETS()) expect(text).not.toContain(secret);
  expect(text).not.toMatch(/Bearer\s+[A-Za-z0-9_-]{16,}/);
}

let n = 0;
const idem = () => `audit-key-${++n}-${Date.now()}`;
const createBody = (merchantId = 'merchant-1') => ({
  merchantId,
  terminalId: 'terminal-1',
  externalReference: `ref-${++n}`,
  amount: { cents: 1_000, currency: 'BRL' },
});

/** Unidade de trabalho que falha como falharia um driver de banco com mensagem verbosa. */
function failingUow(error: unknown): UnitOfWork {
  return {
    transaction() {
      return Promise.reject(error instanceof Error ? error : new Error('falha'));
    },
  };
}

describe('auditoria: erros inesperados não vazam segredos', () => {
  it('mensagem e stack com segredos: resposta genérica e log sanitizado, com contexto de diagnóstico', async () => {
    const error = new Error(
      `connect failed for ${DB_URL} using Authorization: Bearer ${KEY_A} card=${TEST_PAN} hash ${sha(KEY_A)}`,
    );
    const { app, logs } = setup({ uow: failingUow(error) });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: { authorization: `Bearer ${KEY_A}`, 'idempotency-key': idem(), 'x-correlation-id': 'corr-audit-0001' },
      payload: createBody(),
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'erro interno; informe o correlationId ao suporte', correlationId: 'corr-audit-0001' },
    });
    expectNoSecrets(res.body);

    const output = logs.join('');
    expectNoSecrets(output);
    // Observabilidade preservada: tipo do erro, correlação e mensagem sanitizada continuam disponíveis.
    const entry = logs.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l['msg'] === 'erro inesperado');
    expect(entry).toBeDefined();
    expect(entry!['reqId']).toBe('corr-audit-0001');
    expect(entry!['err']).toMatchObject({ type: 'Error' });
    expect(String((entry!['err'] as { message: string }).message)).toContain('[REDACTED');
  });

  it('erro de banco: detail, query, parâmetros e hint nunca vão para o log; SQLSTATE e constraint vão', async () => {
    const pgLike = Object.assign(new Error('duplicate key value violates unique constraint "x_uq"'), {
      code: '23505',
      constraint: 'x_uq',
      detail: `Key (secret)=(${DB_PASSWORD}) already exists.`,
      hint: `try ${KEY_A}`,
      where: `SQL statement "SELECT '${TEST_PAN}'"`,
      query: `INSERT INTO t VALUES ('${DB_PASSWORD}')`,
      parameters: [KEY_A, TEST_PAN],
    });
    const { app, logs } = setup({ uow: failingUow(pgLike) });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: { authorization: `Bearer ${KEY_A}`, 'idempotency-key': idem() },
      payload: createBody(),
    });
    expect(res.statusCode).toBe(500);
    expectNoSecrets(res.body);
    expect(res.body).not.toContain('INSERT');
    const output = logs.join('');
    expectNoSecrets(output);
    expect(output).not.toContain('INSERT INTO');
    expect(output).toContain('"code":"23505"');
    expect(output).toContain('"constraint":"x_uq"');
  });

  it('em produção o stack não é registrado', async () => {
    const { app, logs } = setup({ uow: failingUow(new Error(`boom ${DB_URL}`)), production: true });
    await app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: { authorization: `Bearer ${KEY_A}`, 'idempotency-key': idem() },
      payload: createBody(),
    });
    const output = logs.join('');
    expectNoSecrets(output);
    expect(output).not.toContain('"stack"');
  });

  it('JSON malformado contendo segredos: 400 genérico, sem eco na resposta nem no log', async () => {
    const { app, logs } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: { authorization: `Bearer ${KEY_A}`, 'idempotency-key': idem(), 'content-type': 'application/json' },
      payload: `{"pan":"${TEST_PAN}","password":"${DB_PASSWORD}",`,
    });
    expect(res.statusCode).toBe(400);
    expectNoSecrets(res.body);
    expectNoSecrets(logs.join(''));
  });

  it('erro de validação Zod não ecoa valores', async () => {
    const { app, logs } = setup();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: { authorization: `Bearer ${KEY_A}`, 'idempotency-key': idem() },
      payload: { ...createBody(), terminalId: DB_PASSWORD, amount: { cents: TEST_PAN, currency: 'BRL' } },
    });
    expect(res.statusCode).toBe(400);
    expectNoSecrets(res.body);
    expectNoSecrets(logs.join(''));
  });
});

describe('auditoria: resultado do provedor é normalizado antes de persistir e responder', () => {
  it('código e referência com conteúdo inseguro são substituídos', async () => {
    const leaky: PaymentProvider = {
      id: SIMULATOR_PROVIDER_ID,
      kind: 'SIMULATOR',
      capabilities: new PaymentSimulator().capabilities,
      execute() {
        return Promise.resolve({
          status: 'REJECTED',
          providerReference: `REF ${TEST_PAN} ${DB_PASSWORD}`,
          resultCode: `Saldo insuficiente no cartao ${TEST_PAN} senha=${DB_PASSWORD}`,
        });
      },
      query() {
        return Promise.resolve({ status: 'NOT_FOUND' });
      },
    };
    const { app, logs } = setup({ providers: [leaky] });
    const created = await app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: { authorization: `Bearer ${KEY_A}`, 'idempotency-key': idem() },
      payload: createBody(),
    });
    const id = created.json<{ id: string }>().id;
    const res = await app.inject({
      method: 'POST',
      url: `/v1/payments/${id}/authorize`,
      headers: { authorization: `Bearer ${KEY_A}`, 'idempotency-key': idem() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      payment: { state: 'DECLINED' },
      operation: { status: 'REJECTED', resultCode: 'PROVIDER_CODE_INVALID', providerReference: null },
    });
    expectNoSecrets(res.body);
    expectNoSecrets(logs.join(''));
  });
});

describe('auditoria: autenticação e exposição', () => {
  it('sem credencial: 401 antes de qualquer outra validação (inclusive ID malformado)', async () => {
    const { app } = setup();
    for (const [method, url] of [
      ['GET', '/v1/payments/id-malformado'],
      ['POST', '/v1/payments/id-malformado/authorize'],
      ['POST', '/v1/payments'],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('credencial ausente e inválida recebem a mesma resposta', async () => {
    const { app } = setup();
    const missing = await app.inject({ method: 'GET', url: '/v1/payments/x', headers: { 'x-correlation-id': 'corr-same-0001' } });
    const invalid = await app.inject({
      method: 'GET',
      url: '/v1/payments/x',
      headers: { authorization: `Bearer ${randomBytes(32).toString('base64url')}`, 'x-correlation-id': 'corr-same-0001' },
    });
    expect(missing.statusCode).toBe(401);
    expect(invalid.statusCode).toBe(401);
    expect(invalid.body).toBe(missing.body);
  });

  it('mesmo tenant, estabelecimento não autorizado: 404 em consulta e em todas as operações', async () => {
    const { app } = setup();
    const created = await app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: { authorization: `Bearer ${KEY_A}`, 'idempotency-key': idem() },
      payload: createBody('merchant-2'),
    });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ id: string }>().id;
    const asC = { authorization: `Bearer ${KEY_C}` };
    expect((await app.inject({ method: 'GET', url: `/v1/payments/${id}`, headers: asC })).statusCode).toBe(404);
    for (const path of ['authorize', 'confirm', 'undo', 'cancel', 'abandon']) {
      const res = await app.inject({ method: 'POST', url: `/v1/payments/${id}/${path}`, headers: { ...asC, 'idempotency-key': idem() } });
      expect(res.statusCode, path).toBe(404);
    }
    const refund = await app.inject({
      method: 'POST',
      url: `/v1/payments/${id}/refunds`,
      headers: { ...asC, 'idempotency-key': idem() },
      payload: { amount: { cents: 1, currency: 'BRL' } },
    });
    expect(refund.statusCode).toBe(404);
    // O pagamento continua intacto para quem tem acesso.
    const own = await app.inject({ method: 'GET', url: `/v1/payments/${id}`, headers: { authorization: `Bearer ${KEY_A}` } });
    expect(own.json()).toMatchObject({ state: 'CREATED', operations: [] });
  });
});
