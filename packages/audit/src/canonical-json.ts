import { createHash } from 'node:crypto';

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * Serialização determinística: chaves ordenadas, sem espaços. Rejeita valores
 * que não têm representação JSON estável (NaN, Infinity, undefined em arrays,
 * funções, bigint). Datas são convertidas para ISO-8601.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, new Set());
}

function serialize(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: número não finito');
      return JSON.stringify(value);
    case 'object': {
      if (seen.has(value)) throw new TypeError('canonicalJson: referência circular');
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          return `[${value.map((item: unknown) => {
            if (item === undefined) throw new TypeError('canonicalJson: undefined em array');
            return serialize(item, seen);
          }).join(',')}]`;
        }
        const entries = Object.entries(value as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${serialize(v, seen)}`).join(',')}}`;
      } finally {
        seen.delete(value);
      }
    }
    case 'bigint':
    case 'function':
    case 'symbol':
    case 'undefined':
      break;
  }
  throw new TypeError(`canonicalJson: tipo não suportado (${typeof value})`);
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
