import { useState } from 'react';
import { navigate } from '../App.tsx';
import { api, type Customer, type Dashboard, type PaymentState, type SystemStatus } from '../api.ts';
import { DailyChart } from '../components/DailyChart.tsx';
import { EmptyState, ErrorNotice, IdText, Loading, PageHeader, Pill, Segmented, ToneIcon, useApi } from '../components/ui.tsx';
import { ACTION_LABEL, clock, money, shortDay, STATE_LABEL, when } from '../format.ts';

type Preset = '7' | '14' | '30' | 'all' | 'custom';
const PRESETS: readonly { value: Preset; label: string }[] = [
  { value: '7', label: '7 dias' },
  { value: '14', label: '14 dias' },
  { value: '30', label: '30 dias' },
  { value: 'all', label: 'Tudo' },
  { value: 'custom', label: 'Personalizado' },
];

export function DashboardPage() {
  const [preset, setPreset] = useState<Preset>('14');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [customerId, setCustomerId] = useState('');
  const customers = useApi(() => api.get<Customer[]>('/customers', { limit: 200 }), []);

  const range = (() => {
    if (preset === 'all') return { ok: true as const, query: {} };
    if (preset === 'custom') {
      if (!customFrom || !customTo) return { ok: false as const, message: 'Escolha a data inicial e a final para ver o período personalizado.' };
      const from = new Date(`${customFrom}T00:00:00`);
      const to = new Date(`${customTo}T23:59:59.999`);
      if (from > to) return { ok: false as const, message: 'A data inicial precisa ser anterior ou igual à final.' };
      return { ok: true as const, query: { from: from.toISOString(), to: to.toISOString() } };
    }
    return { ok: true as const, query: { from: new Date(Date.now() - Number(preset) * 86_400_000).toISOString() } };
  })();

  const dash = useApi(
    () => (range.ok ? api.get<Dashboard>('/dashboard', { ...range.query, customerId }) : Promise.resolve(null)),
    [preset, customFrom, customTo, customerId],
    { pollMs: 5_000 },
  );
  const system = useApi(() => api.get<SystemStatus>('/system'), [], { pollMs: 5_000 });

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Indicadores calculados a partir dos pagamentos gravados no PostgreSQL local. Os valores são de transações simuladas."
        actions={dash.updatedAt ? <span className="updated-at">Atualizado às {clock(dash.updatedAt)}</span> : null}
      />

      <div className="toolbar">
        <Segmented label="Período" value={preset} options={PRESETS} onChange={setPreset} />
        {preset === 'custom' ? (
          <>
            <label className="inline-field">
              <span>De</span>
              <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} />
            </label>
            <label className="inline-field">
              <span>Até</span>
              <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} />
            </label>
          </>
        ) : null}
        <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} aria-label="Cliente">
          <option value="">Todos os clientes</option>
          {(customers.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.tradeName ?? c.legalName}
            </option>
          ))}
        </select>
      </div>

      {!range.ok ? (
        <div className="notice notice-info">
          <p>{range.message}</p>
        </div>
      ) : null}
      {customers.error ? <ErrorNotice error={customers.error} onRetry={customers.reload} /> : null}
      {dash.error ? <ErrorNotice error={dash.error} onRetry={dash.reload} /> : null}
      {range.ok && !dash.data && dash.loading ? <Loading /> : null}
      {dash.data ? <DashboardBody data={dash.data} allTime={preset === 'all'} /> : null}

      <section className="panel" aria-labelledby="proc-title">
        <div className="panel-head">
          <h2 id="proc-title">Processamento</h2>
          <p className="panel-note">Worker, fila de tarefas e eventos a publicar</p>
        </div>
        {system.error ? <ErrorNotice error={system.error} onRetry={system.reload} /> : null}
        {system.data ? <SystemBlock status={system.data} /> : system.error ? null : <Loading />}
      </section>
    </>
  );
}

