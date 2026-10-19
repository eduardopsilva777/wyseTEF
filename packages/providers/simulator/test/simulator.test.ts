import { afterEach, describe, expect, it } from 'vitest';
import { money, newOperationId, newPaymentId, parseTerminalId, uuidv7Timestamp, type OperationKind } from '@tef/domain';
import type { ProviderNotification, ProviderOperationRequest } from '@tef/provider-contract';
import { runProviderConformanceSuite } from '@tef/provider-contract/conformance';
import {
  DEFAULT_SIMULATOR_CAPABILITIES,
  InMemorySimulatorLedger,
  PaymentSimulator,
  SimulatedCommunicationError,
  type SimulatorScenario,
} from '../src/index.ts';

function request(kind: OperationKind = 'AUTHORIZATION', cents = 1_000): ProviderOperationRequest {
  return {
    kind,
    clientReference: newOperationId(),
    paymentId: newPaymentId(),
    terminalId: parseTerminalId('terminal-1'),
    amount: money(cents),
    originalProviderReference: null,
  };
}

runProviderConformanceSuite({
  name: 'SIMULATOR (padrão)',
  createProvider: () => new PaymentSimulator(),
  successfulRequest: (kind) => request(kind, 1_000),
});

runProviderConformanceSuite({
  name: 'SIMULATOR (sem capacidades opcionais)',
  createProvider: () =>
    new PaymentSimulator({
      capabilities: {
        twoPhaseConfirmation: false,
        undo: false,
        cancellation: false,
        refund: { full: false, partial: false },
        query: false,
        queryNotFoundIsDefinitive: false,
        guaranteesNotSentOnPreSendFailure: false,
      },
    }),
  successfulRequest: (kind) => request(kind, 1_000),
});

describe('simulador: identificação', () => {
  it('declara-se SIMULATOR e usa apenas referências fictícias', async () => {
    const sim = new PaymentSimulator();
    expect(sim.kind).toBe('SIMULATOR');
    expect(sim.id).toBe('SIMULATOR');
    const result = await sim.execute(request(), new AbortController().signal);
    expect(result).toMatchObject({ status: 'SUCCEEDED', resultCode: 'SIM_APPROVED' });
    if (result.status === 'SUCCEEDED') expect(result.providerReference).toMatch(/^SIM-\d{8}$/);
  });
});

