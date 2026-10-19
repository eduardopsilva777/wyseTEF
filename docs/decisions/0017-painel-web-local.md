# 0017 — Painel web local (React + Vite) sem segredos no navegador

- **Status:** Aceita
- **Data:** 2026-10-18

## Decisão
- `apps/web`: React 19 + TypeScript strict + Vite 8 (a mesma versão já instalada pelo Vitest). Sem bibliotecas de UI, roteamento ou estado: roteamento por hash e `fetch` simples.
- O servidor de desenvolvimento escuta em `127.0.0.1:5173` (porta fixa) e encaminha **apenas** `/admin` para a API local. O navegador fala com uma única origem; o cookie de sessão funciona sem CORS.
- Nenhuma variável de ambiente chega ao bundle: `envPrefix` é um prefixo que nenhuma variável do projeto usa, e o código do painel não lê `import.meta.env`. Segredos nunca usam `VITE_`.
- Autorização é sempre do servidor; a interface só esconde ações que o servidor recusaria de qualquer forma.
- Fontes do sistema (sem requisições a servidores externos); cores do gráfico validadas para daltonismo nos modos claro e escuro.
- Verificações: `tests/security/frontend.test.ts` (estático) e `npm run check:web` (gera o bundle e procura valores reais do `.env`, nomes de variáveis sensíveis e padrões de credenciais).

## Pendências
Empacotamento e hospedagem do painel para ambientes não locais; testes de componentes e de acessibilidade automatizados.
