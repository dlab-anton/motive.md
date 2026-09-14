-- Private OpenRouter credentials remain encrypted at rest. Public project
-- funding continues through the existing source/grant/attempt ledger.

CREATE TABLE motive.provider_connections (
  id UUID PRIMARY KEY,
  owner_actor_id TEXT NOT NULL CHECK (char_length(owner_actor_id) BETWEEN 1 AND 512),
  provider TEXT NOT NULL CHECK (provider = 'openrouter'),
  credential_ref TEXT NOT NULL UNIQUE CHECK (credential_ref ~ '^openrouter:[0-9a-f-]{36}$'),
  status TEXT NOT NULL CHECK (status IN ('CONNECTED', 'DISCONNECTED')),
  encrypted_credential BYTEA,
  credential_fingerprint TEXT CHECK (credential_fingerprint IS NULL OR credential_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  provider_metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provider_metadata) = 'object'),
  connected_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  disconnected_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (owner_actor_id, provider),
  CHECK ((status = 'CONNECTED' AND encrypted_credential IS NOT NULL AND disconnected_at IS NULL)
      OR (status = 'DISCONNECTED' AND encrypted_credential IS NULL AND disconnected_at IS NOT NULL))
);

CREATE TABLE motive.provider_connect_flows (
  token_digest TEXT PRIMARY KEY CHECK (token_digest ~ '^sha256:[a-f0-9]{64}$'),
  owner_actor_id TEXT NOT NULL CHECK (char_length(owner_actor_id) BETWEEN 1 AND 512),
  provider TEXT NOT NULL CHECK (provider = 'openrouter'),
  encrypted_code_verifier BYTEA NOT NULL,
  callback_url TEXT NOT NULL CHECK (char_length(callback_url) BETWEEN 1 AND 2048),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > created_at)
);
CREATE INDEX provider_connect_flows_expiry_idx ON motive.provider_connect_flows (expires_at) WHERE consumed_at IS NULL;

CREATE TABLE motive.provider_project_budgets (
  id UUID PRIMARY KEY,
  connection_id UUID NOT NULL REFERENCES motive.provider_connections(id) ON DELETE RESTRICT,
  owner_actor_id TEXT NOT NULL CHECK (char_length(owner_actor_id) BETWEEN 1 AND 512),
  project_id UUID NOT NULL REFERENCES motive.projects(id) ON DELETE RESTRICT,
  source_id UUID NOT NULL UNIQUE REFERENCES motive.funding_sources(id) ON DELETE RESTRICT,
  grant_id UUID UNIQUE REFERENCES motive.grants(id) ON DELETE RESTRICT,
  work_order_id UUID REFERENCES motive.work_orders(id) ON DELETE RESTRICT,
  assigned_agent_id UUID REFERENCES motive.participation_agent_tokens(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider = 'openrouter'),
  model_id TEXT NOT NULL CHECK (char_length(model_id) BETWEEN 3 AND 256),
  limit_usd NUMERIC(30,12) NOT NULL CHECK (limit_usd > 0),
  expires_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('WAITING_TO_ACTIVATE', 'ACTIVE', 'REVOKED')),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  revoked_at TIMESTAMPTZ,
  UNIQUE (owner_actor_id, idempotency_key),
  CHECK ((status = 'ACTIVE' AND grant_id IS NOT NULL AND revoked_at IS NULL)
      OR (status = 'WAITING_TO_ACTIVATE' AND grant_id IS NULL AND revoked_at IS NULL)
      OR (status = 'REVOKED' AND revoked_at IS NOT NULL))
);
CREATE INDEX provider_project_budgets_owner_idx ON motive.provider_project_budgets (owner_actor_id, created_at DESC);

CREATE TABLE motive.provider_budget_activations (
  budget_id UUID PRIMARY KEY REFERENCES motive.provider_project_budgets(id) ON DELETE RESTRICT,
  assigned_agent_id UUID NOT NULL REFERENCES motive.participation_agent_tokens(id) ON DELETE RESTRICT,
  work_order_id UUID NOT NULL REFERENCES motive.work_orders(id) ON DELETE RESTRICT,
  grant_id UUID UNIQUE REFERENCES motive.grants(id) ON DELETE RESTRICT,
  attempt_id UUID UNIQUE REFERENCES motive.attempts(id) ON DELETE RESTRICT,
  capability_id UUID UNIQUE REFERENCES motive.run_capabilities(id) ON DELETE RESTRICT,
  profile_digest TEXT NOT NULL CHECK (profile_digest ~ '^sha256:[a-f0-9]{64}$'),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  capability_expires_at TIMESTAMPTZ,
  delivery_epoch INTEGER NOT NULL DEFAULT 0 CHECK (delivery_epoch >= 0),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACTIVE', 'REVOKED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status = 'ACTIVE' AND grant_id IS NOT NULL AND attempt_id IS NOT NULL
          AND capability_id IS NOT NULL AND capability_expires_at IS NOT NULL)
      OR status <> 'ACTIVE')
);

REVOKE ALL ON motive.provider_connections FROM PUBLIC;
REVOKE ALL ON motive.provider_connect_flows FROM PUBLIC;
REVOKE ALL ON motive.provider_project_budgets FROM PUBLIC;
REVOKE ALL ON motive.provider_budget_activations FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'motive_control_reader') THEN
    EXECUTE 'REVOKE ALL ON motive.provider_connections FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON motive.provider_connect_flows FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON motive.provider_project_budgets FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON motive.provider_budget_activations FROM motive_control_reader';
  END IF;
END $$;
