import { describe, expect, it } from 'vitest';
import { newOperationId, type OperationKind } from '@tef/domain';
import type { PaymentProvider, ProviderOperationRequest } from './index.ts';

/**
 * Suíte de conformidade que TODO adaptador (simulador ou oficial) deve passar.
 * Não substitui o roteiro de homologação do provedor; apenas garante que o
 * adaptador respeita o contrato interno.
 */
export interface ConformanceOptions {
  readonly name: string;
  readonly createProvider: () => PaymentProvider;
  /** Requisição que o adaptador deve processar com sucesso em ambiente de testes. */
  readonly successfulRequest: (kind: OperationKind) => ProviderOperationRequest;
}

const SENSITIVE_KEY = /(pan|card.?number|cvv|cvc|track|pin|password|secret|token)/i;
const PAN_LIKE = /\b\d{13,19}\b/;

function assertNoSensitiveData(value: unknown): void {
  const json = JSON.stringify(value);
  expect(json).not.toMatch(PAN_LIKE);
  const walk = (v: unknown): void => {
    if (v && typeof v === 'object') {
      for (const [k, child] of Object.entries(v)) {
        expect(k, `campo sensível no resultado: ${k}`).not.toMatch(SENSITIVE_KEY);
        walk(child);
      }
    }
  };
  walk(value);
}

export function runProviderConformanceSuite(options: ConformanceOptions): void {
  describe(`contrato de provedor: ${options.name}`, () => {
    it('declara identificação, tipo e todas as capacidades', () => {
      const provider = options.createProvider();
      expect(provider.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/);
      expect(['SIMULATOR', 'OFFICIAL']).toContain(provider.kind);
      const c = provider.capabilities;
      for (const flag of [
        c.twoPhaseConfirmation,
        c.undo,
        c.cancellation,
        c.query,
        c.queryNotFoundIsDefinitive,
        c.guaranteesNotSentOnPreSendFailure,
        c.refund.full,
        c.refund.partial,
      ]) {
        expect(typeof flag).toBe('boolean');
      }
      if (c.queryNotFoundIsDefinitive) expect(c.query).toBe(true);
    });

    it('implementa consulta se, e somente se, declarar a capacidade', () => {
      const provider = options.createProvider();
      expect(typeof provider.query === 'function').toBe(provider.capabilities.query);
    });

    it('processa uma autorização de teste sem expor dados sensíveis', async () => {
      const provider = options.createProvider();
      const result = await provider.execute(options.successfulRequest('AUTHORIZATION'), new AbortController().signal);
      expect(result.status).toBe('SUCCEEDED');
      assertNoSensitiveData(result);
      if (result.status === 'SUCCEEDED' && result.requiresConfirmation) {
        expect(provider.capabilities.twoPhaseConfirmation).toBe(true);
      }
    });

    it('não confirma sucesso quando o sinal já está abortado', async () => {
      const provider = options.createProvider();
      const controller = new AbortController();
      controller.abort();
      let status: string;
      try {
        status = (await provider.execute(options.successfulRequest('AUTHORIZATION'), controller.signal)).status;
      } catch {
        status = 'THREW';
      }
      expect(['THREW', 'UNKNOWN', 'NOT_SENT']).toContain(status);
      if (status === 'NOT_SENT') expect(provider.capabilities.guaranteesNotSentOnPreSendFailure).toBe(true);
    });

    it('consulta: referência inexistente nunca retorna FOUND', async () => {
      const provider = options.createProvider();
      if (!provider.query) return;
      const result = await provider.query(
        { kind: 'AUTHORIZATION', clientReference: newOperationId(), terminalId: options.successfulRequest('AUTHORIZATION').terminalId },
        new AbortController().signal,
      );
      expect(['NOT_FOUND', 'UNAVAILABLE']).toContain(result.status);
    });

    it('consulta: resultado consistente com a operação processada', async () => {
      const provider = options.createProvider();
      if (!provider.query) return;
      const request = options.successfulRequest('AUTHORIZATION');
      const executed = await provider.execute(request, new AbortController().signal);
      const queried = await provider.query(
        { kind: request.kind, clientReference: request.clientReference, terminalId: request.terminalId },
        new AbortController().signal,
      );
      expect(queried.status).toBe('FOUND');
      if (queried.status === 'FOUND' && executed.status === 'SUCCEEDED') {
        expect(queried.outcome).toBe('SUCCEEDED');
        expect(queried.providerReference).toBe(executed.providerReference);
      }
      assertNoSensitiveData(queried);
    });
  });
}
