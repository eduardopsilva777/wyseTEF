import { createHash, randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PaymentService } from '@tef/application';
import { InMemoryUnitOfWork } from '@tef/persistence/memory';
import { createProviderRegistry } from '@tef/provider-contract';
import { PaymentSimulator, SIMULATOR_PROVIDER_ID, type SimulatorScenario } from '@tef/provider-simulator';
import { buildApp } from '../src/app.ts';
import { createAuthenticator } from '../src/auth.ts';
import { createLogger } from '../src/logging.ts';

// Chaves geradas em tempo de execução: nenhuma credencial fica no repositório.
const KEY_A = randomBytes(32).toString('base64url');
const KEY_B = randomBytes(32).toString('base64url');
const sha = (k: string) => createHash('sha256').update(k).digest('hex');
// Número de teste público (não pertence a cartão real), montado em tempo de
// execução para que nenhum literal semelhante a PAN fique no repositório.
const TEST_PAN = ['4111', '1111', '1111', '1111'].join('');

interface TestContext {
  app: FastifyInstance;
  logs: string[];
  scenario: { current: SimulatorScenario };
}

function setup(): TestContext {
  const logs: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      logs.push(chunk.toString('utf8'));
      cb();
    },
  });
  const scenario = { current: { type: 'APPROVE' } as SimulatorScenario };
  const simulator = new PaymentSimulator({ scenario: () => scenario.current });
  const providers = createProviderRegistry([simulator]);
  const logger = createLogger('debug', false, stream);
  const service = new PaymentService({ uow: new InMemoryUnitOfWork(), providers, providerTimeoutMs: 50, logger });
  const app = buildApp({
    service,
    providers,
    defaultProviderId: SIMULATOR_PROVIDER_ID,
    logger,
    authenticate: createAuthenticator([
      { keyId: 'key-a', keySha256: sha(KEY_A), tenantId: 'tenant-a', merchantIds: ['merchant-1', 'merchant-2'] },
      { keyId: 'key-b', keySha256: sha(KEY_B), tenantId: 'tenant-b', merchantIds: ['merchant-1'] },
    ]),
  });
  return { app, logs, scenario };
}

let t: TestContext;
beforeEach(() => {
  t = setup();
});
afterEach(async () => {
  await t.app.close();
});

let counter = 0;
const key = () => `api-test-key-${++counter}-${Date.now()}`;
const auth = (k = KEY_A) => ({ authorization: `Bearer ${k}` });
const body = (overrides: Record<string, unknown> = {}) => ({
  merchantId: 'merchant-1',
  terminalId: 'terminal-1',
  externalReference: `pedido-${++counter}`,
  amount: { cents: 1_000, currency: 'BRL' },
  ...overrides,
});

async function createPayment(payload = body(), k = key(), apiKey = KEY_A) {
  return t.app.inject({ method: 'POST', url: '/v1/payments', headers: { ...auth(apiKey), 'idempotency-key': k }, payload });
}

describe('API: autenticação e autorização', () => {
  it('rejeita requisição sem credencial (401)', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/v1/payments', headers: { 'idempotency-key': key() }, payload: body() });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  });

  it('rejeita credencial inválida (401)', async () => {
    const res = await createPayment(body(), key(), randomBytes(32).toString('base64url'));
    expect(res.statusCode).toBe(401);
  });

  it('rejeita estabelecimento não autorizado para a credencial (403)', async () => {
    const res = await createPayment(body({ merchantId: 'merchant-2' }), key(), KEY_B);
    expect(res.statusCode).toBe(403);
  });

  it('outro tenant recebe 404 ao consultar ou operar o pagamento', async () => {
    const created = (await createPayment()).json<{ id: string }>();
    const read = await t.app.inject({ method: 'GET', url: `/v1/payments/${created.id}`, headers: auth(KEY_B) });
    expect(read.statusCode).toBe(404);
    const op = await t.app.inject({
      method: 'POST',
      url: `/v1/payments/${created.id}/authorize`,
      headers: { ...auth(KEY_B), 'idempotency-key': key() },
    });
    expect(op.statusCode).toBe(404);
  });

  it('ID malformado é tratado como inexistente', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/v1/payments/qualquer-coisa', headers: auth() });
    expect(res.statusCode).toBe(404);
  });
});

