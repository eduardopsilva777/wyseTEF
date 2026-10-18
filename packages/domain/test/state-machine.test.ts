import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  allowedOperationTargets,
  allowedPaymentTargets,
  assertOperationTransition,
  assertPaymentTransition,
  CapabilityNotSupportedError,
  EVIDENCE_SOURCES,
  EvidenceRequiredError,
  InvalidTransitionError,
  OPERATION_STATUSES,
  PAYMENT_STATES,
  TERMINAL_PAYMENT_STATES,
  type PaymentState,
} from '../src/index.ts';
import { ALL_CAPABILITIES, evidence, MINIMAL_CAPABILITIES, NOW } from './fixtures.ts';

const VALID_PAYMENT_TRANSITIONS: ReadonlyArray<readonly [PaymentState, PaymentState]> = [
  ['CREATED', 'PROCESSING'],
  ['CREATED', 'CANCELLED'],
  ['PROCESSING', 'AUTHORIZED'],
  ['PROCESSING', 'APPROVED'],
  ['PROCESSING', 'DECLINED'],
  ['PROCESSING', 'CANCELLED'],
  ['PROCESSING', 'UNKNOWN'],
  ['AUTHORIZED', 'APPROVED'],
  ['AUTHORIZED', 'REVERSED'],
  ['AUTHORIZED', 'UNKNOWN'],
  ['UNKNOWN', 'AUTHORIZED'],
  ['UNKNOWN', 'APPROVED'],
  ['UNKNOWN', 'DECLINED'],
  ['UNKNOWN', 'CANCELLED'],
  ['UNKNOWN', 'REVERSED'],
  ['APPROVED', 'REVERSED'],
];

describe('máquina de estados do pagamento', () => {
  it('a tabela de transições é exatamente a documentada', () => {
    const actual = PAYMENT_STATES.flatMap((from) => allowedPaymentTargets(from).map((to) => `${from}->${to}`)).sort();
    expect(actual).toEqual(VALID_PAYMENT_TRANSITIONS.map(([f, t]) => `${f}->${t}`).sort());
  });

  it('estados terminais não aceitam nenhuma transição', () => {
    for (const terminal of TERMINAL_PAYMENT_STATES) {
      expect(allowedPaymentTargets(terminal)).toEqual([]);
      for (const to of PAYMENT_STATES) {
        expect(() => assertPaymentTransition(terminal, to, { capabilities: ALL_CAPABILITIES, evidence: evidence('MANUAL_RESOLUTION') }))
          .toThrow(InvalidTransitionError);
      }
    }
  });

  it('todo par fora da tabela é rejeitado', () => {
    const valid = new Set(VALID_PAYMENT_TRANSITIONS.map(([f, t]) => `${f}->${t}`));
    for (const from of PAYMENT_STATES) {
      for (const to of PAYMENT_STATES) {
        if (valid.has(`${from}->${to}`)) continue;
        expect(() => assertPaymentTransition(from, to, { capabilities: ALL_CAPABILITIES, evidence: evidence('PROVIDER_RESPONSE') }))
          .toThrow(InvalidTransitionError);
      }
    }
  });

  it('UNKNOWN não volta para PROCESSING (sem nova cobrança automática)', () => {
    expect(() => assertPaymentTransition('UNKNOWN', 'PROCESSING', { capabilities: ALL_CAPABILITIES })).toThrow(InvalidTransitionError);
  });

  it('APPROVED nunca vira DECLINED, e DECLINED nunca vira APPROVED', () => {
    const ctx = { capabilities: ALL_CAPABILITIES, evidence: evidence('MANUAL_RESOLUTION') };
    expect(() => assertPaymentTransition('APPROVED', 'DECLINED', ctx)).toThrow(InvalidTransitionError);
    expect(() => assertPaymentTransition('DECLINED', 'APPROVED', ctx)).toThrow(InvalidTransitionError);
  });

  it('resultado definitivo exige evidência', () => {
    for (const to of ['APPROVED', 'DECLINED', 'CANCELLED'] as const) {
      expect(() => assertPaymentTransition('PROCESSING', to, { capabilities: ALL_CAPABILITIES })).toThrow(EvidenceRequiredError);
    }
    expect(() => assertPaymentTransition('UNKNOWN', 'DECLINED', { capabilities: ALL_CAPABILITIES })).toThrow(EvidenceRequiredError);
  });

  it('entrada em UNKNOWN não exige evidência (é a ausência dela)', () => {
    expect(() => assertPaymentTransition('PROCESSING', 'UNKNOWN', { capabilities: MINIMAL_CAPABILITIES })).not.toThrow();
  });

  it('UNKNOWN só é resolvido por consulta, notificação, conciliação ou resolução manual', () => {
    const ctx = (source: (typeof EVIDENCE_SOURCES)[number]) => ({ capabilities: ALL_CAPABILITIES, evidence: evidence(source) });
    expect(() => assertPaymentTransition('UNKNOWN', 'DECLINED', ctx('LOCAL_NO_CONTACT'))).toThrow(EvidenceRequiredError);
    expect(() => assertPaymentTransition('UNKNOWN', 'CANCELLED', ctx('ADAPTER_NOT_SENT'))).toThrow(EvidenceRequiredError);
    for (const ok of ['PROVIDER_QUERY', 'PROVIDER_NOTIFICATION', 'RECONCILIATION_FILE', 'MANUAL_RESOLUTION'] as const) {
      expect(() => assertPaymentTransition('UNKNOWN', 'DECLINED', ctx(ok))).not.toThrow();
    }
  });

  it('desistência antes do envio só aceita evidência local', () => {
    expect(() =>
      assertPaymentTransition('CREATED', 'CANCELLED', { capabilities: MINIMAL_CAPABILITIES, evidence: evidence('LOCAL_NO_CONTACT') }),
    ).not.toThrow();
    expect(() =>
      assertPaymentTransition('CREATED', 'CANCELLED', { capabilities: MINIMAL_CAPABILITIES, evidence: evidence('PROVIDER_RESPONSE') }),
    ).toThrow(EvidenceRequiredError);
  });

  it('AUTHORIZED exige a capacidade de duas fases', () => {
    expect(() =>
      assertPaymentTransition('PROCESSING', 'AUTHORIZED', { capabilities: MINIMAL_CAPABILITIES, evidence: evidence('PROVIDER_RESPONSE') }),
    ).toThrow(CapabilityNotSupportedError);
  });

  it('desfazimento exige a capacidade declarada', () => {
    const caps = { ...ALL_CAPABILITIES, undo: false };
    expect(() => assertPaymentTransition('AUTHORIZED', 'REVERSED', { capabilities: caps, evidence: evidence('PROVIDER_RESPONSE') }))
      .toThrow(CapabilityNotSupportedError);
  });

  it('"não enviado" pelo adaptador exige a garantia declarada', () => {
    const caps = { ...ALL_CAPABILITIES, guaranteesNotSentOnPreSendFailure: false };
    expect(() => assertPaymentTransition('PROCESSING', 'CANCELLED', { capabilities: caps, evidence: evidence('ADAPTER_NOT_SENT') }))
      .toThrow(CapabilityNotSupportedError);
  });

  it('resolução manual exige dupla aprovação por pessoas distintas', () => {
    const selfApproved = {
      source: 'MANUAL_RESOLUTION' as const,
      observedAt: NOW,
      manual: { resolvedBy: 'op', approvedBy: 'op', justification: 'x', supportingDocumentRef: 'y' },
    };
    expect(() => assertPaymentTransition('UNKNOWN', 'APPROVED', { capabilities: ALL_CAPABILITIES, evidence: selfApproved }))
      .toThrow(EvidenceRequiredError);
  });

  it('propriedade: nenhuma sequência de tentativas sai das transições documentadas', () => {
    const valid = new Set(VALID_PAYMENT_TRANSITIONS.map(([f, t]) => `${f}->${t}`));
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.constantFrom(...PAYMENT_STATES), fc.constantFrom(...EVIDENCE_SOURCES), fc.boolean()), { maxLength: 30 }),
        (attempts) => {
          let state: PaymentState = 'CREATED';
          const visited: string[] = [];
          for (const [to, source, withEvidence] of attempts) {
            try {
              assertPaymentTransition(state, to, {
                capabilities: ALL_CAPABILITIES,
                evidence: withEvidence ? evidence(source) : null,
              });
              visited.push(`${state}->${to}`);
              state = to;
            } catch {
              // tentativa rejeitada: estado inalterado
            }
          }
          for (const step of visited) expect(valid.has(step)).toBe(true);
          // Depois de um estado terminal, nada mais muda.
          const firstTerminal = visited.findIndex((s) => TERMINAL_PAYMENT_STATES.has(s.split('->')[1] as PaymentState));
          if (firstTerminal >= 0) expect(visited.length).toBe(firstTerminal + 1);
        },
      ),
    );
  });
});

