import { useMemo, useState } from 'react';
import { api, FINAL_STATES, type AuditEntry, type Customer, type PaymentDetail, type PaymentState, type PaymentSummary } from '../api.ts';
import {
  Button,
  ConfirmDialog,
  EmptyState,
  errorMessage,
  ErrorNotice,
  Field,
  HierarchyPath,
  IdText,
  Loading,
  Modal,
  PageHeader,
  Pill,
  Segmented,
  SkeletonTable,
  SortTh,
  StateBadge,
  useApi,
  useToast,
  type SortDir,
} from '../components/ui.tsx';
import {
  ACTION_LABEL,
  clock,
  EVIDENCE_LABEL,
  money,
  OPERATION_KIND_LABEL,
  OPERATION_STATUS_LABEL,
  parseCents,
  STATE_LABEL,
  STATE_TONE,
  when,
  type Tone,
} from '../format.ts';

const STATES: PaymentState[] = ['CREATED', 'PROCESSING', 'AUTHORIZED', 'APPROVED', 'DECLINED', 'UNKNOWN', 'CANCELLED', 'REVERSED'];
const STATE_ORDER: Record<PaymentState, number> = { UNKNOWN: 0, PROCESSING: 1, AUTHORIZED: 2, CREATED: 3, APPROVED: 4, DECLINED: 5, REVERSED: 6, CANCELLED: 7 };
type Period = '1' | '7' | '30' | 'all';
const PERIODS: readonly { value: Period; label: string }[] = [
  { value: '1', label: '24 horas' },
  { value: '7', label: '7 dias' },
  { value: '30', label: '30 dias' },
  { value: 'all', label: 'Tudo' },
];
type SortKey = 'createdAt' | 'amount' | 'state';

