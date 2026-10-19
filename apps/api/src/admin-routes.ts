import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isValidIdempotencyKey, type Actor, type AdminService, type PaymentService } from '@tef/application';
import {
  CUSTOMER_STATUSES,
  MERCHANT_STATUSES,
  PAYMENT_STATES,
  parseMerchantId,
  parsePaymentId,
  parseProviderId,
  parseTenantId,
  parseTerminalId,
  positiveMoney,
  TERMINAL_STATUSES,
  type PaymentId,
  type TenantId,
} from '@tef/domain';
import type { ProviderRegistry } from '@tef/provider-contract';
import { SIMULATOR_DIRECTIVES } from '@tef/provider-simulator';
import {
  ADMIN_CSRF_HEADER,
  ADMIN_SESSION_COOKIE,
  clearedSessionCookie,
  readCookie,
  sessionCookie,
  type AdminSession,
  type DevAdminAuth,
} from './admin-auth.ts';
import { HttpError } from './http-errors.ts';
import { presentOperation, presentPayment } from './presenters.ts';
import {
  presentAudit,
  presentCustomer,
  presentHeartbeat,
  presentJob,
  presentMerchant,
  presentPaymentSummary,
  presentTerminal,
} from './presenters-admin.ts';
import { parse } from './validation.ts';

export interface AdminRouteDeps {
  readonly auth: DevAdminAuth;
  readonly admin: AdminService;
  readonly payments: PaymentService;
  readonly providers: ProviderRegistry;
  /** Origens aceitas no cabeçalho Origin (o painel local). */
  readonly allowedOrigins: readonly string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    adminSession: AdminSession | null;
  }
}

const CODE = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/);
const LIMIT = z.coerce.number().int().min(1).max(200).default(50);
const optionalText = z.string().max(120).optional();
const isoDate = z.iso.datetime({ offset: true }).transform((v) => new Date(v)).optional();

const customerCreate = z.object({ id: CODE, legalName: z.string().min(2).max(120), tradeName: z.string().max(120).nullable().optional() }).strict();
const customerPatch = z
  .object({ legalName: z.string().min(2).max(120).optional(), tradeName: z.string().max(120).nullable().optional(), status: z.enum(CUSTOMER_STATUSES).optional() })
  .strict();
const merchantCreate = z.object({ id: CODE, name: z.string().min(2).max(120), city: z.string().max(80).nullable().optional() }).strict();
const merchantPatch = z
  .object({ name: z.string().min(2).max(120).optional(), city: z.string().max(80).nullable().optional(), status: z.enum(MERCHANT_STATUSES).optional() })
  .strict();
const terminalCreate = z.object({ id: CODE, merchantId: CODE, label: z.string().min(1).max(80), providerId: CODE.default('SIMULATOR') }).strict();
const terminalPatch = z.object({ label: z.string().min(1).max(80).optional(), status: z.enum(TERMINAL_STATUSES).optional() }).strict();
const simulatorPayment = z
  .object({
    customerId: CODE,
    merchantId: CODE,
    terminalId: CODE,
    amountCents: z.number().int().min(1).max(99_999_999_99),
    scenario: z.enum(Object.keys(SIMULATOR_DIRECTIVES) as [keyof typeof SIMULATOR_DIRECTIVES, ...(keyof typeof SIMULATOR_DIRECTIVES)[]]),
    externalReference: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,63}$/).optional(),
  })
  .strict();
const refundBody = z.object({ amountCents: z.number().int().min(1).max(99_999_999_99) }).strict();

function customerParam(params: unknown): TenantId {
  const { customerId } = parse(z.object({ customerId: z.string() }).loose(), params);
  try {
    return parseTenantId(customerId);
  } catch {
    throw new HttpError(404, 'NOT_FOUND', 'cliente não encontrado');
  }
}

function paymentParam(params: unknown): PaymentId {
  const { paymentId } = parse(z.object({ paymentId: z.string() }).loose(), params);
  try {
    return parsePaymentId(paymentId);
  } catch {
    throw new HttpError(404, 'NOT_FOUND', 'pagamento não encontrado');
  }
}

function idempotencyKey(request: FastifyRequest): string {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || !isValidIdempotencyKey(key)) {
    throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'cabeçalho Idempotency-Key ausente ou inválido');
  }
  return key;
}

/**
 * API do painel administrativo local (prefixo /admin/api). Toda rota exige o
 * cabeçalho anti-CSRF e, exceto o login, uma sessão válida — a autorização é
 * feita no servidor, nunca só na interface.
 */
