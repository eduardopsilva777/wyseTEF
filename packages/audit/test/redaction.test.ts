import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { redactSensitiveText } from '../src/index.ts';

// Valores de teste gerados em tempo de execução.
const KEY = randomBytes(32).toString('base64url');
const HEX = randomBytes(32).toString('hex');
const PASSWORD = `pw-${randomBytes(6).toString('hex')}`;
const TEST_PAN = ['4111', '1111', '1111', '1111'].join('');

describe('redactSensitiveText', () => {
  it.each([
    ['URL com credencial', `connect ${['postgres://u', `${PASSWORD}@h:5432/db`].join(':')} failed`, PASSWORD],
    ['Bearer', `header Authorization: Bearer ${KEY}`, KEY],
    ['atribuição password=', `password=${PASSWORD} host=x`, PASSWORD],
    ['atribuição JSON', `{"apiKey": "${PASSWORD}"}`, PASSWORD],
    ['senha em português', `senha: ${PASSWORD}`, PASSWORD],
    ['número longo (PAN)', `cartao ${TEST_PAN} recusado`, TEST_PAN],
    ['hash hex', `hash ${HEX}`, HEX],
    ['chave base64url solta', `valor ${KEY}`, KEY],
  ])('remove %s', (_label, input, secret) => {
    const output = redactSensitiveText(input);
    expect(output).not.toContain(secret);
    expect(output).toContain('[REDACTED');
  });

  it('remove chave privada', () => {
    const pem = ['-----BEGIN', 'PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'].join(' ');
    expect(redactSensitiveText(`x ${pem} y`)).toBe('x [REDACTED_PRIVATE_KEY] y');
  });

  it('preserva identificadores internos e mensagens comuns', () => {
    const msg = 'operação op_0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b do pagamento pay_0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b falhou com 23505';
    expect(redactSensitiveText(msg)).toBe(msg);
    expect(redactSensitiveText('duplicate key value violates unique constraint "payments_protected_reference_uq"'))
      .toBe('duplicate key value violates unique constraint "payments_protected_reference_uq"');
  });

  it('trunca textos longos', () => {
    expect(redactSensitiveText('a b '.repeat(1_000), 50)).toHaveLength(50 + '…[truncated]'.length);
  });
});
