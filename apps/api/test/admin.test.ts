import { createHash, randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AdminService, OutboxPublisher, PaymentService, Worker } from '@tef/application';
import { InMemoryUnitOfWork } from '@tef/persistence/memory';
import { createProviderRegistry } from '@tef/provider-contract';
import { directiveScenarioResolver, PaymentSimulator } from '@tef/provider-simulator';
import { seedCatalog } from '../../../tests/support/catalog.ts';
import { DevAdminAuth } from '../src/admin-auth.ts';
import { buildApp } from '../src/app.ts';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createLogger } from '../src/logging.ts';

// Gerados em tempo de execução: nada fica no repositório.
const ADMIN_TOKEN = randomBytes(32).toString('base64url');
const API_KEY = randomBytes(32).toString('base64url');
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const ORIGIN = 'http://127.0.0.1:5173';

interface Ctx {
  app: FastifyInstance;
  logs: string[];
  work: () => Promise<void>;
}

async function setup(options: { admin?: boolean; maxLoginAttempts?: number } = {}): Promise<Ctx> {
  const logs: string[] = [];
  const logger = createLogger('debug', false, new Writable({ write(c: Buffer, _e, cb) { logs.push(c.toString()); cb(); } }));
  const uow = new InMemoryUnitOfWork();
  await seedCatalog(uow);
  const simulator = new PaymentSimulator({
    scenario: directiveScenarioResolver((req) => uow.transaction((r) => r.testDirectives.get(req.paymentId)), { delayMs: 120 }),
  });
  const providers = createProviderRegistry([simulator]);
  const service = new PaymentService({ uow, providers, providerTimeoutMs: 40, logger });
  const worker = new Worker({ uow, service, publisher: new OutboxPublisher({ uow, sink: { deliver: () => Promise.resolve() } }), workerId: 'w', leaseMs: 2_000 });
  const app = buildApp({
    service,
    providers,
    logger,
    authenticate: createAuthenticator([{ keyId: 'integrador', keySha256: sha(API_KEY), tenantId: 'tenant-a', merchantIds: ['merchant-1'] }]),
    ...(options.admin === false
      ? {}
      : {
          admin: {
            auth: new DevAdminAuth({ tokenSha256: sha(ADMIN_TOKEN), maxLoginAttempts: options.maxLoginAttempts ?? 10 }),
            service: new AdminService({ uow, providers }),
            allowedOrigins: [ORIGIN],
          },
        }),
  });
  return { app, logs, work: async () => { await worker.runOnce(); } };
}

let t: Ctx;
let cookie = '';
const H = (extra: Record<string, string> = {}) => ({ 'x-tef-admin': '1', origin: ORIGIN, ...(cookie ? { cookie } : {}), ...extra });
let n = 0;
const idem = () => `adm-key-${++n}-${Date.now()}`;

async function login(app: FastifyInstance): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/admin/api/session', headers: { 'x-tef-admin': '1', origin: ORIGIN }, payload: { token: ADMIN_TOKEN } });
  expect(res.statusCode).toBe(200);
  return String(res.headers['set-cookie']).split(';')[0]!;
}

beforeEach(async () => {
  t = await setup();
  cookie = '';
});
afterEach(async () => {
  await t.app.close();
});

