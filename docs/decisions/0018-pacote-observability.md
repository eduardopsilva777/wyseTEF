# 0018 — Logger sanitizado compartilhado (@tef/observability)

- **Status:** Aceita
- **Data:** 2026-10-18

## Decisão
Com dois processos (API e worker), o logger com campos permitidos, redação e serializador de erros sanitizado foi movido de `apps/api/src/logging.ts` para `packages/observability`. O arquivo antigo da API passou a ser uma reexportação, para não quebrar imports existentes. Cada processo identifica-se pelo campo `service` (`tef-api`, `tef-worker`).
