# Decisões arquiteturais (ADRs)

Um arquivo por decisão, numeração sequencial e imutável. Para mudar uma decisão,
crie uma nova ADR que a substitua e atualize o status da antiga.

Status possíveis: **Aceita**, **Provisória** (vale até a condição de revisão), **Pendente** (ainda não decidida), **Substituída**.

| Nº | Decisão | Status |
|----|---------|--------|
| [0001](0001-monolito-modular-hexagonal.md) | Monólito modular com portas e adaptadores | Aceita |
| [0002](0002-orquestrador-semi-integrado.md) | Orquestrador semi-integrado, fora do fluxo de dados de cartão | Aceita |
| [0003](0003-stack-backend-typescript.md) | Stack do backend (TypeScript/Node 24/Fastify/Zod/Vitest) | Aceita (versões provisórias) |
| [0004](0004-postgresql-fonte-da-verdade.md) | PostgreSQL como fonte da verdade e estratégia de concorrência | Aceita |
| [0005](0005-pagamento-e-operacoes-com-evidencia.md) | Pagamento + operações, máquina de estados e evidência obrigatória | Aceita |
| [0006](0006-idempotencia.md) | Estratégia de idempotência | Aceita (retenção provisória) |
| [0007](0007-unknown-nunca-reenviado.md) | UNKNOWN nunca é reenviado automaticamente | Aceita |
| [0008](0008-auditoria-encadeada-e-outbox.md) | Auditoria encadeada por hash e outbox transacional | Aceita (ancoragem externa pendente) |
| [0009](0009-autenticacao-provisoria-chave-api.md) | Autenticação por chave de API | Provisória |
| [0010](0010-typescript-sem-build-em-desenvolvimento.md) | Execução de TypeScript sem etapa de build em desenvolvimento | Provisória |
| [0011](0011-agente-local-adiado.md) | Linguagem e estratégia offline do agente local | Pendente |
| [0012](0012-api-sincrona-na-f1.md) | Chamada ao provedor dentro da requisição na F1 | Provisória |
