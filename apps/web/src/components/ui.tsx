import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ApiError, type PaymentState } from '../api.ts';
import { STATE_LABEL, STATE_TONE, type Tone } from '../format.ts';

// --------------------------------------------------------------- marca e ícones

export function Wordmark() {
  return (
    <span className="wordmark" aria-label="WyseTEF">
      <span className="wordmark-wyse" aria-hidden="true">
        Wyse
      </span>
      <span className="wordmark-tef" aria-hidden="true">
        TEF
      </span>
    </span>
  );
}

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
    <span className={`badge badge-${tone}`} data-state={state}>
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

/** Identificador longo encurtado, com o valor completo disponível e botão de copiar. */
export function IdText({ value, head = 12 }: { value: string; head?: number }) {
  const [copied, setCopied] = useState(false);
  const short = value.length > head + 6 ? `${value.slice(0, head)}…${value.slice(-4)}` : value;
  return (
    <span className="id" title={value}>
      <span>{short}</span>
      <button
        type="button"
        className="copy-btn"
        aria-label={copied ? 'Copiado' : `Copiar ${value}`}
        onClick={(e) => {
          e.stopPropagation();
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }}
      >
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          {copied ? (
            <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          ) : (
            <path d="M5.5 5.5h7v7h-7zM3.5 10.5v-7h7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          )}
        </svg>
      </button>
    </span>
  );
}

/** Caminho da hierarquia cliente → estabelecimento → terminal. */
export function HierarchyPath({ parts }: { parts: (string | null | undefined)[] }) {
  const items = parts.filter((p): p is string => Boolean(p));
  return (
    <span className="path">
      {items.map((p, i) => (
        <span key={`${p}-${i}`}>
          {i > 0 ? (
            <span className="path-sep" aria-hidden="true">
              {' › '}
            </span>
          ) : null}
          {p}
        </span>
      ))}
    </span>
  );
}

// --------------------------------------------------------------- básicos

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'md' | 'sm';
  busy?: boolean;
  'data-autofocus'?: boolean;
};

export function Button({ variant = 'secondary', size = 'md', busy = false, children, disabled, className, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      className={`btn btn-${variant} ${size === 'sm' ? 'btn-sm' : ''} ${className ?? ''}`}
      disabled={disabled || busy}
      aria-busy={busy}
    >
      {busy ? <span className="spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
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

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export type SortDir = 'asc' | 'desc';

export function SortTh<K extends string>({
  label,
  column,
  sort,
  onSort,
  className,
}: {
  label: string;
  column: K;
  sort: { key: K; dir: SortDir };
  onSort: (s: { key: K; dir: SortDir }) => void;
  className?: string;
}) {
  const active = sort.key === column;
  return (
    <th scope="col" className={className} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="sort-btn" onClick={() => onSort({ key: column, dir: active && sort.dir === 'desc' ? 'asc' : 'desc' })}>
        {label}
        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
          <path d={active && sort.dir === 'asc' ? 'M3 7.5L6 4.5l3 3' : 'M3 4.5L6 7.5l3-3'} fill="none" stroke="currentColor" strokeWidth="1.6" opacity={active ? 1 : 0.4} />
        </svg>
      </button>
    </th>
  );
}

export function Field({
  label,
  hint,
  error,
  optional = false,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | undefined;
  optional?: boolean;
  children: (props: { id: string; 'aria-invalid': boolean; 'aria-describedby'?: string }) => ReactNode;
}) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className={`field ${error ? 'field-invalid' : ''}`}>
      <label htmlFor={id}>
        {label} {optional ? <span className="field-optional">(opcional)</span> : null}
      </label>
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

/** Linhas de esqueleto para tabelas durante o primeiro carregamento. */
export function SkeletonTable({ columns, rows = 4 }: { columns: number; rows?: number }) {
  return (
    <div className="table-wrap" role="status" aria-label="Carregando">
      <table className="table">
        <tbody>
          {Array.from({ length: rows }, (_, r) => (
            <tr key={r}>
              {Array.from({ length: columns }, (_, c) => (
                <td key={c}>
                  <span className="skeleton" style={{ width: `${50 + ((r * 7 + c * 13) % 40)}%` }} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ErrorNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const api = error instanceof ApiError ? error : null;
  const unreachable = !api || api.status >= 500;
  return (
    <div className="notice notice-error" role="alert">
      <p>
        {api && !unreachable
          ? api.message
          : 'A API local não respondeu. Verifique se ela está rodando (npm run dev); a tela tenta de novo automaticamente.'}
      </p>
      {api?.correlationId ? <p className="notice-meta">Correlação: {api.correlationId}</p> : null}
      {onRetry ? (
        <div className="notice-actions">
          <Button size="sm" onClick={onRetry}>
            Tentar agora
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'HAS_DEPENDENCIES') return 'Este registro tem histórico vinculado e não pode ser excluído. Desative-o para impedir novos pagamentos.';
    if (error.code === 'DUPLICATE_CODE') return 'Este código já está em uso. Escolha outro.';
    if (error.code === 'REFERENCE_INVALID') return `${error.message}. Verifique se cliente, estabelecimento e terminal estão ativos e vinculados entre si.`;
    if (error.status >= 500) return 'A API local não respondeu. Tente de novo em instantes.';
    return error.message;
  }
  return 'Falha de comunicação com a API local.';
}

// --------------------------------------------------------------- diálogos

export function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.showModal();
    // showModal foca o primeiro elemento (o botão Fechar); o foco deve ir ao primeiro campo.
    const first = dialog.querySelector<HTMLElement>('[data-autofocus], .modal-body input:not([type=radio]), .modal-body select');
    first?.focus();
    return () => dialog.close();
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
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="form-actions">
        <Button variant="ghost" onClick={onClose}>
          Voltar
        </Button>
        <Button
          variant={danger ? 'danger' : 'primary'}
          busy={busy}
          data-autofocus
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
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
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
  updatedAt: Date | null;
  reload: () => void;
}

/** Intervalo de nova tentativa após falha, para telas sem atualização periódica. */
const RETRY_MS = 5_000;

/**
 * Carrega dados da API; `deps` recarrega; `pollMs` atualiza periodicamente enquanto
 * `poll(data)` for verdadeiro. Em falha, mantém os dados já exibidos e continua tentando
 * (no ritmo de `pollMs` ou, sem ele, a cada RETRY_MS) até a API responder.
 */
export function useApi<T>(load: () => Promise<T>, deps: readonly unknown[], options: { pollMs?: number; poll?: (data: T) => boolean } = {}): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
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
          setUpdatedAt(new Date());
          if (options.pollMs && (!options.poll || options.poll(d))) timer = setTimeout(() => run(false), options.pollMs);
        })
        .catch((e: unknown) => {
          if (!active) return;
          setError(e);
          // Falha transitória: continua tentando, sem perder os dados já exibidos.
          timer = setTimeout(() => run(false), options.pollMs ?? RETRY_MS);
        })
        .finally(() => active && setLoading(false));
    };
    run(true);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [...deps, tick]);

  return { data, error, loading, updatedAt, reload: () => setTick((t) => t + 1) };
}
