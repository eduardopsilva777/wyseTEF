# Arquitetura

> Situação: **Fase 2A — MVP local**. Legenda: **[implementado]** existe e tem testes; **[planejado]** ainda não existe.

## Visão geral

```
 Integrador (PDV/TouchPay)          Operador local (navegador)
        │ Bearer + Idempotency-Key           │ http://127.0.0.1:5173 (Vite, só loopback)
        ▼                                     ▼ proxy /admin  (cookie HttpOnly + x-tef-admin)
 ┌──────────────────────────── apps/api (127.0.0.1:3000) ────────────────────────────┐
 │ /v1/*  integração: aceita trabalho (201/202), nunca chama o provedor             │
 │ /admin/api/*  painel local: cadastro, transações, simulador, auditoria           │
 └───────────────────────┬────────────────────────────────────────────────────────────┘
                         │ PaymentService / AdminService (packages/application)
                         ▼
                 PostgreSQL (fonte da verdade)
   payments · payment_operations · idempotency_keys · audit_events · outbox_events
   customers · merchants · terminals · jobs · provider_test_directives
   simulator_ledger · worker_heartbeats
                         ▲
                         │ FOR UPDATE SKIP LOCKED + lease
 ┌──────────────────── apps/worker (health 127.0.0.1:3001) ─────────────────────────┐
 │ executa EXECUTE_OPERATION e RECONCILE_OPERATION · publica a outbox · batimento   │
 │ recuperação de IN_FLIGHT antigo · SIMULADOR (livro no PostgreSQL)                │
 └───────────────────────────────────────────────────────────────────────────────────┘
```

## Componentes

| Componente | Responsabilidade | Estado |
|---|---|---|
| `packages/domain` | Money em centavos, IDs tipados, Payment/Operation, máquina de estados, evidências, capacidades, tipos de cadastro. Sem I/O. | implementado |
| `packages/application` | `PaymentService` (criação, solicitação assíncrona, execução de tarefas, reconciliação, notificações, recuperação, resolução manual), `AdminService` (cadastro e leituras do painel), `Worker` e `OutboxPublisher`. Portas de persistência. | implementado |
| `packages/providers/contract` | Interface `PaymentProvider`, capacidades, suíte de conformidade, registro de provedores. | implementado |
| `packages/providers/simulator` | `SIMULATOR`: cenários controlados, diretivas de teste, livro plugável (memória ou PostgreSQL). | implementado |
| `packages/persistence` | PostgreSQL (migrações 0001–0004, repositórios, fila, outbox, cadastro, leituras, livro do simulador) e implementação em memória para testes; CLIs de migração e de dados de demonstração. | implementado |
| `packages/audit` | Encadeamento e verificação da auditoria, lista de campos permitidos, redação de texto livre. | implementado |
| `packages/observability` | Logger sanitizado compartilhado por API e worker. | implementado |
| `apps/api` | HTTP (Fastify): `/v1` (integração, chave de API) e `/admin/api` (painel local, sessão de desenvolvimento). | implementado |
| `apps/worker` | Processo separado: fila durável, outbox, batimento, health check, encerramento gracioso. | implementado |
| `apps/web` | Painel React local: dashboard, clientes, estabelecimentos, terminais, transações, simulador, auditoria, área reservada de usuários. | implementado |
| Agente local | Execução presencial quando exigida pelo provedor (ADR 0011). | planejado |
| Adaptadores oficiais | Um por provedor, com contrato e documentação oficial. | planejado |
| Autenticação de produção, RBAC, MFA, rate limiting | | planejado |

## Fluxo assíncrono de um pagamento (implementado)

1. **API — transação única:** reserva a chave de idempotência; valida cliente, estabelecimento e terminal (ativos, coerentes); grava o pagamento; com `authorize`, aplica `CREATED → PROCESSING`, grava a operação `PENDING`, a tarefa `EXECUTE_OPERATION`, a auditoria e a outbox. Responde **202**.
2. **Worker — reivindica** a tarefa (`SKIP LOCKED`, lease). Prazos pelo relógio do PostgreSQL, não do processo (ADR 0019).
3. **Worker — transação:** bloqueia o pagamento; se a operação está `PENDING`, marca `IN_FLIGHT` (o "envio" só acontece uma vez); se já está `IN_FLIGHT`, o worker anterior caiu: marca `UNKNOWN` sem reenviar.
4. **Worker — chama o provedor** fora de transação, com timeout. Exceção ou timeout viram `UNKNOWN`.
5. **Worker — transação:** registra o resultado (idempotente). Se `UNKNOWN` e o provedor tem consulta, enfileira `RECONCILE_OPERATION`.
6. **Worker — conclui** a tarefa (fencing pelo lease) e publica a outbox.

Notificações do provedor e resoluções manuais usam o mesmo registro de resultado do passo 5.

## API HTTP

### Integração (`/v1`, Bearer)

| Método e rota | Resposta |
|---|---|
| `POST /v1/payments` | 202 com `authorize` (padrão) e operação `PENDING`; 201 com `"authorize": false` |
| `GET /v1/payments/{id}` | Estado e operações |
| `POST /v1/payments/{id}/abandon` | Desistência antes do envio (só `CREATED`) |
| `POST /v1/payments/{id}/authorize`, `/confirm`, `/undo`, `/cancel`, `/refunds` | 202 (operação aceita para o worker) |

### Painel local (`/admin/api`, sessão de desenvolvimento)
Sessão (`POST/GET/DELETE /session`), `GET /dashboard`, `GET /system`, `GET /providers`, CRUD de `customers`, `customers/{id}/merchants`, `customers/{id}/terminals` (listas em `GET /merchants`, `GET /terminals`), `GET /payments`, `GET /customers/{id}/payments/{pid}`, `POST …/cancel`, `POST …/refunds`, `POST …/reconcile` (202, agenda consulta), `GET /simulator/scenarios`, `POST /simulator/payments` (202), `GET /audit`, `GET /audit/verify`.

## Limitações conhecidas
Ver `ROADMAP.md` e as ADRs 0009, 0010, 0013, 0015 e 0016.
