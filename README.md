# TEF Platform

Plataforma de orquestração de pagamentos (TEF) — **Fase 1: fundação e núcleo transacional.**

> **Aviso:** não há integração com adquirentes ou provedores reais. O único provedor é o **SIMULATOR**, com dados fictícios.
> A plataforma não é homologada, certificada nem conforme ao PCI, e não está pronta para produção.

## Requisitos
- Node.js 24 (testado com 24.21.0) e npm 11.
- Docker com Compose (só para PostgreSQL de desenvolvimento e testes de integração).

## Instalação
```bash
npm install
cp .env.example .env      # PowerShell: Copy-Item .env.example .env
# edite .env: defina POSTGRES_PASSWORD (local) e TEF_API_CREDENTIALS
```

Gerar uma chave de API local e o hash que vai no `.env`:
```bash
node -e "const c=require('crypto');const k=c.randomBytes(32).toString('base64url');console.log('chave:',k);console.log('sha256:',c.createHash('sha256').update(k).digest('hex'))"
```
Guarde a chave fora do repositório. No `.env` vai apenas o `sha256`.

## Comandos

| Comando | O que faz |
|---|---|
| `npm run lint` | ESLint com regras que exigem tipos |
| `npm run typecheck` | `tsc` em modo strict (sem emissão) |
| `npm test` | Todos os testes; os de PostgreSQL aparecem como *skipped* sem banco |
| `npm run db:up` / `npm run db:down` | Sobe/derruba o PostgreSQL 18 de desenvolvimento (`infra/dev`, porta local 55432) |
| `npm run test:db` | Testes de integração com PostgreSQL real (exige `db:up` e `.env`, ou `TEST_DATABASE_URL`) |
| `npm run db:migrate` | Aplica migrações em `DATABASE_URL` |
| `npm run dev:api` | Sobe a API com recarga (`node --watch`, TypeScript executado pelo Node 24) |
| `npm run check:secrets` | Varredura de segredos e de números que parecem cartão |
| `npm run check:deps` | `npm audit` |
| `npm run verify` | lint + tipos + testes + segredos + dependências |

Executar a API localmente:
```bash
npm run db:up
# carregue as variáveis do .env no shell (bash: set -a; . ./.env; set +a)
npm run db:migrate
npm run dev:api
```
Sem Docker, use `TEF_PERSISTENCE=memory` (só desenvolvimento; os dados somem ao reiniciar).
Nesta fase a API só aceita `HOST` em loopback (127.0.0.1, ::1, localhost); não exponha a porta em rede.

Exemplo:
```bash
curl -X POST http://127.0.0.1:3000/v1/payments \
  -H "authorization: Bearer $TEF_KEY" -H "idempotency-key: pedido-1-criar" \
  -H "content-type: application/json" \
  -d '{"merchantId":"merchant-dev","terminalId":"t-1","externalReference":"pedido-1","amount":{"cents":1000,"currency":"BRL"}}'
```
Cenários do simulador por centavos: veja `docs/INTEGRATIONS.md`.

## Estrutura
```
apps/api                      API HTTP (Fastify)
packages/domain               Domínio puro: Money, IDs, máquina de estados, evidências
packages/application          Casos de uso e portas
packages/providers/contract   Contrato de provedores + suíte de conformidade
packages/providers/simulator  Adaptador SIMULATOR
packages/persistence          PostgreSQL (migrações, repositórios) e implementação em memória para testes
packages/audit                Auditoria encadeada por hash e sanitização
tests/                        Suíte do serviço (memória e PostgreSQL) e utilitários
docs/                         Produto, arquitetura, ameaças, ciclo de vida, integrações, testes, roadmap, ADRs
infra/dev                     docker-compose de desenvolvimento
```

## Documentação
[Product brief](docs/PRODUCT_BRIEF.md) · [Arquitetura](docs/ARCHITECTURE.md) · [Ciclo de vida](docs/TRANSACTION_LIFECYCLE.md) · [Ameaças](docs/THREAT_MODEL.md) · [Integrações](docs/INTEGRATIONS.md) · [Testes](docs/TEST_STRATEGY.md) · [Roadmap e limitações](docs/ROADMAP.md) · [Decisões](docs/decisions/README.md)
