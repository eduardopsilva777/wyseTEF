import { useState } from 'react';
import { navigate } from '../App.tsx';
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
  Segmented,
  SkeletonTable,
  useApi,
  useToast,
} from '../components/ui.tsx';

const CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
type StatusFilter = '' | 'ACTIVE' | 'INACTIVE';
const STATUS_OPTIONS: readonly { value: StatusFilter; label: string }[] = [
  { value: '', label: 'Todos' },
  { value: 'ACTIVE', label: 'Ativos' },
  { value: 'INACTIVE', label: 'Inativos' },
];

export function MerchantsPage({ params }: { params: URLSearchParams }) {
  const [customerId, setCustomerId] = useState(params.get('customerId') ?? '');
  const [status, setStatus] = useState<StatusFilter>('');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Merchant | 'new' | null>(null);
  const [confirm, setConfirm] = useState<{ merchant: Merchant; action: 'toggle' | 'delete' } | null>(null);
  const toast = useToast();
  const customers = useApi(() => api.get<Customer[]>('/customers', { limit: 200 }), []);
  const list = useApi(() => api.get<Merchant[]>('/merchants', { customerId, status, q, limit: 200 }), [customerId, status, q]);
  const terminals = useApi(() => api.get<Terminal[]>('/terminals', { customerId, limit: 200 }), [customerId]);
  const customerName = (id: string) => {
    const c = customers.data?.find((x) => x.id === id);
    return c ? (c.tradeName ?? c.legalName) : id;
  };
  const terminalCount = (m: Merchant) => terminals.data?.filter((t) => t.customerId === m.customerId && t.merchantId === m.id).length;
  const activeCustomers = (customers.data ?? []).filter((c) => c.status === 'ACTIVE');

  return (
    <>
      <PageHeader
        title="Estabelecimentos"
        description="Lojas ou pontos de venda de cada cliente. O código é único dentro do cliente; estabelecimentos inativos não aceitam novos pagamentos nem novos terminais."
        actions={
          <Button variant="primary" onClick={() => setEditing('new')} disabled={activeCustomers.length === 0}>
            Cadastrar estabelecimento
          </Button>
        }
      />
      <div className="toolbar">
        <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} aria-label="Cliente">
          <option value="">Todos os clientes</option>
          {(customers.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.tradeName ?? c.legalName}
            </option>
          ))}
        </select>
        <Segmented label="Situação" value={status} options={STATUS_OPTIONS} onChange={setStatus} />
        <input type="search" placeholder="Buscar por código, nome ou cidade" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar estabelecimentos" />
        {list.data ? <span className="toolbar-meta">{list.data.length} estabelecimento(s)</span> : null}
      </div>

      {customers.error ? <ErrorNotice error={customers.error} onRetry={customers.reload} /> : null}
      {terminals.error ? <ErrorNotice error={terminals.error} onRetry={terminals.reload} /> : null}
      {list.error ? <ErrorNotice error={list.error} onRetry={list.reload} /> : null}
      {list.loading && !list.data ? <SkeletonTable columns={5} /> : null}
      {list.data?.length === 0 ? (
        <EmptyState title="Nenhum estabelecimento encontrado">
          {activeCustomers.length ? 'Cadastre um estabelecimento para um cliente ativo ou ajuste os filtros.' : 'Cadastre um cliente ativo primeiro.'}
        </EmptyState>
      ) : null}
      {list.data && list.data.length > 0 ? (
        <div className="table-wrap">
          <table className="table" aria-label="Estabelecimentos">
            <thead>
              <tr>
                <th scope="col">Estabelecimento</th>
                <th scope="col">Cidade</th>
                <th scope="col" className="num">
                  Terminais
                </th>
                <th scope="col">Situação</th>
                <th scope="col">
                  <span className="sr-only">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((m) => (
                <tr key={`${m.customerId}/${m.id}`} className={m.status === 'INACTIVE' ? 'row-inactive' : undefined}>
                  <td>
                    <strong>{m.name}</strong>
                    <span className="cell-sub">
                      <HierarchyPath parts={[customerName(m.customerId), m.id]} />
                    </span>
                  </td>
                  <td>{m.city ?? '—'}</td>
                  <td className="num">{terminalCount(m) ?? '—'}</td>
                  <td>{m.status === 'ACTIVE' ? <Pill tone="good">Ativo</Pill> : <Pill tone="neutral">Inativo</Pill>}</td>
                  <td className="row-actions">
                    <Button variant="ghost" size="sm" onClick={() => navigate('terminais', { customerId: m.customerId, merchantId: m.id })}>
                      Terminais
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setEditing(m)}>
                      Editar
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setConfirm({ merchant: m, action: 'toggle' })}>
                      {m.status === 'ACTIVE' ? 'Desativar' : 'Reativar'}
                    </Button>
                    <Button variant="ghost" size="sm" className="danger-text" onClick={() => setConfirm({ merchant: m, action: 'delete' })}>
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
        <MerchantForm
          merchant={editing === 'new' ? null : editing}
          customers={activeCustomers}
          defaultCustomerId={customerId}
          onClose={() => setEditing(null)}
          onSaved={(m) => {
            toast('good', editing === 'new' ? `Estabelecimento ${m.id} cadastrado` : `Estabelecimento ${m.id} salvo`);
            setEditing(null);
            list.reload();
          }}
        />
      ) : null}

      {confirm?.action === 'toggle' ? (
        <ConfirmDialog
          title={confirm.merchant.status === 'ACTIVE' ? 'Desativar estabelecimento' : 'Reativar estabelecimento'}
          message={
            confirm.merchant.status === 'ACTIVE'
              ? `${confirm.merchant.name} deixa de aceitar novos pagamentos e novos terminais. Pagamentos existentes continuam consultáveis.`
              : `${confirm.merchant.name} volta a aceitar novos pagamentos.`
          }
          confirmLabel={confirm.merchant.status === 'ACTIVE' ? 'Desativar estabelecimento' : 'Reativar estabelecimento'}
          danger={confirm.merchant.status === 'ACTIVE'}
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            await api.patch(`/customers/${confirm.merchant.customerId}/merchants/${confirm.merchant.id}`, {
              status: confirm.merchant.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
            });
            toast('good', confirm.merchant.status === 'ACTIVE' ? 'Estabelecimento desativado' : 'Estabelecimento reativado');
            list.reload();
          }}
        />
      ) : null}

      {confirm?.action === 'delete' ? (
        <ConfirmDialog
          title="Excluir estabelecimento"
          message={
            <>
              <p>A exclusão é permanente e só é aceita para estabelecimentos sem terminais e sem pagamentos.</p>
              <p className="muted">Havendo histórico, a plataforma recusa a exclusão: desative o estabelecimento.</p>
            </>
          }
          confirmLabel="Excluir estabelecimento"
          danger
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            await api.del(`/customers/${confirm.merchant.customerId}/merchants/${confirm.merchant.id}`);
            toast('good', 'Estabelecimento excluído');
            list.reload();
          }}
        />
      ) : null}
    </>
  );
}

