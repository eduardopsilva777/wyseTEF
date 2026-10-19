import { useState } from 'react';
import { navigate } from '../App.tsx';
import { api, type Customer } from '../api.ts';
import {
  Button,
  ConfirmDialog,
  EmptyState,
  errorMessage,
  ErrorNotice,
  Field,
  IdText,
  Modal,
  PageHeader,
  Pill,
  Segmented,
  SkeletonTable,
  useApi,
  useToast,
} from '../components/ui.tsx';
import { when } from '../format.ts';

const CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
type StatusFilter = '' | 'ACTIVE' | 'INACTIVE';
const STATUS_OPTIONS: readonly { value: StatusFilter; label: string }[] = [
  { value: '', label: 'Todos' },
  { value: 'ACTIVE', label: 'Ativos' },
  { value: 'INACTIVE', label: 'Inativos' },
];

export function CustomersPage() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('');
  const [editing, setEditing] = useState<Customer | 'new' | null>(null);
  const [confirm, setConfirm] = useState<{ customer: Customer; action: 'toggle' | 'delete' } | null>(null);
  const toast = useToast();
  const list = useApi(() => api.get<Customer[]>('/customers', { q, status, limit: 200 }), [q, status]);

  return (
    <>
      <PageHeader
        title="Clientes"
        description="Clientes empresariais da plataforma. Cada cliente tem seus estabelecimentos, terminais e pagamentos isolados."
        actions={
          <Button variant="primary" onClick={() => setEditing('new')}>
            Cadastrar cliente
          </Button>
        }
      />
      <div className="toolbar">
        <Segmented label="Situação" value={status} options={STATUS_OPTIONS} onChange={setStatus} />
        <input type="search" placeholder="Buscar por código, razão social ou nome fantasia" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar clientes" />
        {list.data ? <span className="toolbar-meta">{list.data.length} cliente(s)</span> : null}
      </div>

      {list.error ? <ErrorNotice error={list.error} onRetry={list.reload} /> : null}
      {list.loading && !list.data ? <SkeletonTable columns={5} /> : null}
      {list.data && list.data.length === 0 ? (
        <EmptyState
          title={q || status ? 'Nenhum cliente encontrado' : 'Nenhum cliente cadastrado'}
          action={
            q || status ? null : (
              <Button variant="primary" onClick={() => setEditing('new')}>
                Cadastrar cliente
              </Button>
            )
          }
        >
          {q || status ? 'Ajuste a busca ou o filtro de situação.' : 'Cadastre um cliente fictício ou rode npm run db:seed para criar dados de demonstração.'}
        </EmptyState>
      ) : null}
      {list.data && list.data.length > 0 ? (
        <div className="table-wrap">
          <table className="table" aria-label="Clientes">
            <thead>
              <tr>
                <th scope="col">Cliente</th>
                <th scope="col">Código</th>
                <th scope="col">Situação</th>
                <th scope="col">Atualizado</th>
                <th scope="col">
                  <span className="sr-only">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((c) => (
                <tr key={c.id} className={c.status === 'INACTIVE' ? 'row-inactive' : undefined}>
                  <td>
                    <strong>{c.tradeName ?? c.legalName}</strong>
                    {c.tradeName ? <span className="cell-sub">{c.legalName}</span> : null}
                  </td>
                  <td>
                    <IdText value={c.id} head={24} />
                  </td>
                  <td>{c.status === 'ACTIVE' ? <Pill tone="good">Ativo</Pill> : <Pill tone="neutral">Inativo: não aceita pagamentos</Pill>}</td>
                  <td>{when(c.updatedAt)}</td>
                  <td className="row-actions">
                    <Button variant="ghost" size="sm" onClick={() => navigate('estabelecimentos', { customerId: c.id })}>
                      Estabelecimentos
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setEditing(c)}>
                      Editar
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setConfirm({ customer: c, action: 'toggle' })}>
                      {c.status === 'ACTIVE' ? 'Desativar' : 'Reativar'}
                    </Button>
                    <Button variant="ghost" size="sm" className="danger-text" onClick={() => setConfirm({ customer: c, action: 'delete' })}>
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
        <CustomerForm
          customer={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(c) => {
            toast('good', editing === 'new' ? `Cliente ${c.id} cadastrado` : `Cliente ${c.id} salvo`);
            setEditing(null);
            list.reload();
          }}
        />
      ) : null}

      {confirm?.action === 'toggle' ? (
        <ConfirmDialog
          title={confirm.customer.status === 'ACTIVE' ? 'Desativar cliente' : 'Reativar cliente'}
          message={
            confirm.customer.status === 'ACTIVE'
              ? `Com o cliente inativo, nenhum novo pagamento pode ser criado para ${confirm.customer.legalName}. Estabelecimentos, terminais e o histórico continuam disponíveis para consulta.`
              : `${confirm.customer.legalName} volta a aceitar novos pagamentos.`
          }
          confirmLabel={confirm.customer.status === 'ACTIVE' ? 'Desativar cliente' : 'Reativar cliente'}
          danger={confirm.customer.status === 'ACTIVE'}
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            await api.patch(`/customers/${confirm.customer.id}`, { status: confirm.customer.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' });
            toast('good', confirm.customer.status === 'ACTIVE' ? 'Cliente desativado' : 'Cliente reativado');
            list.reload();
          }}
        />
      ) : null}

      {confirm?.action === 'delete' ? (
        <ConfirmDialog
          title="Excluir cliente"
          message={
            <>
              <p>A exclusão é permanente e só é aceita para clientes sem estabelecimentos, terminais ou pagamentos.</p>
              <p className="muted">Se houver histórico financeiro, a plataforma recusa a exclusão: desative o cliente para impedir novos pagamentos.</p>
            </>
          }
          confirmLabel="Excluir cliente"
          danger
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            await api.del(`/customers/${confirm.customer.id}`);
            toast('good', 'Cliente excluído');
            list.reload();
          }}
        />
      ) : null}
    </>
  );
}

