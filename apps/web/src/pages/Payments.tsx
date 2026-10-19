import { useState } from 'react';
import { api, FINAL_STATES, type Customer, type PaymentDetail, type PaymentState, type PaymentSummary } from '../api.ts';
import { Button, ConfirmDialog, EmptyState, errorMessage, ErrorNotice, Field, Loading, Modal, PageHeader, Pill, StateBadge, useApi, useToast } from '../components/ui.tsx';
import { EVIDENCE_LABEL, money, OPERATION_KIND_LABEL, OPERATION_STATUS_LABEL, parseCents, STATE_LABEL, STATE_TONE, when } from '../format.ts';

const STATES: PaymentState[] = ['CREATED', 'PROCESSING', 'AUTHORIZED', 'APPROVED', 'DECLINED', 'UNKNOWN', 'CANCELLED', 'REVERSED'];

export function PaymentsPage({ params }: { params: URLSearchParams }) {
  const [customerId, setCustomerId] = useState(params.get('customerId') ?? '');
  const [state, setState] = useState(params.get('state') ?? '');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<{ customerId: string; id: string } | null>(null);
  const customers = useApi(() => api.get<Customer[]>('/customers', { limit: 200 }), []);
  const list = useApi(() => api.get<PaymentSummary[]>('/payments', { customerId, state, q, limit: 100 }), [customerId, state, q], {
    pollMs: 3_000,
  });

  return (
    <>
      <PageHeader title="Transações" description="Pagamentos gravados no banco local. A lista se atualiza a cada 3 segundos." />
      <div className="toolbar">
        <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} aria-label="Cliente">
          <option value="">Todos os clientes</option>
          {(customers.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.tradeName ?? c.legalName}
            </option>
          ))}
        </select>
        <select value={state} onChange={(e) => setState(e.target.value)} aria-label="Estado">
          <option value="">Todos os estados</option>
          {STATES.map((s) => (
            <option key={s} value={s}>
              {STATE_LABEL[s]}
            </option>
          ))}
        </select>
        <input type="search" placeholder="Buscar por ID, referência ou terminal" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar transações" />
      </div>

      {customers.error ? <ErrorNotice error={customers.error} onRetry={customers.reload} /> : null}
      {list.error ? <ErrorNotice error={list.error} onRetry={list.reload} /> : null}
      {list.loading && !list.data ? <Loading /> : null}
      {list.data?.length === 0 ? (
        <EmptyState title="Nenhuma transação encontrada" action={<a className="btn btn-primary" href="#/simulador">Abrir o simulador</a>}>
          {q || state || customerId ? 'Ajuste os filtros.' : 'Crie um pagamento fictício pelo simulador.'}
        </EmptyState>
      ) : null}
      {list.data && list.data.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Criado</th>
                <th scope="col">Estado</th>
                <th scope="col" className="num">
                  Valor
                </th>
                <th scope="col">Cliente e estabelecimento</th>
                <th scope="col">Referência</th>
                <th scope="col">
                  <span className="sr-only">Abrir</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((p) => (
                <tr key={p.id} className="clickable" onClick={() => setOpen({ customerId: p.customerId, id: p.id })}>
                  <td>{when(p.createdAt)}</td>
                  <td>
                    <StateBadge state={p.state} />
                  </td>
                  <td className="num">
                    {money(p.amountCents)}
                    {p.reversedCents > 0 ? <span className="cell-sub">{money(p.reversedCents)} revertidos</span> : null}
                  </td>
                  <td>
                    <span className="code">{p.customerId}</span>
                    <span className="cell-sub code">
                      {p.merchantId} / {p.terminalId}
                    </span>
                  </td>
                  <td className="code">{p.externalReference}</td>
                  <td>
                    <Button
                      variant="ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpen({ customerId: p.customerId, id: p.id });
                      }}
                    >
                      Detalhes
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {open ? (
        <Modal title="Detalhe da transação" onClose={() => setOpen(null)} wide>
          <PaymentDetailPanel customerId={open.customerId} paymentId={open.id} onChanged={list.reload} />
        </Modal>
      ) : null}
    </>
  );
}

