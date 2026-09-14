-- Server-owned Supabase account state. Browser roles have no direct table
-- policy; the application validates Auth sessions and performs all writes.

CREATE TYPE motive.account_identity_status AS ENUM ('ACTIVE','DELETION_PENDING','DELETED');

CREATE TABLE motive.account_identities (
  actor_id TEXT PRIMARY KEY CHECK (actor_id ~ '^account:[A-Za-z0-9._~-]+$' AND char_length(actor_id) BETWEEN 9 AND 488),
  provider TEXT NOT NULL CHECK (provider='supabase'),
  subject_id UUID NOT NULL,
  status motive.account_identity_status NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMPTZ NOT NULL,
  deletion_requested_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  UNIQUE(provider,subject_id),
  CHECK ((status='ACTIVE' AND deletion_requested_at IS NULL AND deleted_at IS NULL)
    OR (status='DELETION_PENDING' AND deletion_requested_at IS NOT NULL AND deleted_at IS NULL)
    OR (status='DELETED' AND deletion_requested_at IS NOT NULL AND deleted_at IS NOT NULL))
);

CREATE TABLE motive.account_profiles (
  actor_id TEXT PRIMARY KEY REFERENCES motive.account_identities(actor_id) ON DELETE RESTRICT,
  display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 60),
  bio TEXT NOT NULL DEFAULT '' CHECK (char_length(bio) <= 280),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE motive.account_project_follows (
  actor_id TEXT NOT NULL REFERENCES motive.account_identities(actor_id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES motive.projects(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(actor_id,project_id)
);

CREATE TABLE motive.account_credit_wallets (
  actor_id TEXT PRIMARY KEY REFERENCES motive.account_identities(actor_id) ON DELETE RESTRICT,
  unit TEXT NOT NULL CHECK (unit='motive_credit'),
  issued INTEGER NOT NULL CHECK (issued=10),
  allocated INTEGER NOT NULL DEFAULT 0 CHECK (allocated BETWEEN 0 AND issued),
  issued_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE motive.account_credit_allocations (
  id UUID PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES motive.account_credit_wallets(actor_id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES motive.projects(id) ON DELETE RESTRICT,
  amount INTEGER NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL CHECK (status='WAITING_FOR_FUNDED_RUN'),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(actor_id,idempotency_key)
);

CREATE TABLE motive.account_credit_ledger_entries (
  id UUID PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES motive.account_credit_wallets(actor_id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('WELCOME_ISSUED','PROJECT_ALLOCATED')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  project_id UUID REFERENCES motive.projects(id) ON DELETE RESTRICT,
  allocation_id UUID REFERENCES motive.account_credit_allocations(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((kind='WELCOME_ISSUED' AND amount=10 AND project_id IS NULL AND allocation_id IS NULL)
    OR (kind='PROJECT_ALLOCATED' AND project_id IS NOT NULL AND allocation_id IS NOT NULL))
);
CREATE UNIQUE INDEX account_credit_one_welcome_idx ON motive.account_credit_ledger_entries(actor_id) WHERE kind='WELCOME_ISSUED';
CREATE UNIQUE INDEX account_credit_one_allocation_idx ON motive.account_credit_ledger_entries(allocation_id) WHERE allocation_id IS NOT NULL;

CREATE OR REPLACE FUNCTION motive.guard_account_identity_transition()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
BEGIN
  IF NEW.actor_id IS DISTINCT FROM OLD.actor_id OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.subject_id IS DISTINCT FROM OLD.subject_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN RAISE EXCEPTION 'account identity is immutable' USING ERRCODE='55000'; END IF;
  IF NOT ((OLD.status='ACTIVE' AND NEW.status='DELETION_PENDING' AND NEW.deletion_requested_at IS NOT NULL AND NEW.deleted_at IS NULL)
    OR (OLD.status='DELETION_PENDING' AND NEW.status='DELETED' AND NEW.deletion_requested_at IS NOT NULL AND NEW.deleted_at IS NOT NULL))
  THEN RAISE EXCEPTION 'account identity transition is invalid' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER account_identity_transition BEFORE UPDATE ON motive.account_identities
  FOR EACH ROW EXECUTE FUNCTION motive.guard_account_identity_transition();
CREATE TRIGGER account_identity_no_delete BEFORE DELETE ON motive.account_identities
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();
CREATE TRIGGER account_credit_wallet_no_mutation BEFORE DELETE ON motive.account_credit_wallets
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();
CREATE TRIGGER account_credit_allocation_immutable BEFORE UPDATE OR DELETE ON motive.account_credit_allocations
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();
CREATE TRIGGER account_credit_ledger_immutable BEFORE UPDATE OR DELETE ON motive.account_credit_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();

ALTER TABLE motive.account_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE motive.account_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE motive.account_project_follows ENABLE ROW LEVEL SECURITY;
ALTER TABLE motive.account_credit_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE motive.account_credit_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE motive.account_credit_ledger_entries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON motive.account_identities,motive.account_profiles,motive.account_project_follows,
  motive.account_credit_wallets,motive.account_credit_allocations,motive.account_credit_ledger_entries FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_account_identity_transition() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    EXECUTE 'REVOKE ALL ON motive.account_identities,motive.account_profiles,motive.account_project_follows,motive.account_credit_wallets,motive.account_credit_allocations,motive.account_credit_ledger_entries FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    EXECUTE 'REVOKE ALL ON motive.account_identities,motive.account_profiles,motive.account_project_follows,motive.account_credit_wallets,motive.account_credit_allocations,motive.account_credit_ledger_entries FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='motive_control_reader') THEN
    EXECUTE 'REVOKE ALL ON motive.account_identities,motive.account_profiles,motive.account_project_follows,motive.account_credit_wallets,motive.account_credit_allocations,motive.account_credit_ledger_entries FROM motive_control_reader';
  END IF;
END $$;
