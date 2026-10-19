-- 0004 — Escopo de autoridade do livro do SIMULADOR.
-- O livro só pode afirmar "não encontrado" (tratado como definitivo pelo simulador)
-- para operações criadas DEPOIS que ele passou a existir. Operações anteriores (ex.:
-- processadas por um simulador com livro em memória, na Fase 1) recebem "consulta
-- indisponível" e permanecem UNKNOWN até resolução com evidência.
-- O início é o momento em que a 0003 foi aplicada (ou agora, se não houver registro).

CREATE TABLE simulator_ledger_meta (
  singleton   boolean     PRIMARY KEY DEFAULT true CHECK (singleton),
  started_at  timestamptz NOT NULL
);

INSERT INTO simulator_ledger_meta (started_at)
SELECT coalesce(
  (SELECT applied_at FROM schema_migrations WHERE version = '0003_simulator_ledger.sql'),
  now()
);
