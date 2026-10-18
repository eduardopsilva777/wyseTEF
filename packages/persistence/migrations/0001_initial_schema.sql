-- 0001 — Esquema inicial do núcleo transacional.
-- Migrações são imutáveis depois de aplicadas: o executor compara o checksum.
-- Nenhuma tabela guarda PAN, CVV, trilha, PIN ou credenciais.

CREATE TABLE payments (
  id                  text        PRIMARY KEY
                                  CHECK (id ~ '^pay_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  tenant_id           text        NOT NULL,
  merchant_id         text        NOT NULL,
  terminal_id         text        NOT NULL,
  external_reference  text        NOT NULL CHECK (char_length(external_reference) BETWEEN 1 AND 64),
  provider_id         text        NOT NULL,
  currency            char(3)     NOT NULL CHECK (currency = 'BRL'),
  amount_cents        bigint      NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 9999999999),
  reversed_cents      bigint      NOT NULL DEFAULT 0 CHECK (reversed_cents >= 0),
  state               text        NOT NULL CHECK (state IN
                        ('CREATED','PROCESSING','AUTHORIZED','APPROVED','DECLINED','UNKNOWN','CANCELLED','REVERSED')),
  state_reason        text,
  version             integer     NOT NULL CHECK (version >= 1),
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL,
  CONSTRAINT payments_reversed_not_above_amount CHECK (reversed_cents <= amount_cents),
  CONSTRAINT payments_reversed_state_consistent CHECK (state <> 'REVERSED' OR reversed_cents = amount_cents)
);

-- Referência comercial protegida: no máximo UMA cobrança por (tenant, estabelecimento,
-- referência) fora dos estados que liberam a referência (DECLINED, CANCELLED).
-- UNKNOWN continua protegendo: impede nova cobrança para a mesma intenção.
CREATE UNIQUE INDEX payments_protected_reference_uq
  ON payments (tenant_id, merchant_id, external_reference)
  WHERE state NOT IN ('DECLINED', 'CANCELLED');

CREATE INDEX payments_tenant_created_idx ON payments (tenant_id, created_at DESC);
CREATE INDEX payments_unknown_idx ON payments (tenant_id, updated_at) WHERE state = 'UNKNOWN';

CREATE TABLE payment_operations (
  id                     text        PRIMARY KEY
                                     CHECK (id ~ '^op_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  payment_id             text        NOT NULL REFERENCES payments (id),
  tenant_id              text        NOT NULL,
  kind                   text        NOT NULL CHECK (kind IN ('AUTHORIZATION','CONFIRMATION','UNDO','CANCELLATION','REFUND')),
  status                 text        NOT NULL CHECK (status IN
                           ('PENDING','IN_FLIGHT','UNKNOWN','SUCCEEDED','REJECTED','ABORTED','NOT_SENT')),
  amount_cents           bigint      NOT NULL CHECK (amount_cents > 0),
  currency               char(3)     NOT NULL CHECK (currency = 'BRL'),
  provider_reference     text,
  result_code            text,
  requires_confirmation  boolean,
  evidence               jsonb,
  version                integer     NOT NULL CHECK (version >= 1),
  created_at             timestamptz NOT NULL,
  updated_at             timestamptz NOT NULL,
  -- Resultado definitivo exige evidência registrada.
  CONSTRAINT payment_operations_final_has_evidence
    CHECK (status NOT IN ('SUCCEEDED','REJECTED','ABORTED','NOT_SENT') OR evidence IS NOT NULL)
);

-- No máximo UMA operação aberta por pagamento: uma operação UNKNOWN bloqueia
-- qualquer tentativa conflitante até ser reconciliada.
CREATE UNIQUE INDEX payment_operations_one_open_uq
  ON payment_operations (payment_id)
  WHERE status IN ('PENDING', 'IN_FLIGHT', 'UNKNOWN');

-- No máximo UMA autorização por pagamento.
CREATE UNIQUE INDEX payment_operations_one_authorization_uq
  ON payment_operations (payment_id)
  WHERE kind = 'AUTHORIZATION';

CREATE INDEX payment_operations_payment_idx ON payment_operations (payment_id, created_at);
CREATE INDEX payment_operations_in_flight_idx ON payment_operations (updated_at) WHERE status = 'IN_FLIGHT';
CREATE INDEX payment_operations_unknown_idx ON payment_operations (updated_at) WHERE status = 'UNKNOWN';

CREATE TABLE idempotency_keys (
  tenant_id        text        NOT NULL,
  merchant_id      text        NOT NULL,
  scope            text        NOT NULL,
  idem_key         text        NOT NULL CHECK (char_length(idem_key) BETWEEN 8 AND 128),
  request_hash     char(64)    NOT NULL,
  resource_type    text        NOT NULL CHECK (resource_type IN ('payment', 'operation')),
  resource_id      text        NOT NULL,
  response_status  integer     NOT NULL,
  created_at       timestamptz NOT NULL,
  expires_at       timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, merchant_id, scope, idem_key)
);

CREATE INDEX idempotency_keys_expires_idx ON idempotency_keys (expires_at);

-- Auditoria encadeada por hash, por tenant. O encadeamento DETECTA adulteração;
-- não a impede. Ver docs/THREAT_MODEL.md para os controles complementares.
CREATE TABLE audit_chain_heads (
  tenant_id  text     PRIMARY KEY,
  last_seq   bigint   NOT NULL,
  last_hash  char(64) NOT NULL
);

CREATE TABLE audit_events (
  tenant_id       text        NOT NULL,
  seq             bigint      NOT NULL CHECK (seq >= 1),
  occurred_at     timestamptz NOT NULL,
  actor_type      text        NOT NULL CHECK (actor_type IN ('API_CLIENT', 'SYSTEM', 'OPERATOR')),
  actor_id        text        NOT NULL,
  action          text        NOT NULL,
  resource_type   text        NOT NULL,
  resource_id     text        NOT NULL,
  correlation_id  text,
  data            jsonb       NOT NULL,
  prev_hash       char(64)    NOT NULL,
  hash            char(64)    NOT NULL,
  PRIMARY KEY (tenant_id, seq)
);

CREATE INDEX audit_events_resource_idx ON audit_events (tenant_id, resource_type, resource_id);

-- Barreira adicional (não absoluta): bloqueia UPDATE/DELETE/TRUNCATE para papéis
-- comuns. Um superusuário ou o dono da tabela pode desativar o gatilho; por isso
-- a aplicação deve rodar com um papel sem esses privilégios (ver THREAT_MODEL).
CREATE FUNCTION audit_events_reject_mutation() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events é somente inserção (operação % rejeitada)', TG_OP;
END;
$$;

CREATE TRIGGER audit_events_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_reject_mutation();

CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_reject_mutation();

-- Outbox transacional: eventos gravados na mesma transação da mudança de estado.
-- O publicador ainda não existe nesta fase (ver ROADMAP).
CREATE TABLE outbox_events (
  id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       text        NOT NULL,
  aggregate_type  text        NOT NULL,
  aggregate_id    text        NOT NULL,
  event_type      text        NOT NULL,
  payload         jsonb       NOT NULL,
  occurred_at     timestamptz NOT NULL,
  published_at    timestamptz
);

CREATE INDEX outbox_events_unpublished_idx ON outbox_events (id) WHERE published_at IS NULL;
