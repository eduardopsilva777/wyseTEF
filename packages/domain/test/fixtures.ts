import {
  createPayment,
  money,
  NO_OPTIONAL_CAPABILITIES,
  parseMerchantId,
  parseProviderId,
  parseTenantId,
  parseTerminalId,
  type Evidence,
  type EvidenceSource,
  type Payment,
  type ProviderCapabilities,
} from '../src/index.ts';

export const NOW = new Date('2026-10-18T12:00:00.000Z');

export const ALL_CAPABILITIES: ProviderCapabilities = {
  twoPhaseConfirmation: true,
  undo: true,
  cancellation: true,
  refund: { full: true, partial: true },
  query: true,
  queryNotFoundIsDefinitive: true,
  guaranteesNotSentOnPreSendFailure: true,
};

export const MINIMAL_CAPABILITIES = NO_OPTIONAL_CAPABILITIES;

export function evidence(source: EvidenceSource, providerReference = 'SIM-TEST'): Evidence {
  if (source === 'MANUAL_RESOLUTION') {
    return {
      source,
      observedAt: NOW,
      manual: { resolvedBy: 'operador-a', approvedBy: 'operador-b', justification: 'extrato conferido', supportingDocumentRef: 'CHAMADO-1' },
    };
  }
  return { source, observedAt: NOW, providerReference };
}

export function newPayment(cents = 10_000): Payment {
  return createPayment(
    {
      tenantId: parseTenantId('tenant-a'),
      merchantId: parseMerchantId('merchant-1'),
      terminalId: parseTerminalId('terminal-1'),
      externalReference: 'pedido-1',
      providerId: parseProviderId('SIMULATOR'),
      amount: money(cents),
    },
    NOW,
  );
}
