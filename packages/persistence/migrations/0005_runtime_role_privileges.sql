-- 0005 — Privilégios das identidades de execução (ADR 0020).
-- Executada por tef_owner (dono do schema). Os papéis são objetos do cluster e vêm do
-- bootstrap (npm run db:bootstrap); esta migração apenas concede privilégios, tabela a
-- tabela, no schema corrente. Nenhum GRANT amplo (ALL TABLES), nenhum privilégio de DDL,
-- TRUNCATE, REFERENCES, TRIGGER ou WITH GRANT OPTION.

DO $$
DECLARE
  s text := current_schema();
  missing text;
BEGIN
  SELECT string_agg(r, ', ') INTO missing
    FROM unnest(ARRAY['tef_owner', 'tef_app', 'tef_worker']) AS r
   WHERE to_regrole(r) IS NULL;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'papéis ausentes no cluster: % (rode "npm run db:bootstrap" antes de migrar)', missing;
  END IF;
  -- Acesso ao schema: concedido aqui quando tef_owner é o dono; no schema "public" de um
  -- banco existente, o bootstrap já concede (o dono de "public" é pg_database_owner).
  IF NOT has_schema_privilege('tef_app', s, 'USAGE') OR NOT has_schema_privilege('tef_worker', s, 'USAGE') THEN
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO tef_app, tef_worker', s);
  END IF;
  IF NOT has_schema_privilege('tef_app', s, 'USAGE') OR NOT has_schema_privilege('tef_worker', s, 'USAGE') THEN
    RAISE EXCEPTION 'tef_app/tef_worker sem USAGE no schema % (rode "npm run db:bootstrap")', s;
  END IF;
END $$;

-- ---------------------------------------------------------------- API (tef_app)
-- Pagamentos e operações: a API cria e aplica transições (bloqueio FOR UPDATE exige UPDATE).
GRANT SELECT, INSERT, UPDATE ON payments, payment_operations TO tef_app;
-- Idempotência: reserva e leitura; nenhuma alteração posterior.
GRANT SELECT, INSERT ON idempotency_keys TO tef_app;
-- Auditoria encadeada: só acrescenta e lê; a cabeça da cadeia é atualizada sob bloqueio.
GRANT SELECT, INSERT, UPDATE ON audit_chain_heads TO tef_app;
GRANT SELECT, INSERT ON audit_events TO tef_app;
-- Outbox: grava eventos na mesma transação; lê a contagem pendente (painel).
GRANT SELECT, INSERT ON outbox_events TO tef_app;
-- Cadastro: CRUD do painel (exclusões com histórico são barradas por FK e pela aplicação).
GRANT SELECT, INSERT, UPDATE, DELETE ON customers, merchants, terminals TO tef_app;
-- Fila: enfileira tarefas e antecipa a reconciliação ("reconciliar agora").
GRANT SELECT, INSERT, UPDATE ON jobs TO tef_app;
-- Diretivas fictícias do simulador e leitura do batimento do worker (painel).
GRANT SELECT, INSERT ON provider_test_directives TO tef_app;
GRANT SELECT ON worker_heartbeats TO tef_app;

-- ---------------------------------------------------------------- worker (tef_worker)
-- Transições de pagamentos e operações já criados pela API (nunca cria pagamentos).
GRANT SELECT, UPDATE ON payments, payment_operations TO tef_worker;
-- Auditoria e outbox: acrescenta eventos; publica (marca entregue/falha) a outbox.
GRANT SELECT, INSERT, UPDATE ON audit_chain_heads TO tef_worker;
GRANT SELECT, INSERT ON audit_events TO tef_worker;
GRANT SELECT, INSERT, UPDATE ON outbox_events TO tef_worker;
-- Fila: reivindica, renova, conclui e enfileira reconciliações.
GRANT SELECT, INSERT, UPDATE ON jobs TO tef_worker;
-- Batimento (upsert) e leitura das diretivas de teste.
GRANT SELECT, INSERT, UPDATE ON worker_heartbeats TO tef_worker;
GRANT SELECT ON provider_test_directives TO tef_worker;
-- Livro durável do SIMULADOR (ADR 0016): registra e consulta o que "o provedor" processou.
GRANT SELECT, INSERT ON simulator_ledger TO tef_worker;
GRANT SELECT ON simulator_ledger_meta TO tef_worker;
GRANT USAGE ON SEQUENCE simulator_ledger_seq TO tef_worker;
