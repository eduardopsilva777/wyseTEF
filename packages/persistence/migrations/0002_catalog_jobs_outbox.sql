-- 0002 — Cadastro (clientes, estabelecimentos, terminais), fila durável de tarefas,
-- entrega da outbox, diretivas de teste do simulador e batimento do worker.
-- Não altera o significado de nada criado pela 0001.

-- Cliente empresarial. O id é o identificador de tenant usado em payments.tenant_id.
CREATE TABLE customers (
  id           text        PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$'),
  legal_name   text        NOT NULL CHECK (char_length(legal_name) BETWEEN 2 AND 120),
  trade_name   text        CHECK (trade_name IS NULL OR char_length(trade_name) BETWEEN 1 AND 120),
  status       text        NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE')),
  version      integer     NOT NULL CHECK (version >= 1),
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL
);

-- Estabelecimento: o código é único dentro do cliente (é o merchant_id dos pagamentos).
CREATE TABLE merchants (
  customer_id  text        NOT NULL REFERENCES customers (id) ON DELETE RESTRICT,
  id           text        NOT NULL CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$'),
  name         text        NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  city         text        CHECK (city IS NULL OR char_length(city) BETWEEN 1 AND 80),
  status       text        NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE')),
  version      integer     NOT NULL CHECK (version >= 1),
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL,
  PRIMARY KEY (customer_id, id)
);

-- Terminal: nesta fase, sempre SIMULADO (nenhum hardware real é suportado).
CREATE TABLE terminals (
  customer_id  text        NOT NULL,
  id           text        NOT NULL CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$'),
  merchant_id  text        NOT NULL,
  label        text        NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  provider_id  text        NOT NULL,
  mode         text        NOT NULL CHECK (mode = 'SIMULATED'),
  status       text        NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE', 'MAINTENANCE')),
  version      integer     NOT NULL CHECK (version >= 1),
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL,
  PRIMARY KEY (customer_id, id),
  UNIQUE (customer_id, merchant_id, id),
  FOREIGN KEY (customer_id, merchant_id) REFERENCES merchants (customer_id, id) ON DELETE RESTRICT
);

-- Integridade referencial dos pagamentos com o cadastro: o terminal precisa existir
-- e pertencer ao estabelecimento do mesmo cliente. NOT VALID: vale para linhas novas
-- sem reprocessar pagamentos que já existam em bancos de desenvolvimento.
ALTER TABLE payments
  ADD CONSTRAINT payments_terminal_fk
  FOREIGN KEY (tenant_id, merchant_id, terminal_id)
  REFERENCES terminals (customer_id, merchant_id, id) ON DELETE RESTRICT NOT VALID;

-- Fila durável de tarefas. Uma tarefa só é reivindicada com FOR UPDATE SKIP LOCKED
-- e recebe um lease; se o worker cair, o lease expira e outra instância a retoma.
CREATE TABLE jobs (
  id                bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind              text        NOT NULL CHECK (kind IN ('EXECUTE_OPERATION', 'RECONCILE_OPERATION')),
  tenant_id         text        NOT NULL,
  payment_id        text        NOT NULL REFERENCES payments (id),
  operation_id      text        NOT NULL REFERENCES payment_operations (id),
  status            text        NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'DONE', 'FAILED')),
  attempts          integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts      integer     NOT NULL CHECK (max_attempts >= 1),
  available_at      timestamptz NOT NULL,
  lease_owner       text,
  lease_expires_at  timestamptz,
  last_error_code   text,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL,
  completed_at      timestamptz,
  CONSTRAINT jobs_running_has_lease CHECK (status <> 'RUNNING' OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
);

-- Tarefa duplicada: no máximo UMA tarefa ativa do mesmo tipo por operação.
CREATE UNIQUE INDEX jobs_one_active_per_operation_uq
  ON jobs (operation_id, kind)
  WHERE status IN ('PENDING', 'RUNNING');

CREATE INDEX jobs_claimable_idx ON jobs (available_at, id) WHERE status = 'PENDING';
CREATE INDEX jobs_running_lease_idx ON jobs (lease_expires_at) WHERE status = 'RUNNING';

-- Entrega da outbox (pelo menos uma vez): tentativas e próximo horário.
ALTER TABLE outbox_events
  ADD COLUMN delivery_attempts integer     NOT NULL DEFAULT 0,
  ADD COLUMN next_attempt_at   timestamptz,
  ADD COLUMN last_error_code   text;

-- Diretiva de cenário para o SIMULADOR (dados de teste fictícios; nunca usada por provedor real).
CREATE TABLE provider_test_directives (
  payment_id   text        PRIMARY KEY REFERENCES payments (id),
  provider_id  text        NOT NULL CHECK (provider_id = 'SIMULATOR'),
  directive    text        NOT NULL CHECK (directive ~ '^[A-Z_]{3,40}$'),
  created_at   timestamptz NOT NULL
);

-- Batimento dos workers (observabilidade do painel e health checks).
CREATE TABLE worker_heartbeats (
  worker_id     text        PRIMARY KEY,
  started_at    timestamptz NOT NULL,
  last_beat_at  timestamptz NOT NULL,
  status        text        NOT NULL CHECK (status IN ('RUNNING', 'STOPPING', 'STOPPED'))
);
