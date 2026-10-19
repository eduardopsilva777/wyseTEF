import { InvariantViolationError } from './errors.ts';
import type { MerchantId, ProviderId, TenantId, TerminalId } from './ids.ts';

/**
 * Cadastro: cliente empresarial (tenant) → estabelecimentos → terminais.
 * Nesta fase todo terminal é SIMULADO; nenhum hardware real é suportado.
 */
export const CUSTOMER_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

export const MERCHANT_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type MerchantStatus = (typeof MERCHANT_STATUSES)[number];

export const TERMINAL_STATUSES = ['ACTIVE', 'INACTIVE', 'MAINTENANCE'] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export interface Customer {
  readonly id: TenantId;
  readonly legalName: string;
  readonly tradeName: string | null;
  readonly status: CustomerStatus;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface Merchant {
  readonly customerId: TenantId;
  readonly id: MerchantId;
  readonly name: string;
  readonly city: string | null;
  readonly status: MerchantStatus;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface Terminal {
  readonly customerId: TenantId;
  readonly id: TerminalId;
  readonly merchantId: MerchantId;
  readonly label: string;
  readonly providerId: ProviderId;
  readonly mode: 'SIMULATED';
  readonly status: TerminalStatus;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function normalizeName(value: string, label: string, min: number, max: number): string {
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (trimmed.length < min || trimmed.length > max) {
    throw new InvariantViolationError(`${label} deve ter entre ${min} e ${max} caracteres`);
  }
  return trimmed;
}

export function normalizeOptionalName(value: string | null | undefined, label: string, max: number): string | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  return normalizeName(value, label, 1, max);
}
