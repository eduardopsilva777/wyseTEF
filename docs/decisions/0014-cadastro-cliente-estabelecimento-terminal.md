# 0014 — Cadastro cliente → estabelecimento → terminal com integridade referencial

- **Status:** Aceita
- **Data:** 2026-10-18

## Decisão
- **Cliente empresarial** (`customers`): o código é o identificador de tenant (`payments.tenant_id`).
- **Estabelecimento** (`merchants`): chave `(cliente, código)`; é o `merchant_id` dos pagamentos.
- **Terminal** (`terminals`): chave `(cliente, código)`, pertence a um estabelecimento do mesmo cliente, tem provedor configurado e `mode = 'SIMULATED'` (nenhum hardware real é suportado nesta fase).
- O provedor de um pagamento vem do **terminal**. A criação exige cliente, estabelecimento e terminal ativos e coerentes (`REFERENCE_INVALID` caso contrário, sem revelar qual falhou).
- No banco: `payments (tenant_id, merchant_id, terminal_id) → terminals (customer_id, merchant_id, id)` com `ON DELETE RESTRICT`, criada `NOT VALID` para não reprocessar pagamentos antigos de bancos de desenvolvimento.
- Registros com dependentes ou histórico financeiro **não são excluídos**: a API responde `HAS_DEPENDENCIES` e o painel orienta a desativar. Pagamentos nunca são excluídos.
- Toda alteração de cadastro é auditada na cadeia do cliente.

## Pendências
- Credenciais de integração continuam em variável de ambiente (ADR 0009) e não são geridas pelo cadastro.
- Sem campos fiscais ou documentos (CNPJ) nesta fase, para não coletar dados desnecessários antes de haver necessidade definida.
