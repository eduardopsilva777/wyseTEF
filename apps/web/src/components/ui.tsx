import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ApiError, type PaymentState } from '../api.ts';
import { STATE_LABEL, STATE_TONE, type Tone } from '../format.ts';

// --------------------------------------------------------------- ícones

const ICON_PATHS: Record<Tone, string> = {
  good: 'M3.5 8.5l3 3 6-7',
  bad: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
  warn: 'M8 3.5v5.5M8 11.6v.4',
  busy: 'M8 3.5a4.5 4.5 0 1 1-4.5 4.5',
  neutral: 'M4 8h8',
  undone: 'M5.5 5H10a2.5 2.5 0 0 1 0 5H6M5.5 5l2-2M5.5 5l2 2',
};

export function ToneIcon({ tone }: { tone: Tone }) {
  return (
    <svg className={`tone-icon tone-${tone}`} viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d={ICON_PATHS[tone]} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Estado do pagamento: cor + ícone + texto (nunca só cor). */
export function StateBadge({ state }: { state: PaymentState }) {
  const tone = STATE_TONE[state];
  return (
    <span className={`badge badge-${tone}`}>
      <ToneIcon tone={tone} />
      {STATE_LABEL[state]}
    </span>
  );
}

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`badge badge-${tone}`}>
      <ToneIcon tone={tone} />
      {children}
    </span>
  );
}

// --------------------------------------------------------------- básicos

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; busy?: boolean };

export function Button({ variant = 'secondary', busy = false, children, disabled, ...rest }: ButtonProps) {
  return (
    <button type="button" {...rest} className={`btn btn-${variant} ${rest.className ?? ''}`} disabled={disabled || busy} aria-busy={busy}>
      {busy ? <span className="spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {description ? <p className="page-description">{description}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | undefined;
  children: (props: { id: string; 'aria-invalid': boolean; 'aria-describedby'?: string }) => ReactNode;
}) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className={`field ${error ? 'field-invalid' : ''}`}>
      <label htmlFor={id}>{label}</label>
      {children({ id, 'aria-invalid': Boolean(error), ...(describedBy ? { 'aria-describedby': describedBy } : {}) })}
      {error ? (
        <p className="field-error" id={`${id}-error`}>
          {error}
        </p>
      ) : hint ? (
        <p className="field-hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children ? <p className="empty-text">{children}</p> : null}
      {action}
    </div>
  );
}

export function Loading({ label = 'Carregando' }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}…
    </div>
  );
}

export function ErrorNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const api = error instanceof ApiError ? error : null;
  return (
    <div className="notice notice-error" role="alert">
      <p>{api ? api.message : 'Não foi possível falar com a API local. Verifique se ela está rodando em 127.0.0.1:3000.'}</p>
      {api?.correlationId ? <p className="notice-meta">Correlação: {api.correlationId}</p> : null}
      {onRetry ? (
        <Button variant="ghost" onClick={onRetry}>
          Tentar de novo
        </Button>
      ) : null}
    </div>
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Falha de comunicação com a API local.';
}

// --------------------------------------------------------------- diálogos

export function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? 'modal-wide' : ''}`}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Fechar">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  danger = false,
  onConfirm,
  onClose,
}: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={title} onClose={onClose}>
      <div className="confirm-text">{message}</div>
      {error ? <p className="field-error">{error}</p> : null}
      <div className="form-actions">
        <Button variant="ghost" onClick={onClose}>
          Voltar
        </Button>
        <Button
          variant={danger ? 'danger' : 'primary'}
          busy={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            onConfirm()
              .then(onClose)
              .catch((e: unknown) => setError(errorMessage(e)))
              .finally(() => setBusy(false));
          }}
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}

// --------------------------------------------------------------- avisos

interface Toast {
  id: number;
  tone: 'good' | 'bad';
  text: string;
}

const ToastContext = createContext<(tone: Toast['tone'], text: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((tone: Toast['tone'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            <ToneIcon tone={t.tone} />
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

// --------------------------------------------------------------- dados

export interface AsyncState<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

/** Carrega dados da API; `deps` recarrega; `pollMs` atualiza periodicamente enquanto `poll(data)` for verdadeiro. */
export function useApi<T>(load: () => Promise<T>, deps: readonly unknown[], options: { pollMs?: number; poll?: (data: T) => boolean } = {}): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = (first: boolean) => {
      if (first) setLoading(true);
      loadRef
        .current()
        .then((d) => {
          if (!active) return;
          setData(d);
          setError(null);
          if (options.pollMs && (!options.poll || options.poll(d))) timer = setTimeout(() => run(false), options.pollMs);
        })
        .catch((e: unknown) => {
          if (!active) return;
          setError(e);
          // Falha transitória: continua tentando no mesmo ritmo, sem perder os dados já exibidos.
          if (options.pollMs) timer = setTimeout(() => run(false), options.pollMs);
        })
        .finally(() => active && setLoading(false));
    };
    run(true);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [...deps, tick]);

  return { data, error, loading, reload: () => setTick((t) => t + 1) };
}
