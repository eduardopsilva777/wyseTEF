# 0020 — Perfis de ambiente e identidades restritas no PostgreSQL

- **Status:** Aceita (a prontidão para produção continua dependendo dos incrementos seguintes da F2B)
- **Data:** 2026-10-19
- **Relaciona-se a:** 0008 (papel da aplicação sem DDL), 0009 e 0015 (recursos de desenvolvimento), 0013 (worker)

## Contexto
Até a F2A, a API, o worker e as migrações usavam o mesmo usuário do PostgreSQL — no ambiente local, o superusuário do contêiner, dono de todas as tabelas. Um defeito ou injeção na API teria privilégio para alterar o esquema, desligar o gatilho da auditoria ou conceder acessos. A configuração diferenciava apenas `NODE_ENV=production`, sem um perfil explícito de homologação.

## Decisão
1. **Perfis** `TEF_ENV` = `dev` | `test` | `staging` | `prod` (pacote `@tef/config`). Sem `TEF_ENV`, `NODE_ENV=production` resolve para `prod` (o mais restritivo); combinações contraditórias são recusadas. Matriz completa em `docs/OPERATIONS.md`. Em resumo: só `dev`/`test` aceitam token do painel local, persistência em memória e credenciais `dev-*`; `staging`/`prod` exigem TLS no banco, cookies `Secure` (`__Secure-tef_admin`) e identidades restritas, e recusam logs `debug`/`trace`; `prod` recusa também o simulador. **Nenhum perfil torna o sistema pronto para produção**: os perfis só impedem a ativação acidental de recursos de desenvolvimento.
2. **Identidades do PostgreSQL** (objetos do cluster, criados por bootstrap, nunca por migração):
   - `tef_owner` — dono do schema e executor das migrações; sem SUPERUSER, CREATEROLE, CREATEDB, REPLICATION ou BYPASSRLS.
   - `tef_app` — API: DML específico por tabela; nenhum DDL, TRUNCATE, TRIGGER, REFERENCES, GRANT OPTION ou propriedade.
   - `tef_worker` — worker: só o que fila, outbox, reconciliação e livro do simulador exigem; não cria pagamentos nem lê cadastro ou idempotência.
3. **Migração 0005** concede os privilégios tabela a tabela no schema corrente e falha se os papéis não existirem. As migrações 0001–0004 não mudam.
4. **Bootstrap local** (`npm run db:bootstrap`, só `dev`/`test`): cria ou ajusta os papéis com as senhas do `.env` (enviadas como verificador SCRAM, nunca em texto puro), transfere a propriedade dos objetos existentes de `public` para `tef_owner`, concede USAGE às identidades de execução e retira `CREATE`/`TEMPORARY` de PUBLIC. Em `staging`/`prod`, os papéis são provisionados pela infraestrutura.
5. **Verificação na inicialização**: API e worker conferem a própria identidade (não superusuário, sem atributos administrativos, não membro de `tef_owner`, não dono de objetos, sem CREATE no schema, membro do papel esperado). Em `staging`/`prod` a violação impede a subida; em `dev` gera aviso; em `test` não é verificada.
6. **Testes** usam logins temporários membros dos papéis reais; migrações rodam como `tef_owner` e o código do produto nunca como dono ou superusuário.
7. **CI**: actions fixadas por SHA completo, Gitleaks com binário verificado por SHA-256 e E2E com Chromium, sem trace nem artefatos.

## Consequências
- Um comprometimento da API não permite DDL, desligar a auditoria, conceder privilégios nem ler o livro do simulador; um do worker não cria pagamentos nem altera cadastro.
- Novas tabelas exigem GRANTs explícitos na própria migração (não há privilégios padrão amplos).
- O bootstrap altera o banco local existente (propriedade dos objetos e ACLs), sem alterar dados.
- Superusuário continua capaz de tudo, inclusive reescrever a auditoria (T9): o acesso de superusuário precisa ser restrito e auditado fora da aplicação.
- RLS, identidade administrativa, MFA, RBAC e limite de taxa continuam pendentes (incrementos I3–I8).
