/**
 * Cliente da API administrativa local. Nenhum segredo vive aqui: a sessão é um
 * cookie HttpOnly emitido pelo servidor após o login; o JavaScript nunca o lê.
 * O cabeçalho `x-tef-admin` é exigido pelo servidor como proteção contra CSRF.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly correlationId: string | null;

  constructor(status: number, code: string, message: string, correlationId: string | null) {
    super(message);
    this.status = status;
    this.code = code;
    this.correlationId = correlationId;
  }
}

type Query = Record<string, string | number | undefined | null>;

function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

let onUnauthenticated: (() => void) | null = null;
export function setUnauthenticatedHandler(handler: () => void): void {
  onUnauthenticated = handler;
}

async function request<T>(method: string, path: string, options: { query?: Query; body?: unknown; idempotent?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { 'x-tef-admin': '1', accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.idempotent) headers['idempotency-key'] = crypto.randomUUID();
  const res = await fetch(withQuery(`/admin/api${path}`, options.query), {
    method,
    headers,
    credentials: 'same-origin',
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; correlationId?: string } } | null)?.error;
    if (res.status === 401 && path !== '/session') onUnauthenticated?.();
    throw new ApiError(res.status, err?.code ?? 'HTTP_ERROR', err?.message ?? `falha na requisição (${res.status})`, err?.correlationId ?? null);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>('GET', path, query ? { query } : {}),
  post: <T>(path: string, body?: unknown, idempotent = false) => request<T>('POST', path, { body: body ?? {}, idempotent }),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, { body }),
  del: (path: string) => request<undefined>('DELETE', path),
};

// ------------------------------------------------------------------- tipos

export type PaymentState = 'CREATED' | 'PROCESSING' | 'AUTHORIZED' | 'APPROVED' | 'DECLINED' | 'UNKNOWN' | 'CANCELLED' | 'REVERSED';
export type OperationStatus = 'PENDING' | 'IN_FLIGHT' | 'UNKNOWN' | 'SUCCEEDED' | 'REJECTED' | 'ABORTED' | 'NOT_SENT';

export interface Session {
  authenticated: boolean;
  operatorId: string;
  mode: 'DEV_LOCAL_ADMIN';
  expiresAt: string;
}

export interface Customer {
  id: string;
  legalName: string;
  tradeName: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface Merchant {
  customerId: string;
  id: string;
  name: string;
  city: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  createdAt: string;
}

export interface Terminal {
  customerId: string;
  id: string;
  merchantId: string;
  label: string;
  providerId: string;
  mode: 'SIMULATED';
  status: 'ACTIVE' | 'INACTIVE' | 'MAINTENANCE';
  createdAt: string;
}

export interface PaymentSummary {
  id: string;
  customerId: string;
  merchantId: string;
  terminalId: string;
  externalReference: string;
  providerId: string;
  amountCents: number;
  reversedCents: number;
  state: PaymentState;
  stateReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Operation {
  id: string;
  kind: 'AUTHORIZATION' | 'CONFIRMATION' | 'UNDO' | 'CANCELLATION' | 'REFUND';
  status: OperationStatus;
  amount: { cents: number };
  providerReference: string | null;
  resultCode: string | null;
  evidenceSource: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentFull {
  id: string;
  merchantId: string;
  terminalId: string;
  externalReference: string;
  provider: { id: string; kind: string; simulated: boolean };
  amount: { cents: number };
  reversedAmount: { cents: number };
  netApprovedAmount: { cents: number } | null;
  state: PaymentState;
  stateReason: string | null;
  createdAt: string;
  updatedAt: string;
  operations: Operation[];
}

export interface Job {
  id: number;
  kind: 'EXECUTE_OPERATION' | 'RECONCILE_OPERATION';
  operationId: string;
  status: 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED';
  attempts: number;
  maxAttempts: number;
  availableAt: string;
  lastErrorCode: string | null;
}

export interface AuditEntry {
  customerId: string;
  seq: number;
  occurredAt: string;
  actorType: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  data: Record<string, string | number | boolean | null>;
  hash: string;
}

export interface PaymentDetail {
  payment: PaymentFull;
  jobs: Job[];
  audit: AuditEntry[];
  testDirective: string | null;
}

export interface Dashboard {
  totals: {
    payments: number;
    approvedCount: number;
    declinedCount: number;
    unknownCount: number;
    pendingCount: number;
    cancelledCount: number;
    reversedCount: number;
    approvalRate: number | null;
  };
  amounts: {
    approvedCents: number;
    netApprovedCents: number;
    reversedCents: number;
    declinedCents: number;
    pendingCents: number;
    unknownCents: number;
    cancelledCents: number;
  };
  unknownOperations: number;
  daily: { day: string; approved: number; declined: number; other: number }[];
  recentActivity: AuditEntry[];
}

export interface SystemStatus {
  jobs: Record<'PENDING' | 'RUNNING' | 'DONE' | 'FAILED', number>;
  outboxPending: number;
  workers: { workerId: string; status: string; startedAt: string; lastBeatAt: string }[];
}

export interface Scenario {
  id: string;
  label: string;
  expected: string;
  fictitious: boolean;
}

export const FINAL_STATES: ReadonlySet<PaymentState> = new Set(['APPROVED', 'DECLINED', 'CANCELLED', 'REVERSED']);
