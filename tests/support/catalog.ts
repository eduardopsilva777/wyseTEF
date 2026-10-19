import { AdminService, DuplicateCodeError, type UnitOfWork } from '@tef/application';
import { parseMerchantId, parseTenantId, parseTerminalId } from '@tef/domain';
import { createProviderRegistry } from '@tef/provider-contract';
import { PaymentSimulator, SIMULATOR_PROVIDER_ID } from '@tef/provider-simulator';

export interface CatalogSpec {
  readonly customer: string;
  readonly merchants: readonly { readonly id: string; readonly terminals: readonly string[] }[];
}

/** Cadastro fictício usado pelos testes: tenant-a (2 estabelecimentos) e tenant-b. */
export const TEST_CATALOG: readonly CatalogSpec[] = [
  {
    customer: 'tenant-a',
    merchants: [
      { id: 'merchant-1', terminals: ['terminal-1'] },
      { id: 'merchant-2', terminals: ['terminal-2'] },
    ],
  },
  { customer: 'tenant-b', merchants: [{ id: 'merchant-1', terminals: ['terminal-1'] }] },
];

/** Popula o cadastro pelo caminho real (AdminService, com auditoria). Idempotente. */
export async function seedCatalog(uow: UnitOfWork, spec: readonly CatalogSpec[] = TEST_CATALOG): Promise<void> {
  const admin = new AdminService({ uow, providers: createProviderRegistry([new PaymentSimulator()]) });
  const actor = { type: 'SYSTEM' as const, id: 'test-seed' };
  const ignoreDuplicate = async (work: () => Promise<unknown>): Promise<void> => {
    try {
      await work();
    } catch (error) {
      if (!(error instanceof DuplicateCodeError)) throw error;
    }
  };
  for (const c of spec) {
    const customerId = parseTenantId(c.customer);
    await ignoreDuplicate(() => admin.createCustomer(actor, { id: customerId, legalName: `Cliente fictício ${c.customer}` }));
    for (const m of c.merchants) {
      const merchantId = parseMerchantId(m.id);
      await ignoreDuplicate(() => admin.createMerchant(actor, customerId, { id: merchantId, name: `Estabelecimento ${m.id}` }));
      for (const t of m.terminals) {
        await ignoreDuplicate(() =>
          admin.createTerminal(actor, customerId, { id: parseTerminalId(t), merchantId, label: `Terminal simulado ${t}`, providerId: SIMULATOR_PROVIDER_ID }),
        );
      }
    }
  }
}
