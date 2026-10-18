# Ciclo de vida das transações

Fonte da verdade no código: `packages/domain/src/state-machine.ts` e `packages/domain/src/payment.ts`.
Os testes `packages/domain/test/state-machine.test.ts` comparam a tabela abaixo com a do código.

## Conceitos

| Termo | Significado neste sistema |
|---|---|
| **Pagamento** | Intenção de cobrança identificada por `(tenant, estabelecimento, referência comercial)`. Tem estado financeiro. |
| **Operação** | Uma interação com o provedor. Tem tipo, valor, status e evidência. |
| **Autorização** (AUTHORIZATION) | Pedido de aprovação da cobrança. No máximo uma por pagamento. |
| **Confirmação** (CONFIRMATION) | Segunda fase, quando o provedor exige que a automação confirme a autorização. |
| **Desfazimento** (UNDO) | Reversão técnica de autorização **ainda não confirmada** (duas fases). |
| **Cancelamento** (CANCELLATION) | Anulação comercial, **sempre pelo valor total**, de transação aprovada; não aceito depois de estorno parcial. |
| **Estorno** (REFUND) | Devolução **total ou parcial** de transação aprovada; cada estorno é uma operação própria. |
| **Desistência antes do envio** | CREATED → CANCELLED, sem contato com o provedor. |

A semântica exata de cancelamento e estorno (prazos, liquidação, parcial) varia por provedor e será mapeada a partir da documentação oficial de cada um. O domínio só permite o que a capacidade declarada autoriza.

## Estados do pagamento

| Estado | Significado | Final? |
|---|---|---|
| CREATED | Registrado; nada enviado | não |
| PROCESSING | Autorização gravada e enviada (ou possivelmente enviada) | não |
| AUTHORIZED | Aprovado pelo provedor; aguarda confirmação (somente com `twoPhaseConfirmation`) | não |
| APPROVED | Aprovado (e confirmado, se aplicável). Aceita cancelamento e estornos | não* |
| DECLINED | Recusado com evidência | sim |
| UNKNOWN | **Não há evidência suficiente para afirmar o resultado financeiro** | não |
| CANCELLED | Encerrado sem efeito financeiro (desistência, abandono no terminal, não enviado) | sim |
| REVERSED | Efeito financeiro integralmente desfeito (desfazimento, cancelamento ou estornos que zeram o saldo) | sim |

\* APPROVED só pode ir para REVERSED.

## Transições do pagamento

| De | Para | Evidência exigida | Capacidade |
|---|---|---|---|
| CREATED | PROCESSING | — | — |
| CREATED | CANCELLED | LOCAL_NO_CONTACT | — |
| PROCESSING | AUTHORIZED | resposta/notificação/consulta do provedor | twoPhaseConfirmation |
| PROCESSING | APPROVED | resposta/notificação/consulta do provedor | — |
| PROCESSING | DECLINED | resposta/notificação/consulta do provedor | — |
| PROCESSING | CANCELLED | provedor (abandono) ou ADAPTER_NOT_SENT | ADAPTER_NOT_SENT exige guaranteesNotSentOnPreSendFailure |
| PROCESSING | UNKNOWN | — (é a ausência de evidência) | — |
| AUTHORIZED | APPROVED | provedor | twoPhaseConfirmation |
| AUTHORIZED | REVERSED | provedor | undo |
| AUTHORIZED | UNKNOWN | — | — |
| UNKNOWN | AUTHORIZED / APPROVED / DECLINED / CANCELLED / REVERSED | consulta, notificação, resposta tardia, arquivo de conciliação ou resolução manual | AUTHORIZED exige twoPhaseConfirmation |
| APPROVED | REVERSED | provedor, arquivo de conciliação ou manual | — |

**Toda transição fora desta tabela é inválida**, em especial: estados finais → qualquer estado; UNKNOWN → PROCESSING; APPROVED ↔ DECLINED; transição para o mesmo estado.

## Status da operação

PENDING → IN_FLIGHT → { SUCCEEDED | REJECTED | ABORTED | NOT_SENT | UNKNOWN }; UNKNOWN → { SUCCEEDED | REJECTED | ABORTED | NOT_SENT }.

- IN_FLIGHT → NOT_SENT só com ADAPTER_NOT_SENT e garantia declarada.
- UNKNOWN → NOT_SENT por consulta só com `queryNotFoundIsDefinitive`.
- Não existe UNKNOWN → IN_FLIGHT/PENDING (sem reenvio).
- **No máximo uma operação aberta** (PENDING, IN_FLIGHT ou UNKNOWN) por pagamento, garantida pelo domínio e por índice único parcial.

## Efeito do resultado da operação no pagamento

| Operação | SUCCEEDED | REJECTED | ABORTED | NOT_SENT | UNKNOWN |
|---|---|---|---|---|---|
| AUTHORIZATION | APPROVED, ou AUTHORIZED se exigir confirmação | DECLINED | CANCELLED | CANCELLED | UNKNOWN |
| CONFIRMATION | APPROVED | UNKNOWN | UNKNOWN | mantém AUTHORIZED | UNKNOWN |
| UNDO | REVERSED | UNKNOWN | UNKNOWN | mantém AUTHORIZED | UNKNOWN |
| CANCELLATION | REVERSED | mantém | mantém | mantém | mantém (operação aberta bloqueia) |
| REFUND | soma ao revertido; REVERSED se zerar | mantém | mantém | mantém | mantém (operação aberta bloqueia) |

Confirmação ou desfazimento recusados levam a UNKNOWN porque a recusa **não prova** o resultado financeiro da autorização.

## Concorrência, timeouts e repetição

- Toda mudança acontece com o pagamento bloqueado (`FOR UPDATE`) e com verificação de versão.
- Timeout da chamada ao provedor (`TEF_PROVIDER_TIMEOUT_MS`) → UNKNOWN (`PROVIDER_TIMEOUT`). Erro após possível envio → UNKNOWN (`PROVIDER_CALL_FAILED`).
- Resposta duplicada ou notificação repetida: mesmo resultado não altera nada; resultado contraditório é rejeitado (`CONFLICTING_EVIDENCE`) e auditado.
- Resposta tardia (após UNKNOWN): pode resolver a operação se vier do provedor (notificação, consulta). A resposta síncrona que chega depois do timeout é descartada; a resolução vem por notificação ou consulta.
- Queda do processo: `recoverStaleInFlight(olderThanMs)` converte IN_FLIGHT antigo em UNKNOWN.

## Referência comercial
Fica protegida enquanto o pagamento estiver em qualquer estado **exceto** DECLINED e CANCELLED. Assim, após recusa o cliente pode tentar outro cartão com a mesma referência; com UNKNOWN, não. Pagamento dividido (dois cartões no mesmo pedido) usa referências distintas, uma por intenção de cobrança.

## Valores
Inteiros em centavos, BRL apenas. Limite técnico provisório de R$ 99.999.999,99 por transação (`MAX_TRANSACTION_CENTS`). O limite comercial real depende do provedor e do contrato.

## Lacunas conhecidas
- Pagamento UNKNOWN sem operação aberta (ex.: confirmação resolvida como REJECTED) ainda não tem rotina de resolução em nível de pagamento; exige conciliação por arquivo ou resolução manual a ser implementada.
- Desfazimento de autorização UNKNOWN ainda não é suportado (depende do comportamento documentado de cada provedor).
- Estado fiscal: separado e ainda não modelado.