export function PaymentsPage({ params }: { params: URLSearchParams }) {
  const [customerId, setCustomerId] = useState(params.get('customerId') ?? '');
  const [state, setState] = useState(params.get('state') ?? '');
  const [period, setPeriod] = useState<Period>('all');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'createdAt', dir: 'desc' });
  const [open, setOpen] = useState<{ customerId: string; id: string } | null>(null);
  const customers = useApi(() => api.get<Customer[]>('/customers', { limit: 200 }), []);
  const list = useApi(
    () =>
      api.get<PaymentSummary[]>('/payments', {
        customerId,
        state,
        q,
        limit: 200,
        ...(period === 'all' ? {} : { from: new Date(Date.now() - Number(period) * 86_400_000).toISOString() }),
      }),
    [customerId, state, q, period],
    { pollMs: 3_000 },
  );

  const rows = useMemo(() => {
    const data = [...(list.data ?? [])];
    const dir = sort.dir === 'asc' ? 1 : -1;
    data.sort((a, b) => {
      if (sort.key === 'amount') return (a.amountCents - b.amountCents) * dir;
      if (sort.key === 'state') return (STATE_ORDER[a.state] - STATE_ORDER[b.state]) * dir;
      return a.createdAt.localeCompare(b.createdAt) * dir;
    });
    return data;
  }, [list.data, sort]);

  const unknownCount = rows.filter((p) => p.state === 'UNKNOWN').length;

  return (
    <>
      <PageHeader
        title="Transações"
        description="Pagamentos gravados no banco local, atualizados a cada 3 segundos. Todos são simulados."
        actions={list.updatedAt ? <span className="updated-at">Atualizado às {clock(list.updatedAt)}</span> : null}
      />
      <div className="toolbar">
        <Segmented label="Período" value={period} options={PERIODS} onChange={setPeriod} />
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
        {list.data ? (
          <span className="toolbar-meta">
            {rows.length} transação(ões){unknownCount > 0 ? `, ${unknownCount} com resultado desconhecido` : ''}
          </span>
        ) : null}
      </div>

      {customers.error ? <ErrorNotice error={customers.error} onRetry={customers.reload} /> : null}
      {list.error ? <ErrorNotice error={list.error} onRetry={list.reload} /> : null}
      {list.loading && !list.data ? <SkeletonTable columns={5} rows={6} /> : null}
      {list.data?.length === 0 ? (
        <EmptyState title="Nenhuma transação encontrada" action={q || state || customerId || period !== 'all' ? null : <a className="btn btn-primary" href="#/simulador">Abrir o simulador</a>}>
          {q || state || customerId || period !== 'all' ? 'Ajuste os filtros ou o período.' : 'Crie um pagamento fictício pelo simulador.'}
        </EmptyState>
      ) : null}
      {rows.length > 0 ? (
        <div className="table-wrap">
          <table className="table" aria-label="Transações">
            <thead>
              <tr>
                <SortTh label="Horário" column="createdAt" sort={sort} onSort={setSort} />
                <SortTh label="Estado" column="state" sort={sort} onSort={setSort} />
                <SortTh label="Valor" column="amount" sort={sort} onSort={setSort} className="num" />
                <th scope="col">Pagamento e referência</th>
                <th scope="col">Cliente › Estabelecimento › Terminal</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr
                  key={p.id}
                  className={`clickable ${p.state === 'UNKNOWN' ? 'row-attention' : ''}`}
                  onClick={() => setOpen({ customerId: p.customerId, id: p.id })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') setOpen({ customerId: p.customerId, id: p.id });
                  }}
                  tabIndex={0}
                  aria-label={`Abrir pagamento ${p.externalReference}, ${STATE_LABEL[p.state]}, ${money(p.amountCents)}`}
                >
                  <td>{when(p.createdAt)}</td>
                  <td>
                    <StateBadge state={p.state} />
                  </td>
                  <td className="num">
                    {money(p.amountCents)}
                    {p.reversedCents > 0 ? <span className="cell-sub">{money(p.reversedCents)} revertidos</span> : null}
                  </td>
                  <td>
                    <IdText value={p.id} />
                    <span className="cell-sub code">{p.externalReference}</span>
                  </td>
                  <td>
                    <HierarchyPath parts={[p.customerId, p.merchantId, p.terminalId]} />
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

const OPEN_STATUSES = new Set(['PENDING', 'IN_FLIGHT', 'UNKNOWN']);

function operationTone(status: string): Tone {
  if (status === 'SUCCEEDED') return 'good';
  if (status === 'REJECTED') return 'bad';
  if (status === 'UNKNOWN') return 'warn';
  if (status === 'PENDING' || status === 'IN_FLIGHT') return 'busy';
  return 'neutral';
}

/** Converte um evento de auditoria em linha do histórico. */
function describe(e: AuditEntry): { title: string; detail: string; tone: Tone; major: boolean } {
  const d = e.data;
  const to = typeof d['toState'] === 'string' ? (d['toState'] as PaymentState) : null;
  const kind = typeof d['operationKind'] === 'string' ? (OPERATION_KIND_LABEL[d['operationKind']] ?? d['operationKind']) : null;
  const opStatus = typeof d['operationStatus'] === 'string' ? d['operationStatus'] : null;
  if (e.action === 'payment.state_changed' && to) {
    return { title: `Pagamento: ${STATE_LABEL[to]}`, detail: typeof d['stateReason'] === 'string' ? d['stateReason'] : '', tone: STATE_TONE[to], major: true };
  }
  if (e.action === 'payment.created') return { title: 'Pagamento criado', detail: `estado inicial ${STATE_LABEL[to ?? 'CREATED']}`, tone: 'neutral', major: true };
  if (e.action === 'operation.result_recorded' && opStatus) {
    const evidence = typeof d['evidenceSource'] === 'string' ? `evidência: ${EVIDENCE_LABEL[d['evidenceSource']] ?? d['evidenceSource']}` : 'sem evidência definitiva';
    const code = typeof d['resultCode'] === 'string' ? `, código ${d['resultCode']}` : '';
    return {
      title: `${kind ?? 'Operação'}: ${OPERATION_STATUS_LABEL[opStatus as keyof typeof OPERATION_STATUS_LABEL] ?? opStatus}`,
      detail: `${evidence}${code}`,
      tone: operationTone(opStatus),
      major: false,
    };
  }
  return { title: `${ACTION_LABEL[e.action] ?? e.action}${kind ? ` (${kind})` : ''}`, detail: '', tone: 'neutral', major: false };
}

/** Detalhe com atualização automática enquanto houver algo em andamento. */
export function PaymentDetailPanel({
  customerId,
  paymentId,
  onChanged,
  expectedFinal,
}: {
  customerId: string;
  paymentId: string;
  onChanged?: () => void;
  /** Estado final esperado pelo cenário do simulador (para explicar resultados inesperados). */
  expectedFinal?: PaymentState;
}) {
  const toast = useToast();
  const [refundOpen, setRefundOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const detail = useApi(() => api.get<PaymentDetail>(`/customers/${customerId}/payments/${paymentId}`), [customerId, paymentId], {
    pollMs: 1_200,
    poll: (d) =>
      !FINAL_STATES.has(d.payment.state) ||
      d.payment.operations.some((o) => OPEN_STATUSES.has(o.status)) ||
      d.jobs.some((j) => j.status === 'PENDING' || j.status === 'RUNNING'),
  });

  if (!detail.data) return detail.error ? <ErrorNotice error={detail.error} onRetry={detail.reload} /> : <Loading />;
  const { payment, jobs, audit, testDirective } = detail.data;
  const openOp = payment.operations.find((o) => OPEN_STATUSES.has(o.status));
  const unknownOp = payment.operations.find((o) => o.status === 'UNKNOWN');
  const inFlight = payment.operations.find((o) => o.status === 'PENDING' || o.status === 'IN_FLIGHT');
  const reconcileJob = jobs.find((j) => j.kind === 'RECONCILE_OPERATION' && (j.status === 'PENDING' || j.status === 'RUNNING'));
  const exhausted = jobs.some((j) => j.status === 'FAILED');
  const history = [...audit].sort((a, b) => a.seq - b.seq);
  const available = payment.amount.cents - payment.reversedAmount.cents;
  const canReverse = payment.state === 'APPROVED' && !openOp;
  const after = () => {
    detail.reload();
    onChanged?.();
  };

  return (
    <div className="detail" data-payment-state={payment.state}>
      {detail.error ? <ErrorNotice error={detail.error} onRetry={detail.reload} /> : null}
      <div className="detail-head">
        <StateBadge state={payment.state} />
        <p className="detail-amount">{money(payment.amount.cents)}</p>
        {payment.reversedAmount.cents > 0 ? <span className="muted">{money(payment.reversedAmount.cents)} revertidos</span> : null}
        {payment.provider.simulated ? <span className="tag">simulado{testDirective ? `: cenário ${testDirective}` : ''}</span> : null}
      </div>

      {inFlight ? (
        <div className="processing" role="status">
          <span className="spinner" aria-hidden="true" />
          {inFlight.status === 'PENDING' ? 'Na fila: aguardando o worker processar a operação.' : 'Enviada ao provedor simulado: aguardando resposta.'}
        </div>
      ) : null}

      {payment.state === 'UNKNOWN' || unknownOp ? (
        <div className="notice notice-warn" role="note">
          <p>
            <strong>Sem evidência do resultado financeiro.</strong> Nenhuma nova cobrança será feita automaticamente.{' '}
            {reconcileJob
              ? 'A reconciliação por consulta ao provedor está agendada; o resultado aparece aqui quando houver evidência.'
              : exhausted
                ? 'As consultas automáticas se esgotaram sem evidência: o caso exige resolução manual.'
                : 'Peça a reconciliação para que o worker consulte o provedor.'}
          </p>
        </div>
      ) : null}

      {expectedFinal && FINAL_STATES.has(payment.state) && payment.state !== expectedFinal ? (
        <div className="notice notice-info" role="note">
          <p>
            <strong>Resultado diferente do esperado pelo cenário ({STATE_LABEL[expectedFinal]}).</strong> Isso pode acontecer se o worker foi reiniciado, se
            o tempo limite foi alterado ou se o cenário dependia de uma consulta indisponível. Nenhuma cobrança será repetida; confira o histórico de eventos
            abaixo e a página de auditoria.
          </p>
        </div>
      ) : null}

      <dl className="facts">
        <div>
          <dt>Identificador</dt>
          <dd>
            <IdText value={payment.id} head={40} />
          </dd>
        </div>
        <div>
          <dt>Referência comercial</dt>
          <dd className="code">{payment.externalReference}</dd>
        </div>
        <div>
          <dt>Cliente › Estabelecimento › Terminal</dt>
          <dd>
            <HierarchyPath parts={[customerId, payment.merchantId, payment.terminalId]} />
          </dd>
        </div>
        <div>
          <dt>Criado em</dt>
          <dd>{when(payment.createdAt)}</dd>
        </div>
        <div>
          <dt>Motivo do estado</dt>
          <dd className="code">{payment.stateReason ?? '—'}</dd>
        </div>
        <div>
          <dt>Saldo disponível para estorno</dt>
          <dd>{payment.state === 'APPROVED' ? money(available) : '—'}</dd>
        </div>
      </dl>

      <div className="detail-actions">
        {canReverse ? (
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
            {busy ? 'Agendando' : 'Reconciliar agora'}
          </Button>
        ) : null}
      </div>

      <section aria-labelledby="hist-title">
        <h3 id="hist-title">Histórico de eventos</h3>
        <ol className="trail">
          {history.map((e) => {
            const item = describe(e);
            return (
              <li key={e.seq} className={`trail-step trail-${item.tone} ${item.major ? '' : 'trail-minor'}`}>
                <span className="trail-dot" aria-hidden="true" />
                <div>
                  <p className="trail-title">{item.title}</p>
                  <p className="trail-meta">
                    {when(e.occurredAt)}
                    {item.detail ? `, ${item.detail}` : ''}
                    {e.correlationId ? `, correlação ${e.correlationId}` : ''}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      <section aria-labelledby="ops-title">
        <h3 id="ops-title">Operações junto ao provedor</h3>
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
                    <Pill tone={operationTone(o.status)}>{OPERATION_STATUS_LABEL[o.status]}</Pill>
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

      <section aria-labelledby="jobs-title">
        <h3 id="jobs-title">Tarefas do worker</h3>
        {jobs.length === 0 ? (
          <p className="muted">Nenhuma tarefa: o pagamento foi criado sem autorização automática.</p>
        ) : (
          <ul className="plain-list">
            {jobs.map((j) => (
              <li key={j.id}>
                {j.kind === 'EXECUTE_OPERATION' ? 'Executar operação' : 'Reconciliar por consulta'}:{' '}
                {j.status === 'DONE' ? 'concluída' : j.status === 'PENDING' ? 'na fila' : j.status === 'RUNNING' ? 'em execução' : 'esgotada (exige ação manual)'} ({j.attempts}/
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
          message={`O cancelamento devolve o valor total (${money(payment.amount.cents)}), passa pela fila do worker e não pode ser desfeito. Para devolver só parte do valor, use o estorno.`}
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
        noValidate
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
        <Field label="Valor do estorno" hint={`Disponível: ${money(maxCents)}. O estorno é irreversível; parciais mantêm o pagamento aprovado com saldo menor.`} error={error}>
          {(p) => <input {...p} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder="0,00" />}
        </Field>
        <div className="form-actions">
          <Button variant="ghost" onClick={onClose}>
            Voltar
          </Button>
          <Button type="submit" variant="primary" busy={busy}>
            {busy ? 'Solicitando' : 'Estornar'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