describe('simulador: cenários controlados', () => {
  const sims: PaymentSimulator[] = [];
  afterEach(() => sims.splice(0).forEach((s) => s.dispose()));

  const simWith = (scenario: SimulatorScenario, caps = DEFAULT_SIMULATOR_CAPABILITIES) => {
    const sim = new PaymentSimulator({ capabilities: caps, scenario: () => scenario });
    sims.push(sim);
    return sim;
  };
  const signal = () => new AbortController().signal;

  it('aprovação', async () => {
    expect((await simWith({ type: 'APPROVE' }).execute(request(), signal())).status).toBe('SUCCEEDED');
  });

  it('recusa', async () => {
    expect(await simWith({ type: 'DECLINE' }).execute(request(), signal())).toMatchObject({ status: 'REJECTED', resultCode: 'SIM_DECLINED' });
  });

  it('abandono no terminal', async () => {
    expect((await simWith({ type: 'ABORT_AT_TERMINAL' }).execute(request(), signal())).status).toBe('ABORTED');
  });

  it('timeout antes do envio: NOT_SENT e nada registrado no provedor', async () => {
    const sim = simWith({ type: 'TIMEOUT_BEFORE_SEND' });
    const req = request();
    expect((await sim.execute(req, signal())).status).toBe('NOT_SENT');
    expect(sim.receivedCount()).toBe(0);
    expect(await sim.query!({ kind: req.kind, clientReference: req.clientReference, terminalId: req.terminalId }, signal()))
      .toEqual({ status: 'NOT_FOUND' });
  });

  it('timeout antes do envio sem garantia declarada: UNKNOWN', async () => {
    const sim = simWith({ type: 'TIMEOUT_BEFORE_SEND' }, { ...DEFAULT_SIMULATOR_CAPABILITIES, guaranteesNotSentOnPreSendFailure: false });
    expect((await sim.execute(request(), signal())).status).toBe('UNKNOWN');
  });

  it('timeout após envio: não responde até o abort, mas o provedor registrou', async () => {
    const sim = simWith({ type: 'TIMEOUT_AFTER_SEND', hiddenOutcome: 'SUCCEEDED' });
    const controller = new AbortController();
    const req = request();
    const pending = sim.execute(req, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(sim.receivedCount()).toBe(1);
    expect(await sim.query!({ kind: req.kind, clientReference: req.clientReference, terminalId: req.terminalId }, signal()))
      .toMatchObject({ status: 'FOUND', outcome: 'SUCCEEDED' });
  });

  it('resposta atrasada: responde depois do atraso e também notifica', async () => {
    const sim = simWith({ type: 'DELAYED_RESPONSE', delayMs: 20, outcome: 'SUCCEEDED' });
    const notifications: ProviderNotification[] = [];
    sim.onNotification((n) => notifications.push(n));
    const started = Date.now();
    const result = await sim.execute(request(), signal());
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    expect(result.status).toBe('SUCCEEDED');
    await new Promise((r) => setTimeout(r, 30));
    expect(notifications).toHaveLength(1);
  });

  it('falha de comunicação: lança erro após o provedor registrar', async () => {
    const sim = simWith({ type: 'COMMUNICATION_FAILURE', hiddenOutcome: 'REJECTED' });
    await expect(sim.execute(request(), signal())).rejects.toBeInstanceOf(SimulatedCommunicationError);
    expect(sim.receivedCount()).toBe(1);
  });

  it('resposta duplicada: aprovação na resposta e duas notificações iguais', async () => {
    const sim = simWith({ type: 'DUPLICATE_RESPONSE' });
    const notifications: ProviderNotification[] = [];
    sim.onNotification((n) => notifications.push(n));
    const req = request();
    await sim.execute(req, signal());
    await new Promise((r) => setTimeout(r, 10));
    expect(notifications).toHaveLength(2);
    expect(notifications[0]).toEqual(notifications[1]);
    expect(notifications[0]!.clientReference).toBe(req.clientReference);
  });

  it('desconhecido esclarecido depois por consulta', async () => {
    const sim = simWith({ type: 'UNKNOWN_THEN_RECONCILED', hiddenOutcome: 'REJECTED' });
    const req = request();
    expect((await sim.execute(req, signal())).status).toBe('UNKNOWN');
    expect(await sim.query!({ kind: req.kind, clientReference: req.clientReference, terminalId: req.terminalId }, signal()))
      .toMatchObject({ status: 'FOUND', outcome: 'REJECTED' });
  });

  it('é idempotente pela referência do cliente', async () => {
    const sim = simWith({ type: 'APPROVE' });
    const req = request();
    const a = await sim.execute(req, signal());
    const b = await sim.execute(req, signal());
    expect(a).toEqual(b);
    expect(sim.receivedCount()).toBe(1);
  });

  it('convenção por centavos (apenas simulador) escolhe cenários de autorização', async () => {
    const sim = new PaymentSimulator();
    sims.push(sim);
    expect((await sim.execute(request('AUTHORIZATION', 1_051), signal())).status).toBe('REJECTED');
    expect((await sim.execute(request('AUTHORIZATION', 1_052), signal())).status).toBe('ABORTED');
    expect((await sim.execute(request('AUTHORIZATION', 1_053), signal())).status).toBe('NOT_SENT');
    expect((await sim.execute(request('AUTHORIZATION', 1_058), signal())).status).toBe('UNKNOWN');
    expect((await sim.execute(request('REFUND', 1_051), signal())).status).toBe('SUCCEEDED');
  });
});

describe('simulador: autoridade do livro', () => {
  it('extrai o instante de criação do identificador UUIDv7', () => {
    const before = Date.now();
    const id = newOperationId();
    const ts = uuidv7Timestamp(id);
    expect(ts).not.toBeNull();
    expect(ts!).toBeGreaterThanOrEqual(before);
    expect(ts!).toBeLessThanOrEqual(Date.now());
    expect(uuidv7Timestamp('nao-e-uuid')).toBeNull();
  });

  it('operação anterior ao livro: consulta indisponível, nunca "não encontrado"', async () => {
    const legacy = request();
    const sim = new PaymentSimulator({ ledger: new InMemorySimulatorLedger(Date.now() + 60_000) });
    const result = await sim.query!({ kind: 'AUTHORIZATION', clientReference: legacy.clientReference, terminalId: legacy.terminalId }, new AbortController().signal);
    expect(result).toEqual({ status: 'UNAVAILABLE', resultCode: 'SIM_LEDGER_NOT_AUTHORITATIVE' });
  });
});
