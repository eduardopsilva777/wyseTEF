import { InvalidAmountError } from './errors.ts';

/**
 * Valores monetários são sempre inteiros em centavos (unidade mínima da moeda).
 * Nenhum cálculo financeiro usa ponto flutuante: toda operação verifica que o
 * resultado continua sendo um inteiro seguro (Number.isSafeInteger).
 */
export const SUPPORTED_CURRENCIES = ['BRL'] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

declare const centsBrand: unique symbol;
export type Cents = number & { readonly [centsBrand]: true };

export interface Money {
  readonly cents: Cents;
  readonly currency: Currency;
}

/**
 * Limite técnico por transação. PROVISÓRIO: o limite comercial real depende do
 * provedor e do contrato (ver docs/TRANSACTION_LIFECYCLE.md). Mantido bem abaixo
 * de Number.MAX_SAFE_INTEGER para que somas de estornos nunca percam precisão.
 */
export const MAX_TRANSACTION_CENTS = 99_999_999_99; // R$ 99.999.999,99

function assertCurrency(currency: string): asserts currency is Currency {
  if (!(SUPPORTED_CURRENCIES as readonly string[]).includes(currency)) {
    throw new InvalidAmountError('moeda não suportada');
  }
}

/** Valor não negativo (usado para acumuladores, como total estornado). */
export function money(cents: number, currency: string = 'BRL'): Money {
  assertCurrency(currency);
  if (!Number.isSafeInteger(cents)) {
    throw new InvalidAmountError('o valor deve ser um número inteiro de centavos');
  }
  if (cents < 0) {
    throw new InvalidAmountError('o valor não pode ser negativo');
  }
  if (cents > MAX_TRANSACTION_CENTS) {
    throw new InvalidAmountError('o valor excede o limite técnico por transação');
  }
  return { cents: cents as Cents, currency };
}

/** Valor estritamente positivo (usado para cobranças e estornos). */
export function positiveMoney(cents: number, currency: string = 'BRL'): Money {
  const value = money(cents, currency);
  if (value.cents === 0) {
    throw new InvalidAmountError('o valor deve ser maior que zero');
  }
  return value;
}

export function zero(currency: Currency): Money {
  return money(0, currency);
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new InvalidAmountError(`moedas diferentes: ${String(a.currency)} e ${String(b.currency)}`);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.cents + b.cents, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  if (b.cents > a.cents) {
    throw new InvalidAmountError('a subtração resultaria em valor negativo');
  }
  return money(a.cents - b.cents, a.currency);
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  return a.cents === b.cents ? 0 : a.cents < b.cents ? -1 : 1;
}

export function isZero(value: Money): boolean {
  return value.cents === 0;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.cents === b.cents;
}
