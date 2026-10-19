import { PageHeader, Pill } from '../components/ui.tsx';

/** Área reservada: nada aqui está implementado. Não há formulários nem ações. */
export function UsersPage() {
  return (
    <>
      <PageHeader title="Usuários e permissões" description="Funcionalidade futura. Esta área ainda não existe e não oferece nenhuma ação." />
      <section className="panel pending-panel" aria-label="Situação atual">
        <p>
          <Pill tone="neutral">Não implementado</Pill>
        </p>
        <h2>O que existe hoje</h2>
        <p>
          Um único acesso de desenvolvimento local, liberado por um token configurado no servidor e válido apenas em loopback. Ele não identifica pessoas e
          não serve para produção.
        </p>
        <h2>O que falta antes de qualquer uso comercial</h2>
        <ul className="plain-list">
          <li>Contas individuais de operadores, com MFA.</li>
          <li>Perfis de permissão (por exemplo: leitura, operação, conciliação, administração) aplicados no servidor.</li>
          <li>Escopo por cliente para usuários de clientes empresariais.</li>
          <li>Dupla aprovação para resolução manual e para estornos acima de um limite.</li>
          <li>Rotação e revogação de credenciais de integração sem reinício.</li>
        </ul>
        <p className="muted">Esses requisitos estão registrados no roadmap e no modelo de ameaças do projeto.</p>
      </section>
    </>
  );
}
