import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isValidIdempotencyKey, type PaymentService, type PaymentView, type RequestContext } from '@tef/application';
import {
  parseExternalReference,
  parseMerchantId,
  parsePaymentId,
  parseTerminalId,
  positiveMoney,
  type PaymentId,
  type ProviderId,
} from '@tef/domain';
import type { ProviderRegistry } from '@tef/provider-contract';
import type { Principal } from './auth.ts';
import { HttpError, RequestValidationError, toHttpError } from './http-errors.ts';
import { presentOperation, presentPayment } from './presenters.ts';

export interface AppDeps {
  readonly service: PaymentService;
  readonly providers: ProviderRegistry;
  /** Provedor usado para novos pagamentos (nesta fase, apenas o simulador). */
  readonly defaultProviderId: ProviderId;
  readonly authenticate: (authorization: string | undefined) => Principal | null;
  readonly logger: FastifyBaseLogger;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

const CORRELATION_ID = /^[A-Za-z0-9_.:-]{8,128}$/;

const amountSchema = z.object({
  cents: z.number().int(),
  currency: z.literal('BRL'),
}).strict();

const createPaymentSchema = z.object({
  merchantId: z.string(),
  terminalId: z.string(),
  externalReference: z.string(),
  amount: amountSchema,
}).strict();

const refundSchema = z.object({ amount: amountSchema }).strict();
const paymentParamsSchema = z.object({ paymentId: z.string() });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new RequestValidationError(result.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code })));
  }
  return result.data;
}

function requireIdempotencyKey(request: FastifyRequest): string {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || !isValidIdempotencyKey(key)) {
    throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'cabeçalho Idempotency-Key ausente ou inválido (8 a 128 caracteres [A-Za-z0-9_.:-])');
  }
  return key;
}

function requirePrincipal(request: FastifyRequest): Principal {
  if (!request.principal) throw new HttpError(401, 'UNAUTHENTICATED', 'credencial ausente ou inválida');
  return request.principal;
}

function contextOf(request: FastifyRequest): RequestContext {
  const principal = requirePrincipal(request);
  return { tenantId: principal.tenantId, actor: { type: 'API_CLIENT', id: principal.keyId }, correlationId: request.id };
}

