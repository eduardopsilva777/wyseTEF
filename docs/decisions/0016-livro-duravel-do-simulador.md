# 0016 — Livro durável do simulador; a API nunca chama o provedor

- **Status:** Aceita
- **Data:** 2026-10-18

## Contexto (defeito encontrado durante a Fase 2A)
O simulador guardava em memória o que havia processado. Com API e worker em processos separados, o "reconciliar agora" do painel consultava o simulador do processo da API, que respondia "não encontrado". Como o simulador declara "não encontrado" como definitivo, uma operação **recusada** pelo simulador do worker era registrada como `NOT_SENT` e o pagamento ia para `CANCELLED`. O mesmo ocorreria após reiniciar o worker. Um teste de integração com PostgreSQL revelou o problema.

## Decisão
1. O livro do simulador (`simulator_ledger`, migração 0003) fica no PostgreSQL: compartilhado por todos os processos e durável entre reinícios, como seria o estado de um provedor externo. A implementação em memória continua disponível para testes de um único processo.
2. **A API não chama o provedor.** Ela só aceita trabalho e grava tarefas. "Reconciliar agora" antecipa (ou cria) a tarefa `RECONCILE_OPERATION`, e quem consulta é o worker.
3. **Escopo de autoridade (migração 0004, auditoria pré-commit):** o livro só afirma "não encontrado" para operações criadas depois do seu início (`simulator_ledger_meta.started_at`, igual ao momento em que a 0003 foi aplicada). O instante de criação vem do próprio ID UUIDv7 da operação. Para operações anteriores, a consulta responde `UNAVAILABLE` e o pagamento permanece UNKNOWN.

## Pagamento UNKNOWN legado (banco de desenvolvimento)
Um pagamento de teste da F1 (`tenant-dev`, R$ 10,58) ficou UNKNOWN. Foi processado por um simulador com livro em memória, que registrou aprovação e foi perdido; não há tarefa nem registro no livro durável. **Sem o escopo de autoridade, um "reconciliar agora" o marcaria como não enviado/cancelado, o que seria falso.** Com a 0004, a reconciliação responde "indisponível" e o pagamento continua UNKNOWN.
Estratégia segura: não apagar nem editar a linha; não reconciliar automaticamente; resolver apenas por **resolução manual com dupla aprovação** e documento que registre a origem (teste da F1, simulador em memória), quando a rota administrativa de resolução manual existir (F2). Até lá, o painel o mostra como "Resultado desconhecido". O pagamento é fictício e não tem efeito financeiro.

## Consequências
- Testes de regressão: reinício do worker resolve a operação com o resultado real (`tests/integration/postgres-async.test.ts`); fluxo do painel com reconciliação pelo worker.
- Operações anteriores ao início do livro não têm registro; a consulta responde `UNAVAILABLE` e elas permanecem UNKNOWN até resolução manual (teste em `tests/integration/postgres-async.test.ts`).
