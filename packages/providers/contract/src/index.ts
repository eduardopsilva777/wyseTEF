import type {
  Money,
  OperationId,
  OperationKind,
  PaymentId,
  ProviderCapabilities,
  ProviderId,
  TerminalId,
} from '@tef/domain';

export type { ProviderCapabilities } from '@tef/domain';

/**
 * Contrato que todo adaptador de provedor implementa. Os adaptadores TRADUZEM;
 * não decidem regra de negócio nem transição de estado (isso é do domínio).
 *
 * Regras obrigatórias para implementações:
 *  - nunca receber, registrar ou devolver PAN completo, CVV, trilha ou PIN;
 *  - só retornar NOT_SENT quando houver garantia de que nada foi enviado E a
 *    capacidade `guaranteesNotSentOnPreSendFailure` estiver declarada;
 *  - em qualquer dúvida após um possível envio, retornar UNKNOWN (ou lançar erro,
 *    que a aplicação trata como UNKNOWN);
 *  - respeitar o AbortSignal: ao ser abortado, a aplicação registra UNKNOWN;
 *  - `kind` = 'SIMULATOR' só para o simulador. Adaptadores reais usam 'OFFICIAL'
 *    e só podem existir com documentação e autorização formais do provedor.
 */
export interface PaymentProvider {
  readonly id: ProviderId;
  readonly kind: 'SIMULATOR' | 'OFFICIAL';
  readonly capabilities: ProviderCapabilities;
  execute(request: ProviderOperationRequest, signal: AbortSignal): Promise<ProviderOperationResult>;
  /** Obrigatório quando `capabilities.query` for `true`. */
  query?(request: ProviderQueryRequest, signal: AbortSignal): Promise<ProviderQueryResult>;
}

export interface ProviderOperationRequest {
  readonly kind: OperationKind;
  /** Referência única enviada ao provedor; usada depois para consulta e conciliação. */
  readonly clientReference: OperationId;
  readonly paymentId: PaymentId;
  readonly terminalId: TerminalId;
  readonly amount: Money;
  /** Referência do provedor para a autorização original (confirmação, desfazimento, cancelamento, estorno). */
  readonly originalProviderReference: string | null;
}

export type ProviderOperationResult =
  | {
      readonly status: 'SUCCEEDED';
      readonly providerReference: string;
      readonly resultCode?: string;
      /** Apenas autorização: o provedor exige confirmação (duas fases). */
      readonly requiresConfirmation?: boolean;
    }
  | { readonly status: 'REJECTED'; readonly providerReference?: string; readonly resultCode: string }
  | { readonly status: 'ABORTED'; readonly providerReference?: string; readonly resultCode: string }
  | { readonly status: 'NOT_SENT'; readonly resultCode: string }
  | { readonly status: 'UNKNOWN'; readonly resultCode: string };

export interface ProviderQueryRequest {
  readonly kind: OperationKind;
  readonly clientReference: OperationId;
  readonly terminalId: TerminalId;
}

export type ProviderQueryResult =
  | {
      readonly status: 'FOUND';
      readonly outcome: 'SUCCEEDED' | 'REJECTED' | 'ABORTED';
      readonly providerReference: string;
      readonly resultCode?: string;
      readonly requiresConfirmation?: boolean;
    }
  | { readonly status: 'NOT_FOUND' }
  | { readonly status: 'UNAVAILABLE'; readonly resultCode: string };

/** Notificação assíncrona do provedor (webhook/callback), já autenticada pelo adaptador. */
export interface ProviderNotification {
  readonly providerId: ProviderId;
  readonly clientReference: OperationId;
  readonly result: Exclude<ProviderOperationResult, { status: 'NOT_SENT' | 'UNKNOWN' }>;
}

export interface ProviderRegistry {
  get(id: ProviderId): PaymentProvider;
}

export class UnknownProviderError extends Error {
  readonly code = 'UNKNOWN_PROVIDER';
}

export function createProviderRegistry(providers: readonly PaymentProvider[]): ProviderRegistry {
  const byId = new Map(providers.map((p) => [p.id as string, p]));
  return {
    get(id) {
      const provider = byId.get(id);
      if (!provider) throw new UnknownProviderError(`provedor não registrado: ${id}`);
      return provider;
    },
  };
}
