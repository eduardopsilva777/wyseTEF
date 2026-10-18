import { InMemoryUnitOfWork } from '@tef/persistence/memory';
import { describePaymentServiceSuite } from '../support/service-suite.ts';

// Cada teste recebe uma unidade de trabalho nova; a última é usada nas inspeções.
let current = new InMemoryUnitOfWork();

describePaymentServiceSuite({
  name: 'memória',
  uow: () => (current = new InMemoryUnitOfWork()),
  auditFor: async (tenantId) => current.snapshot().audit.filter((r) => r.tenantId === tenantId),
  outboxEventTypes: async (paymentId) =>
    current.snapshot().outbox.filter((e) => e.aggregateId === paymentId).map((e) => e.eventType),
});