/** Detalhe com atualização automática enquanto houver algo em andamento. */
export function PaymentDetailPanel({ customerId, paymentId, onChanged }: { customerId: string; paymentId: string; onChanged?: () => void }) {
  const toast = useToast();
  const [refundOpen, setRefundOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const detail = useApi(() => api.get<PaymentDetail>(`/customers/${customerId}/payments/${paymentId}`), [customerId, paymentId], {
    pollMs: 1_200,
    poll: (d) =>
      !FINAL_STATES.has(d.payment.state) ||
      d.payment.operations.some((o) => ['PENDING', 'IN_FLIGHT', 'UNKNOWN'].includes(o.status)) ||
      d.jobs.some((j) => j.status === 'PENDING' || j.status === 'RUNNING'),
  });

  if (detail.error) return <ErrorNotice error={detail.error} onRetry={detail.reload} />;
  if (!detail.data) return <Loading />;
  const { payment, jobs, audit, testDirective } = detail.data;
  const openOp = payment.operations.find((o) => ['PENDING', 'IN_FLIGHT', 'UNKNOWN'].includes(o.status));
  const unknownOp = payment.operations.find((o) => o.status === 'UNKNOWN');
  const reconcileJob = jobs.find((j) => j.kind === 'RECONCILE_OPERATION' && (j.status === 'PENDING' || j.status === 'RUNNING'));
  const transitions = audit
    .filter((e) => e.action === 'payment.state_changed' || e.action === 'payment.created')
    .sort((a, b) => a.seq - b.seq);
  const available = payment.amount.cents - payment.reversedAmount.cents;
  const after = () => {
    detail.reload();
    onChanged?.();
  };

  return (
    <div className="detail">
      <div className="detail-head">
        <StateBadge state={payment.state} />
        <p className="detail-amount">{money(payment.amount.cents)}</p>
        {payment.reversedAmount.cents > 0 ? <p className="muted">{money(payment.reversedAmount.cents)} revertidos</p> : null}
        {payment.provider.simulated ? <span className="tag">simulado{testDirective ? `: cenário ${testDirective}` : ''}</span> : null}
      </div>

      {payment.state === 'UNKNOWN' || unknownOp ? (
        <div className="notice notice-warn">
          <p>
            <strong>Sem evidência do resultado financeiro.</strong> Nenhuma nova cobrança será feita automaticamente.{' '}
            {reconcileJob ? 'A reconciliação por consulta ao provedor está agendada.' : 'Peça a reconciliação para consultar o provedor.'}
          </p>
        </div>
      ) : null}

      <dl className="facts">
        <div>
          <dt>Identificador</dt>
          <dd className="code">{payment.id}</dd>
        </div>
        <div>
          <dt>Referência comercial</dt>
          <dd className="code">{payment.externalReference}</dd>
        </div>
        <div>
          <dt>Cliente, estabelecimento e terminal</dt>
          <dd className="code">
            {customerId} / {payment.merchantId} / {payment.terminalId}
          </dd>
        </div>
        <div>
          <dt>Motivo do estado</dt>
          <dd className="code">{payment.stateReason ?? '—'}</dd>
        </div>
      </dl>

      <div className="detail-actions">
        {payment.state === 'APPROVED' && !openOp ? (
          <>
            <Button onClick={() => setRefundOpen(true)}>Estornar</Button>
            {payment.reversedAmount.cents === 0 ? <Button onClick={() => setCancelOpen(true)}>Cancelar pagamento</Button> : null}
          </>
        ) : null}
        {unknownOp ? (
          <Button
            variant="primary"
            busy={busy}
            onClick={() => {
              setBusy(true);
              api
                .post(`/customers/${customerId}/payments/${paymentId}/reconcile`)
                .then(() => {
                  toast('good', 'Reconciliação agendada: o worker vai consultar o provedor');
                  after();
                })
                .catch((e: unknown) => toast('bad', errorMessage(e)))
                .finally(() => setBusy(false));
            }}
          >
            Reconciliar agora
          </Button>
        ) : null}
      </div>

      <section>
        <h3>Trilha de estados</h3>
        <ol className="trail">
          {transitions.map((e) => {
            const to = (e.data['toState'] as PaymentState | undefined) ?? 'CREATED';
            return (
              <li key={e.seq} className={`trail-step trail-${STATE_TONE[to]}`}>
                <span className="trail-dot" aria-hidden="true" />
                <div>
                  <p className="trail-state">{STATE_LABEL[to]}</p>
                  <p className="trail-meta">
                    {when(e.occurredAt)}
                    {e.data['stateReason'] ? `, ${String(e.data['stateReason'])}` : ''}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      <section>
        <h3>Operações junto ao provedor</h3>
        <div className="table-wrap">
          <table className="table compact">
            <thead>
              <tr>
                <th scope="col">Tipo</th>
                <th scope="col">Situação</th>
                <th scope="col" className="num">
                  Valor
                </th>
                <th scope="col">Evidência</th>
                <th scope="col">Referência do provedor</th>
              </tr>
            </thead>
            <tbody>
              {payment.operations.map((o) => (
                <tr key={o.id}>
                  <td>{OPERATION_KIND_LABEL[o.kind] ?? o.kind}</td>
                  <td>
                    <Pill
                      tone={
                        o.status === 'SUCCEEDED' ? 'good' : o.status === 'REJECTED' ? 'bad' : o.status === 'UNKNOWN' ? 'warn' : o.status === 'PENDING' || o.status === 'IN_FLIGHT' ? 'busy' : 'neutral'
                      }
                    >
                      {OPERATION_STATUS_LABEL[o.status]}
                    </Pill>
                    {o.resultCode ? <span className="cell-sub code">{o.resultCode}</span> : null}
                  </td>
                  <td className="num">{money(o.amount.cents)}</td>
                  <td>{o.evidenceSource ? (EVIDENCE_LABEL[o.evidenceSource] ?? o.evidenceSource) : '—'}</td>
                  <td className="code">{o.providerReference ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h3>Tarefas do worker</h3>
        {jobs.length === 0 ? (
          <p className="muted">Nenhuma tarefa: o pagamento foi criado sem autorização automática.</p>
        ) : (
          <ul className="plain-list">
            {jobs.map((j) => (
              <li key={j.id}>
                {j.kind === 'EXECUTE_OPERATION' ? 'Executar operação' : 'Reconciliar por consulta'}:{' '}
                {j.status === 'DONE' ? 'concluída' : j.status === 'PENDING' ? 'na fila' : j.status === 'RUNNING' ? 'em execução' : 'esgotada'} ({j.attempts}/
                {j.maxAttempts} tentativas){j.lastErrorCode ? `, último código ${j.lastErrorCode}` : ''}
              </li>
            ))}
          </ul>
        )}
      </section>

      {refundOpen ? (
        <RefundDialog
          maxCents={available}
          onClose={() => setRefundOpen(false)}
          onConfirm={async (cents) => {
            await api.post(`/customers/${customerId}/payments/${paymentId}/refunds`, { amountCents: cents }, true);
            toast('good', `Estorno de ${money(cents)} solicitado`);
            after();
          }}
        />
      ) : null}
      {cancelOpen ? (
        <ConfirmDialog
          title="Cancelar pagamento"
          message={`O cancelamento é sempre pelo valor total (${money(payment.amount.cents)}) e passa pela fila do worker. Para devolver só parte do valor, use o estorno.`}
          confirmLabel="Cancelar pagamento"
          danger
          onClose={() => setCancelOpen(false)}
          onConfirm={async () => {
            await api.post(`/customers/${customerId}/payments/${paymentId}/cancel`, {}, true);
            toast('good', 'Cancelamento solicitado');
            after();
          }}
        />
      ) : null}
    </div>
  );
}

function RefundDialog({ maxCents, onClose, onConfirm }: { maxCents: number; onClose: () => void; onConfirm: (cents: number) => Promise<void> }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Estornar" onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          const cents = parseCents(value);
          if (cents === null) return setError('Informe um valor em reais, por exemplo 12,50.');
          if (cents > maxCents) return setError(`O máximo disponível para estorno é ${money(maxCents)}.`);
          setBusy(true);
          onConfirm(cents)
            .then(onClose)
            .catch((err: unknown) => setError(errorMessage(err)))
            .finally(() => setBusy(false));
        }}
      >
        <Field label="Valor do estorno" hint={`Disponível: ${money(maxCents)}. Estornos parciais mantêm o pagamento aprovado com saldo menor.`} error={error}>
          {(p) => <input {...p} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder="0,00" autoFocus />}
        </Field>
        <div className="form-actions">
          <Button variant="ghost" onClick={onClose}>
            Voltar
          </Button>
          <Button type="submit" variant="primary" busy={busy}>
            Estornar
          </Button>
        </div>
      </form>
    </Modal>
  );
}
