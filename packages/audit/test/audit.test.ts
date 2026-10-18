import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  chainAuditEvent,
  GENESIS_HASH,
  sanitizeAuditData,
  verifyAuditChain,
  type AuditEventInput,
  type AuditRecord,
} from '../src/index.ts';

// Número de teste público (não pertence a cartão real), montado em tempo de
// execução para que nenhum literal semelhante a PAN fique no repositório.
const TEST_PAN = ['4111', '1111', '1111', '1111'].join('');

const event = (n: number): AuditEventInput => ({
  tenantId: 'tenant-a',
  occurredAt: new Date(Date.UTC(2026, 9, 18, 12, 0, n)),
  actorType: 'SYSTEM',
  actorId: 'test',
  action: 'payment.state_changed',
  resourceType: 'payment',
  resourceId: `pay_${n}`,
  correlationId: null,
  data: { fromState: 'CREATED', toState: 'PROCESSING', amountCents: n },
});

function chain(size: number): AuditRecord[] {
  const records: AuditRecord[] = [];
  for (let i = 1; i <= size; i++) {
    const last = records.at(-1);
    records.push(chainAuditEvent(last ? { seq: last.seq, hash: last.hash } : null, event(i)));
  }
  return records;
}

describe('JSON canônico', () => {
  it('independe da ordem das chaves', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it('rejeita valores sem representação estável', () => {
    expect(() => canonicalJson({ x: Number.NaN })).toThrow();
    expect(() => canonicalJson({ x: 1n })).toThrow();
    expect(() => canonicalJson([undefined])).toThrow();
  });

  it('propriedade: objetos com as mesmas entradas em ordem diferente geram a mesma serialização', () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.oneof(fc.integer(), fc.string(), fc.boolean())), (dict) => {
        const reversed = Object.fromEntries(Object.entries(dict).reverse());
        expect(canonicalJson(reversed)).toBe(canonicalJson(dict));
      }),
    );
  });
});

describe('cadeia de auditoria', () => {
  it('começa no hash gênese e encadeia', () => {
    const records = chain(3);
    expect(records[0]!.prevHash).toBe(GENESIS_HASH);
    expect(records[1]!.prevHash).toBe(records[0]!.hash);
    expect(verifyAuditChain(records)).toEqual({ valid: true, head: { seq: 3, hash: records[2]!.hash } });
  });

  it('detecta conteúdo alterado', () => {
    const records = chain(3);
    const tampered = [...records];
    tampered[1] = { ...records[1]!, data: { ...records[1]!.data, amountCents: 999 } };
    expect(verifyAuditChain(tampered)).toMatchObject({ valid: false, brokenAtSeq: 2 });
  });

  it('detecta remoção de registro', () => {
    const records = chain(3);
    expect(verifyAuditChain([records[0]!, records[2]!])).toMatchObject({ valid: false, brokenAtSeq: 3 });
  });

  it('detecta reordenação', () => {
    const records = chain(3);
    expect(verifyAuditChain([records[1]!, records[0]!, records[2]!])).toMatchObject({ valid: false });
  });
});

describe('sanitização dos dados de auditoria', () => {
  it('descarta campos fora da lista permitida, inclusive campos sensíveis', () => {
    const data = sanitizeAuditData({
      toState: 'APPROVED',
      pan: TEST_PAN,
      cvv: '123',
      authorization: 'Bearer abc',
      apiKey: 'segredo',
      track2: `;${TEST_PAN}=2512?`,
      pinBlock: '0000',
    });
    expect(data).toEqual({ toState: 'APPROVED' });
  });

  it('o registro encadeado contém apenas dados sanitizados', () => {
    const record = chainAuditEvent(null, { ...event(1), data: { toState: 'X', cvv: 'cvv-sentinela' } as never });
    expect(record.data).toEqual({ toState: 'X' });
    expect(JSON.stringify(record)).not.toContain('cvv-sentinela');
  });

  it('limita o tamanho dos valores', () => {
    expect(sanitizeAuditData({ reason: 'x'.repeat(1_000) }).reason).toHaveLength(200);
  });
});
