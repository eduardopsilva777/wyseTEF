import type { OperationStatus, PaymentState } from './api.ts';

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const dateTime = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'America/Sao_Paulo' });
const dayMonth = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });

/** Centavos inteiros -> texto em reais. Nenhum cálculo é feito em ponto flutuante. */
export const money = (cents: number): string => brl.format(cents / 100);
export const when = (iso: string): string => dateTime.format(new Date(iso));
export const shortDay = (day: string): string => dayMonth.format(new Date(`${day}T00:00:00Z`));

/** Converte "12,34" ou "12.34" em centavos inteiros sem ponto flutuante. */
export function parseCents(input: string): number | null {
  const normalized = input.trim().replace(/\s/g, '').replace(/^R\$/, '');
  const m = /^(\d{1,9})(?:[.,](\d{1,2}))?$/.exec(normalized);
  if (!m) return null;
  const reais = Number(m[1]);
  const centavos = Number((m[2] ?? '0').padEnd(2, '0'));
  const total = reais * 100 + centavos;
  return Number.isSafeInteger(total) && total > 0 ? total : null;
}

export const STATE_LABEL: Record<PaymentState, string> = {
  CREATED: 'Criado',
  PROCESSING: 'Processando',
  AUTHORIZED: 'Autorizado',
  APPROVED: 'Aprovado',
  DECLINED: 'Recusado',
  UNKNOWN: 'Resultado desconhecido',
  CANCELLED: 'Cancelado',
  REVERSED: 'Revertido',
};

export const OPERATION_STATUS_LABEL: Record<OperationStatus, string> = {
  PENDING: 'Na fila',
  IN_FLIGHT: 'Enviada',
  UNKNOWN: 'Sem resposta definitiva',
  SUCCEEDED: 'Concluída',
  REJECTED: 'Recusada',
  ABORTED: 'Abandonada',
  NOT_SENT: 'Não enviada',
};

export const OPERATION_KIND_LABEL: Record<string, string> = {
  AUTHORIZATION: 'Autorização',
  CONFIRMATION: 'Confirmação',
  UNDO: 'Desfazimento',
  CANCELLATION: 'Cancelamento',
  REFUND: 'Estorno',
};

export const EVIDENCE_LABEL: Record<string, string> = {
  LOCAL_NO_CONTACT: 'sem contato com o provedor',
  ADAPTER_NOT_SENT: 'adaptador garante que não enviou',
  PROVIDER_RESPONSE: 'resposta do provedor',
  PROVIDER_NOTIFICATION: 'notificação do provedor',
  PROVIDER_QUERY: 'consulta ao provedor',
  RECONCILIATION_FILE: 'arquivo de conciliação',
  MANUAL_RESOLUTION: 'resolução manual',
};

/** Tom visual do estado (cor + ícone sempre acompanham o rótulo). */
export type Tone = 'good' | 'bad' | 'warn' | 'busy' | 'neutral' | 'undone';
export const STATE_TONE: Record<PaymentState, Tone> = {
  CREATED: 'neutral',
  PROCESSING: 'busy',
  AUTHORIZED: 'busy',
  APPROVED: 'good',
  DECLINED: 'bad',
  UNKNOWN: 'warn',
  CANCELLED: 'neutral',
  REVERSED: 'undone',
};

export const ACTION_LABEL: Record<string, string> = {
  'payment.created': 'Pagamento criado',
  'payment.state_changed': 'Estado do pagamento alterado',
  'payment.balance_changed': 'Saldo do pagamento alterado',
  'operation.requested': 'Operação solicitada',
  'operation.dispatched': 'Operação enviada ao provedor',
  'operation.result_recorded': 'Resultado registrado',
  'operation.conflicting_evidence': 'Evidência conflitante rejeitada',
  'operation.reconciliation_requested': 'Reconciliação solicitada',
  'customer.created': 'Cliente cadastrado',
  'customer.updated': 'Cliente alterado',
  'customer.deleted': 'Cliente excluído',
  'merchant.created': 'Estabelecimento cadastrado',
  'merchant.updated': 'Estabelecimento alterado',
  'merchant.deleted': 'Estabelecimento excluído',
  'terminal.created': 'Terminal cadastrado',
  'terminal.updated': 'Terminal alterado',
  'terminal.deleted': 'Terminal excluído',
};
