import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  applyOperationOutcome,
  availableForReversal,
  cancelBeforeSubmission,
  CapabilityNotSupportedError,
  ConflictingEvidenceError,
  InvalidTransitionError,
  markDispatched,
  money,
  OperationInProgressError,
  planOperation,
  RefundExceedsAvailableError,
  type Operation,
  type OperationKind,
  type OperationOutcome,
  type Payment,
  type ProviderCapabilities,
} from '../src/index.ts';
import { ALL_CAPABILITIES, evidence, MINIMAL_CAPABILITIES, newPayment, NOW } from './fixtures.ts';

const ok = (extra: Partial<Extract<OperationOutcome, { status: 'SUCCEEDED' }>> = {}): OperationOutcome => ({
  status: 'SUCCEEDED',
  evidence: evidence('PROVIDER_RESPONSE'),
  providerReference: 'SIM-1',
  ...extra,
});

/** Executa planejar -> enviar -> aplicar resultado, devolvendo o novo par. */
function run(
  payment: Payment,
  operations: Operation[],
  kind: OperationKind,
  outcome: OperationOutcome,
  caps: ProviderCapabilities = ALL_CAPABILITIES,
  amount?: number,
): { payment: Payment; operations: Operation[]; operation: Operation } {
  const planned = planOperation({
    payment,
    operations,
    kind,
    ...(amount !== undefined ? { amount: money(amount) } : {}),
    capabilities: caps,
    now: NOW,
  });
  const dispatched = markDispatched(planned.operation, caps, NOW);
  const applied = applyOperationOutcome({ payment: planned.payment, operation: dispatched, outcome, capabilities: caps, now: NOW });
  return { payment: applied.payment, operations: [...operations, applied.operation], operation: applied.operation };
}

function approved(caps: ProviderCapabilities = ALL_CAPABILITIES, cents = 10_000) {
  return run(newPayment(cents), [], 'AUTHORIZATION', ok(), caps);
}

describe('pagamento: autorização', () => {
  it('cria o pagamento em CREATED, versão 1, sem valor revertido', () => {
    const p = newPayment();
    expect(p.state).toBe('CREATED');
    expect(p.version).toBe(1);
    expect(p.reversedAmount.cents).toBe(0);
    expect(p.id).toMatch(/^pay_/);
  });

  it('autorização move para PROCESSING antes do envio', () => {
    const planned = planOperation({ payment: newPayment(), operations: [], kind: 'AUTHORIZATION', capabilities: MINIMAL_CAPABILITIES, now: NOW });
    expect(planned.payment.state).toBe('PROCESSING');
    expect(planned.operation.status).toBe('PENDING');
    expect(planned.operation.id).toMatch(/^op_/);
  });

  it.each([
    ['SUCCEEDED', 'APPROVED'],
    ['REJECTED', 'DECLINED'],
    ['ABORTED', 'CANCELLED'],
    ['UNKNOWN', 'UNKNOWN'],
  ] as const)('resultado %s -> pagamento %s', (status, expected) => {
    const outcome: OperationOutcome =
      status === 'UNKNOWN'
        ? { status, reason: 'PROVIDER_TIMEOUT' }
        : status === 'SUCCEEDED'
          ? ok()
          : { status, evidence: evidence('PROVIDER_RESPONSE'), resultCode: 'X' };
    expect(run(newPayment(), [], 'AUTHORIZATION', outcome, MINIMAL_CAPABILITIES).payment.state).toBe(expected);
  });

  it('NOT_SENT (com garantia do adaptador) cancela sem efeito financeiro', () => {
    const r = run(newPayment(), [], 'AUTHORIZATION', { status: 'NOT_SENT', evidence: evidence('ADAPTER_NOT_SENT') });
    expect(r.payment.state).toBe('CANCELLED');
    expect(r.payment.stateReason).toBe('NOT_SENT_TO_PROVIDER');
  });

  it('pagamento UNKNOWN não aceita nova autorização', () => {
    const r = run(newPayment(), [], 'AUTHORIZATION', { status: 'UNKNOWN', reason: 'PROVIDER_TIMEOUT' });
    expect(() => planOperation({ payment: r.payment, operations: r.operations, kind: 'AUTHORIZATION', capabilities: ALL_CAPABILITIES, now: NOW }))
      .toThrow(OperationInProgressError);
  });

  it('pagamento só tem uma autorização, mesmo após resultado definitivo', () => {
    const r = run(newPayment(), [], 'AUTHORIZATION', { status: 'REJECTED', evidence: evidence('PROVIDER_RESPONSE'), resultCode: 'X' });
    expect(() => planOperation({ payment: r.payment, operations: r.operations, kind: 'AUTHORIZATION', capabilities: ALL_CAPABILITIES, now: NOW }))
      .toThrow(InvalidTransitionError);
  });

  it('UNKNOWN resolvido por consulta vira APPROVED', () => {
    const r = run(newPayment(), [], 'AUTHORIZATION', { status: 'UNKNOWN', reason: 'PROVIDER_TIMEOUT' });
    const resolved = applyOperationOutcome({
      payment: r.payment,
      operation: r.operation,
      outcome: { status: 'SUCCEEDED', evidence: evidence('PROVIDER_QUERY') },
      capabilities: ALL_CAPABILITIES,
      now: NOW,
    });
    expect(resolved.payment.state).toBe('APPROVED');
    expect(resolved.operation.status).toBe('SUCCEEDED');
  });

  it('desistência antes do envio cancela', () => {
    expect(cancelBeforeSubmission(newPayment(), MINIMAL_CAPABILITIES, NOW).state).toBe('CANCELLED');
  });

  it('autorização com confirmação pendente sem capacidade de duas fases é rejeitada', () => {
    expect(() => run(newPayment(), [], 'AUTHORIZATION', ok({ requiresConfirmation: true }), MINIMAL_CAPABILITIES))
      .toThrow(CapabilityNotSupportedError);
  });
});

