import type { Job, WorkerHeartbeat } from '@tef/application';
import type { AuditRecord } from '@tef/audit';
import type { Customer, Merchant, Payment, Terminal } from '@tef/domain';

export const presentCustomer = (c: Customer) => ({
  id: c.id,
  legalName: c.legalName,
  tradeName: c.tradeName,
  status: c.status,
  version: c.version,
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
});

export const presentMerchant = (m: Merchant) => ({
  customerId: m.customerId,
  id: m.id,
  name: m.name,
  city: m.city,
  status: m.status,
  version: m.version,
  createdAt: m.createdAt.toISOString(),
  updatedAt: m.updatedAt.toISOString(),
});

export const presentTerminal = (t: Terminal) => ({
  customerId: t.customerId,
  id: t.id,
  merchantId: t.merchantId,
  label: t.label,
  providerId: t.providerId,
  mode: t.mode,
  status: t.status,
  version: t.version,
  createdAt: t.createdAt.toISOString(),
  updatedAt: t.updatedAt.toISOString(),
});

export const presentPaymentSummary = (p: Payment) => ({
  id: p.id,
  customerId: p.tenantId,
  merchantId: p.merchantId,
  terminalId: p.terminalId,
  externalReference: p.externalReference,
  providerId: p.providerId,
  amountCents: p.amount.cents,
  reversedCents: p.reversedAmount.cents,
  currency: p.amount.currency,
  state: p.state,
  stateReason: p.stateReason,
  createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt.toISOString(),
});

export const presentJob = (j: Job) => ({
  id: j.id,
  kind: j.kind,
  operationId: j.operationId,
  status: j.status,
  attempts: j.attempts,
  maxAttempts: j.maxAttempts,
  availableAt: j.availableAt.toISOString(),
  lastErrorCode: j.lastErrorCode,
  completedAt: j.completedAt?.toISOString() ?? null,
});

export const presentAudit = (r: AuditRecord) => ({
  customerId: r.tenantId,
  seq: r.seq,
  occurredAt: r.occurredAt.toISOString(),
  actorType: r.actorType,
  actorId: r.actorId,
  action: r.action,
  resourceType: r.resourceType,
  resourceId: r.resourceId,
  data: r.data,
  hash: r.hash,
});

export const presentHeartbeat = (h: WorkerHeartbeat) => ({
  workerId: h.workerId,
  status: h.status,
  startedAt: h.startedAt.toISOString(),
  lastBeatAt: h.lastBeatAt.toISOString(),
});