describe('painel: sessão administrativa local e proteções', () => {
  it('sem painel configurado, as rotas /admin/api não existem', async () => {
    const off = await setup({ admin: false });
    const res = await off.app.inject({ method: 'GET', url: '/admin/api/session', headers: H() });
    expect(res.statusCode).toBe(404);
    await off.app.close();
  });

  it('exige o cabeçalho anti-CSRF em todas as rotas (inclusive login)', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/admin/api/session', headers: { origin: ORIGIN }, payload: { token: ADMIN_TOKEN } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'ADMIN_CSRF_HEADER_REQUIRED' } });
  });

  it('recusa origem diferente do painel local', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/admin/api/session', headers: { 'x-tef-admin': '1', origin: 'https://site-malicioso.example' }, payload: { token: ADMIN_TOKEN } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'ADMIN_ORIGIN_FORBIDDEN' } });
  });

  it('sem sessão: 401 em qualquer rota protegida', async () => {
    for (const url of ['/admin/api/dashboard', '/admin/api/customers', '/admin/api/payments', '/admin/api/audit', '/admin/api/system']) {
      const res = await t.app.inject({ method: 'GET', url, headers: H() });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('token errado: 401; tentativas em excesso: 429', async () => {
    const limited = await setup({ maxLoginAttempts: 3 });
    for (let i = 0; i < 3; i++) {
      const res = await limited.app.inject({ method: 'POST', url: '/admin/api/session', headers: H(), payload: { token: randomBytes(32).toString('base64url') } });
      expect(res.statusCode).toBe(401);
    }
    const blocked = await limited.app.inject({ method: 'POST', url: '/admin/api/session', headers: H(), payload: { token: ADMIN_TOKEN } });
    expect(blocked.statusCode).toBe(429);
    await limited.app.close();
  });

  it('login emite cookie HttpOnly + SameSite=Strict, sem devolver o token; logout invalida', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/admin/api/session', headers: H(), payload: { token: ADMIN_TOKEN } });
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(/^tef_dev_admin=[A-Za-z0-9_-]{43}; Path=\/admin; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
    expect(res.body).not.toContain(ADMIN_TOKEN);
    expect(res.json()).toMatchObject({ authenticated: true, mode: 'DEV_LOCAL_ADMIN' });
    cookie = setCookie.split(';')[0]!;
    expect((await t.app.inject({ method: 'GET', url: '/admin/api/session', headers: H() })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'DELETE', url: '/admin/api/session', headers: H() })).statusCode).toBe(204);
    expect((await t.app.inject({ method: 'GET', url: '/admin/api/session', headers: H() })).statusCode).toBe(401);
  });

  it('credencial de integrador não abre o painel, e a sessão do painel não abre a API /v1', async () => {
    const asIntegrator = await t.app.inject({ method: 'GET', url: '/admin/api/customers', headers: { 'x-tef-admin': '1', authorization: `Bearer ${API_KEY}` } });
    expect(asIntegrator.statusCode).toBe(401);
    cookie = await login(t.app);
    const v1 = await t.app.inject({ method: 'GET', url: '/v1/payments/pay_x', headers: { cookie } });
    expect(v1.statusCode).toBe(401);
  });

  it('nem o token nem o identificador de sessão aparecem nos logs', async () => {
    cookie = await login(t.app);
    await t.app.inject({ method: 'GET', url: '/admin/api/customers', headers: H() });
    const output = t.logs.join('');
    expect(output).not.toContain(ADMIN_TOKEN);
    expect(output).not.toContain(cookie.split('=')[1]!);
    expect(output).not.toContain(sha(ADMIN_TOKEN));
  });
});

describe('painel: cadastro (CRUD) com validação e isolamento entre clientes', () => {
  beforeEach(async () => {
    cookie = await login(t.app);
  });

  it('cliente: criar, buscar, editar, código duplicado e validação sem eco', async () => {
    const created = await t.app.inject({ method: 'POST', url: '/admin/api/customers', headers: H(), payload: { id: 'acme-demo', legalName: 'ACME Fictícia Ltda', tradeName: 'ACME' } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id: 'acme-demo', status: 'ACTIVE', version: 1 });

    const dup = await t.app.inject({ method: 'POST', url: '/admin/api/customers', headers: H(), payload: { id: 'acme-demo', legalName: 'Outra' } });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ error: { code: 'DUPLICATE_CODE' } });

    const search = await t.app.inject({ method: 'GET', url: '/admin/api/customers?q=acme', headers: H() });
    expect(search.json<{ id: string }[]>().map((c) => c.id)).toEqual(['acme-demo']);

    const patched = await t.app.inject({ method: 'PATCH', url: '/admin/api/customers/acme-demo', headers: H(), payload: { tradeName: 'ACME Pagamentos' } });
    expect(patched.json()).toMatchObject({ tradeName: 'ACME Pagamentos', version: 2 });

    const invalid = await t.app.inject({ method: 'POST', url: '/admin/api/customers', headers: H(), payload: { id: "x'; DROP TABLE customers;--", legalName: 'a' } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).not.toContain('DROP TABLE');
  });

  it('não exclui cliente com dependentes; exclui quando não há; desativar bloqueia novos pagamentos', async () => {
    const withDeps = await t.app.inject({ method: 'DELETE', url: '/admin/api/customers/tenant-a', headers: H() });
    expect(withDeps.statusCode).toBe(409);
    expect(withDeps.json()).toMatchObject({ error: { code: 'HAS_DEPENDENCIES' } });

    await t.app.inject({ method: 'POST', url: '/admin/api/customers', headers: H(), payload: { id: 'temporario', legalName: 'Temporário Fictício' } });
    expect((await t.app.inject({ method: 'DELETE', url: '/admin/api/customers/temporario', headers: H() })).statusCode).toBe(204);

    await t.app.inject({ method: 'PATCH', url: '/admin/api/customers/tenant-a', headers: H(), payload: { status: 'INACTIVE' } });
    const blocked = await t.app.inject({
      method: 'POST',
      url: '/admin/api/simulator/payments',
      headers: H({ 'idempotency-key': idem() }),
      payload: { customerId: 'tenant-a', merchantId: 'merchant-1', terminalId: 'terminal-1', amountCents: 1000, scenario: 'APPROVE' },
    });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json()).toMatchObject({ error: { code: 'REFERENCE_INVALID' } });
  });

  it('estabelecimentos e terminais são escopados pelo cliente do caminho', async () => {
    // merchant-2 só existe em tenant-a: pelo caminho de tenant-b, não existe.
    const crossPatch = await t.app.inject({ method: 'PATCH', url: '/admin/api/customers/tenant-b/merchants/merchant-2', headers: H(), payload: { name: 'Invasão' } });
    expect(crossPatch.statusCode).toBe(404);
    const crossTerminal = await t.app.inject({
      method: 'POST',
      url: '/admin/api/customers/tenant-b/terminals',
      headers: H(),
      payload: { id: 'novo-terminal', merchantId: 'merchant-2', label: 'Caixa' },
    });
    expect(crossTerminal.statusCode).toBe(422);

    const merchant = await t.app.inject({ method: 'POST', url: '/admin/api/customers/tenant-b/merchants', headers: H(), payload: { id: 'loja-centro', name: 'Loja Centro', city: 'São Paulo' } });
    expect(merchant.statusCode).toBe(201);
    const terminal = await t.app.inject({ method: 'POST', url: '/admin/api/customers/tenant-b/terminals', headers: H(), payload: { id: 'caixa-01', merchantId: 'loja-centro', label: 'Caixa 01' } });
    expect(terminal.json()).toMatchObject({ mode: 'SIMULATED', providerId: 'SIMULATOR', status: 'ACTIVE' });
    const listed = await t.app.inject({ method: 'GET', url: '/admin/api/terminals?customerId=tenant-b&merchantId=loja-centro', headers: H() });
    expect(listed.json<{ id: string }[]>().map((x) => x.id)).toEqual(['caixa-01']);
    const maintenance = await t.app.inject({ method: 'PATCH', url: '/admin/api/customers/tenant-b/terminals/caixa-01', headers: H(), payload: { status: 'MAINTENANCE' } });
    expect(maintenance.json()).toMatchObject({ status: 'MAINTENANCE' });
    expect((await t.app.inject({ method: 'DELETE', url: '/admin/api/customers/tenant-b/terminals/caixa-01', headers: H() })).statusCode).toBe(204);
  });
});