function CustomerForm({ customer, onClose, onSaved }: { customer: Customer | null; onClose: () => void; onSaved: (c: Customer) => void }) {
  const [id, setId] = useState(customer?.id ?? '');
  const [legalName, setLegalName] = useState(customer?.legalName ?? '');
  const [tradeName, setTradeName] = useState(customer?.tradeName ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const validate = () => {
    const e: Record<string, string> = {};
    if (!customer && !CODE.test(id.trim())) e['id'] = 'Use de 1 a 64 caracteres: letras, números, ponto, hífen, dois-pontos ou sublinhado, começando por letra ou número.';
    if (legalName.trim().length < 2 || legalName.trim().length > 120) e['legalName'] = 'Informe a razão social (entre 2 e 120 caracteres).';
    if (tradeName.trim().length > 120) e['tradeName'] = 'Use no máximo 120 caracteres.';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  return (
    <Modal title={customer ? `Editar cliente ${customer.id}` : 'Cadastrar cliente'} onClose={onClose}>
      <form
        className="form"
        noValidate
        onSubmit={(ev) => {
          ev.preventDefault();
          if (!validate()) return;
          setBusy(true);
          const body = { legalName: legalName.trim(), tradeName: tradeName.trim() || null };
          (customer ? api.patch<Customer>(`/customers/${customer.id}`, body) : api.post<Customer>('/customers', { id: id.trim(), ...body }))
            .then(onSaved)
            .catch((err: unknown) => setErrors({ form: errorMessage(err) }))
            .finally(() => setBusy(false));
        }}
      >
        {!customer ? (
          <Field label="Código" hint="Identificador permanente do cliente (usado como tenant). Não pode ser alterado depois." error={errors['id']}>
            {(p) => <input {...p} value={id} onChange={(e) => setId(e.target.value)} autoComplete="off" />}
          </Field>
        ) : null}
        <Field label="Razão social" error={errors['legalName']}>
          {(p) => <input {...p} value={legalName} onChange={(e) => setLegalName(e.target.value)} />}
        </Field>
        <Field label="Nome fantasia" optional error={errors['tradeName']}>
          {(p) => <input {...p} value={tradeName} onChange={(e) => setTradeName(e.target.value)} />}
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
            {busy ? 'Salvando' : customer ? 'Salvar cliente' : 'Cadastrar cliente'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
