import { parseProviderId, uuidv7Timestamp, type OperationId, type OperationKind, type ProviderCapabilities } from '@tef/domain';
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

export type ScenarioResolver = (request: ProviderOperationRequest) => SimulatorScenario | Promise<SimulatorScenario>;

/**
 * Diretivas de teste aceitas pelo painel local (dados fictícios). Aplicam-se à
 * AUTORIZAÇÃO; as demais operações do mesmo pagamento são aprovadas.
 */
export const SIMULATOR_DIRECTIVES = {
  APPROVE: { label: 'Aprovação', expected: 'APPROVED' },
  DECLINE: { label: 'Recusa', expected: 'DECLINED' },
  ABORT_AT_TERMINAL: { label: 'Cancelado no terminal pelo portador', expected: 'CANCELLED' },
  TIMEOUT_BEFORE_SEND: { label: 'Timeout antes do envio', expected: 'CANCELLED (não enviado)' },
  TIMEOUT_AFTER_SEND: { label: 'Timeout após possível envio', expected: 'UNKNOWN → reconciliado como APPROVED' },
  COMMUNICATION_FAILURE: { label: 'Falha de comunicação após envio', expected: 'UNKNOWN → reconciliado como DECLINED' },
  DELAYED_RESPONSE: { label: 'Resposta atrasada (após o timeout)', expected: 'UNKNOWN → resolvido pela notificação como APPROVED' },
  DUPLICATE_RESPONSE: { label: 'Resposta duplicada', expected: 'APPROVED (duplicatas ignoradas)' },
  UNKNOWN_THEN_RECONCILED: { label: 'Resultado desconhecido esclarecido por consulta', expected: 'UNKNOWN → reconciliado como APPROVED' },
} as const;

export type SimulatorDirective = keyof typeof SIMULATOR_DIRECTIVES;

export function isSimulatorDirective(value: string): value is SimulatorDirective {
  return Object.hasOwn(SIMULATOR_DIRECTIVES, value);
}

/** Converte a diretiva persistida no cenário do simulador. */
export function scenarioFromDirective(directive: SimulatorDirective, options: { delayMs: number }): SimulatorScenario {
  switch (directive) {
    case 'APPROVE': return { type: 'APPROVE' };
    case 'DECLINE': return { type: 'DECLINE' };
    case 'ABORT_AT_TERMINAL': return { type: 'ABORT_AT_TERMINAL' };
    case 'TIMEOUT_BEFORE_SEND': return { type: 'TIMEOUT_BEFORE_SEND' };
    case 'TIMEOUT_AFTER_SEND': return { type: 'TIMEOUT_AFTER_SEND', hiddenOutcome: 'SUCCEEDED' };
    case 'COMMUNICATION_FAILURE': return { type: 'COMMUNICATION_FAILURE', hiddenOutcome: 'REJECTED' };
    case 'DELAYED_RESPONSE': return { type: 'DELAYED_RESPONSE', delayMs: options.delayMs, outcome: 'SUCCEEDED' };
    case 'DUPLICATE_RESPONSE': return { type: 'DUPLICATE_RESPONSE' };
    case 'UNKNOWN_THEN_RECONCILED': return { type: 'UNKNOWN_THEN_RECONCILED', hiddenOutcome: 'SUCCEEDED' };
  }
}

/**
 * Resolvedor que consulta a diretiva do pagamento (ex.: no PostgreSQL) e, sem
 * diretiva, recorre à convenção por centavos.
 */
export function directiveScenarioResolver(
  lookup: (request: ProviderOperationRequest) => Promise<string | null>,
  options: { delayMs: number },
): ScenarioResolver {
  const fallback = scenarioByAmountSuffix({ delayMs: options.delayMs });
  return async (request) => {
    if (request.kind !== 'AUTHORIZATION') return { type: 'APPROVE' };
    const directive = await lookup(request);
    return directive && isSimulatorDirective(directive) ? scenarioFromDirective(directive, options) : fallback(request);
  };
}

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

export interface LedgerEntry {
  readonly kind: OperationKind;
  readonly outcome: SimulatedOutcome;
  readonly providerReference: string;
  readonly requiresConfirmation: boolean;
}

/**
 * "Verdade do lado do provedor" do simulador: o que ele processou, por referência
 * do cliente. Precisa ser compartilhada por todos os processos que consultam o
 * simulador e sobreviver a reinícios — senão uma consulta responderia "não
 * encontrado" para algo que foi processado (ver docs/decisions/0016).
 */
export interface SimulatorLedger {
  /** Grava se ainda não existir; devolve o registro vigente (idempotente pela referência). */
  recordIfAbsent(clientReference: OperationId, entry: Omit<LedgerEntry, 'providerReference'>): Promise<LedgerEntry>;
  find(clientReference: OperationId): Promise<LedgerEntry | null>;
  /**
   * O livro só responde por operações criadas depois que ele passou a existir (o ID
   * UUIDv7 da operação carrega o instante de criação). Para as anteriores, a ausência
   * de registro NÃO prova que nada foi processado.
   */
  isAuthoritativeFor(clientReference: OperationId): Promise<boolean>;
}

/** Livro em memória: adequado para testes de um único processo. */
export class InMemorySimulatorLedger implements SimulatorLedger {
  private readonly entries = new Map<OperationId, LedgerEntry>();
  private sequence = 0;
  private readonly startedAt: number;

  constructor(startedAt: number = Date.now()) {
    this.startedAt = startedAt;
  }

