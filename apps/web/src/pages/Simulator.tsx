import { useState } from 'react';
import { api, type Customer, type Merchant, type PaymentFull, type PaymentState, type Scenario, type Terminal } from '../api.ts';
import { Button, EmptyState, errorMessage, ErrorNotice, Field, Loading, PageHeader, useApi } from '../components/ui.tsx';
import { money, parseCents, STATE_LABEL } from '../format.ts';
import { PaymentDetailPanel } from './Payments.tsx';

/** Troca os nomes técnicos dos estados (APPROVED, UNKNOWN…) pelos rótulos do painel. */
function translateStates(text: string): string {
  return text.replace(/\b(CREATED|PROCESSING|AUTHORIZED|APPROVED|DECLINED|UNKNOWN|CANCELLED|REVERSED)\b/g, (s) => STATE_LABEL[s as PaymentState].toLowerCase());
}

/** Agrupamento dos cenários fictícios por natureza. */
const GROUPS: readonly { title: string; ids: readonly string[] }[] = [
  { title: 'Resposta definitiva do provedor', ids: ['APPROVE', 'DECLINE', 'ABORT_AT_TERMINAL'] },
  { title: 'Falha antes do envio', ids: ['TIMEOUT_BEFORE_SEND'] },
  { title: 'Falha após possível envio (resultado desconhecido)', ids: ['TIMEOUT_AFTER_SEND', 'COMMUNICATION_FAILURE', 'UNKNOWN_THEN_RECONCILED'] },
  { title: 'Respostas fora de ordem', ids: ['DELAYED_RESPONSE', 'DUPLICATE_RESPONSE'] },
];

/** Estado final esperado de cada cenário (o painel explica se o resultado divergir). */
const EXPECTED_FINAL: Record<string, PaymentState> = {
  APPROVE: 'APPROVED',
  DECLINE: 'DECLINED',
  ABORT_AT_TERMINAL: 'CANCELLED',
  TIMEOUT_BEFORE_SEND: 'CANCELLED',
  TIMEOUT_AFTER_SEND: 'APPROVED',
  COMMUNICATION_FAILURE: 'DECLINED',
  DELAYED_RESPONSE: 'APPROVED',
  DUPLICATE_RESPONSE: 'APPROVED',
  UNKNOWN_THEN_RECONCILED: 'APPROVED',
};

interface CreatedRun {
  customerId: string;
  id: string;
  scenario: string;
  label: string;
  cents: number;
}

