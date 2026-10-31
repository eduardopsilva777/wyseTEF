# Operação: ambientes, banco e CI

> Situação: Fase 2B, incremento I2. Ainda **não há** ambiente de homologação ou produção, autenticação administrativa definitiva, RBAC, MFA, RLS nem limite de taxa. Os perfis `staging` e `prod` existem para que recursos de desenvolvimento **não possam** ser ativados por engano; eles não tornam o sistema pronto para uso comercial.

## 1. Perfis de ambiente (`TEF_ENV`, ADR 0020)

| Regra | `dev` | `test` | `staging` | `prod` |
|---|---|---|---|---|
| `NODE_ENV` coerente | development | test | production | production |
| Persistência em memória | permitida | permitida | recusada | recusada |
| Provedor SIMULATOR | permitido | permitido | permitido (respostas marcadas como simuladas) | **recusado** |
| Token do painel local (`TEF_DEV_ADMIN_TOKEN_SHA256`) | permitido | permitido | recusado | recusado |
| Credenciais de integração `dev-*` | permitidas | permitidas | recusadas | recusadas |
| Cookie de sessão | `tef_dev_admin`, sem `Secure` | idem | `__Secure-tef_admin`, `Secure` | idem |
| TLS no PostgreSQL (`sslmode`) | — | — | `require` ou mais forte | `verify-full` |
| Identidade restrita de banco | aviso | não verificada | **obrigatória** | **obrigatória** |
| `LOG_LEVEL` debug/trace | permitido | permitido | recusado | recusado |
| Escuta da API e do health do worker | só loopback | só loopback | só loopback | só loopback |

- Sem `TEF_ENV`: `NODE_ENV=production` → `prod`; `NODE_ENV=test` → `test`; caso contrário `dev`.
- `TEF_ENV=dev` com `NODE_ENV=production` (ou qualquer contradição) impede a inicialização.
- Hoje **não existe configuração de `prod` válida**: o único provedor é o simulador.
- `HttpOnly` e `SameSite=Strict` valem em todos os perfis.

### Variáveis obrigatórias por processo
| Processo | Variáveis | Observação |
|---|---|---|
| API | `DATABASE_URL` (papel `tef_app`), `TEF_API_CREDENTIALS` | `TEF_PERSISTENCE=memory` só em dev/test |
| Worker | `TEF_WORKER_DATABASE_URL` (papel `tef_worker`) | em dev/test aceita `DATABASE_URL` por compatibilidade; em staging/prod exige identidade distinta da API |
| Migrações | `TEF_OWNER_DATABASE_URL` (papel `tef_owner`) | em dev/test, sem ela, usa `DATABASE_URL` com aviso; `TEF_MIGRATION_ROLE` faz `SET ROLE` quando o login é membro do dono |
| Bootstrap local | `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB` ou `TEF_DB_ADMIN_URL` | só dev/test; recusado em staging/prod |

Mensagens de configuração nunca ecoam valores (URLs, senhas, hashes).

## 2. Papéis do PostgreSQL

| Papel | Responsabilidade | Pode | Não pode |
|---|---|---|---|
| `tef_owner` | Dono do schema; executa migrações | DDL no schema da plataforma | SUPERUSER, CREATEROLE, CREATEDB, REPLICATION, BYPASSRLS |
| `tef_app` | API | DML específico da 0005 (pagamentos, operações, idempotência, auditoria por inserção, outbox por inserção, cadastro, fila, diretivas de teste) | DDL, TRUNCATE, desligar gatilhos, GRANT, ler o livro do simulador, publicar a outbox, apagar pagamentos ou auditoria |
| `tef_worker` | Worker | Transições de pagamentos e operações, auditoria por inserção, publicação da outbox, fila, batimento, livro do simulador | Criar pagamentos ou operações, ler cadastro ou idempotência, DDL, TRUNCATE, apagar tarefas |

A lista exata está em `packages/persistence/migrations/0005_runtime_role_privileges.sql`. Toda migração nova que criar tabela deve trazer os próprios GRANTs, com o mínimo necessário.

## 3. Inicialização local

```bash
npm install
npm run dev:setup   # cria/completa o .env: senhas aleatórias das identidades de banco (nunca exibidas)
npm run dev         # db:up → db:bootstrap → db:migrate (tef_owner) → API (tef_app), worker (tef_worker) e painel
```

Passo a passo equivalente:
```bash
npm run db:up
npm run db:bootstrap   # papéis, propriedade dos objetos de public para tef_owner, ACLs (idempotente; não apaga dados)
npm run db:migrate     # como tef_owner
```