function DashboardBody({ data, allTime }: { data: Dashboard; allTime: boolean }) {
  const t = data.totals;
  const rate = t.approvalRate === null ? 'ainda sem respostas definitivas' : `${(t.approvalRate * 100).toFixed(1).replace('.', ',')}% de aprovação`;
  const firstDay = data.daily[0]?.day;
  const lastDay = data.daily.at(-1)?.day;
  const chartEmpty = data.daily.every((d) => d.approved + d.declined + d.other === 0);

  return (
    <>
      {data.unknownOperations > 0 ? (
        <button type="button" className="attention" onClick={() => navigate('transacoes', { state: 'UNKNOWN' })}>
          <Pill tone="warn">{data.unknownOperations} sem resultado definitivo</Pill>
          <span>Nenhuma cobrança será repetida. O worker consulta o provedor até ter evidência; abra as transações para acompanhar ou pedir a reconciliação agora.</span>
        </button>
      ) : null}

      <section className="kpis" aria-label="Indicadores do período">
        <div className="kpi kpi-lead">
          <p className="kpi-label">Saldo aprovado líquido</p>
          <p className="kpi-value">{money(data.amounts.netApprovedCents)}</p>
          <p className="kpi-note">
            {t.payments} pagamento(s) no período, {rate}
          </p>
        </div>
        <Kpi tone="good" label="Aprovados" count={t.approvedCount + t.reversedCount} note={`${money(data.amounts.approvedCents)} aprovados; ${money(data.amounts.reversedCents)} revertidos`} />
        <Kpi tone="bad" label="Recusados" count={t.declinedCount} note={`${money(data.amounts.declinedCents)} em tentativas recusadas`} />
        <Kpi tone="busy" label="Em processamento" count={t.pendingCount} note={`${money(data.amounts.pendingCents)} aguardando o worker`} />
        <Kpi
          tone="warn"
          label="Resultado desconhecido"
          count={t.unknownCount}
          note={`${money(data.amounts.unknownCents)}; ${data.unknownOperations} operação(ões) em reconciliação`}
          emphasis={t.unknownCount > 0}
        />
      </section>

      <div className="grid-2">
        <section className="panel" aria-labelledby="chart-title">
          <div className="panel-head">
            <h2 id="chart-title">Pagamentos por dia</h2>
            {firstDay && lastDay ? (
              <p className="panel-note">
                {shortDay(firstDay)} a {shortDay(lastDay)}
                {allTime ? ' (o gráfico mostra os últimos 14 dias)' : ''}
              </p>
            ) : null}
          </div>
          {chartEmpty ? (
            <EmptyState title="Nenhum pagamento neste intervalo">
              Ajuste o período ou o cliente, ou crie um pagamento fictício no <a href="#/simulador">simulador</a>.
            </EmptyState>
          ) : (
            <DailyChart data={data.daily} />
          )}
        </section>
        <section className="panel" aria-labelledby="activity-title">
          <div className="panel-head">
            <h2 id="activity-title">Atividade recente</h2>
            <a href="#/auditoria" className="panel-note">
              Ver auditoria
            </a>
          </div>
          {data.recentActivity.length === 0 ? (
            <EmptyState title="Sem atividade registrada" />
          ) : (
            <ol className="activity">
              {data.recentActivity.map((e) => (
                <li key={`${e.customerId}-${e.seq}`}>
                  <span>
                    {ACTION_LABEL[e.action] ?? e.action}
                    {typeof e.data['toState'] === 'string' && e.data['toState'] in STATE_LABEL ? `: ${STATE_LABEL[e.data['toState'] as PaymentState]}` : ''}
                  </span>
                  <span className="activity-meta">
                    {e.customerId}, {when(e.occurredAt)}
                  </span>
                  <IdText value={e.resourceId} />
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </>
  );
}

function Kpi({ tone, label, count, note, emphasis = false }: { tone: 'good' | 'bad' | 'busy' | 'warn'; label: string; count: number; note: string; emphasis?: boolean }) {
  return (
    <div className={`kpi ${emphasis ? 'kpi-warn' : ''}`}>
      <p className="kpi-label">
        <ToneIcon tone={tone} />
        {label}
      </p>
      <p className="kpi-value">{count}</p>
      <p className="kpi-note">{note}</p>
    </div>
  );
}

function SystemBlock({ status }: { status: SystemStatus }) {
  const now = Date.now();
  const alive = status.workers.filter((w) => w.status === 'RUNNING' && now - Date.parse(w.lastBeatAt) < 15_000);
  return (
    <div className="system">
      <div>
        <p className="kpi-label">Worker</p>
        {alive.length > 0 ? (
          <Pill tone="good">{alive.length} ativo(s)</Pill>
        ) : (
          <Pill tone="warn">Nenhum worker ativo: os pagamentos ficam na fila até um worker iniciar</Pill>
        )}
      </div>
      <div>
        <p className="kpi-label">Fila de tarefas</p>
        <p className="system-figures">
          {status.jobs.PENDING} na fila, {status.jobs.RUNNING} em execução, {status.jobs.DONE} concluídas
          {status.jobs.FAILED > 0 ? `, ${status.jobs.FAILED} esgotadas (exigem ação manual)` : ''}
        </p>
      </div>
      <div>
        <p className="kpi-label">Eventos aguardando publicação</p>
        <p className="system-figures">{status.outboxPending}</p>
      </div>
    </div>
  );
}
