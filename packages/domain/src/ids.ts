import { randomFillSync } from 'node:crypto';
import { InvalidIdentifierError } from './errors.ts';

/**
 * Identificadores internos: prefixo + UUIDv7 (ordenável por tempo).
 * Os tipos são "branded" para que o compilador impeça usar o ID de uma
 * operação onde se espera o de um pagamento, e vice-versa.
 */
declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type PaymentId = Brand<string, 'PaymentId'>;
export type OperationId = Brand<string, 'OperationId'>;
export type TenantId = Brand<string, 'TenantId'>;
export type MerchantId = Brand<string, 'MerchantId'>;
export type TerminalId = Brand<string, 'TerminalId'>;
export type ProviderId = Brand<string, 'ProviderId'>;

const UUID_V7 = '[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const PAYMENT_ID_PATTERN = new RegExp(`^pay_${UUID_V7}$`);
const OPERATION_ID_PATTERN = new RegExp(`^op_${UUID_V7}$`);
/** IDs externos (tenant, estabelecimento, terminal, provedor) definidos pelo cadastro. */
const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  randomFillSync(bytes);
  let ts = BigInt(now);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(ts & 0xffn);
    ts >>= 8n;
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_V7_SUFFIX = new RegExp(`(?:^|_)(${UUID_V7})$`);

/** Instante (ms) embutido num identificador UUIDv7 (com ou sem prefixo); `null` se não for UUIDv7. */
export function uuidv7Timestamp(id: string): number | null {
  const m = UUID_V7_SUFFIX.exec(id);
  if (!m?.[1]) return null;
  return parseInt(m[1].replace(/-/g, '').slice(0, 12), 16);
}

export function newPaymentId(): PaymentId {
  return `pay_${uuidv7()}` as PaymentId;
}

export function newOperationId(): OperationId {
  return `op_${uuidv7()}` as OperationId;
}

export function parsePaymentId(value: string): PaymentId {
  if (!PAYMENT_ID_PATTERN.test(value)) throw new InvalidIdentifierError('identificador de pagamento inválido');
  return value as PaymentId;
}

export function parseOperationId(value: string): OperationId {
  if (!OPERATION_ID_PATTERN.test(value)) throw new InvalidIdentifierError('identificador de operação inválido');
  return value as OperationId;
}

function parseExternal<T>(value: string, label: string): T {
  if (!EXTERNAL_ID_PATTERN.test(value)) throw new InvalidIdentifierError(`identificador de ${label} inválido`);
  return value as T;
}

export const parseTenantId = (v: string): TenantId => parseExternal<TenantId>(v, 'tenant');
export const parseMerchantId = (v: string): MerchantId => parseExternal<MerchantId>(v, 'estabelecimento');
export const parseTerminalId = (v: string): TerminalId => parseExternal<TerminalId>(v, 'terminal');
export const parseProviderId = (v: string): ProviderId => parseExternal<ProviderId>(v, 'provedor');

/** Referência comercial do PDV (identifica a intenção de cobrança, não o pedido inteiro). */
export const EXTERNAL_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,63}$/;

export function parseExternalReference(value: string): string {
  if (!EXTERNAL_REFERENCE_PATTERN.test(value)) {
    throw new InvalidIdentifierError('referência comercial inválida');
  }
  return value;
}
