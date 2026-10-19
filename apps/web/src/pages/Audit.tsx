import { useState } from 'react';
import { api, type AuditEntry, type Customer } from '../api.ts';
import { Button, EmptyState, errorMessage, ErrorNotice, Loading, PageHeader, Pill, useApi } from '../components/ui.tsx';
import { ACTION_LABEL, when } from '../format.ts';

type Verification = { valid: true; records: number } | { valid: false; brokenAtSeq: number; reason: string; records: number };

export function AuditPage() {
  const [customerId, setCustomerId] = useState('');
  const [resourceType, setResourceType] = useState('');
  const [verification, setVerification] = useState<Verification | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const customers = useApi(() => api.get<Customer[]>('/customers', { limit: 200 }), []);
  const list = useApi(() => api.get<AuditEntry[]>('/audit', { customerId, resourceType, limit: 200 }), [customerId, resourceType]);

  return (
    <>
      <PageHeader
        title="Auditoria"
        description="Eventos encadeados por hash, por cliente. Contém apenas campos permitidos: nenhum dado de cartão, credencial ou corpo de requisição."
      />
      <div className="toolbar">
        <select
          value={customerId}
          onChange={(e) => {
            setCustomerId(e.target.value);
            setVerification(null);
          }}
          aria-label="Cliente"
        >
          <option value="">Todos os clientes</option>
          {(customers.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.tradeName ?? c.legalName}
            </option>
          ))}
        </select>
        <select value={resourceType} onChange={(e) => setResourceType(e.target.value)} aria-label="Tipo de registro">
          <option value="">Todos os tipos</option>
          <option value="payment">Pagamentos</option>
          <option value="operation">Operações</option>
          <option value="customer">Clientes</option>
          <option value="merchant">Estabelecimentos</option>
          <option value="terminal">Terminais</option>
        </select>
        <Button
          disabled={!customerId}
          busy={busy}
          title={customerId ? undefined : 'Escolha um cliente: cada cliente tem sua própria cadeia'}
          onClick={() => {
            setBusy(true);
            setVerifyError(null);
            api
              .get<Verification>('/audit/verify', { customerId })
              .then(setVerification)
              .catch((e: unknown) => setVerifyError(errorMessage(e)))
              .finally(() => setBusy(false));
          }}
        >
          Verificar cadeia do cliente
        </Button>
      </div>

      {verification ? (
        verification.valid ? (
          <div className="notice notice-good">
            <Pill tone="good">Cadeia íntegra</Pill> {verification.records} eventos conferidos. A verificação detecta alterações, remoções e reordenações; ela não
            impede que alguém com privilégio total no banco reescreva tudo.
          </div>
        ) : (
          <div className="notice notice-error" role="alert">
            <Pill tone="bad">Cadeia quebrada</Pill> no evento {verification.brokenAtSeq}: {verification.reason}.
          </div>
        )
      ) : null}
      {verifyError ? <p className="field-error">{verifyError}</p> : null}

      {customers.error ? <ErrorNotice error={customers.error} onRetry={customers.reload} /> : null}
      {list.error ? <ErrorNotice error={list.error} onRetry={list.reload} /> : null}
      {list.loading && !list.data ? <Loading /> : null}
      {list.data?.length === 0 ? <EmptyState title="Nenhum evento encontrado" /> : null}
      {list.data && list.data.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Quando</th>
                <th scope="col">Evento</th>
                <th scope="col">Registro</th>
                <th scope="col">Autor</th>
                <th scope="col">Dados</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((e) => (
                <tr key={`${e.customerId}-${e.seq}`}>
                  <td>
                    {when(e.occurredAt)}
                    <span className="cell-sub">
                      {e.customerId}, evento {e.seq}
                    </span>
                  </td>
                  <td>{ACTION_LABEL[e.action] ?? e.action}</td>
                  <td className="code">{e.resourceId}</td>
                  <td>
                    {e.actorType === 'OPERATOR' ? 'Operador' : e.actorType === 'SYSTEM' ? 'Sistema' : 'Integração'}
                    <span className="cell-sub code">{e.actorId}</span>
                  </td>
                  <td className="audit-data">
                    {Object.entries(e.data)
                      .filter(([, v]) => v !== null)
                      .map(([k, v]) => (
                        <span key={k} className="kv">
                          {k}: <span className="code">{String(v)}</span>
                        </span>
                      ))}
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
