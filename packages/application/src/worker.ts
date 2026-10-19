import type { Actor, PaymentService } from './payment-service.ts';
import { NOOP_LOGGER, type AppLogger, type Job, type StoredOutboxEvent, type UnitOfWork } from './ports.ts';

/**
 * Destino dos eventos da outbox. Nesta fase: registro estruturado (log). Entrega
 * por webhook a clientes fica para fases futuras.
 */
export interface OutboxSink {
  deliver(event: StoredOutboxEvent): Promise<void>;
}

export interface OutboxPublisherDeps {
  readonly uow: UnitOfWork;
  readonly sink: OutboxSink;
  readonly clock?: () => Date;
  readonly logger?: AppLogger;
  readonly batchSize?: number;
}

/**
 * Publica a outbox com entrega pelo menos uma vez: os eventos são reivindicados
 * com bloqueio, entregues e marcados como publicados na MESMA transação. Se o
 * processo cair antes do commit, os eventos continuam pendentes e serão
 * entregues de novo (os consumidores deduplicam pelo id do evento).
 */
export class OutboxPublisher {
  private readonly deps: Required<Omit<OutboxPublisherDeps, 'logger' | 'clock'>> & { clock: () => Date; logger: AppLogger };

  constructor(deps: OutboxPublisherDeps) {
    this.deps = {
      uow: deps.uow,
      sink: deps.sink,
      batchSize: deps.batchSize ?? 50,
      clock: deps.clock ?? (() => new Date()),
      logger: deps.logger ?? NOOP_LOGGER,
    };
  }

  async publishOnce(): Promise<{ published: number; failed: number }> {
    const { uow, sink, batchSize, clock, logger } = this.deps;
    return uow.transaction(async (repos) => {
      const now = clock();
      const events = await repos.outbox.claimUnpublished(batchSize, now);
      let published = 0;
      let failed = 0;
      for (const event of events) {
        try {
          await sink.deliver(event);
          await repos.outbox.markPublished(event.id, now);
          published++;
        } catch (error) {
          failed++;
          const delay = Math.min(1_000 * 2 ** Math.min(event.deliveryAttempts, 10), 10 * 60_000);
          await repos.outbox.markDeliveryFailed(event.id, new Date(now.getTime() + delay), 'SINK_DELIVERY_FAILED');
          logger.warn({ outboxId: event.id, errorName: error instanceof Error ? error.name : 'unknown' }, 'falha ao entregar evento da outbox; nova tentativa agendada');
        }
      }
      return { published, failed };
    });
  }
}

export interface WorkerDeps {
  readonly uow: UnitOfWork;
  readonly service: PaymentService;
  readonly publisher: OutboxPublisher;
  readonly workerId: string;
  /** Lease das tarefas; precisa ser bem maior que o timeout do provedor. */
  readonly leaseMs: number;
  readonly batchSize?: number;
  readonly pollIntervalMs?: number;
  readonly recoverySweepIntervalMs?: number;
  readonly clock?: () => Date;
  readonly logger?: AppLogger;
}

export interface WorkerHealth {
  readonly workerId: string;
  readonly status: 'IDLE' | 'RUNNING' | 'STOPPING' | 'STOPPED';
  readonly startedAt: string | null;
  readonly lastLoopAt: string | null;
  readonly lastLoopError: string | null;
  readonly jobsProcessed: number;
  readonly eventsPublished: number;
}

/**
 * Worker: reivindica tarefas duráveis (PostgreSQL), executa-as e publica a outbox.
 * O laço de polling é só um gatilho; todo estado vive no banco, então nenhuma
 * tarefa se perde se o processo reiniciar.
 */
export class Worker {
  private readonly uow: UnitOfWork;
  private readonly service: PaymentService;
  private readonly publisher: OutboxPublisher;
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private readonly recoverySweepIntervalMs: number;
  private readonly clock: () => Date;
  private readonly logger: AppLogger;
  private readonly actor: Actor;

  private status: WorkerHealth['status'] = 'IDLE';
  private startedAt: Date | null = null;
  private lastLoopAt: Date | null = null;
  private lastLoopError: string | null = null;
  private lastRecoveryAt = 0;
  private jobsProcessed = 0;
  private eventsPublished = 0;
  private timer: NodeJS.Timeout | null = null;
  private currentLoop: Promise<void> | null = null;

  constructor(deps: WorkerDeps) {
    const minLease = deps.service.providerCallTimeoutMs * 2 + 1_000;
    if (deps.leaseMs < minLease) {
      throw new Error(`leaseMs (${deps.leaseMs}) deve ser >= ${minLease} (2x timeout do provedor + 1s)`);
    }
    this.uow = deps.uow;
    this.service = deps.service;
    this.publisher = deps.publisher;
    this.workerId = deps.workerId;
    this.leaseMs = deps.leaseMs;
    this.batchSize = deps.batchSize ?? 10;
    this.pollIntervalMs = deps.pollIntervalMs ?? 500;
    this.recoverySweepIntervalMs = deps.recoverySweepIntervalMs ?? 30_000;
    this.clock = deps.clock ?? (() => new Date());
    this.logger = deps.logger ?? NOOP_LOGGER;
    this.actor = { type: 'SYSTEM', id: `worker:${deps.workerId}` };
  }