### Atualização de um ambiente local anterior à F2B
`npm run dev:setup` detecta um `.env` em que `DATABASE_URL` usa o superusuário do contêiner. Ele grava `DATABASE_URL` (`tef_app`), `TEF_OWNER_DATABASE_URL` e `TEF_WORKER_DATABASE_URL` com senhas novas e faz cópia em `.env.backup-<data>` (ignorada pelo Git; apague quando não precisar mais). Em seguida, `npm run dev` aplica o bootstrap e a migração 0005. Os dados existentes, inclusive o pagamento UNKNOWN legado, não são alterados.

## 4. Recuperação do ambiente local
| Situação | Procedimento |
|---|---|
| Senha de identidade perdida, ou `.env` restaurado de outra máquina | `npm run dev:setup -- --rotate-db-passwords` e depois `npm run db:bootstrap` (reaplica as senhas nos papéis) |
| API ou worker avisam "identidade de banco não é a restrita" | `npm run dev:setup` e depois `npm run db:bootstrap` |
| `db:migrate` falha com "papéis ausentes" | `npm run db:bootstrap` antes de migrar |
| `db:migrate` falha com permissão (42501/3F000) | O schema ainda pertence ao superusuário: `npm run db:bootstrap` |
| Senha do superusuário local perdida | Não há recuperação sem acesso ao contêiner. A alternativa destrutiva (`docker compose down -v`) apaga os dados locais e só deve ser usada conscientemente |

Nenhum procedimento exibe senhas. O bootstrap envia ao servidor apenas o verificador SCRAM-SHA-256.

## 5. Staging e produção (quando existirem)
- Papéis e senhas provisionados pela infraestrutura (DBA/IaC), com segredos em cofre. O bootstrap local é recusado.
- `TEF_OWNER_DATABASE_URL` só no processo de migração (pipeline de deploy), nunca na API ou no worker.
- TLS obrigatório até o PostgreSQL. O acesso de superusuário deve ser restrito e auditado: ele contorna a auditoria (T9).
- Pendente antes de qualquer exposição: autenticação administrativa, MFA, RBAC, limite de taxa, RLS e TLS na borda (incrementos I3–I12).

## 6. Verificações de segurança automatizadas
- `tests/integration/postgres-roles.test.ts`:
  - DDL, desligar gatilhos, `session_replication_role`, `TRUNCATE`, `UPDATE`/`DELETE` na auditoria, escalada de papel e `GRANT` executados de verdade com `tef_app` e `tef_worker`; o PostgreSQL nega cada um.
  - Operações legítimas da API (inclusive HTTP real) e do worker, com as garantias do I1.
  - Verificação de identidade na inicialização.
- `tests/integration/migrations.test.ts`: base anterior (objetos do superusuário) → bootstrap → 0002–0005 como `tef_owner`, preservando dados e checksums.
- Testes de configuração por perfil (`packages/config/test`, `apps/api/test/config.test.ts`, `apps/worker/test/config.test.ts`) e do cookie (`apps/api/test/cookie-policy.test.ts`).
- `tests/tooling/dev-setup.test.ts`: geração e conversão do `.env` num diretório temporário, sem imprimir senhas.

## 7. CI (`.github/workflows/ci.yml`)

| Job | Etapas |
|---|---|
| `secrets` | Gitleaks 8.30.1 (binário verificado por SHA-256) sobre os commits introduzidos: `base..head` em PR, `before..sha` em push e histórico completo no primeiro push. Regras padrão, sem allowlist (`.gitleaks.toml`) |
| `verify` | `npm ci` → lint → tipos → testes unitários → `test:db` (PostgreSQL 18 de serviço) → `check:web` → `check:secrets` → `check:deps` → Chromium do Playwright → `test:e2e` |

- **Actions fixadas por SHA completo**, conferido em 2026-10-19 nos repositórios e releases oficiais:
  - `actions/checkout` v7.0.1 = `3d3c42e5aac5ba805825da76410c181273ba90b1`.
  - `actions/setup-node` v7.0.0 = `820762786026740c76f36085b0efc47a31fe5020`. A v7.1.0 tinha 11 dias e não foi adotada.
- `permissions: contents: read` e `persist-credentials: false`.
- **E2E:**
  - Banco descartável e logins temporários criados e removidos pelo `scripts/test-e2e.mjs`, inclusive em falha.
  - Trace e screenshots desligados no CI, porque o token do painel é digitado no login; nenhum artefato é publicado.
- **Limitações:**
  - O workflow **nunca foi executado** em serviço de CI: não há repositório remoto.
  - Localmente foram validados o workflow (actionlint 1.7.12), a sintaxe bash dos blocos `run`, o Gitleaks 8.30.1 (histórico e alterações) e todas as etapas `npm`.
  - O E2E rodou localmente com Edge, não com o Chromium do Playwright (que não foi baixado).
  - A imagem `postgres:18-alpine` é referenciada por tag, não por digest.
