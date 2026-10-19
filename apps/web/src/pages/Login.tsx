import { useState } from 'react';
import { api, type Session } from '../api.ts';
import { Button, errorMessage, Field } from '../components/ui.tsx';

export function LoginPage({ onLoggedIn }: { onLoggedIn: (s: Session) => void }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  return (
    <div className="login">
      <form
        className="login-card"
        onSubmit={(e) => {
          e.preventDefault();
          if (token.trim().length < 16) {
            setError('Cole o token administrativo local completo.');
            return;
          }
          setBusy(true);
          setError(undefined);
          api
            .post<Session>('/session', { token: token.trim() })
            .then((s) => {
              setToken('');
              onLoggedIn(s);
            })
            .catch((err: unknown) => setError(errorMessage(err)))
            .finally(() => setBusy(false));
        }}
      >
        <h1>Console de operação</h1>
        <p className="login-lead">
          Acesso de desenvolvimento local. Use o token gerado por <code>npm run dev:setup</code>; ele é validado pela API e nunca fica guardado no navegador.
        </p>
        <Field label="Token administrativo local" error={error}>
          {(p) => (
            <input
              {...p}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoFocus
            />
          )}
        </Field>
        <Button type="submit" variant="primary" busy={busy}>
          Entrar
        </Button>
        <p className="login-foot">
          Este acesso não é a autenticação de produção: não há usuários, MFA nem perfis de permissão ainda.
        </p>
      </form>
    </div>
  );
}
