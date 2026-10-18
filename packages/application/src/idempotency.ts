import { canonicalJson, sha256Hex } from '@tef/audit';

/** Formato aceito para a chave enviada pelo cliente no cabeçalho Idempotency-Key. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;

export function isValidIdempotencyKey(key: string): boolean {
  return IDEMPOTENCY_KEY_PATTERN.test(key);
}

/**
 * Hash canônico da requisição: escopo + parâmetros normalizados, com chaves
 * ordenadas. Duas requisições com o mesmo conteúdo semântico geram o mesmo hash,
 * independentemente da ordem dos campos no JSON recebido.
 */
export function requestHash(scope: string, payload: Readonly<Record<string, unknown>>): string {
  return sha256Hex(canonicalJson({ scope, payload }));
}

/** PROVISÓRIO: retenção das chaves (ver docs/decisions/0006). Rotina de expurgo ainda não existe. */
export const DEFAULT_IDEMPOTENCY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
