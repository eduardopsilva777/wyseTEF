import { InMemoryUnitOfWork } from '@tef/persistence/memory';
import { seedCatalog } from '../support/catalog.ts';
import { describeAsyncSuite } from '../support/async-suite.ts';

let current = new InMemoryUnitOfWork();

describeAsyncSuite({
  name: 'memória',
  uow: async (clock) => {
    current = new InMemoryUnitOfWork({ clock: () => new Date(clock.ms) });
    await seedCatalog(current);
    return current;
  },
  advanceQueue: (clock, ms) => {
    clock.ms += ms;
    return Promise.resolve();
  },
  resultCount: async (tenantId, operationId) =>
    current.snapshot().audit.filter((r) => r.tenantId === tenantId && r.resourceId === operationId && r.action === 'operation.result_recorded').length,
  dispatchCount: async (tenantId, operationId) =>
    current.snapshot().audit.filter((r) => r.tenantId === tenantId && r.resourceId === operationId && r.action === 'operation.dispatched').length,
});
