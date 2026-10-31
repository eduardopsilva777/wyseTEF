# Roadmap

| Fase | Entrega | Critérios de conclusão | Situação |
|---|---|---|---|
| F0 Descoberta | Diagnóstico, arquitetura, riscos | Direção aprova posicionamento e stack | **concluída** |
| F1 Fundação | Monorepo, domínio, máquina de estados, idempotência, PostgreSQL, auditoria, outbox, simulador, API mínima, docs, ADRs | Lint, tipos e testes verdes; suíte do serviço verde **contra PostgreSQL real**; varredura de segredos limpa | **concluída** (commit `7d22f60`) |
| F2A MVP local | API assíncrona (202), fila durável com lease, worker, outbox publicada, cadastro (clientes, estabelecimentos, terminais simulados), painel web local, simulador com diretivas, acesso administrativo de desenvolvimento, dados de demonstração | Lint, tipos, testes unitários e de PostgreSQL verdes; painel funcionando contra API, worker e banco reais | **implementada; aguardando revisão** |
| F2 API e operação | Modelo assíncrono (202 + consulta/webhook), worker (outbox, reconciliação agendada, recuperação, expurgo de idempotência), rotas administrativas com RBAC/MFA, autenticação definitiva, rate limiting, RLS, observabilidade (OpenTelemetry), CI | Matriz de autorização 100% negada entre tenants; UNKNOWN reconciliado automaticamente quando há consulta; alertas | pendente |
| F3 Agente (protótipo) | Agente com terminal simulado, canal mTLS, diário local sem reenvio, atualização assinada | Agente encerrado à força em IN_FLIGHT se recupera como UNKNOWN; atualização inválida recusada | pendente — **depende do SDK real (ADR 0011)** |
| F4 Primeira integração em sandbox | Adaptador OFFICIAL de um provedor | Contrato e documentação oficial; suíte de conformidade; roteiro de homologação do provedor executado em teste | pendente — **depende de contrato** |
| F5 Conciliação e painel | Conciliação por arquivo, painel administrativo, monitoramento | Conciliação diária sem divergências não explicadas | pendente |
| F6 Pré-piloto | Pentest, avaliação de escopo PCI com QSA, resposta a incidentes, empacotamento de produção | Achados críticos e altos corrigidos; parecer formal | pendente |
| F7 Piloto e SDK | Lojas piloto controladas, SDK e documentação pública | Critérios definidos pela direção | pendente |

## Limitações conhecidas (F1 + F2A)
1. ~~Operações chamam o provedor dentro da requisição HTTP~~ — resolvido na F2A (ADR 0013).
2. Autenticação provisória por chave de API, revogação só com reinício; sem rate limiting. Por isso a API só escuta em loopback (ADR 0009).
3. Worker implementado (F2A). A outbox é publicada apenas para o log estruturado; não há entrega a clientes (webhooks). Resolução manual ainda não tem rota HTTP.
4. Sem expurgo de chaves de idempotência.
5. Auditoria sem ancoragem externa. (O papel da aplicação deixou de ser o dono das tabelas na F2B/I2, ADR 0020.)
6. Sem RLS no PostgreSQL (isolamento por filtro em todas as consultas).
7. Sem empacotamento de produção (ADR 0010).
8. Desfazimento de autorização UNKNOWN e resolução de pagamento UNKNOWN sem operação aberta não implementados.
9. Estado fiscal não modelado.
10. CI definido em `.github/workflows/ci.yml`, mas **nunca executado** (não há repositório remoto). Desde a F2B/I2: actions fixadas por SHA, Gitleaks fixado e E2E com Chromium; ainda sem SAST dedicado e com a imagem do PostgreSQL referenciada por tag.
11. Isolamento por estabelecimento é aplicado na camada HTTP; aplicação e banco isolam por tenant.
12. Acesso administrativo apenas de desenvolvimento local (ADR 0015): sem usuários, MFA ou RBAC.
13. ~~Lease e `available_at` usam o relógio da aplicação~~ — resolvido na F2B/I1 (ADR 0019): decisões da fila pelo relógio do PostgreSQL. Resta depender do NTP do servidor de banco; batimento do worker e agendamento da outbox continuam no relógio do processo (sem efeito sobre segurança).
14. Tarefas `FAILED` (tentativas esgotadas) não têm rotina de saneamento; aparecem no painel.
15. Painel sem testes automatizados de componentes nem testes Playwright versionados; validado no navegador com playwright-cli (manual) e por testes da API administrativa e verificações estáticas. Recomendado para a F2: Playwright com 5 fluxos (login, CRUD de cliente, pagamento simulado com aprovação, UNKNOWN reconciliado, falha da API exibida) e testes de componentes para formulários e selo de estado.
16. `recoverStaleInFlight` deve ser chamado com limite maior que o timeout do provedor; uma recuperação prematura marca UNKNOWN cedo demais (sem reenvio; a resposta real ainda resolve a operação — coberto por teste no PostgreSQL), mas não há proteção automática contra configuração errada. Desde a ADR 0019, a varredura ignora operações cuja tarefa ainda detém lease válido pelo relógio do banco.

## F2B / I2 — perfis de ambiente, papéis de banco e CI (2026-10-19)
`TEF_ENV` (dev/test/staging/prod) com matriz validada na inicialização; identidades `tef_owner` (migrações), `tef_app` (API) e `tef_worker` (worker) com GRANTs específicos na migração 0005 e bootstrap local (`npm run db:bootstrap`); verificação da identidade de banco na subida; cookie `Secure` em staging/prod; workflow de CI com actions por SHA, Gitleaks e E2E. Testes reais de privilégio em `tests/integration/postgres-roles.test.ts`. Detalhes em `docs/OPERATIONS.md` e na ADR 0020.

## F2B / I1 — relógio do PostgreSQL na fila (2026-10-19)
Fila e leases decididos por `clock_timestamp()`; contrato da fila com durações em vez de instantes; conclusão e reagendamento exigem lease válido; varredura de `IN_FLIGHT` respeita a posse de tarefa ativa. Testes no PostgreSQL com relógios de processo divergentes (±1 h) em `tests/integration/postgres-queue-clock.test.ts`. Sem migração.

## Auditoria pré-commit da F2A (2026-10-18)
Correções: fencing com renovação de lease antes de qualquer ação do worker; escopo de autoridade do livro do simulador (migração 0004) protegendo o pagamento UNKNOWN legado; erros de carregamento sempre exibidos e atualização periódica que se recupera de falhas; testes de atualização de banco (0001 → 0004), configuração do worker e concorrência entre reconciliação e resposta original.

## Auditoria pré-commit da F1 (2026-10-18)
Correções aplicadas antes do commit inicial: redação de mensagens e stacks de erro nos logs, exclusão de campos de driver com valores, normalização de códigos e referências de provedores, autenticação antes de qualquer processamento em `/v1`, escuta somente em loopback, ouvinte de erro do pool PostgreSQL, verificação de auditoria e outbox sob concorrência no PostgreSQL. Testes em `apps/api/test/security-audit.test.ts`, `packages/audit/test/redaction.test.ts` e `tests/integration/postgres.test.ts`.
