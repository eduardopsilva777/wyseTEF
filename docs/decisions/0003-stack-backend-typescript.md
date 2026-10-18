# 0003 — Stack do backend

- **Status:** Aceita (versões provisórias, revisar a cada fase)
- **Data:** 2026-10-18

## Decisão
- Node.js 24 (instalado: 24.21.0), TypeScript em modo `strict` (inclui `exactOptionalPropertyTypes` e `noUncheckedIndexedAccess`).
- npm workspaces; Fastify 5 (API); Zod 4 (validação); Vitest 5 + fast-check 4 (testes); pg 8 (PostgreSQL); pino 10 (logs).
- Versões fixadas exatamente no `package.json` (sem intervalos), com `package-lock.json` versionado.

## Compatibilidade verificada em 2026-10-18
- **TypeScript fixado em 6.0.3, não 7.x:** `typescript-eslint` 8.71.2 declara `typescript >=4.8.4 <6.1.0`. Revisar quando o typescript-eslint suportar o TS 7.
- Vitest 5.0.5 exige Node `^22.12 || ^24 || >=26`; ESLint 10 aceita Node `>=24`; Fastify 5.12 aceita pino `^9.14 || ^10.1`.

## Consequências
- Uma só linguagem para API, domínio e testes. O agente local pode usar outra linguagem (ver 0011).
