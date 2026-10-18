/**
 * Normalização de textos vindos de provedores antes de persistir, auditar,
 * registrar ou devolver pela API. O contrato proíbe dados sensíveis, mas a
 * aplicação não confia nisso: só aceita tokens curtos com caracteres seguros.
 */
const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
const SAFE_REFERENCE = /^[A-Za-z0-9_.:/-]{1,128}$/;

export const INVALID_PROVIDER_CODE = 'PROVIDER_CODE_INVALID';

function containsCardLikeNumber(value: string): boolean {
  for (const match of value.matchAll(/(?<!\d)\d{13,19}(?!\d)/g)) {
    const digits = match[0];
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

/** Código de resultado: inválido vira PROVIDER_CODE_INVALID (o fato de haver código é preservado). */
export function safeProviderCode(code: string | undefined): string | undefined {
  if (code === undefined) return undefined;
  return SAFE_CODE.test(code) && !containsCardLikeNumber(code) ? code : INVALID_PROVIDER_CODE;
}

/** Referência do provedor: inválida é descartada (não deve ser registrada nem devolvida). */
export function safeProviderReference(reference: string | undefined): string | undefined {
  if (reference === undefined) return undefined;
  return SAFE_REFERENCE.test(reference) && !containsCardLikeNumber(reference) ? reference : undefined;
}
