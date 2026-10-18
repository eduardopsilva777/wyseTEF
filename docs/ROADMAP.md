# Roadmap

| Fase | Entrega | Critérios de conclusão | Situação |
|---|---|---|---|
| F0 Descoberta | Diagnóstico, arquitetura, riscos | Direção aprova posicionamento e stack | **concluída** |
| F1 Fundação | Monorepo, domínio, máquina de estados, idempotência, PostgreSQL, auditoria, outbox, simulador, API mínima, docs, ADRs | Lint, tipos e testes verdes; suíte do serviço verde **contra PostgreSQL real**; varredura de segredos limpa | **implementada; aguardando revisão e commit inicial** |
| F2 API e operação | Modelo assíncrono (202 + consulta/webhook), worker (outbox, reconciliação agendada, recuperação, expurgo de idempotência), rotas administrativas com RBAC/MFA, autenticação definitiva, rate limiting, RLS, observabilidade (OpenTelemetry), CI | Matriz de autorização 100% negada entre tenants; UNKNOWN reconciliado automaticamente quando há consulta; alertas | pendente |
| F3 Agente (protótipo) | Agente com terminal simulado, canal mTLS, diário local sem reenvio, atualização assinada | Agente encerrado à força em IN_FLIGHT se recupera como UNKNOWN; atualização inválida recusada | pendente — **depende do SDK real (ADR 0011)** |
| F4 Primeira integração em sandbox | Adaptador OFFICIAL de um provedor | Contrato e documentação oficial; suíte de conformidade; roteiro de homologação do provedor executado em teste | pendente — **depende de contrato** |
| F5 Conciliação e painel | Conciliação por arquivo, painel administrativo, monitoramento | Conciliação diária sem divergências não explicadas | pendente |
| F6 Pré-piloto | Pentest, avaliação de escopo PCI com QSA, resposta a incidentes, empacotamento de produção | Achados críticos e altos corrigidos; parecer formal | pendente |
| F7 Piloto e SDK | Lojas piloto controladas, SDK e documentação pública | Critérios definidos pela direção | pendente |

## Limitações conhecidas da F1
1. Operações chamam o provedor dentro da requisição HTTP (ADR 0012).
2. Autenticação provisória por chave de API, revogação só com reinício; sem rate limiting. Por isso a API só escuta em loopback (ADR 0009).
3. Sem worker: outbox não é publicado; reconciliação e recuperação existem como casos de uso, mas não rodam agendadas nem têm rota HTTP.
4. Sem expurgo de chaves de idempotência.
5. Auditoria sem ancoragem externa; papel de banco da aplicação ainda é o dono das tabelas em desenvolvimento.
6. Sem RLS no PostgreSQL (isolamento por filtro em todas as consultas).
7. Sem empacotamento de produção (ADR 0010).
8. Desfazimento de autorização UNKNOWN e resolução de pagamento UNKNOWN sem operação aberta não implementados.
9. Estado fiscal não modelado.
10. CI definido em `.github/workflows/ci.yml`, mas **nunca executado** (não há repositório remoto). Actions referenciadas por tag, não por SHA; sem gitleaks nem SAST dedicado.
11. Isolamento por estabelecimento é aplicado na camada HTTP; aplicação e banco isolam por tenant.
12. `recoverStaleInFlight` deve ser chamado com limite maior que o timeout do provedor; uma recuperação prematura marca UNKNOWN cedo demais (sem reenvio; a resposta real ainda resolve a operação — coberto por teste no PostgreSQL), mas não há proteção automática contra configuração errada.

## Auditoria pré-commit (2026-10-18)
Correções aplicadas antes do commit inicial: redação de mensagens e stacks de erro nos logs, exclusão de campos de driver com valores, normalização de códigos e referências de provedores, autenticação antes de qualquer processamento em `/v1`, escuta somente em loopback, ouvinte de erro do pool PostgreSQL, verificação de auditoria e outbox sob concorrência no PostgreSQL. Testes em `apps/api/test/security-audit.test.ts`, `packages/audit/test/redaction.test.ts` e `tests/integration/postgres.test.ts`.
