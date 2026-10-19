# Modelo de ameaças (versão F1)

> Escopo: núcleo transacional, API, worker, painel local e persistência (F1 + F2A). Revisar a cada fase e antes de qualquer piloto.
> Este documento **não** é uma avaliação PCI e não declara conformidade.

## Ativos
| Ativo | Observação |
|---|---|
| Estado das transações e saldos revertidos | Integridade é crítica (cobrança duplicada, estorno indevido) |
| Chaves de API dos clientes | Configuradas só como SHA-256 |
| Credenciais de provedores (futuro) | Ainda não existem; irão para cofre de segredos |
| Trilha de auditoria | Integridade e não repúdio |
| Dados de cartão | **Não existem no sistema** (ADR 0002). Nenhum PAN, CVV, trilha ou PIN é aceito, registrado ou armazenado |
| Binários e atualizações do agente (futuro) | Cadeia de suprimentos |

## Fronteiras de confiança
Integrador ↔ API (internet) · API ↔ PostgreSQL · API ↔ provedor (futuro) · Agente ↔ nuvem (futuro) · PDV ↔ agente em localhost (futuro, **não confiável por padrão**).

## Ameaças e controles

| # | Ameaça | Controle implementado | Pendente |
|---|---|---|---|
| T1 | Acesso a transações de outro cliente (BOLA/IDOR) | Tenant vem da credencial; todas as consultas filtram `tenant_id`; estabelecimento verificado na camada HTTP (a aplicação e o banco isolam por tenant); 404 para recurso alheio; testes de isolamento (API, aplicação, SQL) | RLS no PostgreSQL como segunda barreira |
| T2 | Cobrança duplicada por repetição ou concorrência | Idempotência por chave + hash; referência comercial protegida; bloqueio de linha + versão + índices únicos parciais; testado com 30 requisições concorrentes no PostgreSQL | — |
| T3 | Nova cobrança após resultado desconhecido | UNKNOWN bloqueia novas operações; sem transição para reenvio; referência continua protegida | Rotina agendada de reconciliação e alertas |
| T4 | Resultado falso ou inconsistente do provedor | Evidência tipada obrigatória; capacidades declaradas; resultado incompatível vira UNKNOWN; notificação de outro provedor rejeitada; evidência contraditória rejeitada e auditada; código de resultado e referência do provedor normalizados (charset e tamanho restritos, sem números com Luhn válido) antes de persistir, auditar, registrar ou responder | Autenticação de webhooks reais (assinatura do provedor) |
| T5 | Replay de requisições | Idempotência impede efeito duplicado | Janela temporal/nonce para requisições assinadas, se adotadas |
| T6 | Vazamento de segredos em logs ou respostas | Serializadores com campos permitidos (sem cabeçalhos/corpo); redação de caminhos sensíveis; erros 500 genéricos com correlationId; mensagens e stacks de erro passam por `redactSensitiveText` (URLs com senha, Bearer, atribuições de segredo, números longos, tokens opacos); campos de driver com valores (`detail`, `hint`, `where`, `query`, `parameters`) nunca são registrados; sem stack em produção; configuração inválida não ecoa valores; testes de regressão em `apps/api/test/security-audit.test.ts` | Revisão periódica dos logs em ambiente real |
| T7 | Segredos no código ou no Git | `.env` ignorado; `check-secrets` (chaves privadas, tokens, atribuições, URLs com senha, números que passam no Luhn) | gitleaks (ou equivalente) no CI; cofre de segredos |
| T8 | SQL injection | Consultas 100% parametrizadas; validação de formato dos IDs; teste com entrada maliciosa | — |
| T9 | Adulteração da auditoria | Cadeia de hash por tenant com verificação; gatilho contra UPDATE/DELETE/TRUNCATE | Papel de aplicação sem privilégio de dono/DDL; ancoragem externa (WORM); verificação agendada |
| T10 | Credencial de API vazada ou fraca | Hash SHA-256 de chave aleatória, comparação em tempo constante, formato mínimo; autenticação antes de qualquer processamento; 401 idêntico para ausente/inválida | Rotação, revogação, escopos, OAuth2/mTLS, limite de taxa (ADR 0009) |
| T11 | Abuso/DoS da API | Limite de corpo (16 KB), timeouts de banco e provedor; API só escuta em loopback nesta fase (configuração recusa outro HOST) | Rate limiting por credencial e por IP; proteção de borda |
| T12 | Uso do simulador em produção | Configuração recusa `TEF_PROVIDER=simulator` e persistência em memória com `NODE_ENV=production`; respostas marcam `simulated: true` | — |
| T13 | Abuso de operador (resolução manual) | Dupla aprovação por pessoas distintas, justificativa e documento obrigatórios, auditados | Rota administrativa com MFA e RBAC |
| T14 | Comprometimento do agente ou da atualização (futuro) | — | Atualização assinada, mTLS por agente, revogação, SBOM |
| T15 | Processo local malicioso chamando o agente (futuro) | — | Pareamento PDV↔agente, token por instalação, ACL |
| T16 | Painel local usado por terceiros ou exposto em rede | Rotas /admin só existem com token configurado; recusado em produção; API e Vite só em loopback (configuração recusa outro HOST); limite de tentativas de login | Autenticação de produção com contas, MFA, RBAC (ADR 0015) |
| T17 | CSRF / uso da sessão por outra origem | Cookie HttpOnly + SameSite=Strict + Path=/admin; cabeçalho obrigatório x-tef-admin; Origin restrito a origens locais; sem CORS | — |
| T18 | Segredo embutido no JavaScript do painel | Nenhuma variável de ambiente exposta (envPrefix não usado, sem VITE_); token digitado e validado no servidor; teste estático e verificação do bundle (`check:web`) comparando valores reais do .env | — |
| T19 | Cobrança duplicada por worker que caiu ou tarefa entregue duas vezes | PENDING→IN_FLIGHT uma única vez sob bloqueio; IN_FLIGHT encontrado vira UNKNOWN; lease renovado com verificação de posse na mesma transação do envio (worker que perdeu a posse não age); tarefa ativa única por operação; testado com 3 workers no PostgreSQL | Sincronização de relógio entre hosts (lease usa relógio da aplicação) |
| T20 | Resultado falso por estado perdido do provedor (simulador entre processos/reinícios) | Livro durável do simulador no PostgreSQL com escopo de autoridade (operações anteriores ao livro nunca viram "não enviado"); a API nunca chama o provedor (ADR 0016) | Para provedores reais: depende da consulta oficial |
| T21 | Acesso entre clientes pelo painel | Rotas escopadas por /customers/{id}; consultas por cliente; FKs compostas; testes de isolamento | Operador local é global por definição (ADR 0015) |

## Riscos residuais aceitos na F1
- Autenticação provisória (T10); sem rate limiting (T11) — mitigado na F1 pela escuta somente em loopback.
- A redação de texto livre é heurística: reduz, mas não elimina, o risco de uma biblioteca colocar dado sensível numa mensagem de erro.
- Workflow de CI usa actions por tag de versão (não por SHA) e nunca foi executado.
- O operador do painel local enxerga todos os clientes; não há usuários individuais nem trilha por pessoa.
- Auditoria detecta, mas não impede, reescrita por superusuário (T9).
- Ambiente de desenvolvimento usa PostgreSQL com usuário dono das tabelas.

## Resposta a incidentes (a formalizar)
Procedimento pendente para: suspeita de cobrança duplicada, UNKNOWN em massa, cadeia de auditoria inválida, vazamento de credencial. Requisitos mínimos já viabilizados pelo código: correlationId em toda resposta, trilha de auditoria por recurso, resolução manual auditada.

## Conformidade
Os requisitos do PCI DSS e do PCI Secure Software Standard aplicáveis devem ser avaliados com profissionais qualificados (QSA) e com os provedores parceiros. Nenhuma declaração de conformidade, certificação ou homologação é feita.
