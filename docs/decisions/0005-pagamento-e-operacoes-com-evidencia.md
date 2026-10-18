# 0005 — Pagamento + operações, máquina de estados e evidência obrigatória

- **Status:** Aceita
- **Data:** 2026-10-18

## Decisão
- **Pagamento** (intenção de cobrança) tem estado financeiro: CREATED, PROCESSING, AUTHORIZED, APPROVED, DECLINED, UNKNOWN, CANCELLED, REVERSED.
- **Operação** (cada interação com o provedor) tem tipo e status próprios. Tipos: AUTHORIZATION, CONFIRMATION, UNDO (desfazimento), CANCELLATION (cancelamento), REFUND (estorno). Status: PENDING, IN_FLIGHT, UNKNOWN, SUCCEEDED, REJECTED, ABORTED, NOT_SENT.
- Cancelamento, desfazimento e estorno **não são sinônimos** (ver `docs/TRANSACTION_LIFECYCLE.md`).
- Transições centralizadas em tabelas no domínio (`packages/domain/src/state-machine.ts`). Todo resultado definitivo exige **evidência tipada** (resposta, notificação, consulta, arquivo de conciliação ou resolução manual com dupla aprovação), compatível com a transição e com as capacidades declaradas pelo provedor.
- Estorno parcial é uma operação própria, contabilizada em `reversedAmount`. O pagamento só vira REVERSED quando o saldo aprovado chega a zero.
- O estado fiscal é separado e não existe neste núcleo.

## Consequências
- Um resultado incompatível com o contrato (por exemplo, confirmação pendente sem capacidade de duas fases) é rejeitado pelo domínio e registrado como UNKNOWN pela aplicação.