describe('máquina de estados da operação', () => {
  it('estados finais não aceitam transições', () => {
    for (const status of ['SUCCEEDED', 'REJECTED', 'ABORTED', 'NOT_SENT'] as const) {
      expect(allowedOperationTargets(status)).toEqual([]);
    }
  });

  it('IN_FLIGHT só vira NOT_SENT com garantia do adaptador', () => {
    expect(() => assertOperationTransition('IN_FLIGHT', 'NOT_SENT', { capabilities: ALL_CAPABILITIES, evidence: evidence('PROVIDER_RESPONSE') }))
      .toThrow(EvidenceRequiredError);
    expect(() => assertOperationTransition('IN_FLIGHT', 'NOT_SENT', { capabilities: ALL_CAPABILITIES, evidence: evidence('ADAPTER_NOT_SENT') }))
      .not.toThrow();
  });

  it('UNKNOWN -> NOT_SENT por consulta só se "não encontrado" for definitivo para o provedor', () => {
    const caps = { ...ALL_CAPABILITIES, queryNotFoundIsDefinitive: false };
    expect(() => assertOperationTransition('UNKNOWN', 'NOT_SENT', { capabilities: caps, evidence: evidence('PROVIDER_QUERY') }))
      .toThrow(CapabilityNotSupportedError);
    expect(() => assertOperationTransition('UNKNOWN', 'NOT_SENT', { capabilities: ALL_CAPABILITIES, evidence: evidence('PROVIDER_QUERY') }))
      .not.toThrow();
  });

  it('UNKNOWN não volta para IN_FLIGHT nem PENDING (sem reenvio)', () => {
    expect(() => assertOperationTransition('UNKNOWN', 'IN_FLIGHT', { capabilities: ALL_CAPABILITIES })).toThrow(InvalidTransitionError);
    expect(() => assertOperationTransition('UNKNOWN', 'PENDING', { capabilities: ALL_CAPABILITIES })).toThrow(InvalidTransitionError);
  });

  it('toda transição de operação é coberta pela tabela', () => {
    for (const from of OPERATION_STATUSES) {
      for (const to of OPERATION_STATUSES) {
        const allowed = allowedOperationTargets(from).includes(to);
        if (!allowed) {
          expect(() => assertOperationTransition(from, to, { capabilities: ALL_CAPABILITIES, evidence: evidence('MANUAL_RESOLUTION') }))
            .toThrow(InvalidTransitionError);
        }
      }
    }
  });
});