describe('painel: simulador, transações, dashboard e auditoria', () => {
  beforeEach(async () => {
    cookie = await login(t.app);
  });

  it('cenários são listados como fictícios', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/admin/api/simulator/scenarios', headers: H() });
    const list = res.json<{ id: string; fictitious: boolean }[]>();
    expect(list.length).toBe(9);
    expect(list.every((s) => s.fictitious)).toBe(true);
  });

  it('pagamento simulado: 202, worker processa, detalhe e dashboard refletem dados reais', async () => {
    const empty = await t.app.inject({ method: 'GET', url: '/admin/api/dashboard?customerId=tenant-a', headers: H() });
    expect(empty.json()).toMatchObject({ totals: { payments: 0, approvalRate: null }, amounts: { approvedCents: 0 } });

    const created = await t.app.inject({
      method: 'POST',
      url: '/admin/api/simulator/payments',
      headers: H({ 'idempotency-key': idem() }),
      payload: { customerId: 'tenant-a', merchantId: 'merchant-1', terminalId: 'terminal-1', amountCents: 2_590, scenario: 'DECLINE' },
    });
    expect(created.statusCode).toBe(202);
    expect(created.json()).toMatchObject({ state: 'PROCESSING', provider: { simulated: true } });
    const id = created.json<{ id: string }>().id;

    await t.work();
    const detail = await t.app.inject({ method: 'GET', url: `/admin/api/customers/tenant-a/payments/${id}`, headers: H() });
    expect(detail.json()).toMatchObject({
      payment: { state: 'DECLINED', operations: [{ kind: 'AUTHORIZATION', status: 'REJECTED' }] },
      jobs: [{ kind: 'EXECUTE_OPERATION', status: 'DONE' }],
      testDirective: 'DECLINE',
    });
    // Detalhe por outro cliente: não existe.
    expect((await t.app.inject({ method: 'GET', url: `/admin/api/customers/tenant-b/payments/${id}`, headers: H() })).statusCode).toBe(404);

    const list = await t.app.inject({ method: 'GET', url: '/admin/api/payments?state=DECLINED', headers: H() });
    expect(list.json<{ id: string }[]>().map((p) => p.id)).toContain(id);

    const dash = await t.app.inject({ method: 'GET', url: '/admin/api/dashboard?customerId=tenant-a', headers: H() });
    expect(dash.json()).toMatchObject({ totals: { payments: 1, declinedCount: 1, approvalRate: 0 }, amounts: { declinedCents: 2_590, approvedCents: 0 } });
  });

  it('UNKNOWN: "reconciliar agora" agenda a consulta (202); o worker resolve sem reenviar', async () => {
    const created = await t.app.inject({
      method: 'POST',
      url: '/admin/api/simulator/payments',
      headers: H({ 'idempotency-key': idem() }),
      payload: { customerId: 'tenant-a', merchantId: 'merchant-1', terminalId: 'terminal-1', amountCents: 1_000, scenario: 'TIMEOUT_AFTER_SEND' },
    });
    const id = created.json<{ id: string }>().id;
    await t.work();
    const unknown = await t.app.inject({ method: 'GET', url: `/admin/api/customers/tenant-a/payments/${id}`, headers: H() });
    expect(unknown.json()).toMatchObject({ payment: { state: 'UNKNOWN' } });

    const reconcile = await t.app.inject({ method: 'POST', url: `/admin/api/customers/tenant-a/payments/${id}/reconcile`, headers: H() });
    expect(reconcile.statusCode).toBe(202);
    expect(reconcile.json()).toMatchObject({ scheduled: 'EXPEDITED' });
    await t.work();
    const final = await t.app.inject({ method: 'GET', url: `/admin/api/customers/tenant-a/payments/${id}`, headers: H() });
    expect(final.json()).toMatchObject({ payment: { state: 'APPROVED', operations: [{ status: 'SUCCEEDED', evidenceSource: 'PROVIDER_QUERY' }] } });

    const nothing = await t.app.inject({ method: 'POST', url: `/admin/api/customers/tenant-a/payments/${id}/reconcile`, headers: H() });
    expect(nothing.statusCode).toBe(409);
  });

  it('estorno e cancelamento pelo painel exigem Idempotency-Key e passam pela fila', async () => {
    const created = await t.app.inject({
      method: 'POST',
      url: '/admin/api/simulator/payments',
      headers: H({ 'idempotency-key': idem() }),
      payload: { customerId: 'tenant-a', merchantId: 'merchant-1', terminalId: 'terminal-1', amountCents: 5_000, scenario: 'APPROVE' },
    });
    const id = created.json<{ id: string }>().id;
    await t.work();
    const noKey = await t.app.inject({ method: 'POST', url: `/admin/api/customers/tenant-a/payments/${id}/refunds`, headers: H(), payload: { amountCents: 1_000 } });
    expect(noKey.statusCode).toBe(400);
    const refund = await t.app.inject({ method: 'POST', url: `/admin/api/customers/tenant-a/payments/${id}/refunds`, headers: H({ 'idempotency-key': idem() }), payload: { amountCents: 1_000 } });
    expect(refund.statusCode).toBe(202);
    await t.work();
    const after = await t.app.inject({ method: 'GET', url: `/admin/api/customers/tenant-a/payments/${id}`, headers: H() });
    expect(after.json()).toMatchObject({ payment: { state: 'APPROVED', reversedAmount: { cents: 1_000 } } });
  });

  it('auditoria lista eventos e verifica a cadeia', async () => {
    const list = await t.app.inject({ method: 'GET', url: '/admin/api/audit?customerId=tenant-a&resourceType=customer', headers: H() });
    expect(list.json<{ action: string }[]>().some((e) => e.action === 'customer.created')).toBe(true);
    const verify = await t.app.inject({ method: 'GET', url: '/admin/api/audit/verify?customerId=tenant-a', headers: H() });
    expect(verify.json()).toMatchObject({ valid: true });
    expect(verify.json<{ records: number }>().records).toBeGreaterThan(0);
  });

  it('estado do sistema expõe fila, outbox e workers', async () => {
    await t.work();
    const res = await t.app.inject({ method: 'GET', url: '/admin/api/system', headers: H() });
    expect(res.json()).toMatchObject({ jobs: { PENDING: 0 }, workers: [{ workerId: 'w', status: 'RUNNING' }] });
  });
});

describe('configuração do acesso administrativo', () => {
  const credentials = JSON.stringify([{ keyId: 'k1', keySha256: 'a'.repeat(64), tenantId: 't', merchantIds: ['m'] }]);
  it('é recusado em produção', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'x', TEF_API_CREDENTIALS: credentials, TEF_DEV_ADMIN_TOKEN_SHA256: 'b'.repeat(64) }),
    ).toThrow(/não é permitido em produção/);
  });
  it('aceita apenas origens locais', () => {
    expect(() =>
      loadConfig({ TEF_PERSISTENCE: 'memory', TEF_API_CREDENTIALS: credentials, TEF_ADMIN_ALLOWED_ORIGINS: 'https://painel.example.com' }),
    ).toThrow(/origens locais/);
    expect(loadConfig({ TEF_PERSISTENCE: 'memory', TEF_API_CREDENTIALS: credentials }).TEF_ADMIN_ALLOWED_ORIGINS).toEqual([
      'http://127.0.0.1:5173',
      'http://localhost:5173',
    ]);
  });
});
