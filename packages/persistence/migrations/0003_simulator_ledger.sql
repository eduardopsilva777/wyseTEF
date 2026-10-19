-- 0003 — Livro do SIMULADOR ("verdade do lado do provedor" simulada).
-- Compartilhado por todos os processos e durável entre reinícios: sem isso, uma
-- consulta feita por outro processo (ou após reinício) responderia "não encontrado"
-- para algo que foi processado, e "não encontrado" é tratado como definitivo pelo
-- simulador. Dados exclusivamente fictícios; nunca usado por provedor real.

CREATE SEQUENCE simulator_ledger_seq;

CREATE TABLE simulator_ledger (
  client_reference       text        PRIMARY KEY,
  kind                   text        NOT NULL CHECK (kind IN ('AUTHORIZATION','CONFIRMATION','UNDO','CANCELLATION','REFUND')),
  outcome                text        NOT NULL CHECK (outcome IN ('SUCCEEDED', 'REJECTED', 'ABORTED')),
  provider_reference     text        NOT NULL UNIQUE CHECK (provider_reference ~ '^SIM-[0-9]{8,}$'),
  requires_confirmation  boolean     NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now()
);
