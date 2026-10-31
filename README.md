# TEF Platform

**WyseTEF**: plataforma de orquestração de pagamentos (TEF). **Fase 2A, MVP local** com API assíncrona, worker, PostgreSQL e painel web.

> **Aviso:** não há integração com adquirentes ou provedores reais. O único provedor é o **SIMULATOR**, com dados fictícios. Nenhum pagamento é real.
> A plataforma não é homologada, certificada nem conforme ao PCI, e não está pronta para produção. O acesso ao painel é exclusivo do ambiente de desenvolvimento local.

## Pré-requisitos
- Node.js 24 (testado com 24.21.0) e npm 11.
- Docker com Compose (PostgreSQL 18 de desenvolvimento).
- Portas livres em 127.0.0.1: 3000 (API), 3001 (health do worker), 5173 (painel), 55432 (PostgreSQL).

## Primeira execução
```bash
npm install
npm run dev:setup   # cria o .env com segredos aleatórios (inclusive as senhas das identidades de banco, nunca exibidas)
                    # e mostra UMA vez o token do painel e a chave de API
npm run dev         # sobe PostgreSQL, cria os papéis (db:bootstrap), migra como tef_owner e inicia API (tef_app), worker (tef_worker) e painel
npm run db:seed     # opcional, em outro terminal: dados fictícios de demonstração
```

Guarde o token exibido pelo `dev:setup`: ele não fica gravado em lugar nenhum (o `.env` tem só o SHA-256). Para gerar outro: `npm run dev:setup -- --rotate-admin-token` (ou `--rotate-api-key` para a chave de integração) e reinicie a API.

| Componente | Endereço local |
|---|---|
| **Painel** | **http://127.0.0.1:5173** |
| API | http://127.0.0.1:3000 (health: `/health`) |
| Worker | http://127.0.0.1:3001/health |
| PostgreSQL | 127.0.0.1:55432 |

Tudo escuta apenas em loopback; a configuração recusa outros endereços nesta fase.

Perfis de ambiente (`TEF_ENV`: dev, test, staging, prod), papéis do PostgreSQL, atualização de um ambiente local antigo, recuperação de credenciais e CI: **[docs/OPERATIONS.md](docs/OPERATIONS.md)**. Um `.env` anterior à F2B é convertido pelo `npm run dev:setup`.

## Comandos

| Comando | O que faz |
|---|---|
| `npm run dev` | Ambiente completo (Ctrl+C encerra) |
| `npm run dev:api` / `dev:worker` / `dev:web` | Cada componente separadamente (carregue o `.env` no shell para API e worker) |
| `npm run db:up` / `db:down` | Sobe/derruba o PostgreSQL de desenvolvimento |
| `npm run db:bootstrap` | Cria/ajusta os papéis `tef_owner`, `tef_app` e `tef_worker` no PostgreSQL local (só dev/test; idempotente; não apaga dados) |
| `npm run db:migrate` | Aplica migrações como `tef_owner` (`TEF_OWNER_DATABASE_URL` do `.env`) |
| `npm run db:seed` | Insere dados fictícios; nunca apaga nem altera dados existentes; rodar de novo não duplica |
| `npm run lint` / `typecheck` | ESLint (com tipos) e TypeScript strict (backend e painel) |
| `npm test` | Todos os testes; os de PostgreSQL aparecem como *skipped* sem banco |
| `npm run test:db` | Testes de integração com PostgreSQL real (exige `db:up`); o código do produto roda com os papéis restritos |
| `npm run test:e2e` | Testes do painel no navegador (Playwright + Edge do sistema; `PW_CHANNEL=chromium` no CI; exige `db:up`). Cria um banco descartável, logins temporários dos papéis e credenciais aleatórias, usa as portas 3100/3101/5180 e remove tudo ao final, mesmo em falha |
| `npm run check:web` | Gera o bundle do painel e procura segredos nele |
| `npm run check:secrets` / `check:deps` | Varredura de segredos no repositório / `npm audit` |
| `npm run verify` | lint + tipos + testes + bundle + segredos + dependências |

## Roteiro rápido no painel
1. **Entrar:** cole o token do painel.
2. **Cadastrar:** Clientes → *Cadastrar cliente* (ex.: código `padaria-aurora`); Estabelecimentos → *Cadastrar estabelecimento*; Terminais → *Cadastrar terminal* (sempre simulado).
3. **Pagar:** Simulador → escolha cliente, estabelecimento, terminal, valor e cenário → *Criar pagamento simulado*. O resultado se atualiza sozinho conforme o worker processa a fila.
4. **Recusa:** cenário *Recusa* → estado final **Recusado**.
5. **Timeout:** cenário *Timeout após possível envio* → **Resultado desconhecido** por alguns segundos (nada é cobrado de novo) e depois **Aprovado**, com evidência "consulta ao provedor". *Timeout antes do envio* termina **Cancelado** (não enviado).
6. **Reconciliação:** cenário *Falha de comunicação após envio* → **Resultado desconhecido** e depois **Recusado** pela consulta. Em Transações, um pagamento em resultado desconhecido mostra *Reconciliar agora*, que antecipa a consulta feita pelo worker.
7. **Acompanhar:** Dashboard (indicadores do banco), Transações (detalhe com trilha de estados, operações, evidências e tarefas) e Auditoria (eventos e verificação da cadeia).

## API de integração (exemplo)
```bash
curl -X POST http://127.0.0.1:3000/v1/payments \
  -H "authorization: Bearer $TEF_KEY" -H "idempotency-key: pedido-1-criar" \
  -H "content-type: application/json" \
  -d '{"merchantId":"loja-centro","terminalId":"caixa-01","externalReference":"pedido-1","amount":{"cents":1000,"currency":"BRL"}}'
# 202 Accepted: estado PROCESSING, operação PENDING; consulte com GET /v1/payments/{id}
```
A chave `$TEF_KEY` é a exibida pelo `dev:setup` (cliente `demo-mercado`, criado pelo `db:seed`).

## Estrutura
```
apps/api                      API HTTP (integração /v1 e painel /admin/api)
apps/worker                   Worker: fila durável, outbox, health check
apps/web                      Painel React + Vite (somente local)
packages/domain               Domínio puro: Money, IDs, máquina de estados, cadastro
packages/application          Casos de uso, worker e portas
packages/providers/contract   Contrato de provedores + suíte de conformidade
packages/providers/simulator  Adaptador SIMULATOR e livro do simulador
packages/persistence          PostgreSQL (migrações, repositórios, CLIs) e implementação em memória para testes
packages/audit                Auditoria encadeada, sanitização e redação
packages/observability        Logger sanitizado
tests/                        Suítes de serviço, assíncrona, integração e segurança
docs/                         Produto, arquitetura, ameaças, ciclo de vida, integrações, testes, roadmap, ADRs
infra/dev                     docker-compose de desenvolvimento
```

## Documentação
[Product brief](docs/PRODUCT_BRIEF.md) · [Arquitetura](docs/ARCHITECTURE.md) · [Ciclo de vida](docs/TRANSACTION_LIFECYCLE.md) · [Ameaças](docs/THREAT_MODEL.md) · [Integrações](docs/INTEGRATIONS.md) · [Testes](docs/TEST_STRATEGY.md) · [Roadmap e limitações](docs/ROADMAP.md) · [Decisões](docs/decisions/README.md)
