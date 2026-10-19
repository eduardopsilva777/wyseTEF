import { useState } from 'react';
import { api, type Customer, type Merchant, type PaymentFull, type Scenario, type Terminal } from '../api.ts';
import { Button, EmptyState, errorMessage, ErrorNotice, Field, Loading, PageHeader, useApi } from '../components/ui.tsx';
import { parseCents } from '../format.ts';
import { PaymentDetailPanel } from './Payments.tsx';

export function SimulatorPage() {
  const customers = useApi(() => api.get<Customer[]>('/customers', { status: 'ACTIVE', limit: 200 }), []);
  const scenarios = useApi(() => api.get<Scenario[]>('/simulator/scenarios'), []);
  const [customerId, setCustomerId] = useState('');
  const effectiveCustomer = customerId || customers.data?.[0]?.id || '';
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
  const [created, setCreated] = useState<{ customerId: string; id: string }[]>([]);

  if (customers.loading && !customers.data) return <Loading />;
  const loadError = customers.error ?? scenarios.error ?? merchants.error ?? terminals.error;
  if (customers.error && !customers.data) return <ErrorNotice error={customers.error} onRetry={customers.reload} />;
  const selected = scenarios.data?.find((s) => s.id === scenario);

  return (
    <>
      <PageHeader
        title="Simulador de pagamentos"
        description="Cria pagamentos fictícios que percorrem o caminho real: API, fila durável, worker e PostgreSQL. Nenhum cartão é solicitado e nenhuma aprovação é real."
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
            onSubmit={(e) => {
              e.preventDefault();
              const cents = parseCents(amount);
              const errs: Record<string, string> = {};
              if (cents === null) errs['amount'] = 'Informe um valor em reais, por exemplo 25,90.';
              if (!effectiveTerminal) errs['terminal'] = 'Escolha um terminal ativo.';
              setErrors(errs);
              if (Object.keys(errs).length || cents === null) return;
              setBusy(true);
              api
                .post<PaymentFull>(
                  '/simulator/payments',
                  { customerId: effectiveCustomer, merchantId: effectiveMerchant, terminalId: effectiveTerminal, amountCents: cents, scenario },
                  true,
                )
                .then((p) => setCreated((list) => [{ customerId: effectiveCustomer, id: p.id }, ...list].slice(0, 5)))
                .catch((err: unknown) => setErrors({ form: errorMessage(err) }))
                .finally(() => setBusy(false));
            }}
          >
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
                <select {...p} value={effectiveMerchant} onChange={(e) => setMerchantId(e.target.value)}>
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
                <select {...p} value={effectiveTerminal} onChange={(e) => setTerminalId(e.target.value)}>
                  {(terminals.data ?? []).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Valor" error={errors['amount']}>
              {(p) => <input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
            </Field>
            <fieldset className="scenarios">
              <legend>Cenário de teste (fictício)</legend>
              {(scenarios.data ?? []).map((s) => (
                <label key={s.id} className={`scenario ${scenario === s.id ? 'scenario-on' : ''}`}>
                  <input type="radio" name="scenario" value={s.id} checked={scenario === s.id} onChange={() => setScenario(s.id)} />
                  <span>
                    <span className="scenario-label">{s.label}</span>
                    <span className="scenario-expected">Esperado: {s.expected}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            {errors['form'] ? <p className="field-error">{errors['form']}</p> : null}
            <Button type="submit" variant="primary" busy={busy}>
              Criar pagamento simulado
            </Button>
            {selected ? <p className="field-hint">O cenário vale para a autorização. Estornos e cancelamentos deste pagamento são aprovados pelo simulador.</p> : null}
          </form>

          <div className="sim-results">
            {created.length === 0 ? (
              <EmptyState title="Nenhum pagamento criado nesta sessão">
                O resultado aparece aqui e se atualiza sozinho conforme o worker processa a fila.
              </EmptyState>
            ) : (
              created.map((c) => (
                <section key={c.id} className="panel">
                  <PaymentDetailPanel customerId={c.customerId} paymentId={c.id} />
                </section>
              ))
            )}
          </div>
        </div>
      )}
    </>
  );
}
