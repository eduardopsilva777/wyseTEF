import type { PaymentView } from '@tef/application';
import { availableForReversal, type Operation } from '@tef/domain';

/** Representação pública. Contém apenas dados de negócio — nenhum dado de cartão existe no sistema. */
export function presentPayment(view: PaymentView, providerKind: 'SIMULATOR' | 'OFFICIAL'): Record<string, unknown> {
  const p = view.payment;
  return {
    id: p.id,
    merchantId: p.merchantId,
    terminalId: p.terminalId,
    externalReference: p.externalReference,
    provider: { id: p.providerId, kind: providerKind, simulated: providerKind === 'SIMULATOR' },
    amount: { cents: p.amount.cents, currency: p.amount.currency },
    reversedAmount: { cents: p.reversedAmount.cents, currency: p.reversedAmount.currency },
    netApprovedAmount:
      p.state === 'APPROVED' || p.state === 'REVERSED'
        ? { cents: availableForReversal(p).cents, currency: p.amount.currency }
        : null,
    state: p.state,
    stateReason: p.stateReason,
    version: p.version,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    operations: view.operations.map(presentOperation),
  };
}

export function presentOperation(op: Operation): Record<string, unknown> {
  return {
    id: op.id,
    kind: op.kind,
    status: op.status,
    amount: { cents: op.amount.cents, currency: op.amount.currency },
    providerReference: op.providerReference,
    resultCode: op.resultCode,
    requiresConfirmation: op.requiresConfirmation,
    evidenceSource: op.evidence?.source ?? null,
    createdAt: op.createdAt.toISOString(),
    updatedAt: op.updatedAt.toISOString(),
  };
}
