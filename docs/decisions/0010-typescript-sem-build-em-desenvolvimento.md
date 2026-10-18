# 0010 — Execução de TypeScript sem etapa de build em desenvolvimento

- **Status:** Provisória
- **Data:** 2026-10-18

## Decisão
Os pacotes exportam `src/*.ts` diretamente. Em desenvolvimento, o Node 24 executa TypeScript com remoção nativa de tipos (por isso `erasableSyntaxOnly` e imports com extensão `.ts`); o Vitest usa o próprio transformador. A verificação de tipos é feita por `tsc` com `noEmit`.

Verificado em 2026-10-18: `node apps/api/src/main.ts` sobe a API e atende requisições contra o PostgreSQL local.

## Pendência
Definir o empacotamento de produção (build com `tsc` ou bundler, e imagem mínima) antes da primeira implantação.
