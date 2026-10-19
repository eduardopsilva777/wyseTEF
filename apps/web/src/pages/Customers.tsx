import { useState } from 'react';
import { navigate } from '../App.tsx';
import { api, type Customer } from '../api.ts';
import { Button, ConfirmDialog, EmptyState, errorMessage, ErrorNotice, Field, Loading, Modal, PageHeader, Pill, useApi, useToast } from '../components/ui.tsx';
import { when } from '../format.ts';

const CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

export function CustomersPage() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
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
        <input type="search" placeholder="Buscar por código, razão social ou nome fantasia" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar clientes" />
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Situação">
          <option value="">Todas as situações</option>
          <option value="ACTIVE">Ativos</option>
          <option value="INACTIVE">Inativos</option>
        </select>
      </div>

      {list.error ? <ErrorNotice error={list.error} onRetry={list.reload} /> : null}
      {list.loading && !list.data ? <Loading /> : null}
      {list.data && list.data.length === 0 ? (
        <EmptyState
          title={q || status ? 'Nenhum cliente encontrado' : 'Nenhum cliente cadastrado'}
          action={
            <Button variant="primary" onClick={() => setEditing('new')}>
              Cadastrar cliente
            </Button>
          }
        >
          {q || status ? 'Ajuste a busca ou os filtros.' : 'Cadastre um cliente fictício ou rode npm run db:seed para dados de demonstração.'}
        </EmptyState>
      ) : null}
      {list.data && list.data.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
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
                <tr key={c.id}>
                  <td>
                    <strong>{c.tradeName ?? c.legalName}</strong>
                    {c.tradeName ? <span className="cell-sub">{c.legalName}</span> : null}
                  </td>
                  <td className="code">{c.id}</td>
                  <td>{c.status === 'ACTIVE' ? <Pill tone="good">Ativo</Pill> : <Pill tone="neutral">Inativo</Pill>}</td>
                  <td>{when(c.updatedAt)}</td>
                  <td className="row-actions">
                    <Button variant="ghost" onClick={() => navigate('estabelecimentos', { customerId: c.id })}>
                      Estabelecimentos
                    </Button>
                    <Button variant="ghost" onClick={() => setEditing(c)}>
                      Editar
                    </Button>
                    <Button variant="ghost" onClick={() => setConfirm({ customer: c, action: 'toggle' })}>
                      {c.status === 'ACTIVE' ? 'Desativar' : 'Reativar'}
                    </Button>
                    <Button variant="ghost" className="danger-text" onClick={() => setConfirm({ customer: c, action: 'delete' })}>
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
              ? `Com o cliente inativo, nenhum novo pagamento pode ser criado para ${confirm.customer.legalName}. O histórico continua disponível.`
              : `${confirm.customer.legalName} volta a aceitar novos pagamentos.`
          }
          confirmLabel={confirm.customer.status === 'ACTIVE' ? 'Desativar' : 'Reativar'}
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
          message="A exclusão só é aceita para clientes sem estabelecimentos, terminais ou pagamentos. Havendo histórico, desative o cliente."
          confirmLabel="Excluir"
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
    if (!customer && !CODE.test(id)) e['id'] = 'Use letras, números, ponto, hífen, dois-pontos ou sublinhado (até 64).';
    if (legalName.trim().length < 2 || legalName.trim().length > 120) e['legalName'] = 'Informe entre 2 e 120 caracteres.';
    if (tradeName.trim().length > 120) e['tradeName'] = 'Até 120 caracteres.';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  return (
    <Modal title={customer ? `Editar ${customer.id}` : 'Cadastrar cliente'} onClose={onClose}>
      <form
        className="form"
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
          <Field label="Código" hint="Identificador permanente do cliente (vira o tenant). Não pode ser alterado depois." error={errors['id']}>
            {(p) => <input {...p} value={id} onChange={(e) => setId(e.target.value)} autoFocus />}
          </Field>
        ) : null}
        <Field label="Razão social" error={errors['legalName']}>
          {(p) => <input {...p} value={legalName} onChange={(e) => setLegalName(e.target.value)} />}
        </Field>
        <Field label="Nome fantasia" hint="Opcional." error={errors['tradeName']}>
          {(p) => <input {...p} value={tradeName} onChange={(e) => setTradeName(e.target.value)} />}
        </Field>
        {errors['form'] ? <p className="field-error">{errors['form']}</p> : null}
        <div className="form-actions">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" busy={busy}>
            {customer ? 'Salvar cliente' : 'Cadastrar cliente'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
