import type { z } from 'zod';
import { RequestValidationError } from './http-errors.ts';

/** Valida com Zod; o erro devolve apenas caminho e código, nunca o valor recebido. */
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new RequestValidationError(result.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code })));
  }
  return result.data;
}
