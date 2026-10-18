import { createHash, timingSafeEqual } from 'node:crypto';
import { parseMerchantId, parseTenantId, type MerchantId, type TenantId } from '@tef/domain';
import type { ApiCredential } from './config.ts';

/**
 * Autenticação PROVISÓRIA por chave de API (Bearer) — ver docs/decisions/0009.
 * Só o SHA-256 da chave é configurado. O tenant vem SEMPRE da credencial,
 * nunca do corpo da requisição. Este esquema não é a fronteira definitiva:
 * produção exigirá credenciais por cliente com rotação (ex.: OAuth2 client
 * credentials e/ou mTLS) e gestão em cofre.
 */
export interface Principal {
  readonly keyId: string;
  readonly tenantId: TenantId;
  readonly merchantIds: ReadonlySet<MerchantId>;
}

interface StoredCredential {
  readonly keyId: string;
  readonly hash: Buffer;
  readonly tenantId: TenantId;
  readonly merchantIds: ReadonlySet<MerchantId>;
}

const BEARER = /^Bearer ([A-Za-z0-9_\-.~+/]{16,256}=*)$/;

export function createAuthenticator(credentials: readonly ApiCredential[]): (authorization: string | undefined) => Principal | null {
  const stored: StoredCredential[] = credentials.map((c) => ({
    keyId: c.keyId,
    hash: Buffer.from(c.keySha256, 'hex'),
    tenantId: parseTenantId(c.tenantId),
    merchantIds: new Set(c.merchantIds.map(parseMerchantId)),
  }));

  return (authorization) => {
    if (!authorization) return null;
    const match = BEARER.exec(authorization);
    if (!match?.[1]) return null;
    const presented = createHash('sha256').update(match[1], 'utf8').digest();
    let found: StoredCredential | null = null;
    // Percorre todas as credenciais para não revelar, pelo tempo, qual delas casou.
    for (const credential of stored) {
      if (timingSafeEqual(presented, credential.hash) && !found) found = credential;
    }
    return found ? { keyId: found.keyId, tenantId: found.tenantId, merchantIds: found.merchantIds } : null;
  };
}
