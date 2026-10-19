import { canonicalJson, sha256Hex } from './canonical-json.ts';

/**
 * Dados de auditoria usam LISTA DE CAMPOS PERMITIDOS: qualquer chave fora da
 * lista é descartada antes da gravação. Nunca entram na auditoria: PAN, CVV,
 * trilha, PIN, credenciais, chaves de API, tokens ou corpo bruto de requisições.
 */
export const AUDIT_DATA_ALLOWED_KEYS = [
  'fromState',
  'toState',
  'stateReason',
  'operationId',
  'operationKind',
  'operationStatus',
  'fromOperationStatus',
  'amountCents',
  'reversedCents',
  'currency',
  'merchantId',
  'terminalId',
  'externalReference',
  'providerId',
  'providerKind',
  'providerReference',
  'resultCode',
  'evidenceSource',
  'resolvedBy',
  'approvedBy',
  'supportingDocumentRef',
  'idempotentReplay',
  'reason',
  'customerId',
  'name',
  'label',
  'city',
  'entityStatus',
  'previousStatus',
  'testDirective',
  'jobKind',
] as const;

export type AuditDataKey = (typeof AUDIT_DATA_ALLOWED_KEYS)[number];
export type AuditData = Partial<Record<AuditDataKey, string | number | boolean | null>>;

const ALLOWED = new Set<string>(AUDIT_DATA_ALLOWED_KEYS);
const MAX_VALUE_LENGTH = 200;

export function sanitizeAuditData(data: Readonly<Record<string, unknown>>): AuditData {
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!ALLOWED.has(key)) continue;
    if (value === null || typeof value === 'boolean') {
      result[key] = value;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      result[key] = value;
    } else if (typeof value === 'string') {
      result[key] = value.length > MAX_VALUE_LENGTH ? value.slice(0, MAX_VALUE_LENGTH) : value;
    }
  }
  return result;
}

export type ActorType = 'API_CLIENT' | 'SYSTEM' | 'OPERATOR';
export type AuditResourceType = 'payment' | 'operation' | 'customer' | 'merchant' | 'terminal';

export interface AuditEventInput {
  readonly tenantId: string;
  readonly occurredAt: Date;
  readonly actorType: ActorType;
  readonly actorId: string;
  readonly action: string;
  readonly resourceType: AuditResourceType;
  readonly resourceId: string;
  readonly correlationId: string | null;
  readonly data: AuditData;
}

export interface AuditRecord extends AuditEventInput {
  readonly seq: number;
  readonly prevHash: string;
  readonly hash: string;
}

/** Hash "gênese" da cadeia de cada tenant. */
export const GENESIS_HASH = '0'.repeat(64);

function hashPayload(seq: number, prevHash: string, event: AuditEventInput): string {
  return sha256Hex(
    canonicalJson({
      seq,
      prevHash,
      tenantId: event.tenantId,
      occurredAt: event.occurredAt.toISOString(),
      actorType: event.actorType,
      actorId: event.actorId,
      action: event.action,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      correlationId: event.correlationId,
      data: event.data,
    }),
  );
}

export interface ChainHead {
  readonly seq: number;
  readonly hash: string;
}

/**
 * Encadeia o evento ao anterior (por tenant). O encadeamento permite DETECTAR
 * alterações, remoções ou inserções fora de ordem; ele não impede que alguém
 * com privilégio suficiente reescreva a cadeia inteira. Ver docs/THREAT_MODEL.md.
 */
export function chainAuditEvent(head: ChainHead | null, input: AuditEventInput): AuditRecord {
  const event: AuditEventInput = { ...input, data: sanitizeAuditData(input.data) };
  const seq = (head?.seq ?? 0) + 1;
  const prevHash = head?.hash ?? GENESIS_HASH;
  return { ...event, seq, prevHash, hash: hashPayload(seq, prevHash, event) };
}

export type ChainVerification =
  | { readonly valid: true; readonly head: ChainHead | null }
  | { readonly valid: false; readonly brokenAtSeq: number; readonly reason: string };

/** Verifica uma sequência de registros de UM tenant, ordenada por `seq`. */
export function verifyAuditChain(records: readonly AuditRecord[]): ChainVerification {
  let expectedPrev = GENESIS_HASH;
  let expectedSeq = 1;
  for (const record of records) {
    if (record.seq !== expectedSeq) {
      return { valid: false, brokenAtSeq: record.seq, reason: `sequência esperada ${expectedSeq}` };
    }
    if (record.prevHash !== expectedPrev) {
      return { valid: false, brokenAtSeq: record.seq, reason: 'hash anterior não confere' };
    }
    if (hashPayload(record.seq, record.prevHash, record) !== record.hash) {
      return { valid: false, brokenAtSeq: record.seq, reason: 'conteúdo alterado' };
    }
    expectedPrev = record.hash;
    expectedSeq++;
  }
  const last = records.at(-1);
  return { valid: true, head: last ? { seq: last.seq, hash: last.hash } : null };
}