  /** Uma iteração completa (usada pelo laço e diretamente pelos testes). */
  async runOnce(): Promise<{ jobs: number; published: number }> {
    const now = this.clock();
    await this.uow.transaction((repos) =>
      repos.heartbeats.beat({ workerId: this.workerId, startedAt: this.startedAt ?? now, lastBeatAt: now, status: 'RUNNING' }),
    );

    const jobs = await this.uow.transaction((repos) => repos.jobs.claim(this.workerId, this.batchSize, this.leaseMs, now));
    await Promise.all(jobs.map((job) => this.runJob(job)));
    this.jobsProcessed += jobs.length;

    if (now.getTime() - this.lastRecoveryAt >= this.recoverySweepIntervalMs) {
      this.lastRecoveryAt = now.getTime();
      const recovered = await this.service.recoverStaleInFlight(this.leaseMs * 2);
      if (recovered > 0) this.logger.warn({ recovered }, 'operações IN_FLIGHT antigas marcadas como UNKNOWN (sem reenvio)');
    }

    const { published } = await this.publisher.publishOnce();
    this.eventsPublished += published;
    this.lastLoopAt = this.clock();
    return { jobs: jobs.length, published };
  }

  private async runJob(job: Job): Promise<void> {
    const now = this.clock();
    try {
      if (job.attempts > job.maxAttempts) {
        await this.uow.transaction((repos) => repos.jobs.retryLater(job.id, this.workerId, now, 'MAX_ATTEMPTS_EXCEEDED', now));
        this.logger.error({ jobId: job.id, operationId: job.operationId, kind: job.kind }, 'tarefa excedeu o máximo de tentativas; marcada FAILED');
        return;
      }
      const outcome = await this.service.processJob(job, this.actor, { workerId: this.workerId, leaseMs: this.leaseMs });
      if (outcome.kind === 'LOST_LEASE') return; // outro worker é o dono atual
      if (outcome.kind === 'DONE') {
        const completed = await this.uow.transaction((repos) => repos.jobs.complete(job.id, this.workerId, this.clock()));
        if (!completed) this.logger.warn({ jobId: job.id }, 'lease perdido antes da conclusão; outro worker assumiu a tarefa');
      } else {
        const result = await this.uow.transaction((repos) =>
          repos.jobs.retryLater(job.id, this.workerId, outcome.availableAt, outcome.errorCode, this.clock()),
        );
        if (result === 'FAILED') this.logger.error({ jobId: job.id, kind: job.kind }, 'tarefa sem resolução após o máximo de tentativas');
      }
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      this.logger.error(
        { jobId: job.id, kind: job.kind, err: error, code: typeof code === 'string' ? code : null },
        'falha ao processar tarefa; será retomada',
      );
      await this.uow
        .transaction((repos) =>
          repos.jobs.retryLater(job.id, this.workerId, new Date(this.clock().getTime() + 1_000 * job.attempts), 'PROCESSING_ERROR', this.clock()),
        )
        .catch(() => undefined); // se nem isso for possível, o lease expira e a tarefa é retomada
    }
  }

  start(): void {
    if (this.status === 'RUNNING') return;
    this.status = 'RUNNING';
    this.startedAt = this.clock();
    const loop = (): void => {
      if (this.status !== 'RUNNING') return;
      this.currentLoop = this.runOnce()
        .then(() => {
          this.lastLoopError = null;
        })
        .catch((error: unknown) => {
          this.lastLoopError = error instanceof Error ? error.name : 'unknown';
          this.logger.error({ err: error }, 'falha no laço do worker');
        })
        .finally(() => {
          this.currentLoop = null;
          if (this.status === 'RUNNING') this.timer = setTimeout(loop, this.pollIntervalMs);
        });
    };
    loop();
  }

  /** Encerramento gracioso: para de reivindicar, aguarda a iteração em curso e registra STOPPED. */
  async stop(): Promise<void> {
    if (this.status !== 'RUNNING') return;
    this.status = 'STOPPING';
    if (this.timer) clearTimeout(this.timer);
    if (this.currentLoop) await this.currentLoop;
    const now = this.clock();
    await this.uow
      .transaction((repos) => repos.heartbeats.beat({ workerId: this.workerId, startedAt: this.startedAt ?? now, lastBeatAt: now, status: 'STOPPED' }))
      .catch(() => undefined);
    this.status = 'STOPPED';
  }

  health(): WorkerHealth {
    return {
      workerId: this.workerId,
      status: this.status,
      startedAt: this.startedAt?.toISOString() ?? null,
      lastLoopAt: this.lastLoopAt?.toISOString() ?? null,
      lastLoopError: this.lastLoopError,
      jobsProcessed: this.jobsProcessed,
      eventsPublished: this.eventsPublished,
    };
  }
}
