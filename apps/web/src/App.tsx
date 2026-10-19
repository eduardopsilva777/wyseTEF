import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, setUnauthenticatedHandler, type Session } from './api.ts';
import { Loading, ToastProvider, Wordmark } from './components/ui.tsx';
import { AuditPage } from './pages/Audit.tsx';
import { CustomersPage } from './pages/Customers.tsx';
import { DashboardPage } from './pages/Dashboard.tsx';
import { LoginPage } from './pages/Login.tsx';
import { MerchantsPage } from './pages/Merchants.tsx';
import { PaymentsPage } from './pages/Payments.tsx';
import { SimulatorPage } from './pages/Simulator.tsx';
import { TerminalsPage } from './pages/Terminals.tsx';
import { UsersPage } from './pages/Users.tsx';
import { useTheme } from './theme.ts';

interface RouteDef {
  path: string;
  label: string;
  group: 'operação' | 'cadastro' | 'controle';
  tag?: string;
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
  { path: 'usuarios', label: 'Usuários e permissões', group: 'controle', tag: 'futuro', render: () => <UsersPage /> },
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
      <strong>Ambiente local de demonstração.</strong>
      <span>Todas as transações passam pelo simulador com dados fictícios. Nenhum pagamento é real.</span>
    </div>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button type="button" className="icon-btn" onClick={() => setTheme(next)} aria-label={theme === 'dark' ? 'Usar tema claro' : 'Usar tema escuro'} title={theme === 'dark' ? 'Tema claro' : 'Tema escuro'}>
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
        {theme === 'dark' ? (
          <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <circle cx="10" cy="10" r="3.5" />
            <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />
          </g>
        ) : (
          <path d="M15.5 12.5A6.5 6.5 0 0 1 7.5 4.5a6.5 6.5 0 1 0 8 8z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        )}
      </svg>
    </button>
  );
}

export function App() {
  useTheme(); // aplica o tema salvo desde o primeiro render
  const route = useHashRoute();
  const [session, setSession] = useState<Session | null | 'checking'>('checking');
  const [navOpen, setNavOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);

  const check = useCallback(() => {
    api
      .get<Session>('/session')
      .then(setSession)
      .catch(() => setSession(null));
  }, []);

  useEffect(() => {
    setUnauthenticatedHandler(() => setSession(null));
    check();
  }, [check]);

  useEffect(() => setNavOpen(false), [route.path]);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setNavOpen(false);
        menuButton.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen]);

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
      <a className="skip-link" href="#conteudo" onClick={(e) => { e.preventDefault(); document.getElementById('conteudo')?.focus(); }}>
        Pular para o conteúdo
      </a>
      <SafetyBand />
      <div className="shell">
        <aside className={`rail ${navOpen ? 'rail-open' : ''}`} aria-label="Navegação principal">
          <div className="brand">
            <Wordmark />
            <span className="brand-sub">Console de operação</span>
          </div>
          <nav aria-label="Seções">
            {groups.map(({ g, items }) => (
              <div key={g} className="nav-group">
                <p className="nav-group-label">{GROUP_LABEL[g]}</p>
                {items.map((r) => (
                  <a key={r.path} href={`#/${r.path}`} className={`nav-link ${r.path === current.path ? 'active' : ''}`} aria-current={r.path === current.path ? 'page' : undefined}>
                    {r.label}
                    {r.tag ? <span className="nav-tag">{r.tag}</span> : null}
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
              className="btn btn-sm btn-secondary"
              onClick={() => {
                void api.del('/session').finally(() => setSession(null));
              }}
            >
              Encerrar sessão
            </button>
          </div>
        </aside>
        {navOpen ? <button type="button" className="backdrop" aria-label="Fechar menu" onClick={() => setNavOpen(false)} /> : null}
        <div className="main">
          <div className="topbar">
            <button
              ref={menuButton}
              type="button"
              className="icon-btn menu-btn"
              onClick={() => setNavOpen((o) => !o)}
              aria-expanded={navOpen}
              aria-label={navOpen ? 'Fechar menu' : 'Abrir menu'}
            >
              <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
                <path d="M3 6h14M3 10h14M3 14h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
            <span className="topbar-context">
              <span className="hide-sm">{GROUP_LABEL[current.group]}</span>
              <span className="path-sep hide-sm" aria-hidden="true">
                ›
              </span>
              <strong>{current.label}</strong>
            </span>
            <div className="topbar-actions">
              <ThemeToggle />
            </div>
          </div>
          <main className="content" id="conteudo" tabIndex={-1} key={current.path}>
            {current.render(route.params)}
          </main>
        </div>
      </div>
    </ToastProvider>
  );
}