export function registerAdminRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
  app.decorateRequest('adminSession', null);

  void app.register(
    (scope, _opts, done) => {
      scope.addHook('onRequest', (request, _reply, next) => {
        if (request.headers[ADMIN_CSRF_HEADER] !== '1') {
          next(new HttpError(403, 'ADMIN_CSRF_HEADER_REQUIRED', 'requisição administrativa sem o cabeçalho obrigatório'));
          return;
        }
        const origin = request.headers.origin;
        if (origin !== undefined && !deps.allowedOrigins.includes(origin)) {
          next(new HttpError(403, 'ADMIN_ORIGIN_FORBIDDEN', 'origem não permitida'));
          return;
        }
        const isLogin = request.method === 'POST' && request.url.split('?')[0] === '/admin/api/session';
        request.adminSession = deps.auth.verify(readCookie(request.headers.cookie, ADMIN_SESSION_COOKIE));
        if (!isLogin && !request.adminSession) {
          next(new HttpError(401, 'ADMIN_UNAUTHENTICATED', 'sessão administrativa ausente ou expirada'));
          return;
        }
        next();
      });

      const actor = (request: FastifyRequest): Actor => ({ type: 'OPERATOR', id: request.adminSession?.operatorId ?? 'unknown' });
      const ctxFor = (request: FastifyRequest, tenantId: TenantId) => ({ tenantId, actor: actor(request), correlationId: request.id });

      // ---------------------------------------------------------------- sessão
      scope.post('/session', async (request, reply) => {
        const { token } = parse(z.object({ token: z.string().max(256) }).strict(), request.body);
        const result = deps.auth.login(token);
        if (result === 'RATE_LIMITED') throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'muitas tentativas; aguarde alguns minutos');
        if (!result) throw new HttpError(401, 'ADMIN_UNAUTHENTICATED', 'token inválido');
        request.log.info({ operatorId: result.session.operatorId }, 'sessão administrativa local iniciada');
        return reply
          .header('set-cookie', sessionCookie(result.sessionId, deps.auth.ttlSeconds))
          .send({ authenticated: true, operatorId: result.session.operatorId, mode: 'DEV_LOCAL_ADMIN', expiresAt: new Date(result.session.expiresAt).toISOString() });
      });

      scope.get('/session', (request) => ({
        authenticated: true,
        operatorId: request.adminSession?.operatorId,
        mode: 'DEV_LOCAL_ADMIN',
        expiresAt: new Date(request.adminSession?.expiresAt ?? 0).toISOString(),
      }));

      scope.delete('/session', async (request, reply) => {
        deps.auth.logout(readCookie(request.headers.cookie, ADMIN_SESSION_COOKIE));
        return reply.header('set-cookie', clearedSessionCookie()).status(204).send();
      });

      // ------------------------------------------------------------- leituras
      scope.get('/dashboard', async (request) => {
        const q = parse(z.object({ from: isoDate, to: isoDate, customerId: CODE.optional() }).strict(), request.query);
        const data = await deps.admin.dashboard({
          ...(q.from ? { from: q.from } : {}),
          ...(q.to ? { to: q.to } : {}),
          ...(q.customerId ? { customerId: parseTenantId(q.customerId) } : {}),
        });
        return { ...data, recentActivity: data.recentActivity.map(presentAudit) };
      });

      scope.get('/system', async () => {
        const s = await deps.admin.systemStatus();
        return { jobs: s.jobs, outboxPending: s.outboxPending, workers: s.workers.map(presentHeartbeat) };
      });

      scope.get('/providers', () => deps.providers.list().map((p) => ({ id: p.id, kind: p.kind, capabilities: p.capabilities })));

      // ------------------------------------------------------------- clientes
      scope.get('/customers', async (request) => {
        const q = parse(z.object({ q: optionalText, status: z.enum(CUSTOMER_STATUSES).optional(), limit: LIMIT }).strict(), request.query);
        return (await deps.admin.listCustomers({ limit: q.limit, ...(q.q ? { q: q.q } : {}), ...(q.status ? { status: q.status } : {}) })).map(presentCustomer);
      });
      scope.post('/customers', async (request, reply) => {
        const body = parse(customerCreate, request.body);
        const created = await deps.admin.createCustomer(actor(request), {
          id: parseTenantId(body.id),
          legalName: body.legalName,
          tradeName: body.tradeName ?? null,
        });
        return reply.status(201).send(presentCustomer(created));
      });
      scope.get('/customers/:customerId', async (request) => presentCustomer(await deps.admin.getCustomer(customerParam(request.params))));
      scope.patch('/customers/:customerId', async (request) => {
        const body = parse(customerPatch, request.body);
        const patch = {
          ...(body.legalName !== undefined ? { legalName: body.legalName } : {}),
          ...(body.tradeName !== undefined ? { tradeName: body.tradeName } : {}),
          ...(body.status !== undefined ? { status: body.status } : {}),
        };
        return presentCustomer(await deps.admin.updateCustomer(actor(request), customerParam(request.params), patch));
      });
      scope.delete('/customers/:customerId', async (request, reply) => {
        await deps.admin.deleteCustomer(actor(request), customerParam(request.params));
        return reply.status(204).send();
      });

      // ----------------------------------------------------- estabelecimentos
      scope.get('/merchants', async (request) => {
        const q = parse(
          z.object({ customerId: CODE.optional(), q: optionalText, status: z.enum(MERCHANT_STATUSES).optional(), limit: LIMIT }).strict(),
          request.query,
        );
        const list = await deps.admin.listMerchants({
          limit: q.limit,
          ...(q.customerId ? { customerId: parseTenantId(q.customerId) } : {}),
          ...(q.q ? { q: q.q } : {}),
          ...(q.status ? { status: q.status } : {}),
        });
        return list.map(presentMerchant);
      });
      scope.post('/customers/:customerId/merchants', async (request, reply) => {
        const body = parse(merchantCreate, request.body);
        const created = await deps.admin.createMerchant(actor(request), customerParam(request.params), {
          id: parseMerchantId(body.id),
          name: body.name,
          city: body.city ?? null,
        });
        return reply.status(201).send(presentMerchant(created));
      });
      scope.patch('/customers/:customerId/merchants/:merchantId', async (request) => {
        const { merchantId } = parse(z.object({ merchantId: CODE }).loose(), request.params);
        const body = parse(merchantPatch, request.body);
        const patch = {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.city !== undefined ? { city: body.city } : {}),
          ...(body.status !== undefined ? { status: body.status } : {}),
        };
        return presentMerchant(await deps.admin.updateMerchant(actor(request), customerParam(request.params), parseMerchantId(merchantId), patch));
      });
      scope.delete('/customers/:customerId/merchants/:merchantId', async (request, reply) => {
        const { merchantId } = parse(z.object({ merchantId: CODE }).loose(), request.params);
        await deps.admin.deleteMerchant(actor(request), customerParam(request.params), parseMerchantId(merchantId));
        return reply.status(204).send();
      });

      // ------------------------------------------------------------ terminais
      scope.get('/terminals', async (request) => {
        const q = parse(
          z
            .object({ customerId: CODE.optional(), merchantId: CODE.optional(), q: optionalText, status: z.enum(TERMINAL_STATUSES).optional(), limit: LIMIT })
            .strict(),
          request.query,
        );
        const list = await deps.admin.listTerminals({
          limit: q.limit,
          ...(q.customerId ? { customerId: parseTenantId(q.customerId) } : {}),
          ...(q.merchantId ? { merchantId: parseMerchantId(q.merchantId) } : {}),
          ...(q.q ? { q: q.q } : {}),
          ...(q.status ? { status: q.status } : {}),
        });
        return list.map(presentTerminal);
      });
      scope.post('/customers/:customerId/terminals', async (request, reply) => {
        const body = parse(terminalCreate, request.body);
        const created = await deps.admin.createTerminal(actor(request), customerParam(request.params), {
          id: parseTerminalId(body.id),
          merchantId: parseMerchantId(body.merchantId),
          label: body.label,
          providerId: parseProviderId(body.providerId),
        });
        return reply.status(201).send(presentTerminal(created));
      });
      scope.patch('/customers/:customerId/terminals/:terminalId', async (request) => {
        const { terminalId } = parse(z.object({ terminalId: CODE }).loose(), request.params);
        const body = parse(terminalPatch, request.body);
        const patch = {
          ...(body.label !== undefined ? { label: body.label } : {}),
          ...(body.status !== undefined ? { status: body.status } : {}),
        };
        return presentTerminal(await deps.admin.updateTerminal(actor(request), customerParam(request.params), parseTerminalId(terminalId), patch));
      });
      scope.delete('/customers/:customerId/terminals/:terminalId', async (request, reply) => {
        const { terminalId } = parse(z.object({ terminalId: CODE }).loose(), request.params);
        await deps.admin.deleteTerminal(actor(request), customerParam(request.params), parseTerminalId(terminalId));
        return reply.status(204).send();
      });

      // ---------------------------------------------------------- pagamentos
      scope.get('/payments', async (request) => {
        const q = parse(
          z
            .object({
              customerId: CODE.optional(),
              merchantId: CODE.optional(),
              state: z.enum(PAYMENT_STATES).optional(),
              q: optionalText,
              from: isoDate,
              to: isoDate,
              limit: LIMIT,
            })
            .strict(),
          request.query,
        );
        const list = await deps.admin.listPayments({
          limit: q.limit,
          ...(q.customerId ? { customerId: parseTenantId(q.customerId) } : {}),
          ...(q.merchantId ? { merchantId: parseMerchantId(q.merchantId) } : {}),
          ...(q.state ? { state: q.state } : {}),
          ...(q.q ? { q: q.q } : {}),
          ...(q.from ? { from: q.from } : {}),
          ...(q.to ? { to: q.to } : {}),
        });
        return list.map(presentPaymentSummary);
      });

      scope.get('/customers/:customerId/payments/:paymentId', async (request) => {
        const detail = await deps.admin.paymentDetail(customerParam(request.params), paymentParam(request.params));
        const provider = deps.providers.get(detail.payment.providerId);
        return {
          payment: presentPayment({ payment: detail.payment, operations: detail.operations }, provider.kind),
          jobs: detail.jobs.map(presentJob),
          audit: detail.audit.map(presentAudit),
          testDirective: detail.testDirective,
        };
      });

      const operationResponse = (result: Awaited<ReturnType<PaymentService['requestOperation']>>) => ({
        operation: presentOperation(result.operation),
        payment: presentPayment(result, deps.providers.get(result.payment.providerId).kind),
      });

      scope.post('/customers/:customerId/payments/:paymentId/cancel', async (request, reply) => {
        const customerId = customerParam(request.params);
        const result = await deps.payments.requestOperation(ctxFor(request, customerId), paymentParam(request.params), 'CANCELLATION', undefined, idempotencyKey(request));
        return reply.status(result.responseStatus).send(operationResponse(result));
      });

      scope.post('/customers/:customerId/payments/:paymentId/refunds', async (request, reply) => {
        const customerId = customerParam(request.params);
        const body = parse(refundBody, request.body);
        const result = await deps.payments.requestOperation(
          ctxFor(request, customerId),
          paymentParam(request.params),
          'REFUND',
          positiveMoney(body.amountCents),
          idempotencyKey(request),
        );
        return reply.status(result.responseStatus).send(operationResponse(result));
      });

      /**
       * "Reconciliar agora": antecipa a tarefa de reconciliação por consulta. A API não
       * chama o provedor; o worker consulta e registra a evidência. Nunca reenvia cobrança.
       */
      scope.post('/customers/:customerId/payments/:paymentId/reconcile', async (request, reply) => {
        const customerId = customerParam(request.params);
        const result = await deps.payments.requestReconciliation(ctxFor(request, customerId), paymentParam(request.params));
        return reply.status(202).send({ scheduled: result.scheduled, operation: presentOperation(result.operation) });
      });

      // ----------------------------------------------------------- simulador
      scope.get('/simulator/scenarios', () =>
        Object.entries(SIMULATOR_DIRECTIVES).map(([id, d]) => ({ id, label: d.label, expected: d.expected, fictitious: true })),
      );

      scope.post('/simulator/payments', async (request, reply) => {
        const body = parse(simulatorPayment, request.body);
        const customerId = parseTenantId(body.customerId);
        const result = await deps.payments.createPayment(
          ctxFor(request, customerId),
          {
            merchantId: parseMerchantId(body.merchantId),
            terminalId: parseTerminalId(body.terminalId),
            externalReference: body.externalReference ?? `sim-${randomUUID()}`,
            amount: positiveMoney(body.amountCents),
            authorize: true,
            testDirective: body.scenario,
          },
          idempotencyKey(request),
        );
        if (result.replayed) reply.header('idempotent-replayed', 'true');
        return reply
          .status(result.responseStatus)
          .send(presentPayment(result, deps.providers.get(result.payment.providerId).kind));
      });

      // ----------------------------------------------------------- auditoria
      scope.get('/audit', async (request) => {
        const q = parse(
          z.object({ customerId: CODE.optional(), resourceType: z.enum(['payment', 'operation', 'customer', 'merchant', 'terminal']).optional(), resourceId: z.string().max(80).optional(), limit: LIMIT }).strict(),
          request.query,
        );
        const list = await deps.admin.listAudit({
          limit: q.limit,
          ...(q.customerId ? { tenantId: parseTenantId(q.customerId) } : {}),
          ...(q.resourceType ? { resourceType: q.resourceType } : {}),
          ...(q.resourceId ? { resourceId: q.resourceId } : {}),
        });
        return list.map(presentAudit);
      });

      scope.get('/audit/verify', async (request) => {
        const q = parse(z.object({ customerId: CODE }).strict(), request.query);
        return deps.admin.verifyAudit(parseTenantId(q.customerId));
      });

      done();
    },
    { prefix: '/admin/api' },
  );
}