describe('pagamento: resultados repetidos e conflitantes', () => {
  it('o mesmo resultado aplicado duas vezes é idempotente', () => {
    const r = approved();
    const again = applyOperationOutcome({ payment: r.payment, operation: r.operation, outcome: ok(), capabilities: ALL_CAPABILITIES, now: NOW });
    expect(again.changed).toBe(false);
    expect(again.payment).toBe(r.payment);
  });

  it('resultado diferente para operação já finalizada é conflito', () => {
    const r = approved();
    expect(() =>
      applyOperationOutcome({
        payment: r.payment,
        operation: r.operation,
        outcome: { status: 'REJECTED', evidence: evidence('PROVIDER_NOTIFICATION'), resultCode: 'X' },
        capabilities: ALL_CAPABILITIES,
        now: NOW,
      }),
    ).toThrow(ConflictingEvidenceError);
  });

  it('ausência de resposta posterior não apaga um resultado definitivo', () => {
    const r = approved();
    const late = applyOperationOutcome({
      payment: r.payment,
      operation: r.operation,
      outcome: { status: 'UNKNOWN', reason: 'LATE_TIMEOUT' },
      capabilities: ALL_CAPABILITIES,
      now: NOW,
    });
    expect(late.changed).toBe(false);
    expect(late.payment.state).toBe('APPROVED');
  });
});

describe('pagamento: duas fases (confirmação e desfazimento)', () => {
  const authorized = () => run(newPayment(), [], 'AUTHORIZATION', ok({ requiresConfirmation: true }));

  it('autorização com confirmação pendente vai para AUTHORIZED', () => {
    expect(authorized().payment.state).toBe('AUTHORIZED');
  });

  it('confirmação bem-sucedida -> APPROVED', () => {
    const a = authorized();
    expect(run(a.payment, a.operations, 'CONFIRMATION', ok()).payment.state).toBe('APPROVED');
  });

  it('confirmação recusada não prova o resultado -> UNKNOWN', () => {
    const a = authorized();
    const r = run(a.payment, a.operations, 'CONFIRMATION', { status: 'REJECTED', evidence: evidence('PROVIDER_RESPONSE'), resultCode: 'X' });
    expect(r.payment.state).toBe('UNKNOWN');
  });

  it('confirmação não enviada mantém AUTHORIZED e permite nova confirmação', () => {
    const a = authorized();
    const r = run(a.payment, a.operations, 'CONFIRMATION', { status: 'NOT_SENT', evidence: evidence('ADAPTER_NOT_SENT') });
    expect(r.payment.state).toBe('AUTHORIZED');
    expect(run(r.payment, r.operations, 'CONFIRMATION', ok()).payment.state).toBe('APPROVED');
  });

  it('desfazimento bem-sucedido -> REVERSED com valor total revertido', () => {
    const a = authorized();
    const r = run(a.payment, a.operations, 'UNDO', ok());
    expect(r.payment.state).toBe('REVERSED');
    expect(r.payment.reversedAmount.cents).toBe(r.payment.amount.cents);
  });

  it('desfazimento exige capacidade e pagamento AUTHORIZED', () => {
    const a = authorized();
    expect(() => run(a.payment, a.operations, 'UNDO', ok(), { ...ALL_CAPABILITIES, undo: false })).toThrow(CapabilityNotSupportedError);
    const p = approved();
    expect(() => run(p.payment, p.operations, 'UNDO', ok())).toThrow(InvalidTransitionError);
  });
});

