import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, setUnauthenticatedHandler, type Session } from './api.ts';
import { Loading, ToastProvider } from './components/ui.tsx';
import { AuditPage } from './pages/Audit.tsx';
import { CustomersPage } from './pages/Customers.tsx';
import { DashboardPage } from './pages/Dashboard.tsx';
import { LoginPage } from './pages/Login.tsx';
import { MerchantsPage } from './pages/Merchants.tsx';
import { PaymentsPage } from './pages/Payments.tsx';
import { SimulatorPage } from './pages/Simulator.tsx';
import { TerminalsPage } from './pages/Terminals.tsx';
import { UsersPage } from './pages/Users.tsx';

interface RouteDef {
  path: string;
  label: string;
  group: 'operação' | 'cadastro' | 'controle';
  render: (params: URLSearchParams) => ReactNode;
}

const ROUTES: RouteDef[] = [
  { path: 'dashboard', label: 'Dashboard', group: 'operação', render: () => <DashboardPage /> },
  { path: 'transacoes', label: 'Transações', group: 'operação', render: (p) => <PaymentsPage params={p} /> },
  { path: 'simulador', label: 'Simulador', group: 'operação', render: () => <SimulatorPage /> },
  { path: 'clientes', label: 'Clientes', group: 'cadastro', render: () => <CustomersPage /> },
  { path: 'estabelecimentos', label: 'Estabelecimentos', group: 'cadastro', render: (p) => <MerchantsPage params={p} /> },
  { path: 'terminais', label: 'Terminais', group: 'cadastro', render: (p) => <TerminalsPage params={p} /> },
  { path: 'auditoria', label: 'Auditoria', group: 'controle', render: () => <AuditPage /> },
  { path: 'usuarios', label: 'Usuários e permissões', group: 'controle', render: () => <UsersPage /> },
];

const GROUP_LABEL = { operação: 'Operação', cadastro: 'Cadastro', controle: 'Controle' } as const;

function parseHash(): { path: string; params: URLSearchParams } {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [path = '', query = ''] = raw.split('?');
  return { path: path || 'dashboard', params: new URLSearchParams(query) };
}

export function navigate(path: string, params?: Record<string, string>): void {
  const qs = params ? `?${new URLSearchParams(params).toString()}` : '';
  window.location.hash = `#/${path}${qs}`;
}

function useHashRoute() {
  const [route, setRoute] = useState(parseHash);
  useEffect(() => {
    const onChange = () => setRoute(parseHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

function SafetyBand() {
  return (
    <div className="safety-band" role="note">
      <strong>Ambiente local de demonstração.</strong> Todas as transações passam pelo simulador com dados fictícios. Nenhum pagamento é real.
    </div>
  );
}

export function App() {
  const route = useHashRoute();
  const [session, setSession] = useState<Session | null | 'checking'>('checking');
  const [navOpen, setNavOpen] = useState(false);

  const check = useCallback(() => {
    api
      .get<Session>('/session')
      .then(setSession)
      .catch((e: unknown) => setSession(e instanceof ApiError && e.status === 401 ? null : null));
  }, []);

  useEffect(() => {
    setUnauthenticatedHandler(() => setSession(null));
    check();
  }, [check]);

  useEffect(() => setNavOpen(false), [route.path]);

  if (session === 'checking') {
    return (
      <div className="boot">
        <Loading label="Verificando a sessão" />
      </div>
    );
  }

  if (!session) {
    return (
      <ToastProvider>
        <SafetyBand />
        <LoginPage onLoggedIn={setSession} />
      </ToastProvider>
    );
  }

  const current = ROUTES.find((r) => r.path === route.path) ?? ROUTES[0]!;
  const groups = (['operação', 'cadastro', 'controle'] as const).map((g) => ({ g, items: ROUTES.filter((r) => r.group === g) }));

  return (
    <ToastProvider>
      <SafetyBand />
      <div className="shell">
        <aside className={`rail ${navOpen ? 'rail-open' : ''}`}>
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="22" height="22">
                <rect x="3" y="6" width="18" height="12" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
                <path d="M3 10h18" stroke="currentColor" strokeWidth="1.8" />
                <path d="M7 14.5h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </span>
            <span>
              <span className="brand-name">TEF Platform</span>
              <span className="brand-sub">Console de operação</span>
            </span>
          </div>
          <nav aria-label="Seções">
            {groups.map(({ g, items }) => (
              <div key={g} className="nav-group">
                <p className="nav-group-label">{GROUP_LABEL[g]}</p>
                {items.map((r) => (
                  <a key={r.path} href={`#/${r.path}`} className={`nav-link ${r.path === current.path ? 'active' : ''}`} aria-current={r.path === current.path ? 'page' : undefined}>
                    {r.label}
                  </a>
                ))}
              </div>
            ))}
          </nav>
          <div className="rail-foot">
            <p className="rail-session">
              Sessão local de desenvolvimento
              <span>{session.operatorId}</span>
            </p>
            <button
              type="button"
              className="rail-logout"
              onClick={() => {
                void api.del('/session').finally(() => setSession(null));
              }}
            >
              Encerrar sessão
            </button>
          </div>
        </aside>
        <div className="main">
          <div className="topbar">
            <button type="button" className="menu-btn" onClick={() => setNavOpen((o) => !o)} aria-expanded={navOpen} aria-label="Abrir menu">
              <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
                <path d="M3 6h14M3 10h14M3 14h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
            <span className="topbar-title">{current.label}</span>
          </div>
          <main className="content" key={current.path}>
            {current.render(route.params)}
          </main>
        </div>
      </div>
    </ToastProvider>
  );
}
