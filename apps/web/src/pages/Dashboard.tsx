import { useState } from 'react';
import { navigate } from '../App.tsx';
import { api, type Customer, type Dashboard, type PaymentState, type SystemStatus } from '../api.ts';
import { DailyChart } from '../components/DailyChart.tsx';
import { EmptyState, ErrorNotice, Loading, PageHeader, Pill, useApi } from '../components/ui.tsx';
import { ACTION_LABEL, money, STATE_LABEL, when } from '../format.ts';

const PERIODS = [
  { id: '7', label: 'Últimos 7 dias', days: 7 },
  { id: '14', label: 'Últimos 14 dias', days: 14 },
  { id: '30', label: 'Últimos 30 dias', days: 30 },
  { id: 'all', label: 'Todo o período', days: null },
] as const;

export function DashboardPage() {
  const [period, setPeriod] = useState<(typeof PERIODS)[number]['id']>('14');
  const [customerId, setCustomerId] = useState('');
  const customers = useApi(() => api.get<Customer[]>('/customers', { limit: 200 }), []);
  const days = PERIODS.find((p) => p.id === period)?.days ?? null;
  const dash = useApi(
    () =>
      api.get<Dashboard>('/dashboard', {
        ...(days ? { from: new Date(Date.now() - days * 86_400_000).toISOString() } : {}),
        customerId,
      }),
    [period, customerId],
    { pollMs: 5_000 },
  );
  const system = useApi(() => api.get<SystemStatus>('/system'), [], { pollMs: 5_000 });

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Números calculados a partir dos pagamentos gravados no PostgreSQL local. Atualiza a cada 5 segundos."
        actions={
          <div className="filters">
            <label className="inline-field">
              <span>Período</span>
              <select value={period} onChange={(e) => setPeriod(e.target.value as typeof period)}>
                {PERIODS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="inline-field">
              <span>Cliente</span>
              <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                <option value="">Todos os clientes</option>
                {(customers.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.tradeName ?? c.legalName}
                  </option>
                ))}
              </select>
            </label>
          </div>
        }
      />

      {customers.error ? <ErrorNotice error={customers.error} onRetry={customers.reload} /> : null}
      {dash.error ? <ErrorNotice error={dash.error} onRetry={dash.reload} /> : null}
      {!dash.data && dash.loading ? <Loading /> : null}

      {dash.data ? <DashboardBody data={dash.data} /> : null}

      <section className="panel">
        <div className="panel-head">
          <h2>Processamento</h2>
        </div>
        {system.data ? <SystemBlock status={system.data} /> : system.error ? <ErrorNotice error={system.error} /> : <Loading />}
      </section>
    </>
  );
}

function DashboardBody({ data }: { data: Dashboard }) {
  const t = data.totals;
  const rate = t.approvalRate === null ? '—' : `${(t.approvalRate * 100).toFixed(1).replace('.', ',')}%`;
  return (
    <>
      {data.unknownOperations > 0 ? (
        <button type="button" className="attention" onClick={() => navigate('transacoes', { state: 'UNKNOWN' })}>
          <Pill tone="warn">{data.unknownOperations} operação(ões) sem resultado definitivo</Pill>
          <span>
            Nada foi cobrado de novo. O worker consulta o provedor até haver evidência; abra as transações para acompanhar ou pedir a reconciliação agora.
          </span>
        </button>
      ) : null}

      <section className="kpis" aria-label="Indicadores">
        <div className="kpi kpi-lead">
          <p className="kpi-label">Saldo aprovado líquido</p>
          <p className="kpi-value">{money(data.amounts.netApprovedCents)}</p>
          <p className="kpi-note">
            {money(data.amounts.approvedCents)} aprovados, {money(data.amounts.reversedCents)} revertidos
          </p>
        </div>
        <div className="kpi">
          <p className="kpi-label">Pagamentos</p>
          <p className="kpi-value">{t.payments}</p>
          <p className="kpi-note">{t.pendingCount} em processamento</p>
        </div>
        <div className="kpi">
          <p className="kpi-label">Taxa de aprovação</p>
          <p className="kpi-value">{rate}</p>
          <p className="kpi-note">
            {t.approvedCount + t.reversedCount} aprovados de {t.approvedCount + t.reversedCount + t.declinedCount} com resposta definitiva
          </p>
        </div>
        <div className="kpi">
          <p className="kpi-label">Recusas</p>
          <p className="kpi-value">{t.declinedCount}</p>
          <p className="kpi-note">{money(data.amounts.declinedCents)} em tentativas recusadas</p>
        </div>
        <div className="kpi">
          <p className="kpi-label">Exigem reconciliação</p>
          <p className="kpi-value">{data.unknownOperations}</p>
          <p className="kpi-note">{money(data.amounts.unknownCents)} com resultado desconhecido</p>
        </div>
      </section>

      <div className="grid-2">
        <section className="panel">
          <div className="panel-head">
            <h2>Pagamentos por dia</h2>
          </div>
          {t.payments === 0 && data.daily.every((d) => d.approved + d.declined + d.other === 0) ? (
            <EmptyState title="Nenhum pagamento no período">Use o simulador para criar o primeiro pagamento fictício.</EmptyState>
          ) : (
            <DailyChart data={data.daily} />
          )}
        </section>
        <section className="panel">
          <div className="panel-head">
            <h2>Atividade recente</h2>
            <a href="#/auditoria" className="link">
              Ver auditoria
            </a>
          </div>
          {data.recentActivity.length === 0 ? (
            <EmptyState title="Sem atividade registrada" />
          ) : (
            <ol className="activity">
              {data.recentActivity.map((e) => (
                <li key={`${e.customerId}-${e.seq}`}>
                  <span className="activity-action">
                    {ACTION_LABEL[e.action] ?? e.action}
                    {typeof e.data['toState'] === 'string' && e.data['toState'] in STATE_LABEL ? `: ${STATE_LABEL[e.data['toState'] as PaymentState]}` : ''}
                  </span>
                  <span className="activity-meta">
                    {e.customerId}, {when(e.occurredAt)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </>
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
          <Pill tone="warn">Nenhum worker ativo: pagamentos ficam na fila até um worker iniciar</Pill>
        )}
      </div>
      <div>
        <p className="kpi-label">Fila de tarefas</p>
        <p className="system-figures">
          {status.jobs.PENDING} na fila, {status.jobs.RUNNING} em execução, {status.jobs.DONE} concluídas
          {status.jobs.FAILED > 0 ? `, ${status.jobs.FAILED} esgotadas` : ''}
        </p>
      </div>
      <div>
        <p className="kpi-label">Eventos aguardando publicação</p>
        <p className="system-figures">{status.outboxPending}</p>
      </div>
    </div>
  );
}
