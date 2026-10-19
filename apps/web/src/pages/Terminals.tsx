import { useState } from 'react';
import { api, type Customer, type Merchant, type Terminal } from '../api.ts';
import {
  Button,
  ConfirmDialog,
  EmptyState,
  errorMessage,
  ErrorNotice,
  Field,
  HierarchyPath,
  Modal,
  PageHeader,
  Pill,
  SkeletonTable,
  useApi,
  useToast,
} from '../components/ui.tsx';

const CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const STATUS_LABEL = { ACTIVE: 'Operando', INACTIVE: 'Inativo', MAINTENANCE: 'Em manutenção' } as const;
const STATUS_TONE = { ACTIVE: 'good', INACTIVE: 'neutral', MAINTENANCE: 'warn' } as const;

export function TerminalsPage({ params }: { params: URLSearchParams }) {
  const [customerId, setCustomerId] = useState(params.get('customerId') ?? '');
  const [merchantId, setMerchantId] = useState(params.get('merchantId') ?? '');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Terminal | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Terminal | null>(null);
  const toast = useToast();
  const customers = useApi(() => api.get<Customer[]>('/customers', { limit: 200 }), []);
  const merchants = useApi(() => api.get<Merchant[]>('/merchants', { customerId, limit: 200 }), [customerId]);
  const list = useApi(() => api.get<Terminal[]>('/terminals', { customerId, merchantId, status, q, limit: 200 }), [customerId, merchantId, status, q]);
  const customerName = (id: string) => {
    const c = customers.data?.find((x) => x.id === id);
    return c ? (c.tradeName ?? c.legalName) : id;
  };
  const merchantName = (cid: string, mid: string) => merchants.data?.find((m) => m.customerId === cid && m.id === mid)?.name ?? mid;

  return (
    <>
      <PageHeader
        title="Terminais"
        description="Pontos de captura vinculados a um estabelecimento. Só terminais em operação, de estabelecimentos e clientes ativos, aceitam pagamentos."
        actions={
          <Button variant="primary" onClick={() => setEditing('new')} disabled={!customers.data?.some((c) => c.status === 'ACTIVE')}>
            Cadastrar terminal
          </Button>
        }
      />
      <div className="notice notice-info" role="note">
        <p>
          <strong>Todos os terminais desta versão são simulados.</strong> Não há suporte nem testes com pinpads ou maquininhas reais; os pagamentos passam pelo provedor SIMULATOR.
        </p>
      </div>
      <ul className="legend-list" aria-label="Estados operacionais">
        <li>
          <Pill tone="good">Operando</Pill> aceita pagamentos
        </li>
        <li>
          <Pill tone="warn">Em manutenção</Pill> recusa novos pagamentos temporariamente
        </li>
        <li>
          <Pill tone="neutral">Inativo</Pill> fora de uso; o histórico é mantido
        </li>
      </ul>
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
          <option value="">{customerId ? 'Todos os estabelecimentos' : 'Escolha um cliente para filtrar'}</option>
          {(merchants.data ?? []).map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Estado operacional">
          <option value="">Todos os estados</option>
          <option value="ACTIVE">Operando</option>
          <option value="MAINTENANCE">Em manutenção</option>
          <option value="INACTIVE">Inativo</option>
        </select>
        <input type="search" placeholder="Buscar por código ou identificação" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar terminais" />
      </div>

      {customers.error ? <ErrorNotice error={customers.error} onRetry={customers.reload} /> : null}
      {merchants.error ? <ErrorNotice error={merchants.error} onRetry={merchants.reload} /> : null}
      {list.error ? <ErrorNotice error={list.error} onRetry={list.reload} /> : null}
      {list.loading && !list.data ? <SkeletonTable columns={5} /> : null}
      {list.data?.length === 0 ? <EmptyState title="Nenhum terminal encontrado">Cadastre um terminal simulado para um estabelecimento ativo ou ajuste os filtros.</EmptyState> : null}
      {list.data && list.data.length > 0 ? (
        <div className="table-wrap">
          <table className="table" aria-label="Terminais">
            <thead>
              <tr>
                <th scope="col">Terminal</th>
                <th scope="col">Cliente › Estabelecimento</th>
                <th scope="col">Provedor</th>
                <th scope="col">Estado operacional</th>
                <th scope="col">
                  <span className="sr-only">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((t) => (
                <tr key={`${t.customerId}/${t.id}`} className={t.status === 'INACTIVE' ? 'row-inactive' : undefined}>
                  <td>
                    <strong>{t.label}</strong>
                    <span className="cell-sub code">{t.id}</span>
                  </td>
                  <td>
                    <HierarchyPath parts={[customerName(t.customerId), merchantName(t.customerId, t.merchantId)]} />
                  </td>
                  <td>
                    {t.providerId} <span className="tag">simulado</span>
                  </td>
                  <td>
                    <Pill tone={STATUS_TONE[t.status]}>{STATUS_LABEL[t.status]}</Pill>
                  </td>
                  <td className="row-actions">
                    <Button variant="ghost" size="sm" onClick={() => setEditing(t)}>
                      Editar
                    </Button>
                    <Button variant="ghost" size="sm" className="danger-text" onClick={() => setDeleting(t)}>
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
          message={
            <>
              <p>A exclusão é permanente e só é aceita para terminais sem pagamentos.</p>
              <p className="muted">Havendo histórico, a plataforma recusa a exclusão: mude o estado para Inativo.</p>
            </>
          }
          confirmLabel="Excluir terminal"
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
  const initialCustomer = terminal?.customerId ?? (customers.some((c) => c.id === defaultCustomerId) ? defaultCustomerId : (customers[0]?.id ?? ''));
  const [customerId, setCustomerId] = useState(initialCustomer);
  const merchants = useApi(
    () => (customerId ? api.get<Merchant[]>('/merchants', { customerId, status: 'ACTIVE', limit: 200 }) : Promise.resolve([])),
    [customerId],
  );
  const [merchantId, setMerchantId] = useState(terminal?.merchantId ?? defaultMerchantId);
  const [id, setId] = useState(terminal?.id ?? '');
  const [label, setLabel] = useState(terminal?.label ?? '');
  const [status, setStatus] = useState<Terminal['status']>(terminal?.status ?? 'ACTIVE');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const effectiveMerchant = merchants.data?.some((m) => m.id === merchantId) ? merchantId : (merchants.data?.[0]?.id ?? '');
  const noMerchants = !terminal && merchants.data !== null && merchants.data.length === 0;

  return (
    <Modal title={terminal ? `Editar terminal ${terminal.id}` : 'Cadastrar terminal simulado'} onClose={onClose}>
      <form
        className="form"
        noValidate
        onSubmit={(ev) => {
          ev.preventDefault();
          const e: Record<string, string> = {};
          if (!terminal && !effectiveMerchant) e['merchantId'] = 'Escolha um estabelecimento ativo deste cliente.';
          if (!terminal && !CODE.test(id.trim())) e['id'] = 'Use de 1 a 64 caracteres: letras, números, ponto, hífen, dois-pontos ou sublinhado.';
          if (!label.trim() || label.trim().length > 80) e['label'] = 'Informe a identificação do terminal (até 80 caracteres).';
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
            <div className="form-row">
              <Field label="Cliente" hint="Somente clientes ativos.">
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
              <Field
                label="Estabelecimento"
                hint="Somente estabelecimentos ativos deste cliente."
                error={errors['merchantId'] ?? (merchants.error ? errorMessage(merchants.error) : noMerchants ? 'Este cliente não tem estabelecimento ativo. Cadastre um antes.' : undefined)}
              >
                {(p) => (
                  <select {...p} value={effectiveMerchant} onChange={(e) => setMerchantId(e.target.value)} disabled={noMerchants}>
                    {(merchants.data ?? []).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            </div>
            <Field label="Código" hint="Único dentro do cliente; não pode ser alterado." error={errors['id']}>
              {(p) => <input {...p} value={id} onChange={(e) => setId(e.target.value)} autoComplete="off" />}
            </Field>
          </>
        ) : null}
        <Field label="Identificação" hint="Ex.: Caixa 01, Totem da entrada." error={errors['label']}>
          {(p) => <input {...p} value={label} onChange={(e) => setLabel(e.target.value)} />}
        </Field>
        {terminal ? (
          <Field label="Estado operacional" hint="Só terminais em operação aceitam pagamentos.">
            {(p) => (
              <select {...p} value={status} onChange={(e) => setStatus(e.target.value as Terminal['status'])}>
                <option value="ACTIVE">Operando</option>
                <option value="MAINTENANCE">Em manutenção</option>
                <option value="INACTIVE">Inativo</option>
              </select>
            )}
          </Field>
        ) : (
          <p className="field-hint">Provedor: SIMULATOR. Provedores reais só existirão com contrato e documentação oficial.</p>
        )}
        {errors['form'] ? (
          <p className="form-error" role="alert">
            {errors['form']}
          </p>
        ) : null}
        <div className="form-actions">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" busy={busy} disabled={noMerchants}>
            {busy ? 'Salvando' : terminal ? 'Salvar terminal' : 'Cadastrar terminal'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