describe('pagamento: cancelamento e estornos', () => {
  it('cancelamento é total e exige capacidade', () => {
    const p = approved();
    const r = run(p.payment, p.operations, 'CANCELLATION', ok());
    expect(r.operation.amount.cents).toBe(10_000);
    expect(r.payment.state).toBe('REVERSED');
    expect(r.payment.stateReason).toBe('CANCELLED_BY_MERCHANT');
    expect(() => run(p.payment, p.operations, 'CANCELLATION', ok(), { ...ALL_CAPABILITIES, cancellation: false }))
      .toThrow(CapabilityNotSupportedError);
  });

  it('cancelamento não é aceito depois de estorno parcial', () => {
    const p = approved();
    const partial = run(p.payment, p.operations, 'REFUND', ok(), ALL_CAPABILITIES, 1_000);
    expect(() => run(partial.payment, partial.operations, 'CANCELLATION', ok())).toThrow(InvalidTransitionError);
  });

  it('estorno parcial mantém APPROVED e contabiliza separadamente', () => {
    const p = approved();
    const r = run(p.payment, p.operations, 'REFUND', ok(), ALL_CAPABILITIES, 2_500);
    expect(r.payment.state).toBe('APPROVED');
    expect(r.payment.reversedAmount.cents).toBe(2_500);
    expect(availableForReversal(r.payment).cents).toBe(7_500);
    expect(r.payment.stateReason).toBe('PARTIALLY_REFUNDED');
  });

  it('estornos parciais até zerar o saldo -> REVERSED', () => {
    const p = approved();
    const a = run(p.payment, p.operations, 'REFUND', ok(), ALL_CAPABILITIES, 4_000);
    const b = run(a.payment, a.operations, 'REFUND', ok(), ALL_CAPABILITIES, 6_000);
    expect(b.payment.state).toBe('REVERSED');
    expect(b.payment.stateReason).toBe('FULLY_REFUNDED');
  });

  it('estorno acima do saldo disponível é rejeitado', () => {
    const p = approved();
    const a = run(p.payment, p.operations, 'REFUND', ok(), ALL_CAPABILITIES, 9_000);
    expect(() => run(a.payment, a.operations, 'REFUND', ok(), ALL_CAPABILITIES, 1_001)).toThrow(RefundExceedsAvailableError);
  });

  it('estorno total e parcial respeitam capacidades distintas', () => {
    const p = approved();
    const noPartial = { ...ALL_CAPABILITIES, refund: { full: true, partial: false } };
    expect(() => run(p.payment, p.operations, 'REFUND', ok(), noPartial, 100)).toThrow(CapabilityNotSupportedError);
    expect(run(p.payment, p.operations, 'REFUND', ok(), noPartial, 10_000).payment.state).toBe('REVERSED');
    const noFull = { ...ALL_CAPABILITIES, refund: { full: false, partial: true } };
    expect(() => run(p.payment, p.operations, 'REFUND', ok(), noFull, 10_000)).toThrow(CapabilityNotSupportedError);
  });

  it('estorno recusado não altera saldo', () => {
    const p = approved();
    const r = run(p.payment, p.operations, 'REFUND', { status: 'REJECTED', evidence: evidence('PROVIDER_RESPONSE'), resultCode: 'X' }, ALL_CAPABILITIES, 1_000);
    expect(r.payment.reversedAmount.cents).toBe(0);
    expect(r.payment.state).toBe('APPROVED');
  });

  it('estorno com resultado desconhecido bloqueia novas operações até ser resolvido', () => {
    const p = approved();
    const r = run(p.payment, p.operations, 'REFUND', { status: 'UNKNOWN', reason: 'PROVIDER_TIMEOUT' }, ALL_CAPABILITIES, 1_000);
    expect(r.payment.state).toBe('APPROVED');
    expect(r.payment.reversedAmount.cents).toBe(0);
    expect(() => run(r.payment, r.operations, 'REFUND', ok(), ALL_CAPABILITIES, 1_000)).toThrow(OperationInProgressError);
  });

  it('estorno não é aceito antes da aprovação', () => {
    expect(() => run(newPayment(), [], 'REFUND', ok(), ALL_CAPABILITIES, 100)).toThrow(InvalidTransitionError);
  });

  it('propriedade: total revertido nunca excede o aprovado, com qualquer sequência de estornos', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.array(fc.integer({ min: 1, max: 1_000_000 }), { maxLength: 20 }),
        (amount, refunds) => {
          let state = approved(ALL_CAPABILITIES, amount);
          for (const value of refunds) {
            try {
              state = run(state.payment, state.operations, 'REFUND', ok(), ALL_CAPABILITIES, value);
            } catch {
              // estorno rejeitado: estado inalterado
            }
            expect(state.payment.reversedAmount.cents).toBeLessThanOrEqual(state.payment.amount.cents);
            expect(state.payment.state === 'REVERSED').toBe(state.payment.reversedAmount.cents === amount);
          }
        },
      ),
    );
  });
});
