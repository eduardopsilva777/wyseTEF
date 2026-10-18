# 0006 — Estratégia de idempotência

- **Status:** Aceita (retenção provisória)
- **Data:** 2026-10-18

## Decisão
- Cabeçalho `Idempotency-Key` obrigatório em todo POST que cria pagamento ou operação.
- Escopo único: `(tenant, estabelecimento, escopo da operação, chave)`, chave primária no banco.
- Hash SHA-256 do JSON canônico (chaves ordenadas) de escopo + parâmetros normalizados.
- A chave é reservada **na mesma transação** que cria o efeito. Se a transação falhar, a reserva também é desfeita.
- Mesma chave + mesmo hash devolve o recurso original (cabeçalho `idempotent-replayed: true`) sem novo efeito. Mesma chave + hash diferente dá 409 `IDEMPOTENCY_CONFLICT`.
- O registro guarda a referência ao recurso e o status HTTP original, não o corpo. A repetição devolve o estado atual do recurso.
- Proteção de negócio adicional: `(tenant, estabelecimento, referência comercial)` única enquanto o pagamento não estiver DECLINED/CANCELLED.

## Provisório
- Retenção de 30 dias (`expires_at`). Ainda **não existe** rotina de expurgo; até lá as chaves não expiram na prática.

## Limite
A idempotência interna **não** garante idempotência na adquirente. Cada adaptador oficial deve usar o mecanismo documentado do provedor. A `clientReference` (ID da operação) é enviada ao provedor para consulta e deduplicação quando ele suportar.
