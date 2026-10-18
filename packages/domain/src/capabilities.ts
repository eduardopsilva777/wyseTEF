/**
 * Capacidades que cada provedor DECLARA a partir da sua documentação oficial.
 * O domínio só permite um comportamento quando a capacidade correspondente
 * está declarada; na dúvida, o valor seguro é `false`.
 */
export interface ProviderCapabilities {
  /** Autorização em duas fases: aprovação seguida de confirmação pela automação. */
  readonly twoPhaseConfirmation: boolean;
  /** Desfazimento: reversão técnica de uma autorização ainda não confirmada. */
  readonly undo: boolean;
  /** Cancelamento: anulação comercial, pelo valor total, de uma transação aprovada. */
  readonly cancellation: boolean;
  /** Estorno: devolução de valor de uma transação aprovada. */
  readonly refund: {
    readonly full: boolean;
    readonly partial: boolean;
  };
  /** Consulta do resultado de uma operação pela referência enviada pelo cliente. */
  readonly query: boolean;
  /**
   * Quando `true`, uma consulta que responde "não encontrado" prova que a operação
   * nunca foi processada. Só declare se a documentação oficial garantir isso.
   */
  readonly queryNotFoundIsDefinitive: boolean;
  /**
   * Quando `true`, o adaptador consegue garantir que uma falha ocorreu ANTES de
   * qualquer envio ao provedor (ex.: conexão nunca estabelecida).
   */
  readonly guaranteesNotSentOnPreSendFailure: boolean;
}

/** Perfil mínimo e conservador: nada além da autorização simples. */
export const NO_OPTIONAL_CAPABILITIES: ProviderCapabilities = Object.freeze({
  twoPhaseConfirmation: false,
  undo: false,
  cancellation: false,
  refund: Object.freeze({ full: false, partial: false }),
  query: false,
  queryNotFoundIsDefinitive: false,
  guaranteesNotSentOnPreSendFailure: false,
});
