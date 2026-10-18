import { PaymentService, type RequestContext, type UnitOfWork } from '@tef/application';
import {
  money,
  parseMerchantId,
  parseTenantId,
  parseTerminalId,
  type ProviderCapabilities,
} from '@tef/domain';
import { InMemoryUnitOfWork } from '@tef/persistence/memory';
import { createProviderRegistry, type PaymentProvider } from '@tef/provider-contract';
import {
  DEFAULT_SIMULATOR_CAPABILITIES,
  PaymentSimulator,
  SIMULATOR_PROVIDER_ID,
  type SimulatorScenario,
} from '@tef/provider-simulator';

export const TENANT_A = parseTenantId('tenant-a');
export const TENANT_B = parseTenantId('tenant-b');
export const MERCHANT = parseMerchantId('merchant-1');
export const TERMINAL = parseTerminalId('terminal-1');

export const ctxA: RequestContext = { tenantId: TENANT_A, actor: { type: 'API_CLIENT', id: 'key-a' }, correlationId: 'corr-test-a' };
export const ctxB: RequestContext = { tenantId: TENANT_B, actor: { type: 'API_CLIENT', id: 'key-b' }, correlationId: 'corr-test-b' };

export const ALL_SIM_CAPABILITIES: ProviderCapabilities = {
  ...DEFAULT_SIMULATOR_CAPABILITIES,
  twoPhaseConfirmation: true,
  undo: true,
};

export interface Harness {
  readonly service: PaymentService;
  readonly simulator: PaymentSimulator;
  readonly uow: UnitOfWork;
  /** Cenário aplicado às próximas operações (padrão: APPROVE). */
  scenario: SimulatorScenario;
  /** Relógio controlável (ms). */
  clockMs: number;
}

export interface HarnessOptions {
  readonly capabilities?: ProviderCapabilities;
  readonly providerTimeoutMs?: number;
  readonly uow?: UnitOfWork;
  readonly extraProviders?: readonly PaymentProvider[];
  readonly forwardNotifications?: boolean;
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const state = { scenario: { type: 'APPROVE' } as SimulatorScenario, clockMs: Date.parse('2026-10-18T12:00:00.000Z') };
  const simulator = new PaymentSimulator({
    capabilities: options.capabilities ?? DEFAULT_SIMULATOR_CAPABILITIES,
    scenario: () => state.scenario,
  });
  const uow = options.uow ?? new InMemoryUnitOfWork();
  const service = new PaymentService({
    uow,
    providers: createProviderRegistry([simulator, ...(options.extraProviders ?? [])]),
    providerTimeoutMs: options.providerTimeoutMs ?? 50,
    clock: () => new Date(state.clockMs),
  });
  if (options.forwardNotifications) {
    simulator.onNotification((n) => {
      void service.handleProviderNotification(n).catch(() => undefined);
    });
  }
  return Object.assign(state, { service, simulator, uow });
}

let referenceCounter = 0;

export function createCommand(cents = 10_000, externalReference = `pedido-${++referenceCounter}`) {
  return {
    merchantId: MERCHANT,
    terminalId: TERMINAL,
    externalReference,
    amount: money(cents),
    providerId: SIMULATOR_PROVIDER_ID,
  };
}

let keyCounter = 0;
export const newKey = (): string => `idem-key-${Date.now()}-${++keyCounter}`;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
