import { parseProviderId, type OperationId, type OperationKind, type ProviderCapabilities } from '@tef/domain';
import type {
  PaymentProvider,
  ProviderNotification,
  ProviderOperationRequest,
  ProviderOperationResult,
  ProviderQueryRequest,
  ProviderQueryResult,
} from '@tef/provider-contract';

/**
 * SIMULADOR DE PAGAMENTOS — NÃO É UM ADQUIRENTE NEM UM PROVEDOR REAL.
 *
 * Produz resultados controlados para testar o núcleo transacional. Todos os
 * dados são fictícios (referências "SIM-...", códigos "SIM_..."). Não reproduz
 * o comportamento de nenhum provedor específico e não simula homologação.
 * A aplicação recusa este adaptador quando NODE_ENV=production.
 */
export const SIMULATOR_PROVIDER_ID = parseProviderId('SIMULATOR');

export type SimulatedOutcome = 'SUCCEEDED' | 'REJECTED' | 'ABORTED';

export type SimulatorScenario =
  /** Aprovação imediata. */
  | { readonly type: 'APPROVE'; readonly requiresConfirmation?: boolean }
  /** Recusa definitiva. */
  | { readonly type: 'DECLINE'; readonly resultCode?: string }
  /** Operação abandonada no terminal (ex.: cliente cancelou). */
  | { readonly type: 'ABORT_AT_TERMINAL' }
  /** Falha antes de qualquer envio simulado: nada é registrado no provedor. */
  | { readonly type: 'TIMEOUT_BEFORE_SEND' }
  /** O provedor processa, mas a resposta nunca chega (até o AbortSignal). */
  | { readonly type: 'TIMEOUT_AFTER_SEND'; readonly hiddenOutcome: SimulatedOutcome }
  /** O provedor processa e responde depois de `delayMs`; também emite notificação. */
  | { readonly type: 'DELAYED_RESPONSE'; readonly delayMs: number; readonly outcome: SimulatedOutcome }
  /** O provedor processa e a conexão cai antes da resposta (erro lançado). */
  | { readonly type: 'COMMUNICATION_FAILURE'; readonly hiddenOutcome: SimulatedOutcome | null }
  /** Aprovação entregue na resposta e repetida duas vezes por notificação. */
  | { readonly type: 'DUPLICATE_RESPONSE' }
  /** O adaptador responde UNKNOWN; a consulta posterior revela o resultado. */
  | { readonly type: 'UNKNOWN_THEN_RECONCILED'; readonly hiddenOutcome: SimulatedOutcome };

export type ScenarioResolver = (request: ProviderOperationRequest) => SimulatorScenario;

export const DEFAULT_SIMULATOR_CAPABILITIES: ProviderCapabilities = Object.freeze({
  twoPhaseConfirmation: false,
  undo: false,
  cancellation: true,
  refund: Object.freeze({ full: true, partial: true }),
  query: true,
  queryNotFoundIsDefinitive: true,
  guaranteesNotSentOnPreSendFailure: true,
});

/**
 * Convenção de testes manuais (APENAS SIMULADOR): os centavos finais do valor de
 * uma AUTORIZAÇÃO escolhem o cenário. Demais operações são aprovadas.
 *   ,51 recusa | ,52 abandono no terminal | ,53 timeout antes do envio
 *   ,54 timeout após envio | ,55 resposta atrasada | ,56 falha de comunicação
 *   ,57 resposta duplicada | ,58 desconhecido esclarecido por consulta | demais: aprova
 */
export function scenarioByAmountSuffix(options: { delayMs?: number; requiresConfirmation?: boolean } = {}): ScenarioResolver {
  return (request) => {
    if (request.kind !== 'AUTHORIZATION') return { type: 'APPROVE' };
    switch (request.amount.cents % 100) {
      case 51: return { type: 'DECLINE' };
      case 52: return { type: 'ABORT_AT_TERMINAL' };
      case 53: return { type: 'TIMEOUT_BEFORE_SEND' };
      case 54: return { type: 'TIMEOUT_AFTER_SEND', hiddenOutcome: 'SUCCEEDED' };
      case 55: return { type: 'DELAYED_RESPONSE', delayMs: options.delayMs ?? 10_000, outcome: 'SUCCEEDED' };
      case 56: return { type: 'COMMUNICATION_FAILURE', hiddenOutcome: 'SUCCEEDED' };
      case 57: return { type: 'DUPLICATE_RESPONSE' };
      case 58: return { type: 'UNKNOWN_THEN_RECONCILED', hiddenOutcome: 'SUCCEEDED' };
      default: return { type: 'APPROVE', requiresConfirmation: options.requiresConfirmation ?? false };
    }
  };
}

export class SimulatedCommunicationError extends Error {
  readonly code = 'SIMULATED_COMMUNICATION_FAILURE';
}

interface LedgerEntry {
  readonly kind: OperationKind;
  readonly outcome: SimulatedOutcome;
  readonly providerReference: string;
  readonly requiresConfirmation: boolean;
}

export interface SimulatorOptions {
  readonly capabilities?: ProviderCapabilities;
  readonly scenario?: ScenarioResolver;
}

function abortError(): Error {
  const error = new Error('operação abortada');
  error.name = 'AbortError';
  return error;
}

