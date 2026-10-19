import { useState } from 'react';
import { api, type Customer, type Merchant, type Terminal } from '../api.ts';
import { Button, ConfirmDialog, EmptyState, errorMessage, ErrorNotice, Field, Loading, Modal, PageHeader, Pill, useApi, useToast } from '../components/ui.tsx';

const CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const STATUS_LABEL = { ACTIVE: 'Operando', INACTIVE: 'Inativo', MAINTENANCE: 'Em manutenção' } as const;

export function TerminalsPage({ params }: { params: URLSearchParams }) {
  const [customerId, setCustomerId] = useState(params.get('customerId') ?? '');
  const [merchantId, setMerchantId] = useState(params.get('merchantId') ?? '');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Terminal | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Terminal | null>(null);
  const toast = useToast();
  const customers = useApi(() => api.get<Customer[]>('/customers', { limit: 200 }), []);
  const merchants = useApi(() => api.get<Merchant[]>('/merchants', { customerId, limit: 200 }), [customerId]);
  const list = useApi(() => api.get<Terminal[]>('/terminals', { customerId, merchantId, q, limit: 200 }), [customerId, merchantId, q]);

  return (
    <>
      <PageHeader
        title="Terminais"
        description="Nesta versão local todo terminal é simulado: nenhum hardware real é suportado nem testado."
        actions={
          <Button variant="primary" onClick={() => setEditing('new')} disabled={!merchants.data?.length}>
            Cadastrar terminal
          </Button>
        }
      />
      <div className="toolbar">
        <select
          value={customerId}
          onChange={(e) => {
            setCustomerId(e.target.value);
            setMerchantId('');
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
        <select value={merchantId} onChange={(e) => setMerchantId(e.target.value)} aria-label="Estabelecimento" disabled={!customerId}>
          <option value="">Todos os estabelecimentos</option>
          {(merchants.data ?? []).map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <input type="search" placeholder="Buscar por código ou identificação" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar terminais" />
      </div>

      {customers.error ? <ErrorNotice error={customers.error} onRetry={customers.reload} /> : null}
      {merchants.error ? <ErrorNotice error={merchants.error} onRetry={merchants.reload} /> : null}
      {list.error ? <ErrorNotice error={list.error} onRetry={list.reload} /> : null}
      {list.loading && !list.data ? <Loading /> : null}
      {list.data?.length === 0 ? <EmptyState title="Nenhum terminal encontrado">Cadastre um terminal simulado para um estabelecimento ativo.</EmptyState> : null}
      {list.data && list.data.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Terminal</th>
                <th scope="col">Estabelecimento</th>
                <th scope="col">Cliente</th>
                <th scope="col">Provedor</th>
                <th scope="col">Estado operacional</th>
                <th scope="col">
                  <span className="sr-only">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((t) => (
                <tr key={`${t.customerId}/${t.id}`}>
                  <td>
                    <strong>{t.label}</strong>
                    <span className="cell-sub code">{t.id}</span>
                  </td>
                  <td className="code">{t.merchantId}</td>
                  <td className="code">{t.customerId}</td>
                  <td>
                    {t.providerId} <span className="tag">simulado</span>
                  </td>
                  <td>
                    <Pill tone={t.status === 'ACTIVE' ? 'good' : t.status === 'MAINTENANCE' ? 'warn' : 'neutral'}>{STATUS_LABEL[t.status]}</Pill>
                  </td>
                  <td className="row-actions">
                    <Button variant="ghost" onClick={() => setEditing(t)}>
                      Editar
                    </Button>
                    <Button variant="ghost" className="danger-text" onClick={() => setDeleting(t)}>
                      Excluir
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {editing ? (
        <TerminalForm
          terminal={editing === 'new' ? null : editing}
          customers={(customers.data ?? []).filter((c) => c.status === 'ACTIVE')}
          defaultCustomerId={customerId}
          defaultMerchantId={merchantId}
          onClose={() => setEditing(null)}
          onSaved={(t) => {
            toast('good', editing === 'new' ? `Terminal ${t.id} cadastrado` : `Terminal ${t.id} salvo`);
            setEditing(null);
            list.reload();
          }}
        />
      ) : null}

      {deleting ? (
        <ConfirmDialog
          title="Excluir terminal"
          message="A exclusão só é aceita para terminais sem pagamentos. Havendo histórico, mude o estado para Inativo."
          confirmLabel="Excluir"
          danger
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api.del(`/customers/${deleting.customerId}/terminals/${deleting.id}`);
            toast('good', 'Terminal excluído');
            list.reload();
          }}
        />
      ) : null}
    </>
  );
}

function TerminalForm({
  terminal,
  customers,
  defaultCustomerId,
  defaultMerchantId,
  onClose,
  onSaved,
}: {
  terminal: Terminal | null;
  customers: Customer[];
  defaultCustomerId: string;
  defaultMerchantId: string;
  onClose: () => void;
  onSaved: (t: Terminal) => void;
}) {
  const [customerId, setCustomerId] = useState(terminal?.customerId ?? (defaultCustomerId || customers[0]?.id || ''));
  const merchants = useApi(() => (customerId ? api.get<Merchant[]>('/merchants', { customerId, status: 'ACTIVE', limit: 200 }) : Promise.resolve([])), [customerId]);
  const [merchantId, setMerchantId] = useState(terminal?.merchantId ?? defaultMerchantId);
  const [id, setId] = useState(terminal?.id ?? '');
  const [label, setLabel] = useState(terminal?.label ?? '');
  const [status, setStatus] = useState<Terminal['status']>(terminal?.status ?? 'ACTIVE');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const effectiveMerchant = merchantId || merchants.data?.[0]?.id || '';

  return (
    <Modal title={terminal ? `Editar ${terminal.id}` : 'Cadastrar terminal simulado'} onClose={onClose}>
      <form
        className="form"
        onSubmit={(ev) => {
          ev.preventDefault();
          const e: Record<string, string> = {};
          if (!terminal && !effectiveMerchant) e['merchantId'] = 'Escolha um estabelecimento ativo.';
          if (!terminal && !CODE.test(id)) e['id'] = 'Use letras, números, ponto, hífen, dois-pontos ou sublinhado (até 64).';
          if (!label.trim()) e['label'] = 'Informe a identificação do terminal.';
          setErrors(e);
          if (Object.keys(e).length) return;
          setBusy(true);
          (terminal
            ? api.patch<Terminal>(`/customers/${terminal.customerId}/terminals/${terminal.id}`, { label: label.trim(), status })
            : api.post<Terminal>(`/customers/${customerId}/terminals`, { id: id.trim(), merchantId: effectiveMerchant, label: label.trim(), providerId: 'SIMULATOR' })
          )
            .then(onSaved)
            .catch((err: unknown) => setErrors({ form: errorMessage(err) }))
            .finally(() => setBusy(false));
        }}
      >
        {!terminal ? (
          <>
            <Field label="Cliente">
              {(p) => (
                <select
                  {...p}
                  value={customerId}
                  onChange={(e) => {
                    setCustomerId(e.target.value);
                    setMerchantId('');
                  }}
                >
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.tradeName ?? c.legalName}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Estabelecimento" error={errors['merchantId'] ?? (merchants.error ? errorMessage(merchants.error) : undefined)}>
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
            <Field label="Código" hint="Único dentro do cliente; não pode ser alterado." error={errors['id']}>
              {(p) => <input {...p} value={id} onChange={(e) => setId(e.target.value)} />}
            </Field>
            <p className="field-hint">Provedor: SIMULATOR. Outros provedores só existirão com contrato e documentação oficial.</p>
          </>
        ) : null}
        <Field label="Identificação" hint="Ex.: Caixa 01, Totem da entrada." error={errors['label']}>
          {(p) => <input {...p} value={label} onChange={(e) => setLabel(e.target.value)} />}
        </Field>
        {terminal ? (
          <Field label="Estado operacional">
            {(p) => (
              <select {...p} value={status} onChange={(e) => setStatus(e.target.value as Terminal['status'])}>
                <option value="ACTIVE">Operando</option>
                <option value="MAINTENANCE">Em manutenção</option>
                <option value="INACTIVE">Inativo</option>
              </select>
            )}
          </Field>
        ) : null}
        {errors['form'] ? <p className="field-error">{errors['form']}</p> : null}
        <div className="form-actions">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" busy={busy}>
            {terminal ? 'Salvar terminal' : 'Cadastrar terminal'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