describe('API: validação de entrada', () => {
  it('exige Idempotency-Key', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/v1/payments', headers: auth(), payload: body() });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });
  });

  it.each([
    ['valor fracionado', { amount: { cents: 10.5, currency: 'BRL' } }],
    ['valor zero', { amount: { cents: 0, currency: 'BRL' } }],
    ['moeda não suportada', { amount: { cents: 100, currency: 'USD' } }],
    ['campo desconhecido', { pan: TEST_PAN }],
    ['referência inválida', { externalReference: "x'; DROP TABLE payments;--" }],
  ])('rejeita %s sem ecoar o valor recebido', async (_label, overrides) => {
    const res = await createPayment(body(overrides));
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(TEST_PAN);
    expect(res.body).not.toContain('DROP TABLE');
  });

  it('rejeita JSON malformado', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: { ...auth(), 'idempotency-key': key(), 'content-type': 'application/json' },
      payload: '{"amount":',
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('API: idempotência e fluxo', () => {
  it('mesma chave e conteúdo: 201 repetido com o mesmo recurso e cabeçalho de repetição', async () => {
    const payload = body();
    const k = key();
    const first = await createPayment(payload, k);
    const second = await createPayment(payload, k);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json<{ id: string }>().id).toBe(first.json<{ id: string }>().id);
  });

  it('mesma chave e conteúdo diferente: 409', async () => {
    const k = key();
    const payload = body();
    await createPayment(payload, k);
    const res = await createPayment({ ...payload, amount: { cents: 2_000, currency: 'BRL' } }, k);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
  });

  it('referência duplicada: 409', async () => {
    const payload = body();
    await createPayment(payload);
    const res = await createPayment(payload);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'DUPLICATE_REFERENCE' } });
  });

  it('fluxo: criar, autorizar, estornar parcialmente e consultar', async () => {
    const created = (await createPayment(body({ amount: { cents: 5_000, currency: 'BRL' } }))).json<{ id: string; provider: unknown }>();
    expect(created.provider).toEqual({ id: 'SIMULATOR', kind: 'SIMULATOR', simulated: true });

    const authorized = await t.app.inject({
      method: 'POST',
      url: `/v1/payments/${created.id}/authorize`,
      headers: { ...auth(), 'idempotency-key': key() },
    });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json()).toMatchObject({ operation: { kind: 'AUTHORIZATION', status: 'SUCCEEDED' }, payment: { state: 'APPROVED' } });

    const refund = await t.app.inject({
      method: 'POST',
      url: `/v1/payments/${created.id}/refunds`,
      headers: { ...auth(), 'idempotency-key': key() },
      payload: { amount: { cents: 1_500, currency: 'BRL' } },
    });
    expect(refund.statusCode).toBe(200);
    expect(refund.json()).toMatchObject({
      payment: { state: 'APPROVED', reversedAmount: { cents: 1_500 }, netApprovedAmount: { cents: 3_500 } },
    });

    const read = await t.app.inject({ method: 'GET', url: `/v1/payments/${created.id}`, headers: auth() });
    expect(read.json<{ operations: unknown[] }>().operations).toHaveLength(2);
    expect(read.headers['cache-control']).toBe('no-store');
  });

  it('resultado desconhecido é exposto como UNKNOWN e nova autorização é recusada', async () => {
    t.scenario.current = { type: 'TIMEOUT_AFTER_SEND', hiddenOutcome: 'SUCCEEDED' };
    const created = (await createPayment()).json<{ id: string }>();
    const res = await t.app.inject({
      method: 'POST',
      url: `/v1/payments/${created.id}/authorize`,
      headers: { ...auth(), 'idempotency-key': key() },
    });
    expect(res.json()).toMatchObject({ payment: { state: 'UNKNOWN' }, operation: { status: 'UNKNOWN' } });
    const retry = await t.app.inject({
      method: 'POST',
      url: `/v1/payments/${created.id}/authorize`,
      headers: { ...auth(), 'idempotency-key': key() },
    });
    expect(retry.statusCode).toBe(409);
    expect(retry.json()).toMatchObject({ error: { code: 'OPERATION_IN_PROGRESS' } });
  });

  it('propaga x-correlation-id válido', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/health', headers: { 'x-correlation-id': 'corr-12345678' } });
    expect(res.headers['x-correlation-id']).toBe('corr-12345678');
  });
});

describe('API: sanitização de logs', () => {
  it('não registra a chave de API, o cabeçalho Authorization nem o corpo da requisição', async () => {
    const sentinelRef = `ref-sentinela-${Date.now()}`;
    await createPayment(body({ externalReference: sentinelRef }));
    await t.app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: { ...auth(), 'idempotency-key': key() },
      payload: { ...body(), pan: TEST_PAN, cvv: '123', track2: `;${TEST_PAN}=2512?` },
    });
    const output = t.logs.join('');
    expect(output.length).toBeGreaterThan(0);
    expect(output).not.toContain(KEY_A);
    expect(output).not.toContain(sha(KEY_A));
    expect(output).not.toMatch(/Bearer/i);
    expect(output).not.toContain(TEST_PAN);
    expect(output).not.toContain(sentinelRef); // corpo nunca é registrado
    expect(output).toContain('"keyId":"key-a"'); // identificador não secreto é registrado
  });

  it('erros inesperados não vazam detalhes na resposta', async () => {
    const broken = setup();
    broken.app.get('/boom', () => {
      throw new Error(`falha interna com segredo ${KEY_A}`);
    });
    const res = await broken.app.inject({ method: 'GET', url: '/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain(KEY_A);
    expect(res.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    await broken.app.close();
  });

  it('a redação cobre campos sensíveis registrados por descuido', () => {
    const lines: string[] = [];
    const logger = createLogger('info', true, new Writable({ write(c: Buffer, _e, cb) { lines.push(c.toString()); cb(); } }));
    logger.info({ ctx: { authorization: 'Bearer x', apiKey: 'k', cvv: '123', pan: TEST_PAN, password: 'p' } }, 'teste');
    const out = lines.join('');
    expect(out).not.toContain(TEST_PAN);
    expect(out).not.toContain('Bearer x');
    expect(out).toContain('[REDACTED]');
  });
});
