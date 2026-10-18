# CLAUDE.md — regras permanentes do projeto TEF Platform

Plataforma de orquestração de pagamentos (TEF) para licenciamento à AMLABS VENTURES e integração futura com a TouchPay.
A direção de produto controla escopo e aprova decisões arquiteturais relevantes. Leia `docs/ARCHITECTURE.md`, `docs/TRANSACTION_LIFECYCLE.md` e `docs/decisions/` antes de mudar comportamento.

## Limites que não podem ser ultrapassados sem autorização explícita e por escrito
- Não conectar adquirentes, provedores ou sistemas de produção (AMLABS, TouchPay). Não realizar cobranças reais.
- Não usar credenciais reais de adquirentes. Integrações reais começam em **ambiente de testes**, com contrato e **documentação oficial**.
- Não implementar comunicação proprietária com pinpads por engenharia reversa ou tentativa e erro.
- Não inventar respostas de adquirentes e apresentá-las como reais. O único adaptador existente é o `SIMULATOR`.
- Não declarar a plataforma PCI compliant, certificada, homologada ou pronta para produção.
- Não criar repositório remoto, fazer push, deploy ou publicar sem autorização.

## Segurança (sempre)
- Nunca aceitar, registrar ou armazenar PIN, CVV, trilha ou PAN completo. Criptografia não torna permitido armazenar dados proibidos.
- Segredos só em variáveis de ambiente ou cofre; nunca no código, no Git, em logs ou em mensagens de erro. `.env` é ignorado pelo Git.
- Logs: apenas campos permitidos (veja `apps/api/src/logging.ts`). Nunca registrar cabeçalhos, corpo de requisição ou objetos de configuração. Erros sempre pela chave `err` (serializador com redação); nunca registrar `detail`/`query`/`parameters` de drivers. Texto livre externo vai para log só depois de `redactSensitiveText`.
- Respostas HTTP de erro: código estável + mensagem controlada + `correlationId`; erros inesperados sempre 500 genérico.
- Textos vindos de provedores (códigos, referências) passam por `safeProviderCode`/`safeProviderReference` antes de persistir ou responder.
- A API só escuta em loopback até existirem autenticação definitiva e rate limiting (F2).
- Auditoria: apenas campos de `AUDIT_DATA_ALLOWED_KEYS` (`packages/audit`).
- SQL sempre parametrizado. Toda consulta de negócio filtra por `tenant_id`.
- O tenant vem da credencial, nunca do corpo da requisição.
- Não usar HMAC com segredo embutido em aplicativo cliente como única fronteira de autenticação.
- Encadeamento de hash detecta adulteração; não chame isso de imutabilidade absoluta.

## Regras transacionais (invariantes)
- Dinheiro é inteiro em centavos (`Money`). Proibido ponto flutuante em cálculo financeiro.
- Transições de estado só pelas funções do domínio (`packages/domain`). Não atualize `state`/`status` diretamente em SQL ou em outra camada.
- Gravar a intenção (PROCESSING/IN_FLIGHT) **antes** de chamar o provedor.
- Falta de resposta = **UNKNOWN**, nunca "falhou". **UNKNOWN nunca é reenviado automaticamente**; só consulta, notificação autenticada, arquivo de conciliação ou resolução manual com dupla aprovação o resolvem.
- Resultado definitivo exige evidência compatível e capacidade declarada pelo provedor.
- Cancelamento, desfazimento e estorno são operações distintas. Estorno parcial não marca o pagamento como REVERSED.
- No máximo uma operação aberta por pagamento.
- Idempotência por `(tenant, estabelecimento, escopo, chave)` com hash canônico. Idempotência interna não garante idempotência na adquirente.
- Estado de pagamento é separado do estado fiscal.

## Arquitetura
- Monólito modular hexagonal. `domain` não faz I/O (o lint impede). Adaptadores traduzem; não decidem estado.
- Sem microsserviços nem abstrações especulativas.
- Novo provedor: implementar `PaymentProvider`, declarar capacidades a partir da documentação oficial (na dúvida, `false`) e passar em `runProviderConformanceSuite`.
- Mudança de esquema: nova migração em `packages/persistence/migrations/NNNN_*.sql`. Nunca editar migração já aplicada.
- Decisão relevante: nova ADR numerada em `docs/decisions/`, marcando claramente o que é provisório.
- Linguagem e estratégia offline do agente local continuam pendentes até análise do SDK oficial (ADR 0011).

## Fluxo de trabalho
- Antes de concluir: `npm run lint`, `npm run typecheck`, `npm test` e, para mudanças de persistência, `npm run test:db` (exige Docker: `npm run db:up`).
- Não declarar sucesso sem evidência. Teste bloqueado por dependência externa deve ser relatado como bloqueado, nunca como aprovado.
- Garantias transacionais só contam como verificadas quando testadas no PostgreSQL.
- Preservar alterações existentes; não sobrescrever configurações globais da máquina.
- Commits apenas quando solicitados.
