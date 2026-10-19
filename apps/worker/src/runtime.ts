import { createServer, type Server } from 'node:http';
import {
  OutboxPublisher,
  PaymentService,
  Worker,
  type AppLogger,
  type OutboxSink,
  type UnitOfWork,
} from '@tef/application';
import { createProviderRegistry } from '@tef/provider-contract';
import { directiveScenarioResolver, PaymentSimulator, type SimulatorLedger } from '@tef/provider-simulator';

/**
 * Montagem do worker (sem efeitos colaterais de processo), reutilizada pelo
 * `main.ts` e pelos testes de integração API + worker.
 */
export interface WorkerRuntimeOptions {
  readonly uow: UnitOfWork;
  readonly logger: AppLogger;
  readonly workerId: string;
  readonly providerTimeoutMs: number;
  readonly leaseMs: number;
  readonly pollIntervalMs?: number;
  readonly batchSize?: number;
  readonly simulatorDelayMs: number;
  readonly clock?: () => Date;
  readonly sink?: OutboxSink;
  /** Livro do simulador; em processos reais, o do PostgreSQL (compartilhado e durável). */
  readonly simulatorLedger?: SimulatorLedger;
}

export interface WorkerRuntime {
  readonly worker: Worker;
  readonly service: PaymentService;
  readonly simulator: PaymentSimulator;
  readonly publisher: OutboxPublisher;
}

/** Sink padrão: registra metadados do evento (sem payload) no log estruturado. */
export function logSink(logger: AppLogger): OutboxSink {
  return {
    deliver(event) {
      logger.info(
        { outboxId: event.id, eventType: event.eventType, aggregateId: event.aggregateId, tenantId: event.tenantId },
        'evento da outbox publicado',
      );
      return Promise.resolve();
    },
  };
}

export function createWorkerRuntime(options: WorkerRuntimeOptions): WorkerRuntime {
  const { uow, logger } = options;
  // O cenário do simulador vem da diretiva gravada junto com o pagamento (painel local);
  // sem diretiva, vale a convenção por centavos.
  const simulator = new PaymentSimulator({
    ...(options.simulatorLedger ? { ledger: options.simulatorLedger } : {}),
    scenario: directiveScenarioResolver(
      (request) => uow.transaction((repos) => repos.testDirectives.get(request.paymentId)),
      { delayMs: options.simulatorDelayMs },
    ),
  });
  const providers = createProviderRegistry([simulator]);
  const service = new PaymentService({
    uow,
    providers,
    providerTimeoutMs: options.providerTimeoutMs,
    logger,
    ...(options.clock ? { clock: options.clock } : {}),
  });
  simulator.onNotification((notification) => {
    service.handleProviderNotification(notification).catch((error: unknown) => {
      logger.warn({ err: error, operationId: notification.clientReference }, 'falha ao processar notificação do simulador');
    });
  });
  const publisher = new OutboxPublisher({
    uow,
    sink: options.sink ?? logSink(logger),
    logger,
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const worker = new Worker({
    uow,
    service,
    publisher,
    workerId: options.workerId,
    leaseMs: options.leaseMs,
    logger,
    ...(options.pollIntervalMs ? { pollIntervalMs: options.pollIntervalMs } : {}),
    ...(options.batchSize ? { batchSize: options.batchSize } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  });
  return { worker, service, simulator, publisher };
}

/** Health check HTTP mínimo (somente loopback). 200 se o laço rodou recentemente, 503 caso contrário. */
export function startHealthServer(worker: Worker, host: string, port: number, staleAfterMs: number): Server {
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || (req.url !== '/health' && req.url !== '/ready')) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not_found"}');
      return;
    }
    const health = worker.health();
    const fresh = health.lastLoopAt !== null && Date.now() - Date.parse(health.lastLoopAt) < staleAfterMs;
    const ok = health.status === 'RUNNING' && fresh;
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(
      JSON.stringify({ health: ok ? 'ok' : 'degraded', ...health }),
    );
  });
  server.listen(port, host);
  return server;
}
