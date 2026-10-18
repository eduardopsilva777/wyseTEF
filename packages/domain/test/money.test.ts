import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { add, compare, InvalidAmountError, MAX_TRANSACTION_CENTS, money, positiveMoney, subtract } from '../src/index.ts';

describe('Money (centavos inteiros)', () => {
  it('aceita inteiros dentro do limite', () => {
    expect(money(0).cents).toBe(0);
    expect(positiveMoney(1).cents).toBe(1);
    expect(money(MAX_TRANSACTION_CENTS).cents).toBe(MAX_TRANSACTION_CENTS);
  });

  it.each([
    ['fração', 10.5],
    ['NaN', Number.NaN],
    ['infinito', Number.POSITIVE_INFINITY],
    ['negativo', -1],
    ['acima do limite', MAX_TRANSACTION_CENTS + 1],
    ['inteiro inseguro', Number.MAX_SAFE_INTEGER + 2],
  ])('rejeita %s', (_label, value) => {
    expect(() => money(value)).toThrow(InvalidAmountError);
  });

  it('rejeita zero quando o valor deve ser positivo', () => {
    expect(() => positiveMoney(0)).toThrow(InvalidAmountError);
  });

  it('rejeita moeda não suportada', () => {
    expect(() => money(100, 'USD')).toThrow(InvalidAmountError);
  });

  it('não permite subtração com resultado negativo', () => {
    expect(() => subtract(money(100), money(101))).toThrow(InvalidAmountError);
  });

  it('não permite soma acima do limite técnico', () => {
    expect(() => add(money(MAX_TRANSACTION_CENTS), money(1))).toThrow(InvalidAmountError);
  });

  it('o exemplo clássico de ponto flutuante não ocorre (10 + 20 centavos = 30)', () => {
    expect(add(money(10), money(20)).cents).toBe(30);
  });

  const cents = fc.integer({ min: 0, max: Math.floor(MAX_TRANSACTION_CENTS / 2) });

  it('propriedade: soma é comutativa e sempre inteira', () => {
    fc.assert(
      fc.property(cents, cents, (a, b) => {
        const x = add(money(a), money(b));
        expect(x.cents).toBe(add(money(b), money(a)).cents);
        expect(Number.isInteger(x.cents)).toBe(true);
      }),
    );
  });

  it('propriedade: subtrair o que foi somado devolve o original', () => {
    fc.assert(
      fc.property(cents, cents, (a, b) => {
        expect(subtract(add(money(a), money(b)), money(b)).cents).toBe(a);
      }),
    );
  });

  it('propriedade: compare é coerente com a ordem dos inteiros', () => {
    fc.assert(
      fc.property(cents, cents, (a, b) => {
        expect(compare(money(a), money(b))).toBe(Math.sign(a - b));
      }),
    );
  });
});