export function SimulatorPage() {
  const customers = useApi(() => api.get<Customer[]>('/customers', { status: 'ACTIVE', limit: 200 }), []);
  const scenarios = useApi(() => api.get<Scenario[]>('/simulator/scenarios'), []);
  const [customerId, setCustomerId] = useState('');
  const effectiveCustomer = customers.data?.some((c) => c.id === customerId) ? customerId : (customers.data?.[0]?.id ?? '');
  const merchants = useApi(
    () => (effectiveCustomer ? api.get<Merchant[]>('/merchants', { customerId: effectiveCustomer, status: 'ACTIVE', limit: 200 }) : Promise.resolve([])),
    [effectiveCustomer],
  );
  const [merchantId, setMerchantId] = useState('');
  const effectiveMerchant = merchants.data?.some((m) => m.id === merchantId) ? merchantId : (merchants.data?.[0]?.id ?? '');
  const terminals = useApi(
    () =>
      effectiveMerchant
        ? api.get<Terminal[]>('/terminals', { customerId: effectiveCustomer, merchantId: effectiveMerchant, status: 'ACTIVE', limit: 200 })
        : Promise.resolve([]),
    [effectiveCustomer, effectiveMerchant],
  );
  const [terminalId, setTerminalId] = useState('');
  const effectiveTerminal = terminals.data?.some((t) => t.id === terminalId) ? terminalId : (terminals.data?.[0]?.id ?? '');
  const [amount, setAmount] = useState('25,90');
  const [scenario, setScenario] = useState('APPROVE');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [runs, setRuns] = useState<CreatedRun[]>([]);

  if (customers.loading && !customers.data) return <Loading />;
  if (customers.error && !customers.data) return <ErrorNotice error={customers.error} onRetry={customers.reload} />;
  const loadError = scenarios.error ?? merchants.error ?? terminals.error;
  const byId = new Map((scenarios.data ?? []).map((s) => [s.id, s]));
  const cents = parseCents(amount);
  const missingContext = !effectiveTerminal;

  return (
    <>
      <PageHeader
        title="Simulador de pagamentos"
        description="Cria pagamentos fictícios que percorrem o caminho real: API, fila durável, worker e PostgreSQL. Nenhum cartão é solicitado e nenhuma aprovação aqui é uma autorização financeira real."
      />
      {loadError ? <ErrorNotice error={loadError} /> : null}
      {customers.data?.length === 0 ? (
        <EmptyState title="Cadastre um cliente, um estabelecimento e um terminal" action={<a className="btn btn-primary" href="#/clientes">Ir para clientes</a>}>
          Ou rode npm run db:seed para criar dados fictícios de demonstração.
        </EmptyState>
      ) : (
        <div className="sim-layout">
          <form
            className="panel form"
            aria-label="Novo pagamento simulado"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              const errs: Record<string, string> = {};
              if (cents === null) errs['amount'] = 'Informe um valor em reais maior que zero, por exemplo 25,90.';
              if (missingContext) errs['terminal'] = 'Escolha um terminal em operação. Se a lista estiver vazia, cadastre um terminal para este estabelecimento.';
              setErrors(errs);
              if (Object.keys(errs).length || cents === null) return;
              setBusy(true);
              api
                .post<PaymentFull>(
                  '/simulator/payments',
                  { customerId: effectiveCustomer, merchantId: effectiveMerchant, terminalId: effectiveTerminal, amountCents: cents, scenario },
                  true,
                )
                .then((p) =>
                  setRuns((list) =>
                    [{ customerId: effectiveCustomer, id: p.id, scenario, label: byId.get(scenario)?.label ?? scenario, cents }, ...list].slice(0, 4),
                  ),
                )
                .catch((err: unknown) => setErrors({ form: errorMessage(err) }))
                .finally(() => setBusy(false));
            }}
          >
            <div className="step">
              <p className="step-title">
                <span className="step-num">1</span>Onde o pagamento acontece
              </p>
              <Field label="Cliente">
                {(p) => (
                  <select {...p} value={effectiveCustomer} onChange={(e) => setCustomerId(e.target.value)}>
                    {(customers.data ?? []).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.tradeName ?? c.legalName}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="Estabelecimento">
                {(p) => (
                  <select {...p} value={effectiveMerchant} onChange={(e) => setMerchantId(e.target.value)} disabled={!merchants.data?.length}>
                    {merchants.data?.length ? null : <option value="">Nenhum estabelecimento ativo</option>}
                    {(merchants.data ?? []).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="Terminal simulado" error={errors['terminal']}>
                {(p) => (
                  <select {...p} value={effectiveTerminal} onChange={(e) => setTerminalId(e.target.value)} disabled={!terminals.data?.length}>
                    {terminals.data?.length ? null : <option value="">Nenhum terminal em operação</option>}
                    {(terminals.data ?? []).map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            </div>

            <div className="step">
              <p className="step-title">
                <span className="step-num">2</span>Valor
              </p>
              <Field label="Valor em reais" hint={cents !== null ? `Valor do pagamento simulado: ${money(cents)}` : 'Use vírgula para os centavos.'} error={errors['amount']}>
                {(p) => <input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
              </Field>
            </div>

            <div className="step">
              <p className="step-title">
                <span className="step-num">3</span>Cenário de teste (fictício)
              </p>
              {GROUPS.map((g) => (
                <fieldset key={g.title} className="scenario-group">
                  <legend>{g.title}</legend>
                  {g.ids
                    .map((id) => byId.get(id))
                    .filter((s): s is Scenario => Boolean(s))
                    .map((s) => (
                      <label key={s.id} className={`scenario ${scenario === s.id ? 'scenario-on' : ''}`}>
                        <input type="radio" name="scenario" value={s.id} checked={scenario === s.id} onChange={() => setScenario(s.id)} />
                        <span>
                          <span className="scenario-label">{s.label}</span>
                          <span className="scenario-expected">Esperado: {translateStates(s.expected)}</span>
                        </span>
                      </label>
                    ))}
                </fieldset>
              ))}
            </div>

            {errors['form'] ? (
              <p className="form-error" role="alert">
                {errors['form']}
              </p>
            ) : null}
            <Button type="submit" variant="primary" busy={busy}>
              {busy ? 'Enviando para a fila' : 'Criar pagamento simulado'}
            </Button>
            <p className="field-hint">O cenário vale para a autorização. Estornos e cancelamentos deste pagamento são aprovados pelo simulador.</p>
          </form>

          <div>
            {runs.length === 0 ? (
              <EmptyState title="Nenhum pagamento criado nesta sessão">
                O resultado aparece aqui e se atualiza sozinho conforme o worker processa a fila. Resultados desconhecidos nunca geram nova cobrança: o worker
                consulta o provedor até ter evidência.
              </EmptyState>
            ) : (
              runs.map((r) => (
                <section key={r.id} className="panel" aria-label={`Resultado do cenário ${r.label}`}>
                  <div className="panel-head">
                    <h2>{r.label}</h2>
                    <p className="panel-note">Resultado simulado, não é autorização financeira</p>
                  </div>
                  <PaymentDetailPanel customerId={r.customerId} paymentId={r.id} {...(EXPECTED_FINAL[r.scenario] ? { expectedFinal: EXPECTED_FINAL[r.scenario] } : {})} />
                </section>
              ))
            )}
          </div>
        </div>
      )}
    </>
  );
}
