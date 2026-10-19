# 0019 — Relógio do PostgreSQL como autoridade temporal da fila

- **Status:** Aceita
- **Data:** 2026-10-19
- **Altera:** a consequência da ADR 0013 sobre o relógio da fila (a 0013 continua aceita)

## Contexto
Na F2A, `available_at`, `lease_expires_at` e as comparações de reivindicação, renovação e reagendamento usavam um instante calculado pelo **processo** (`new Date()` da API ou do worker) e enviado ao banco como parâmetro. Com processos em hosts diferentes, a divergência de relógio decidia quem podia agir:

- um worker com relógio **adiantado** considerava vencido o lease de outro worker ainda ativo e tomava a tarefa;
- um worker com relógio **atrasado** demorava a reassumir tarefas de workers que caíram;
- uma tarefa enfileirada por um processo adiantado ficava indisponível para workers com relógio correto.

O fencing impedia reenvio (a operação encontrada `IN_FLIGHT` vira `UNKNOWN`), mas a divergência gerava `UNKNOWN` prematuro, trabalho manual e atrasos.

## Decisão
1. **Autoridade:** toda decisão temporal da fila no PostgreSQL usa `clock_timestamp()`: disponibilidade (`available_at`), reivindicação, concessão e renovação de lease, conclusão, reagendamento e antecipação ("reconciliar agora").
2. **`clock_timestamp()`, não `now()`:** `now()`/`CURRENT_TIMESTAMP` é o início da transação. Como a renovação do lease acontece numa transação que antes bloqueia o pagamento (e pode esperar), o prazo calculado com `now()` poderia nascer no passado. Cada comando lê `clock_timestamp()` **uma vez** (CTE `clk`), para que comparação e novo prazo usem o mesmo instante.
3. **Durações, não instantes:** o contrato `JobRepository` recebe durações (`delayMs`, `leaseMs`) e não recebe mais `now`. Nenhum instante absoluto calculado no processo é usado para decidir expiração.
4. **Posse estrita:** `renewLease`, `complete` e `retryLater` exigem `status = 'RUNNING'`, o mesmo `lease_owner` **e** `lease_expires_at > clock_timestamp()`. Um lease vencido não é renovado (não ressuscita) nem concluído; a tarefa é reassumida por outro worker, que encontra a operação já resolvida ou `IN_FLIGHT` (e então marca `UNKNOWN`, sem reenviar).
5. **Varredura de `IN_FLIGHT` antigo** (`recoverStaleInFlight`): além da idade da operação, exige que não haja tarefa ativa para ela (PENDING, ou RUNNING com lease válido pelo relógio do banco). Um processo com relógio adiantado não declara abandonada uma operação cujo worker ainda detém o lease.
6. **Memória:** a implementação em memória recebe o relógio da fila por injeção (`new InMemoryUnitOfWork({ clock })`), com as mesmas regras, para testes determinísticos.

## Tempo operacional × fatos de negócio
| Continua no relógio do processo (fato de negócio ou registro) | Passa ao relógio do banco (decisão operacional da fila) |
|---|---|
| `created_at`/`updated_at` de pagamentos e operações, `observedAt` da evidência, `occurred_at` da auditoria, chaves de idempotência | `jobs.available_at`, `lease_expires_at`, `created_at`, `updated_at` e `completed_at` das tarefas |
| Batimento do worker (`worker_heartbeats`) e agendamento da outbox (pelo menos uma vez; atraso não afeta segurança) | Condição "tarefa ativa" usada pela varredura de `IN_FLIGHT` |

## Consequências
- Divergência de relógio entre hosts da aplicação não antecipa nem atrasa leases. O relógio do servidor PostgreSQL precisa estar sincronizado (NTP); um salto no relógio do banco afeta todos os workers igualmente.
- A idade de uma operação `IN_FLIGHT` sem tarefa (caminho síncrono legado) ainda é medida pelo relógio de quem varre, comparado ao `updated_at` gravado no envio; a divergência só antecipa ou atrasa a marcação `UNKNOWN`, nunca causa reenvio.
- Nos testes, a expiração no PostgreSQL exige espera real (prazos de centenas de milissegundos); em memória, avança-se o relógio injetado.
- Sem mudança de esquema.

## Verificação
`tests/integration/postgres-queue-clock.test.ts` (PostgreSQL real, relógios de processo a ±1 h, sem alterar o relógio do sistema operacional) e a suíte assíncrona compartilhada (`tests/support/async-suite.ts`) em memória e no PostgreSQL.