function parsePaymentIdParam(params: unknown): PaymentId {
  const { paymentId } = parse(paymentParamsSchema, params);
  try {
    return parsePaymentId(paymentId);
  } catch {
    // ID malformado é tratado como inexistente: não revela formato nem existência.
    throw new HttpError(404, 'NOT_FOUND', 'pagamento não encontrado');
  }
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    loggerInstance: deps.logger,
    bodyLimit: 16 * 1024,
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: (req) => {
      const header = req.headers['x-correlation-id'];
      return typeof header === 'string' && CORRELATION_ID.test(header) ? header : randomUUID();
    },
  });

  app.decorateRequest('principal', null);

  // Autentica antes de ler o corpo ou validar parâmetros: sem credencial válida,
  // toda rota /v1 responde 401, sem revelar formato de IDs nem existência de rotas.
  app.addHook('onRequest', (request, _reply, done) => {
    request.principal = deps.authenticate(request.headers.authorization);
    if (!request.principal && request.url.startsWith('/v1/')) {
      done(new HttpError(401, 'UNAUTHENTICATED', 'credencial ausente ou inválida'));
      return;
    }
    done();
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-correlation-id', request.id);
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    return payload;
  });

  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        req: request,
        res: reply,
        responseTimeMs: Math.round(reply.elapsedTime),
        keyId: request.principal?.keyId ?? null,
        tenantId: request.principal?.tenantId ?? null,
      },
      'requisição concluída',
    );
  });

  app.setErrorHandler((error, request, reply) => {
    const { status, body, expected } = toHttpError(error, request.id);
    if (expected) {
      request.log.info({ errCode: body.error.code, status }, 'requisição rejeitada');
    } else {
      request.log.error({ err: error }, 'erro inesperado');
    }
    void reply.status(status).send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'rota não encontrada', correlationId: request.id } });
  });

  const providerKind = (view: PaymentView): 'SIMULATOR' | 'OFFICIAL' => deps.providers.get(view.payment.providerId).kind;
  const sendView = (reply: FastifyReply, status: number, view: PaymentView, replayed: boolean): FastifyReply => {
    if (replayed) reply.header('idempotent-replayed', 'true');
    return reply.status(status).send(presentPayment(view, providerKind(view)));
  };

  /** Garante que o pagamento pertence a um estabelecimento autorizado para a credencial. */
  const loadAuthorized = async (request: FastifyRequest, paymentId: PaymentId): Promise<PaymentView> => {
    const principal = requirePrincipal(request);
    const view = await deps.service.getPayment(contextOf(request), paymentId);
    if (!principal.merchantIds.has(view.payment.merchantId)) {
      throw new HttpError(404, 'NOT_FOUND', 'pagamento não encontrado');
    }
    return view;
  };

  app.get('/health', () => ({ status: 'ok' }));

  app.post('/v1/payments', async (request, reply) => {
    const ctx = contextOf(request);
    const principal = requirePrincipal(request);
    const key = requireIdempotencyKey(request);
    const body = parse(createPaymentSchema, request.body);
    const merchantId = parseMerchantId(body.merchantId);
    if (!principal.merchantIds.has(merchantId)) {
      throw new HttpError(403, 'FORBIDDEN', 'credencial sem acesso a este estabelecimento');
    }
    const result = await deps.service.createPayment(
      ctx,
      {
        merchantId,
        terminalId: parseTerminalId(body.terminalId),
        externalReference: parseExternalReference(body.externalReference),
        amount: positiveMoney(body.amount.cents, body.amount.currency),
        providerId: deps.defaultProviderId,
      },
      key,
    );
    return sendView(reply, result.responseStatus, result, result.replayed);
  });

  app.get('/v1/payments/:paymentId', async (request, reply) => {
    const view = await loadAuthorized(request, parsePaymentIdParam(request.params));
    return sendView(reply, 200, view, false);
  });

  app.post('/v1/payments/:paymentId/abandon', async (request, reply) => {
    const paymentId = parsePaymentIdParam(request.params);
    await loadAuthorized(request, paymentId);
    const view = await deps.service.cancelBeforeSubmission(contextOf(request), paymentId);
    return sendView(reply, 200, view, false);
  });

  const operationRoute = (path: string, run: (ctx: RequestContext, id: PaymentId, key: string, body: unknown) => ReturnType<PaymentService['authorize']>) => {
    app.post(`/v1/payments/:paymentId/${path}`, async (request, reply) => {
      const paymentId = parsePaymentIdParam(request.params);
      const key = requireIdempotencyKey(request);
      await loadAuthorized(request, paymentId);
      const result = await run(contextOf(request), paymentId, key, request.body);
      if (result.replayed) reply.header('idempotent-replayed', 'true');
      return reply.status(result.responseStatus).send({
        operation: presentOperation(result.operation),
        payment: presentPayment(result, providerKind(result)),
      });
    });
  };

  operationRoute('authorize', (ctx, id, key) => deps.service.authorize(ctx, id, key));
  operationRoute('confirm', (ctx, id, key) => deps.service.confirm(ctx, id, key));
  operationRoute('undo', (ctx, id, key) => deps.service.undo(ctx, id, key));
  operationRoute('cancel', (ctx, id, key) => deps.service.cancel(ctx, id, key));
  operationRoute('refunds', (ctx, id, key, rawBody) => {
    const body = parse(refundSchema, rawBody);
    return deps.service.refund(ctx, id, positiveMoney(body.amount.cents, body.amount.currency), key);
  });

  return app;
}