function MerchantForm({
  merchant,
  customers,
  defaultCustomerId,
  onClose,
  onSaved,
}: {
  merchant: Merchant | null;
  customers: Customer[];
  defaultCustomerId: string;
  onClose: () => void;
  onSaved: (m: Merchant) => void;
}) {
  const initialCustomer = merchant?.customerId ?? (customers.some((c) => c.id === defaultCustomerId) ? defaultCustomerId : (customers[0]?.id ?? ''));
  const [customerId, setCustomerId] = useState(initialCustomer);
  const [id, setId] = useState(merchant?.id ?? '');
  const [name, setName] = useState(merchant?.name ?? '');
  const [city, setCity] = useState(merchant?.city ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  return (
    <Modal title={merchant ? `Editar estabelecimento ${merchant.id}` : 'Cadastrar estabelecimento'} onClose={onClose}>
      <form
        className="form"
        noValidate
        onSubmit={(ev) => {
          ev.preventDefault();
          const e: Record<string, string> = {};
          if (!merchant && !customerId) e['customerId'] = 'Escolha um cliente ativo.';
          if (!merchant && !CODE.test(id.trim())) e['id'] = 'Use de 1 a 64 caracteres: letras, números, ponto, hífen, dois-pontos ou sublinhado.';
          if (name.trim().length < 2 || name.trim().length > 120) e['name'] = 'Informe o nome (entre 2 e 120 caracteres).';
          if (city.trim().length > 80) e['city'] = 'Use no máximo 80 caracteres.';
          setErrors(e);
          if (Object.keys(e).length) return;
          setBusy(true);
          const body = { name: name.trim(), city: city.trim() || null };
          (merchant
            ? api.patch<Merchant>(`/customers/${merchant.customerId}/merchants/${merchant.id}`, body)
            : api.post<Merchant>(`/customers/${customerId}/merchants`, { id: id.trim(), ...body })
          )
            .then(onSaved)
            .catch((err: unknown) => setErrors({ form: errorMessage(err) }))
            .finally(() => setBusy(false));
        }}
      >
        {!merchant ? (
          <div className="form-row">
            <Field label="Cliente" hint="Somente clientes ativos." error={errors['customerId']}>
              {(p) => (
                <select {...p} value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.tradeName ?? c.legalName}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Código" hint="Único dentro do cliente; não pode ser alterado." error={errors['id']}>
              {(p) => <input {...p} value={id} onChange={(e) => setId(e.target.value)} autoComplete="off" />}
            </Field>
          </div>
        ) : null}
        <Field label="Nome" error={errors['name']}>
          {(p) => <input {...p} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="Cidade" optional error={errors['city']}>
          {(p) => <input {...p} value={city} onChange={(e) => setCity(e.target.value)} />}
        </Field>
        {errors['form'] ? (
          <p className="form-error" role="alert">
            {errors['form']}
          </p>
        ) : null}
        <div className="form-actions">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" busy={busy}>
            {busy ? 'Salvando' : merchant ? 'Salvar estabelecimento' : 'Cadastrar estabelecimento'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
