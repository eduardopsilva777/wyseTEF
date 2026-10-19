# 0013 — Modelo assíncrono: API 202, fila durável no PostgreSQL e worker

- **Status:** Aceita (substitui a 0012)
- **Data:** 2026-10-18

## Decisão
- `POST /v1/payments` (com `authorize`, padrão `true`) e todas as operações (`authorize`, `confirm`, `undo`, `cancel`, `refunds`) **aceitam** o trabalho e respondem **202**. A operação fica `PENDING` e a tarefa `EXECUTE_OPERATION` é gravada **na mesma transação** que o pagamento e a operação: não existe janela em que um pagamento aceito fique sem a tarefa que o processará.
- A fila é a tabela `jobs` no PostgreSQL. O worker reivindica com `FOR UPDATE SKIP LOCKED` e recebe um **lease**; se cair, o lease expira e outra instância retoma. Há fencing: só o dono do lease conclui ou reagenda. Uma tarefa ativa por operação e tipo (índice único parcial).
- **Garantia central:** a transição `PENDING → IN_FLIGHT` acontece sob o bloqueio do pagamento, uma única vez. Uma tarefa que encontra a operação já `IN_FLIGHT` (o worker anterior caiu durante o envio) marca `UNKNOWN` com `WORKER_INTERRUPTED_AFTER_DISPATCH` e **nunca reenvia**.
- Quando uma operação vira `UNKNOWN` e o provedor oferece consulta, uma tarefa `RECONCILE_OPERATION` é enfileirada na mesma transação, com recuo exponencial e limite de tentativas. Consulta não é reenvio de cobrança.
- O lease precisa ser pelo menos 2× o timeout do provedor + 1 s; o worker recusa iniciar se não for.
- **Fencing e renovação (auditoria pré-commit da F2A):** antes de agir sobre a operação (enviar, marcar UNKNOWN ou consultar), o worker renova o lease **na mesma transação**, e só se ainda for o dono e o lease não tiver expirado. Ordem de bloqueio: pagamento, depois tarefa. Um worker que perdeu a posse recebe `LOST_LEASE` e não faz nada. Antes desta correção, só a conclusão verificava a posse.
- A outbox é publicada pelo worker (pelo menos uma vez, com `FOR UPDATE SKIP LOCKED`); nesta fase o destino é o log estruturado.
- O laço de polling é só um gatilho; nenhum estado da fila vive em memória.

## Semântica de estados
`PROCESSING` passa a significar "autorização aceita para processamento". O status da operação diz se ela ainda não foi enviada (`PENDING`) ou se pode ter sido enviada (`IN_FLIGHT`). A regra que importa não muda: só há `UNKNOWN` depois de um possível envio, e `UNKNOWN` nunca é reenviado.

## Consequências
- ~~O relógio usado para `available_at` e leases é o da aplicação~~ — resolvido pela **ADR 0019**: a fila usa o relógio do PostgreSQL (`clock_timestamp()`), e os chamadores informam durações.
- Tarefas que esgotam tentativas ficam `FAILED` e aparecem no painel; não há rotina automática de saneamento.
