# 0015 — Acesso administrativo exclusivo do ambiente local

- **Status:** Provisória (somente desenvolvimento local; não é a autenticação do produto)
- **Data:** 2026-10-18

## Contexto
O painel precisa operar contra a API real sem embutir credenciais no JavaScript entregue ao navegador e sem desligar a autenticação existente.

## Decisão
- As rotas `/admin/api/*` só existem quando `TEF_DEV_ADMIN_TOKEN_SHA256` está configurado. A configuração **recusa** essa variável com `NODE_ENV=production`, e a API só escuta em loopback.
- O operador digita o token no painel. O servidor compara o SHA-256 em tempo constante, limita tentativas (10 a cada 5 minutos) e emite uma sessão aleatória de 256 bits em cookie `HttpOnly; SameSite=Strict; Path=/admin`, válida por 8 horas. O servidor guarda só o hash do identificador da sessão.
- Toda rota administrativa exige o cabeçalho `x-tef-admin: 1` (bloqueia CSRF entre origens, já que não há CORS) e recusa `Origin` fora da lista de origens locais.
- A credencial de integração (`Bearer`) não abre o painel, e a sessão do painel não abre a API `/v1`.
- O token nunca é gravado em texto puro: `npm run dev:setup` o exibe uma vez no terminal e grava só o hash no `.env`.
- O cookie não usa `Secure` porque o painel local roda em `http://127.0.0.1`.

## O operador local é global
A sessão local enxerga todos os clientes (papel de operador da plataforma). O isolamento entre clientes nas rotas administrativas vem do caminho (`/customers/{id}/…`), das consultas escopadas e das chaves estrangeiras, não de permissões por usuário.

## Pendências para uso comercial
Contas individuais com MFA, RBAC aplicado no servidor, escopo por cliente para usuários de clientes, sessões persistentes com revogação, `Secure` + HTTPS, registro de acesso por pessoa.
