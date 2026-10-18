import { EvidenceRequiredError } from './errors.ts';

/**
 * De onde vem a informação que sustenta um resultado. Resultados definitivos
 * (recusa, cancelamento, reversão, aprovação) exigem evidência apropriada;
 * a ausência de resposta NUNCA é evidência de falha.
 */
export const EVIDENCE_SOURCES = [
  /** Nada foi enviado ao provedor (ex.: desistência antes de iniciar). */
  'LOCAL_NO_CONTACT',
  /** O adaptador garante falha antes do envio (exige capacidade declarada). */
  'ADAPTER_NOT_SENT',
  /** Resposta síncrona do provedor à própria operação. */
  'PROVIDER_RESPONSE',
  /** Notificação autenticada enviada pelo provedor. */
  'PROVIDER_NOTIFICATION',
  /** Resultado de consulta ao provedor. */
  'PROVIDER_QUERY',
  /** Arquivo de conciliação oficial do provedor. */
  'RECONCILIATION_FILE',
  /** Resolução manual com dupla aprovação e documento de suporte. */
  'MANUAL_RESOLUTION',
] as const;

export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

export interface ManualResolution {
  readonly resolvedBy: string;
  readonly approvedBy: string;
  readonly justification: string;
  /** Referência ao documento de suporte (chamado, extrato). Nunca dados de cartão. */
  readonly supportingDocumentRef: string;
}

export interface Evidence {
  readonly source: EvidenceSource;
  readonly observedAt: Date;
  readonly providerReference?: string;
  readonly manual?: ManualResolution;
}

/** Fontes que vêm do provedor ou de conciliação, aptas a resolver UNKNOWN. */
export const RESOLUTION_SOURCES: readonly EvidenceSource[] = [
  'PROVIDER_RESPONSE',
  'PROVIDER_NOTIFICATION',
  'PROVIDER_QUERY',
  'RECONCILIATION_FILE',
  'MANUAL_RESOLUTION',
];

/** Fontes diretas do provedor durante o processamento normal. */
export const PROVIDER_SOURCES: readonly EvidenceSource[] = [
  'PROVIDER_RESPONSE',
  'PROVIDER_NOTIFICATION',
  'PROVIDER_QUERY',
];

export function assertEvidenceWellFormed(evidence: Evidence): void {
  if (evidence.source === 'MANUAL_RESOLUTION') {
    const manual = evidence.manual;
    if (!manual) throw new EvidenceRequiredError('resolução manual exige identificação dos responsáveis');
    if (!manual.resolvedBy.trim() || !manual.approvedBy.trim()) {
      throw new EvidenceRequiredError('resolução manual exige responsável e aprovador');
    }
    if (manual.resolvedBy === manual.approvedBy) {
      throw new EvidenceRequiredError('resolução manual exige dupla aprovação por pessoas distintas');
    }
    if (!manual.justification.trim() || !manual.supportingDocumentRef.trim()) {
      throw new EvidenceRequiredError('resolução manual exige justificativa e documento de suporte');
    }
  } else if (evidence.manual) {
    throw new EvidenceRequiredError('dados de resolução manual só são aceitos com a fonte MANUAL_RESOLUTION');
  }
}
