import { InMemoryUnitOfWork } from '@tef/persistence/memory';
import { seedCatalog } from '../support/catalog.ts';
import { describePaymentServiceSuite } from '../support/service-suite.ts';

// Cada teste recebe uma unidade de trabalho nova; a última é usada nas inspeções.
let current = new InMemoryUnitOfWork();

describePaymentServiceSuite({
  name: 'memória',
  uow: async () => {
    current = new InMemoryUnitOfWork();
    await seedCatalog(current);
    return current;
  },
  auditFor: async (tenantId) => current.snapshot().audit.filter((r) => r.tenantId === tenantId),
  outboxEventTypes: async (paymentId) =>
    current.snapshot().outbox.filter((e) => e.aggregateId === paymentId).map((e) => e.eventType),
});
