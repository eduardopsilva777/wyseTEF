# 0007 — UNKNOWN nunca é reenviado automaticamente

- **Status:** Aceita
- **Data:** 2026-10-18

## Decisão
- A intenção (PROCESSING/IN_FLIGHT) é gravada **antes** de chamar o provedor.
- Timeout, erro de comunicação ou queda do processo após um possível envio levam a **UNKNOWN**, nunca a "falhou".
- Uma operação UNKNOWN mantém o pagamento bloqueado para novas operações. Não existe transição UNKNOWN → PROCESSING/IN_FLIGHT.
- A resolução acontece apenas por consulta ao provedor (se declarada), notificação autenticada, arquivo de conciliação ou resolução manual com dupla aprovação.
- "Não encontrado" na consulta só encerra a operação se o provedor declarar `queryNotFoundIsDefinitive`.
- A recuperação (`recoverStaleInFlight`) converte IN_FLIGHT antigo em UNKNOWN e **não reenvia**.
- O diário local do futuro agente seguirá a mesma regra.
