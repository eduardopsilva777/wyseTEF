import { verifyAuditChain, type AuditData, type AuditRecord, type ChainVerification } from '@tef/audit';
import {
  normalizeName,
  normalizeOptionalName,
  PAYMENT_STATES,
  type Customer,
  type CustomerStatus,
  type Merchant,
  type MerchantId,
  type MerchantStatus,
  type Operation,
  type Payment,
  type PaymentId,
  type PaymentState,
  type ProviderId,
  type TenantId,
  type Terminal,
  type TerminalId,
  type TerminalStatus,
} from '@tef/domain';
import type { ProviderRegistry } from '@tef/provider-contract';
import { HasDependenciesError, NotFoundError, ReferenceInvalidError } from './errors.ts';
import type { Actor } from './payment-service.ts';
import type {
  AuditListFilter,
  CatalogListFilter,
  DailyBucket,
  Dependents,
  Job,
  JobStatus,
  PaymentListFilter,
  PeriodFilter,
  Repositories,
  StateTotals,
  UnitOfWork,
  WorkerHeartbeat,
} from './ports.ts';

export interface DashboardSummary {
  readonly totals: {
    readonly payments: number;
    readonly approvedCount: number;
    readonly declinedCount: number;
    readonly unknownCount: number;
    readonly pendingCount: number;
    readonly cancelledCount: number;
    readonly reversedCount: number;
    /** Aprovados / (aprovados + revertidos + recusados). Null sem resultado definitivo. */
    readonly approvalRate: number | null;
  };
  readonly amounts: {
    /** Valor bruto de pagamentos APPROVED. */
    readonly approvedCents: number;
    /** Saldo aprovado líquido (APPROVED menos estornos parciais). */
    readonly netApprovedCents: number;
    readonly reversedCents: number;
    readonly declinedCents: number;
    readonly pendingCents: number;
    readonly unknownCents: number;
    readonly cancelledCents: number;
  };
  readonly byState: Readonly<Record<PaymentState, StateTotals>>;
  readonly unknownOperations: number;
  readonly daily: readonly DailyBucket[];
  readonly recentActivity: readonly AuditRecord[];
}

export interface SystemStatus {
  readonly jobs: Record<JobStatus, number>;
  readonly outboxPending: number;
  readonly workers: readonly WorkerHeartbeat[];
}

export interface PaymentDetail {
  readonly payment: Payment;
  readonly operations: readonly Operation[];
  readonly jobs: readonly Job[];
  readonly audit: readonly AuditRecord[];
  readonly testDirective: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Dia no fuso de São Paulo (AAAA-MM-DD), mesma regra da consulta SQL. */
export function saoPauloDay(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function fillDays(rows: readonly DailyBucket[], from: Date, to: Date): DailyBucket[] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const days: DailyBucket[] = [];
  const seen = new Set<string>();
  for (let t = from.getTime(); t <= to.getTime() + DAY_MS; t += DAY_MS / 2) {
    const day = saoPauloDay(new Date(Math.min(t, to.getTime())));
    if (seen.has(day)) continue;
    seen.add(day);
    days.push(byDay.get(day) ?? { day, approved: 0, declined: 0, other: 0 });
  }
  return days;
}

/**
 * Casos de uso do painel administrativo local (operador da plataforma).
 * Toda alteração de cadastro é auditada. Registros com dependências ou histórico
 * financeiro não são excluídos: devem ser desativados.
 */
export class AdminService {
  private readonly uow: UnitOfWork;
  private readonly providers: ProviderRegistry;
  private readonly clock: () => Date;

  constructor(deps: { uow: UnitOfWork; providers: ProviderRegistry; clock?: () => Date }) {
    this.uow = deps.uow;
    this.providers = deps.providers;
    this.clock = deps.clock ?? (() => new Date());
  }

  // ---------------------------------------------------------------- clientes

  listCustomers(filter: CatalogListFilter): Promise<Customer[]> {
    return this.uow.transaction((r) => r.catalog.listCustomers(filter));
  }

  async getCustomer(id: TenantId): Promise<Customer> {
    const customer = await this.uow.transaction((r) => r.catalog.findCustomer(id));
    if (!customer) throw new NotFoundError('cliente não encontrado');
    return customer;
  }