  isAuthoritativeFor(clientReference: OperationId): Promise<boolean> {
    const created = uuidv7Timestamp(clientReference);
    return Promise.resolve(created !== null && created >= this.startedAt);
  }

  recordIfAbsent(clientReference: OperationId, entry: Omit<LedgerEntry, 'providerReference'>): Promise<LedgerEntry> {
    const existing = this.entries.get(clientReference);
    if (existing) return Promise.resolve(existing);
    this.sequence++;
    const created: LedgerEntry = { ...entry, providerReference: `SIM-${String(this.sequence).padStart(8, '0')}` };
    this.entries.set(clientReference, created);
    return Promise.resolve(created);
  }

  find(clientReference: OperationId): Promise<LedgerEntry | null> {
    return Promise.resolve(this.entries.get(clientReference) ?? null);
  }
}

export interface SimulatorOptions {
  readonly capabilities?: ProviderCapabilities;
  readonly scenario?: ScenarioResolver;
  readonly ledger?: SimulatorLedger;
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
  private readonly ledger: SimulatorLedger;
  private readonly listeners = new Set<(n: ProviderNotification) => void>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly receivedHere = new Set<OperationId>();

  constructor(options: SimulatorOptions = {}) {
    this.capabilities = options.capabilities ?? DEFAULT_SIMULATOR_CAPABILITIES;
    this.ledger = options.ledger ?? new InMemorySimulatorLedger();
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

  /** Operações distintas que chegaram a ESTA instância do simulador (asserções de não repetição). */
  receivedCount(): number {
    return this.receivedHere.size;
  }

  async execute(request: ProviderOperationRequest, signal: AbortSignal): Promise<ProviderOperationResult> {
    if (signal.aborted) {
      if (this.capabilities.guaranteesNotSentOnPreSendFailure) return { status: 'NOT_SENT', resultCode: 'SIM_ABORTED_BEFORE_SEND' };
      throw abortError();
    }
    const scenario = await this.resolveScenario(request);

    switch (scenario.type) {
      case 'APPROVE': {
        const requiresConfirmation = request.kind === 'AUTHORIZATION' && (scenario.requiresConfirmation ?? false);
        const entry = await this.record(request, 'SUCCEEDED', requiresConfirmation);
        return this.toResult(entry);
      }
      case 'DECLINE':
        return this.toResult(await this.record(request, 'REJECTED', false), scenario.resultCode ?? 'SIM_DECLINED');
      case 'ABORT_AT_TERMINAL':
        return this.toResult(await this.record(request, 'ABORTED', false), 'SIM_ABORTED_AT_TERMINAL');
      case 'TIMEOUT_BEFORE_SEND':
        if (this.capabilities.guaranteesNotSentOnPreSendFailure) {
          return { status: 'NOT_SENT', resultCode: 'SIM_TIMEOUT_BEFORE_SEND' };
        }
        return { status: 'UNKNOWN', resultCode: 'SIM_PRE_SEND_FAILURE_UNVERIFIED' };
      case 'TIMEOUT_AFTER_SEND':
        await this.record(request, scenario.hiddenOutcome, false);
        await new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => reject(abortError()), { once: true });
        });
        throw abortError(); // inalcançável: a promessa acima só rejeita
      case 'DELAYED_RESPONSE': {
        const entry = await this.record(request, scenario.outcome, false);
        this.notifyLater(request, entry, scenario.delayMs);
        await sleep(scenario.delayMs, signal);
        return this.toResult(entry);
      }
      case 'COMMUNICATION_FAILURE':
        if (scenario.hiddenOutcome) await this.record(request, scenario.hiddenOutcome, false);
        throw new SimulatedCommunicationError('falha de comunicação simulada');
      case 'DUPLICATE_RESPONSE': {
        const entry = await this.record(request, 'SUCCEEDED', false);
        this.notifyLater(request, entry, 0);
        this.notifyLater(request, entry, 0);
        return this.toResult(entry);
      }
      case 'UNKNOWN_THEN_RECONCILED':
        await this.record(request, scenario.hiddenOutcome, false);
        return { status: 'UNKNOWN', resultCode: 'SIM_RESULT_NOT_RECEIVED' };
    }
  }

  private async queryLedger(request: ProviderQueryRequest, signal: AbortSignal): Promise<ProviderQueryResult> {
    if (signal.aborted) return { status: 'UNAVAILABLE', resultCode: 'SIM_QUERY_ABORTED' };
    const entry = await this.ledger.find(request.clientReference);
    if (!entry && !(await this.ledger.isAuthoritativeFor(request.clientReference))) {
      return { status: 'UNAVAILABLE', resultCode: 'SIM_LEDGER_NOT_AUTHORITATIVE' };
    }
    if (!entry || entry.kind !== request.kind) return { status: 'NOT_FOUND' };
    return {
      status: 'FOUND',
      outcome: entry.outcome,
      providerReference: entry.providerReference,
      resultCode: `SIM_${entry.outcome}`,
      requiresConfirmation: entry.requiresConfirmation,
    };
  }

  /** O simulador também é idempotente pela referência do cliente. */
  private async record(request: ProviderOperationRequest, outcome: SimulatedOutcome, requiresConfirmation: boolean): Promise<LedgerEntry> {
    this.receivedHere.add(request.clientReference);
    return this.ledger.recordIfAbsent(request.clientReference, { kind: request.kind, outcome, requiresConfirmation });
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
