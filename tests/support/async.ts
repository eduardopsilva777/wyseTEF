import { type OutboxSink, type StoredOutboxEvent, type UnitOfWork } from '@tef/application';
import type { SimulatorLedger } from '@tef/provider-simulator';
import { createWorkerRuntime, type WorkerRuntime } from '../../apps/worker/src/runtime.ts';

/** Sink de teste que registra entregas e pode falhar sob demanda. */
export class RecordingSink implements OutboxSink {
  readonly delivered: StoredOutboxEvent[] = [];
  failNext = 0;

  deliver(event: StoredOutboxEvent): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--;
      return Promise.reject(new Error('sink indisponível'));
    }
    this.delivered.push(event);
    return Promise.resolve();
  }
}

export interface TestRuntime extends WorkerRuntime {
  readonly sink: RecordingSink;
  /** Relógio controlável compartilhado (ms). */
  readonly clock: { ms: number };
}

/** Runtime real do worker (apps/worker) com relógio controlável e sink de teste. */
export function testRuntime(
  uow: UnitOfWork,
  options: { workerId?: string; providerTimeoutMs?: number; simulatorDelayMs?: number; clock?: { ms: number }; ledger?: SimulatorLedger } = {},
): TestRuntime {
  const clock = options.clock ?? { ms: Date.parse('2026-10-18T12:00:00.000Z') };
  const sink = new RecordingSink();
  const providerTimeoutMs = options.providerTimeoutMs ?? 40;
  const runtime = createWorkerRuntime({
    uow,
    logger: { info() {}, warn() {}, error() {} },
    workerId: options.workerId ?? 'worker-a',
    providerTimeoutMs,
    leaseMs: providerTimeoutMs * 2 + 1_000,
    simulatorDelayMs: options.simulatorDelayMs ?? 120,
    clock: () => new Date(clock.ms),
    sink,
    ...(options.ledger ? { simulatorLedger: options.ledger } : {}),
  });
  return { ...runtime, sink, clock };
}
