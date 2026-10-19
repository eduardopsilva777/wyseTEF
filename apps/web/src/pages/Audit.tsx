import { useState } from 'react';
import { api, type AuditEntry, type Customer } from '../api.ts';
import { Button, EmptyState, errorMessage, ErrorNotice, IdText, PageHeader, Pill, SkeletonTable, useApi } from '../components/ui.tsx';
import { ACTION_LABEL, clock, when } from '../format.ts';

type Verification =
  | { valid: true; records: number }
  | { valid: false; brokenAtSeq: number; reason: string; records: number };

const ACTOR_LABEL: Record<string, string> = { OPERATOR: 'Operador', SYSTEM: 'Sistema', API_CLIENT: 'Integração' };

export function AuditPage() {
  const [customerId, setCustomerId] = useState('');
  const [resourceType, setResourceType] = useState('');
  const [verification, setVerification] = useState<{ customerId: string; result: Verification; at: Date } | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const customers = useApi(() => api.get<Customer[]>('/customers', { limit: 200 }), []);
  const list = useApi(() => api.get<AuditEntry[]>('/audit', { customerId, resourceType, limit: 200 }), [customerId, resourceType]);

  return (
    <>
      <PageHeader
        title="Auditoria"
        description="Eventos encadeados por hash, por cliente. Contêm apenas campos permitidos: nenhum dado de cartão, credencial ou corpo de requisição."
      />

      <section className="panel" aria-labelledby="verify-title">
        <div className="panel-head">
          <h2 id="verify-title">Verificação da cadeia</h2>
          <p className="panel-note">Cada cliente tem sua própria cadeia</p>
        </div>
        <div className="toolbar">
          <select
            value={customerId}
            onChange={(e) => {
              setCustomerId(e.target.value);
              setVerification(null);
              setVerifyError(null);
            }}
            aria-label="Cliente"
          >
            <option value="">Todos os clientes (lista)</option>
            {(customers.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.tradeName ?? c.legalName}
              </option>
            ))}
          </select>
          <Button
            variant="primary"
            disabled={!customerId}
            busy={busy}
            onClick={() => {
              setBusy(true);
              setVerifyError(null);
              api
                .get<Verification>('/audit/verify', { customerId })
                .then((result) => setVerification({ customerId, result, at: new Date() }))
                .catch((e: unknown) => setVerifyError(errorMessage(e)))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? 'Verificando' : 'Verificar cadeia do cliente'}
          </Button>
          {!customerId ? <span className="toolbar-meta">Escolha um cliente para verificar</span> : null}
        </div>
        {verification ? (
          verification.result.valid ? (
            <div className="notice notice-good verify-result" role="status">
              <p>
                <Pill tone="good">Cadeia íntegra</Pill> {verification.result.records} eventos de {verification.customerId} conferidos às {clock(verification.at)}.
              </p>
              <p className="notice-meta">
                A verificação detecta alteração, remoção ou reordenação de eventos. Ela não torna a trilha imutável: alguém com privilégio total no banco
                poderia reescrevê-la por inteiro, por isso o acesso ao banco precisa ser restrito.
              </p>
            </div>
          ) : (
            <div className="notice notice-error verify-result" role="alert">
              <p>
                <Pill tone="bad">Cadeia quebrada</Pill> no evento {verification.result.brokenAtSeq}: {verification.result.reason}.
              </p>
              <p className="notice-meta">Trate como possível adulteração: preserve o banco e investigue antes de qualquer correção.</p>
            </div>
          )
        ) : null}
        {verifyError ? (
          <p className="form-error" role="alert">
            {verifyError}
          </p>
        ) : null}
      </section>

      <div className="toolbar">
        <select value={resourceType} onChange={(e) => setResourceType(e.target.value)} aria-label="Tipo de registro">
          <option value="">Todos os tipos de registro</option>
          <option value="payment">Pagamentos</option>
          <option value="operation">Operações</option>
          <option value="customer">Clientes</option>
          <option value="merchant">Estabelecimentos</option>
          <option value="terminal">Terminais</option>
        </select>
        {list.data ? <span className="toolbar-meta">{list.data.length} evento(s), do mais recente ao mais antigo</span> : null}
      </div>

      {customers.error ? <ErrorNotice error={customers.error} onRetry={customers.reload} /> : null}
      {list.error ? <ErrorNotice error={list.error} onRetry={list.reload} /> : null}
      {list.loading && !list.data ? <SkeletonTable columns={6} rows={6} /> : null}
      {list.data?.length === 0 ? <EmptyState title="Nenhum evento encontrado">Ajuste o cliente ou o tipo de registro.</EmptyState> : null}
      {list.data && list.data.length > 0 ? (
        <div className="table-wrap">
          <table className="table" aria-label="Eventos de auditoria">
            <thead>
              <tr>
                <th scope="col">Quando</th>
                <th scope="col">Evento</th>
                <th scope="col">Registro</th>
                <th scope="col">Autor</th>
                <th scope="col">Correlação</th>
                <th scope="col">Dados</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((e) => (
                <tr key={`${e.customerId}-${e.seq}`}>
                  <td>
                    {when(e.occurredAt)}
                    <span className="cell-sub">
                      {e.customerId}, evento nº {e.seq}
                    </span>
                  </td>
                  <td>{ACTION_LABEL[e.action] ?? e.action}</td>
                  <td>
                    <IdText value={e.resourceId} />
                  </td>
                  <td>
                    {ACTOR_LABEL[e.actorType] ?? e.actorType}
                    <span className="cell-sub code">{e.actorId}</span>
                  </td>
                  <td>{e.correlationId ? <IdText value={e.correlationId} head={10} /> : <span className="muted">—</span>}</td>
                  <td className="audit-cell">
                    <div className="audit-data">
                      {Object.entries(e.data)
                        .filter(([, v]) => v !== null)
                        .map(([k, v]) => (
                          <span key={k}>
                            {k}: <span className="code">{String(v)}</span>
                          </span>
                        ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}
