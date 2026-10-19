import { useState } from 'react';
import { navigate } from '../App.tsx';
import { api, type Customer, type Merchant } from '../api.ts';
import { Button, ConfirmDialog, EmptyState, errorMessage, ErrorNotice, Field, Loading, Modal, PageHeader, Pill, useApi, useToast } from '../components/ui.tsx';

const CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

export function MerchantsPage({ params }: { params: URLSearchParams }) {
  const [customerId, setCustomerId] = useState(params.get('customerId') ?? '');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Merchant | 'new' | null>(null);
  const [confirm, setConfirm] = useState<{ merchant: Merchant; action: 'toggle' | 'delete' } | null>(null);
  const toast = useToast();
  const customers = useApi(() => api.get<Customer[]>('/customers', { limit: 200 }), []);
  const list = useApi(() => api.get<Merchant[]>('/merchants', { customerId, q, limit: 200 }), [customerId, q]);
  const customerName = (id: string) => {
    const c = customers.data?.find((x) => x.id === id);
    return c ? (c.tradeName ?? c.legalName) : id;
  };

  return (
    <>
      <PageHeader
        title="Estabelecimentos"
        description="Lojas ou pontos de venda de cada cliente. O código é único dentro do cliente."
        actions={
          <Button variant="primary" onClick={() => setEditing('new')} disabled={!customers.data?.length}>
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
        <input type="search" placeholder="Buscar por código, nome ou cidade" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar estabelecimentos" />
      </div>

      {customers.error ? <ErrorNotice error={customers.error} onRetry={customers.reload} /> : null}
      {list.error ? <ErrorNotice error={list.error} onRetry={list.reload} /> : null}
      {list.loading && !list.data ? <Loading /> : null}
      {list.data?.length === 0 ? (
        <EmptyState title="Nenhum estabelecimento encontrado">
          {customers.data?.length ? 'Cadastre um estabelecimento para um cliente.' : 'Cadastre um cliente primeiro.'}
        </EmptyState>
      ) : null}
      {list.data && list.data.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Estabelecimento</th>
                <th scope="col">Cliente</th>
                <th scope="col">Cidade</th>
                <th scope="col">Situação</th>
                <th scope="col">
                  <span className="sr-only">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((m) => (
                <tr key={`${m.customerId}/${m.id}`}>
                  <td>
                    <strong>{m.name}</strong>
                    <span className="cell-sub code">{m.id}</span>
                  </td>
                  <td>{customerName(m.customerId)}</td>
                  <td>{m.city ?? '—'}</td>
                  <td>{m.status === 'ACTIVE' ? <Pill tone="good">Ativo</Pill> : <Pill tone="neutral">Inativo</Pill>}</td>
                  <td className="row-actions">
                    <Button variant="ghost" onClick={() => navigate('terminais', { customerId: m.customerId, merchantId: m.id })}>
                      Terminais
                    </Button>
                    <Button variant="ghost" onClick={() => setEditing(m)}>
                      Editar
                    </Button>
                    <Button variant="ghost" onClick={() => setConfirm({ merchant: m, action: 'toggle' })}>
                      {m.status === 'ACTIVE' ? 'Desativar' : 'Reativar'}
                    </Button>
                    <Button variant="ghost" className="danger-text" onClick={() => setConfirm({ merchant: m, action: 'delete' })}>
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
          customers={(customers.data ?? []).filter((c) => c.status === 'ACTIVE')}
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
              ? `${confirm.merchant.name} deixa de aceitar novos pagamentos. Pagamentos existentes continuam consultáveis.`
              : `${confirm.merchant.name} volta a aceitar novos pagamentos.`
          }
          confirmLabel={confirm.merchant.status === 'ACTIVE' ? 'Desativar' : 'Reativar'}
          danger={confirm.merchant.status === 'ACTIVE'}
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            await api.patch(`/customers/${confirm.merchant.customerId}/merchants/${confirm.merchant.id}`, {
              status: confirm.merchant.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
            });
            toast('good', 'Estabelecimento atualizado');
            list.reload();
          }}
        />
      ) : null}

      {confirm?.action === 'delete' ? (
        <ConfirmDialog
          title="Excluir estabelecimento"
          message="A exclusão só é aceita sem terminais e sem pagamentos. Havendo histórico, desative o estabelecimento."
          confirmLabel="Excluir"
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
  const [customerId, setCustomerId] = useState(merchant?.customerId ?? (defaultCustomerId || customers[0]?.id || ''));
  const [id, setId] = useState(merchant?.id ?? '');
  const [name, setName] = useState(merchant?.name ?? '');
  const [city, setCity] = useState(merchant?.city ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  return (
    <Modal title={merchant ? `Editar ${merchant.id}` : 'Cadastrar estabelecimento'} onClose={onClose}>
      <form
        className="form"
        onSubmit={(ev) => {
          ev.preventDefault();
          const e: Record<string, string> = {};
          if (!merchant && !customerId) e['customerId'] = 'Escolha o cliente.';
          if (!merchant && !CODE.test(id)) e['id'] = 'Use letras, números, ponto, hífen, dois-pontos ou sublinhado (até 64).';
          if (name.trim().length < 2) e['name'] = 'Informe pelo menos 2 caracteres.';
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
          <>
            <Field label="Cliente" error={errors['customerId']}>
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
              {(p) => <input {...p} value={id} onChange={(e) => setId(e.target.value)} />}
            </Field>
          </>
        ) : null}
        <Field label="Nome" error={errors['name']}>
          {(p) => <input {...p} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="Cidade" hint="Opcional.">
          {(p) => <input {...p} value={city} onChange={(e) => setCity(e.target.value)} />}
        </Field>
        {errors['form'] ? <p className="field-error">{errors['form']}</p> : null}
        <div className="form-actions">
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" variant="primary" busy={busy}>
            {merchant ? 'Salvar estabelecimento' : 'Cadastrar estabelecimento'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