  createCustomer(actor: Actor, input: { id: TenantId; legalName: string; tradeName?: string | null }): Promise<Customer> {
    const now = this.clock();
    const customer: Customer = {
      id: input.id,
      legalName: normalizeName(input.legalName, 'razão social', 2, 120),
      tradeName: normalizeOptionalName(input.tradeName, 'nome fantasia', 120),
      status: 'ACTIVE',
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    return this.uow.transaction(async (r) => {
      await r.catalog.insertCustomer(customer);
      await this.audit(r, actor, customer.id, 'customer.created', 'customer', customer.id, now, {
        customerId: customer.id,
        name: customer.legalName,
        entityStatus: customer.status,
      });
      return customer;
    });
  }

  updateCustomer(
    actor: Actor,
    id: TenantId,
    patch: { legalName?: string; tradeName?: string | null; status?: CustomerStatus },
  ): Promise<Customer> {
    const now = this.clock();
    return this.uow.transaction(async (r) => {
      const current = await r.catalog.findCustomer(id);
      if (!current) throw new NotFoundError('cliente não encontrado');
      const next: Customer = {
        ...current,
        ...(patch.legalName !== undefined ? { legalName: normalizeName(patch.legalName, 'razão social', 2, 120) } : {}),
        ...(patch.tradeName !== undefined ? { tradeName: normalizeOptionalName(patch.tradeName, 'nome fantasia', 120) } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        version: current.version + 1,
        updatedAt: now,
      };
      await r.catalog.updateCustomer(next, current.version);
      await this.audit(r, actor, id, 'customer.updated', 'customer', id, now, {
        customerId: id,
        name: next.legalName,
        previousStatus: current.status,
        entityStatus: next.status,
      });
      return next;
    });
  }

  deleteCustomer(actor: Actor, id: TenantId): Promise<void> {
    const now = this.clock();
    return this.uow.transaction(async (r) => {
      const current = await r.catalog.findCustomer(id);
      if (!current) throw new NotFoundError('cliente não encontrado');
      this.assertNoDependents(await r.catalog.customerDependents(id), 'cliente');
      await r.catalog.deleteCustomer(id);
      await this.audit(r, actor, id, 'customer.deleted', 'customer', id, now, { customerId: id, name: current.legalName });
    });
  }

  // ---------------------------------------------------------- estabelecimentos

  listMerchants(filter: CatalogListFilter & { customerId?: TenantId }): Promise<Merchant[]> {
    return this.uow.transaction((r) => r.catalog.listMerchants(filter));
  }

  createMerchant(actor: Actor, customerId: TenantId, input: { id: MerchantId; name: string; city?: string | null }): Promise<Merchant> {
    const now = this.clock();
    return this.uow.transaction(async (r) => {
      const customer = await r.catalog.findCustomer(customerId);
      if (!customer) throw new NotFoundError('cliente não encontrado');
      if (customer.status !== 'ACTIVE') throw new ReferenceInvalidError('cliente inativo não recebe novos estabelecimentos');
      const merchant: Merchant = {
        customerId,
        id: input.id,
        name: normalizeName(input.name, 'nome', 2, 120),
        city: normalizeOptionalName(input.city, 'cidade', 80),
        status: 'ACTIVE',
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      await r.catalog.insertMerchant(merchant);
      await this.audit(r, actor, customerId, 'merchant.created', 'merchant', merchant.id, now, {
        customerId,
        merchantId: merchant.id,
        name: merchant.name,
        city: merchant.city,
        entityStatus: merchant.status,
      });
      return merchant;
    });
  }

  updateMerchant(
    actor: Actor,
    customerId: TenantId,
    id: MerchantId,
    patch: { name?: string; city?: string | null; status?: MerchantStatus },
  ): Promise<Merchant> {
    const now = this.clock();
    return this.uow.transaction(async (r) => {
      const current = await r.catalog.findMerchant(customerId, id);
      if (!current) throw new NotFoundError('estabelecimento não encontrado');
      const next: Merchant = {
        ...current,
        ...(patch.name !== undefined ? { name: normalizeName(patch.name, 'nome', 2, 120) } : {}),
        ...(patch.city !== undefined ? { city: normalizeOptionalName(patch.city, 'cidade', 80) } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        version: current.version + 1,
        updatedAt: now,
      };
      await r.catalog.updateMerchant(next, current.version);
      await this.audit(r, actor, customerId, 'merchant.updated', 'merchant', id, now, {
        customerId,
        merchantId: id,
        name: next.name,
        previousStatus: current.status,
        entityStatus: next.status,
      });
      return next;
    });
  }

  deleteMerchant(actor: Actor, customerId: TenantId, id: MerchantId): Promise<void> {
    const now = this.clock();
    return this.uow.transaction(async (r) => {
      const current = await r.catalog.findMerchant(customerId, id);
      if (!current) throw new NotFoundError('estabelecimento não encontrado');
      this.assertNoDependents(await r.catalog.merchantDependents(customerId, id), 'estabelecimento');
      await r.catalog.deleteMerchant(customerId, id);
      await this.audit(r, actor, customerId, 'merchant.deleted', 'merchant', id, now, { customerId, merchantId: id, name: current.name });
    });
  }

  // ----------------------------------------------------------------- terminais

  listTerminals(filter: CatalogListFilter & { customerId?: TenantId; merchantId?: MerchantId }): Promise<Terminal[]> {
    return this.uow.transaction((r) => r.catalog.listTerminals(filter));
  }

  createTerminal(
    actor: Actor,
    customerId: TenantId,
    input: { id: TerminalId; merchantId: MerchantId; label: string; providerId: ProviderId },
  ): Promise<Terminal> {
    const now = this.clock();
    const provider = this.providers.get(input.providerId); // lança se o provedor não estiver registrado
    if (provider.kind !== 'SIMULATOR') {
      throw new ReferenceInvalidError('nesta fase apenas terminais simulados (provedor SIMULATOR) são aceitos');
    }
    return this.uow.transaction(async (r) => {
      const merchant = await r.catalog.findMerchant(customerId, input.merchantId);
      if (!merchant) throw new ReferenceInvalidError('estabelecimento inexistente para este cliente');
      if (merchant.status !== 'ACTIVE') throw new ReferenceInvalidError('estabelecimento inativo não recebe novos terminais');
      const terminal: Terminal = {
        customerId,
        id: input.id,
        merchantId: input.merchantId,
        label: normalizeName(input.label, 'identificação', 1, 80),
        providerId: input.providerId,
        mode: 'SIMULATED',
        status: 'ACTIVE',
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      await r.catalog.insertTerminal(terminal);
      await this.audit(r, actor, customerId, 'terminal.created', 'terminal', terminal.id, now, {
        customerId,
        merchantId: terminal.merchantId,
        terminalId: terminal.id,
        label: terminal.label,
        providerId: terminal.providerId,
        entityStatus: terminal.status,
      });
      return terminal;
    });
  }

  updateTerminal(
    actor: Actor,
    customerId: TenantId,
    id: TerminalId,
    patch: { label?: string; status?: TerminalStatus },
  ): Promise<Terminal> {
    const now = this.clock();
    return this.uow.transaction(async (r) => {
      const current = await r.catalog.findTerminal(customerId, id);
      if (!current) throw new NotFoundError('terminal não encontrado');
      const next: Terminal = {
        ...current,
        ...(patch.label !== undefined ? { label: normalizeName(patch.label, 'identificação', 1, 80) } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        version: current.version + 1,
        updatedAt: now,
      };
      await r.catalog.updateTerminal(next, current.version);
      await this.audit(r, actor, customerId, 'terminal.updated', 'terminal', id, now, {
        customerId,
        terminalId: id,
        label: next.label,
        previousStatus: current.status,
        entityStatus: next.status,
      });
      return next;
    });
  }

  deleteTerminal(actor: Actor, customerId: TenantId, id: TerminalId): Promise<void> {
    const now = this.clock();
    return this.uow.transaction(async (r) => {
      const current = await r.catalog.findTerminal(customerId, id);
      if (!current) throw new NotFoundError('terminal não encontrado');
      this.assertNoDependents(await r.catalog.terminalDependents(customerId, id), 'terminal');
      await r.catalog.deleteTerminal(customerId, id);
      await this.audit(r, actor, customerId, 'terminal.deleted', 'terminal', id, now, { customerId, terminalId: id, label: current.label });
    });
  }

  // ------------------------------------------------------------------ leituras

  async dashboard(filter: PeriodFilter): Promise<DashboardSummary> {
    return this.uow.transaction(async (r) => {
      const to = filter.to ?? this.clock();
      const from = filter.from && to.getTime() - filter.from.getTime() <= 62 * DAY_MS ? filter.from : new Date(to.getTime() - 13 * DAY_MS);
      const data = await r.reporting.dashboard(filter, { from, to });
      const recentActivity = await r.reporting.listAudit({ ...(filter.customerId ? { tenantId: filter.customerId } : {}), limit: 12 });
      const s = data.byState;
      const pending = (['CREATED', 'PROCESSING', 'AUTHORIZED'] as const).reduce(
        (acc, k) => ({ count: acc.count + s[k].count, cents: acc.cents + s[k].amountCents }),
        { count: 0, cents: 0 },
      );
      const decided = s.APPROVED.count + s.REVERSED.count + s.DECLINED.count;
      return {
        totals: {
          payments: PAYMENT_STATES.reduce((acc, k) => acc + s[k].count, 0),
          approvedCount: s.APPROVED.count,
          declinedCount: s.DECLINED.count,
          unknownCount: s.UNKNOWN.count,
          pendingCount: pending.count,
          cancelledCount: s.CANCELLED.count,
          reversedCount: s.REVERSED.count,
          approvalRate: decided === 0 ? null : (s.APPROVED.count + s.REVERSED.count) / decided,
        },
        amounts: {
          approvedCents: s.APPROVED.amountCents,
          netApprovedCents: s.APPROVED.amountCents - s.APPROVED.reversedCents,
          reversedCents: PAYMENT_STATES.reduce((acc, k) => acc + s[k].reversedCents, 0),
          declinedCents: s.DECLINED.amountCents,
          pendingCents: pending.cents,
          unknownCents: s.UNKNOWN.amountCents,
          cancelledCents: s.CANCELLED.amountCents,
        },
        byState: s,
        unknownOperations: data.unknownOperations,
        daily: fillDays(data.daily, from, to),
        recentActivity,
      };
    });
  }

  listPayments(filter: PaymentListFilter): Promise<Payment[]> {
    return this.uow.transaction((r) => r.reporting.listPayments(filter));
  }

  async paymentDetail(customerId: TenantId, paymentId: PaymentId): Promise<PaymentDetail> {
    return this.uow.transaction(async (r) => {
      const payment = await r.payments.findById(customerId, paymentId);
      if (!payment) throw new NotFoundError('pagamento não encontrado');
      const operations = await r.operations.listByPayment(customerId, paymentId);
      const opIds = new Set<string>(operations.map((o) => o.id));
      const audit = (await r.reporting.listAudit({ tenantId: customerId, limit: 200 })).filter(
        (e) => e.resourceId === paymentId || opIds.has(e.resourceId),
      );
      return {
        payment,
        operations,
        jobs: await r.jobs.listByPayment(customerId, paymentId),
        audit,
        testDirective: await r.testDirectives.get(paymentId),
      };
    });
  }

  listAudit(filter: AuditListFilter): Promise<AuditRecord[]> {
    return this.uow.transaction((r) => r.reporting.listAudit(filter));
  }

  async verifyAudit(tenantId: TenantId): Promise<ChainVerification & { readonly records: number }> {
    const chain = await this.uow.transaction((r) => r.reporting.auditChain(tenantId));
    return { ...verifyAuditChain(chain), records: chain.length };
  }

  systemStatus(): Promise<SystemStatus> {
    return this.uow.transaction(async (r) => ({
      jobs: await r.jobs.countByStatus(),
      outboxPending: await r.outbox.countUnpublished(),
      workers: await r.heartbeats.list(),
    }));
  }

  // ---------------------------------------------------------------- auxiliares

  private assertNoDependents(dependents: Dependents, label: string): void {
    const total = dependents.merchants + dependents.terminals + dependents.payments;
    if (total > 0) {
      throw new HasDependenciesError(
        `${label} possui ${dependents.merchants} estabelecimento(s), ${dependents.terminals} terminal(is) e ${dependents.payments} pagamento(s); desative em vez de excluir`,
      );
    }
  }

  private async audit(
    r: Repositories,
    actor: Actor,
    tenantId: TenantId,
    action: string,
    resourceType: 'customer' | 'merchant' | 'terminal',
    resourceId: string,
    now: Date,
    data: AuditData,
  ): Promise<void> {
    await r.audit.append({
      tenantId,
      occurredAt: now,
      actorType: actor.type,
      actorId: actor.id,
      action,
      resourceType,
      resourceId,
      correlationId: null,
      data,
    });
  }
}
