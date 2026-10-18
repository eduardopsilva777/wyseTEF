# Arquitetura

> Legenda: **[implementado]** existe e tem testes · **[planejado]** ainda não existe.

## Visão geral

```
 Integrador (PDV/TouchPay)
        │ HTTPS + Bearer + Idempotency-Key
        ▼
 apps/api ─────────────► packages/application (PaymentService)
 [implementado]                 │          │            │
                                │ portas   │            │
                 ┌──────────────┘          │            └──────────────┐
                 ▼                         ▼                           ▼
 packages/domain             packages/providers/contract      packages/persistence
 (estado, regras, Money)     (PaymentProvider, capacidades,   ├─ postgres  [implementado]
 [implementado]               suíte de conformidade)          └─ memory (só testes)
                                       │                               │
                                       ▼                               ▼
                         providers/simulator [implementado]      PostgreSQL 18
                         adaptadores OFFICIAL [planejado]        payments, payment_operations,
                                                                 idempotency_keys, audit_events,
                                                                 audit_chain_heads, outbox_events
 packages/audit: JSON canônico, cadeia de hash, lista de campos permitidos [implementado]
```

## Componentes

| Componente | Responsabilidade | Estado |
|---|---|---|
| `packages/domain` | Money em centavos, IDs tipados, Payment/Operation, máquina de estados, evidências, capacidades, erros tipados. Sem I/O. | implementado |
| `packages/application` | Casos de uso: criar, desistir, autorizar, confirmar, desfazer, cancelar, estornar, notificação, recuperação, reconciliação, resolução manual. Portas de persistência. | implementado |
| `packages/providers/contract` | Interface `PaymentProvider`, tipos de requisição/resultado/consulta/notificação, suíte de conformidade. | implementado |
| `packages/providers/simulator` | Adaptador `SIMULATOR` com cenários controlados. | implementado |
| `packages/persistence` | Repositórios PostgreSQL, unidade de trabalho, migrações; implementação em memória para testes. | implementado |
| `packages/audit` | Encadeamento e verificação da auditoria, sanitização. | implementado |
| `apps/api` | HTTP (Fastify), autenticação provisória, validação (Zod), mapeamento de erros, logs sanitizados. | implementado |
| Worker (outbox, reconciliação agendada, expurgo de idempotência) | | planejado |
| Agente local | Execução presencial quando exigida pelo provedor (ver ADR 0011) | planejado |
| Painel administrativo, monitoramento, conciliação por arquivo | | planejado |

## Planos (arquitetura alvo)
- **Plano de controle (nuvem):** API, núcleo transacional, persistência, reconciliação, administração.
- **Execução local:** agente junto ao PDV, quando o provedor exigir biblioteca local ou pinpad. Conexão só de saída, diário local sem reenvio automático.
- **Adaptadores oficiais:** um por provedor, criados apenas com contrato, documentação oficial e autorização.
- **Monitoramento e administração:** métricas, alertas (UNKNOWN acima do limite, cadeia de auditoria inválida), resolução manual com dupla aprovação.

## Fluxo de uma operação (implementado)

1. **Transação 1:** bloqueia o pagamento (`FOR UPDATE`), reserva a chave de idempotência, valida regras no domínio, grava pagamento PROCESSING (se autorização) e operação IN_FLIGHT, mais auditoria e outbox. Commit.
2. **Chamada ao provedor** fora de transação, com `AbortSignal` e timeout. Exceção ou timeout → UNKNOWN.
3. **Transação 2:** bloqueia o pagamento, relê a operação, aplica o resultado no domínio (idempotente), grava operação, pagamento, auditoria e outbox.
4. Notificações, consultas e resoluções manuais usam o mesmo passo 3.

Se o processo cair entre 1 e 3, a operação fica IN_FLIGHT; `recoverStaleInFlight` a converte em UNKNOWN sem reenviar.

## API HTTP (F1)

| Método e rota | Descrição |
|---|---|
| `GET /health` | Vivacidade |
| `POST /v1/payments` | Cria pagamento (CREATED). Exige `Idempotency-Key`. |
| `GET /v1/payments/{id}` | Consulta pagamento e operações |
| `POST /v1/payments/{id}/abandon` | Desistência antes do envio (CREATED → CANCELLED) |
| `POST /v1/payments/{id}/authorize` | Autorização |
| `POST /v1/payments/{id}/confirm` | Confirmação (duas fases) |
| `POST /v1/payments/{id}/undo` | Desfazimento (duas fases) |
| `POST /v1/payments/{id}/cancel` | Cancelamento total |
| `POST /v1/payments/{id}/refunds` | Estorno total ou parcial (`{"amount":{"cents":N,"currency":"BRL"}}`) |

Reconciliação, recuperação e resolução manual existem na camada de aplicação, mas **ainda não têm rota HTTP** (exigem papel administrativo, planejado).

## Limitações conhecidas
Ver `ROADMAP.md` e as ADRs 0009, 0010 e 0012.
