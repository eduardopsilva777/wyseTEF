# 0012 — Chamada ao provedor dentro da requisição na F1

- **Status:** Provisória (substituir antes da integração presencial real)
- **Data:** 2026-10-18

## Decisão
Na F1, `POST /v1/payments/{id}/authorize` (e as demais operações) chama o provedor dentro da requisição, limitada por `TEF_PROVIDER_TIMEOUT_MS`, e devolve o estado resultante, que pode ser UNKNOWN.

## Por que é provisório
Pagamento presencial pode levar dezenas de segundos de interação do portador. O modelo alvo é assíncrono (202 + consulta, long-polling ou webhook), com execução pelo worker ou pelo agente. A gravação antes do envio e a resolução de UNKNOWN já funcionam como no modelo alvo e não mudam.
