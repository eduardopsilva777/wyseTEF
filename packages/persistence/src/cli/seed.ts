import { AdminService, DuplicateCodeError, PaymentService } from '@tef/application';
import { money, parseMerchantId, parseTenantId, parseTerminalId } from '@tef/domain';
import { createProviderRegistry } from '@tef/provider-contract';
import { PaymentSimulator, SIMULATOR_PROVIDER_ID, type SimulatorDirective } from '@tef/provider-simulator';
import { redactSensitiveText } from '@tef/audit';
import { createPgPool, PgUnitOfWork } from '../postgres/index.ts';

/**
 * Dados FICTÍCIOS de demonstração. Nunca apaga nem altera nada:
 *  - cadastro: insere só o que não existe (código duplicado é ignorado);
 *  - pagamentos: chaves de idempotência fixas, então rodar de novo apenas
 *    devolve os pagamentos já criados.
 * Os pagamentos ficam na fila; o worker os processa.
 * Uso: DATABASE_URL=... npm run db:seed
 */
const connectionString = process.env['DATABASE_URL'];
if (!connectionString) {
  console.error('DATABASE_URL não definido (carregue o .env)');
  process.exit(1);
}

const CATALOG = [
  {
    id: 'demo-mercado',
    legalName: 'Mercado Exemplo Ltda (fictício)',
    tradeName: 'Mercado Exemplo',
    merchants: [
      { id: 'loja-centro', name: 'Loja Centro', city: 'São Paulo', terminals: [['caixa-01', 'Caixa 01'], ['caixa-02', 'Caixa 02']] },
      { id: 'loja-norte', name: 'Loja Zona Norte', city: 'São Paulo', terminals: [['caixa-01-norte', 'Caixa 01']] },
    ],
  },
  {
    id: 'demo-farmacia',
    legalName: 'Farmácia Modelo S.A. (fictícia)',
    tradeName: 'Farmácia Modelo',
    merchants: [{ id: 'unidade-sul', name: 'Unidade Sul', city: 'Curitiba', terminals: [['totem-entrada', 'Totem da entrada']] }],
  },
] as const;

const PAYMENTS: { key: string; customer: string; merchant: string; terminal: string; cents: number; directive: SimulatorDirective }[] = [
  { key: 'seed-demo-001', customer: 'demo-mercado', merchant: 'loja-centro', terminal: 'caixa-01', cents: 4_590, directive: 'APPROVE' },
  { key: 'seed-demo-002', customer: 'demo-mercado', merchant: 'loja-centro', terminal: 'caixa-02', cents: 12_000, directive: 'APPROVE' },
  { key: 'seed-demo-003', customer: 'demo-mercado', merchant: 'loja-norte', terminal: 'caixa-01-norte', cents: 2_750, directive: 'DECLINE' },
  { key: 'seed-demo-004', customer: 'demo-mercado', merchant: 'loja-centro', terminal: 'caixa-01', cents: 8_990, directive: 'TIMEOUT_AFTER_SEND' },
  { key: 'seed-demo-005', customer: 'demo-farmacia', merchant: 'unidade-sul', terminal: 'totem-entrada', cents: 3_420, directive: 'APPROVE' },
  { key: 'seed-demo-006', customer: 'demo-farmacia', merchant: 'unidade-sul', terminal: 'totem-entrada', cents: 15_800, directive: 'COMMUNICATION_FAILURE' },
];

const pool = createPgPool({ connectionString, max: 2 });
const uow = new PgUnitOfWork(pool);
const providers = createProviderRegistry([new PaymentSimulator()]);
const admin = new AdminService({ uow, providers });
const payments = new PaymentService({ uow, providers, providerTimeoutMs: 5_000 });
const actor = { type: 'SYSTEM' as const, id: 'demo-seed' };
const created = { customers: 0, merchants: 0, terminals: 0, payments: 0, alreadyExisting: 0 };

const once = async (work: () => Promise<unknown>, counter: keyof typeof created): Promise<void> => {
  try {
    await work();
    created[counter]++;
  } catch (error) {
    if (!(error instanceof DuplicateCodeError)) throw error;
    created.alreadyExisting++;
  }
};

try {
  for (const c of CATALOG) {
    const customerId = parseTenantId(c.id);
    await once(() => admin.createCustomer(actor, { id: customerId, legalName: c.legalName, tradeName: c.tradeName }), 'customers');
    for (const m of c.merchants) {
      const merchantId = parseMerchantId(m.id);
      await once(() => admin.createMerchant(actor, customerId, { id: merchantId, name: m.name, city: m.city }), 'merchants');
      for (const [id, label] of m.terminals) {
        await once(
          () => admin.createTerminal(actor, customerId, { id: parseTerminalId(id), merchantId, label, providerId: SIMULATOR_PROVIDER_ID }),
          'terminals',
        );
      }
    }
  }
  for (const p of PAYMENTS) {
    const result = await payments.createPayment(
      { tenantId: parseTenantId(p.customer), actor, correlationId: null },
      {
        merchantId: parseMerchantId(p.merchant),
        terminalId: parseTerminalId(p.terminal),
        externalReference: p.key,
        amount: money(p.cents),
        authorize: true,
        testDirective: p.directive,
      },
      p.key,
    );
    if (result.replayed) created.alreadyExisting++;
    else created.payments++;
  }
  console.log(JSON.stringify({ seeded: created, note: 'dados fictícios; pagamentos ficam na fila até o worker processar' }));
} catch (error) {
  console.error('falha ao popular dados de demonstração:', error instanceof Error ? redactSensitiveText(error.message) : 'erro desconhecido');
  process.exitCode = 1;
} finally {
  await pool.end();
}