function sleep(ms: number, signal: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class PaymentSimulator implements PaymentProvider {
  readonly id = SIMULATOR_PROVIDER_ID;
  readonly kind = 'SIMULATOR' as const;
  readonly capabilities: ProviderCapabilities;
  readonly query?: (request: ProviderQueryRequest, signal: AbortSignal) => Promise<ProviderQueryResult>;

  private readonly resolveScenario: ScenarioResolver;
  private readonly ledger = new Map<OperationId, LedgerEntry>();
  private readonly listeners = new Set<(n: ProviderNotification) => void>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private sequence = 0;

  constructor(options: SimulatorOptions = {}) {
    this.capabilities = options.capabilities ?? DEFAULT_SIMULATOR_CAPABILITIES;
    this.resolveScenario =
      options.scenario ?? scenarioByAmountSuffix({ requiresConfirmation: this.capabilities.twoPhaseConfirmation });
    if (this.capabilities.query) {
      this.query = (request, signal) => this.queryLedger(request, signal);
    }
  }

  /** Assina notificações assíncronas (equivalente simulado de webhooks). */
  onNotification(listener: (n: ProviderNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Cancela notificações agendadas (uso em testes). */
  dispose(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.listeners.clear();
  }

  /** Número de operações que "chegaram" ao provedor simulado (para asserções de não repetição). */
  receivedCount(): number {
    return this.ledger.size;
  }

  async execute(request: ProviderOperationRequest, signal: AbortSignal): Promise<ProviderOperationResult> {
    if (signal.aborted) {
      if (this.capabilities.guaranteesNotSentOnPreSendFailure) return { status: 'NOT_SENT', resultCode: 'SIM_ABORTED_BEFORE_SEND' };
      throw abortError();
    }
    const scenario = this.resolveScenario(request);

    switch (scenario.type) {
      case 'APPROVE': {
        const requiresConfirmation = request.kind === 'AUTHORIZATION' && (scenario.requiresConfirmation ?? false);
        const entry = this.record(request, 'SUCCEEDED', requiresConfirmation);
        return this.toResult(entry);
      }
      case 'DECLINE':
        return this.toResult(this.record(request, 'REJECTED', false), scenario.resultCode ?? 'SIM_DECLINED');
      case 'ABORT_AT_TERMINAL':
        return this.toResult(this.record(request, 'ABORTED', false), 'SIM_ABORTED_AT_TERMINAL');
      case 'TIMEOUT_BEFORE_SEND':
        if (this.capabilities.guaranteesNotSentOnPreSendFailure) {
          return { status: 'NOT_SENT', resultCode: 'SIM_TIMEOUT_BEFORE_SEND' };
        }
        return { status: 'UNKNOWN', resultCode: 'SIM_PRE_SEND_FAILURE_UNVERIFIED' };
      case 'TIMEOUT_AFTER_SEND':
        this.record(request, scenario.hiddenOutcome, false);
        await new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => reject(abortError()), { once: true });
        });
        throw abortError(); // inalcançável: a promessa acima só rejeita
      case 'DELAYED_RESPONSE': {
        const entry = this.record(request, scenario.outcome, false);
        this.notifyLater(request, entry, scenario.delayMs);
        await sleep(scenario.delayMs, signal);
        return this.toResult(entry);
      }
      case 'COMMUNICATION_FAILURE':
        if (scenario.hiddenOutcome) this.record(request, scenario.hiddenOutcome, false);
        throw new SimulatedCommunicationError('falha de comunicação simulada');
      case 'DUPLICATE_RESPONSE': {
        const entry = this.record(request, 'SUCCEEDED', false);
        this.notifyLater(request, entry, 0);
        this.notifyLater(request, entry, 0);
        return this.toResult(entry);
      }
      case 'UNKNOWN_THEN_RECONCILED':
        this.record(request, scenario.hiddenOutcome, false);
        return { status: 'UNKNOWN', resultCode: 'SIM_RESULT_NOT_RECEIVED' };
    }
  }

  private async queryLedger(request: ProviderQueryRequest, signal: AbortSignal): Promise<ProviderQueryResult> {
    if (signal.aborted) return { status: 'UNAVAILABLE', resultCode: 'SIM_QUERY_ABORTED' };
    await Promise.resolve();
    const entry = this.ledger.get(request.clientReference);
    if (!entry || entry.kind !== request.kind) return { status: 'NOT_FOUND' };
    return {
      status: 'FOUND',
      outcome: entry.outcome,
      providerReference: entry.providerReference,
      resultCode: `SIM_${entry.outcome}`,
      requiresConfirmation: entry.requiresConfirmation,
    };
  }

  private record(request: ProviderOperationRequest, outcome: SimulatedOutcome, requiresConfirmation: boolean): LedgerEntry {
    const existing = this.ledger.get(request.clientReference);
    if (existing) return existing; // o simulador também é idempotente pela referência do cliente
    this.sequence++;
    const entry: LedgerEntry = {
      kind: request.kind,
      outcome,
      providerReference: `SIM-${String(this.sequence).padStart(8, '0')}`,
      requiresConfirmation,
    };
    this.ledger.set(request.clientReference, entry);
    return entry;
  }

  private toResult(entry: LedgerEntry, resultCode?: string): ProviderOperationResult {
    switch (entry.outcome) {
      case 'SUCCEEDED':
        return {
          status: 'SUCCEEDED',
          providerReference: entry.providerReference,
          resultCode: resultCode ?? 'SIM_APPROVED',
          requiresConfirmation: entry.requiresConfirmation,
        };
      case 'REJECTED':
        return { status: 'REJECTED', providerReference: entry.providerReference, resultCode: resultCode ?? 'SIM_DECLINED' };
      case 'ABORTED':
        return { status: 'ABORTED', providerReference: entry.providerReference, resultCode: resultCode ?? 'SIM_ABORTED' };
    }
  }

  private notifyLater(request: ProviderOperationRequest, entry: LedgerEntry, delayMs: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      const result = this.toResult(entry);
      if (result.status === 'NOT_SENT' || result.status === 'UNKNOWN') return;
      const notification: ProviderNotification = { providerId: this.id, clientReference: request.clientReference, result };
      for (const listener of this.listeners) listener(notification);
    }, delayMs);
    this.timers.add(timer);
  }
}
