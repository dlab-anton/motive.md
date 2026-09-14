-- P1 ledger/state kernel.  This schema is private application state; browser
-- roles must not receive generic privileges on it.
CREATE SCHEMA IF NOT EXISTS motive;
REVOKE ALL ON SCHEMA motive FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA motive REVOKE ALL ON TABLES FROM PUBLIC;

CREATE TYPE motive.project_visibility AS ENUM ('PUBLIC', 'PRIVATE');
CREATE TYPE motive.membership_role AS ENUM ('OWNER', 'STEWARD', 'SUPPORTER', 'CONTRIBUTOR', 'REVIEWER');
CREATE TYPE motive.funding_source_status AS ENUM ('ACTIVE', 'FROZEN', 'CLOSED');
CREATE TYPE motive.grant_status AS ENUM ('ACTIVE', 'REVOKED', 'FROZEN', 'CLOSED');
CREATE TYPE motive.work_order_state AS ENUM ('DRAFT', 'READY', 'PAUSED', 'CLOSED');
CREATE TYPE motive.attempt_execution_status AS ENUM (
  'READY', 'RESERVED', 'PROVISIONING', 'RUNNING', 'OUTPUT_SEALED', 'EVALUATING',
  'WAITING_ACCEPTANCE', 'CLOSED', 'FAILED', 'CANCEL_REQUESTED', 'CANCELLED', 'QUARANTINED'
);
CREATE TYPE motive.operation_status AS ENUM ('ISSUING', 'IN_FLIGHT', 'UNKNOWN', 'RECONCILED', 'INCIDENT');
CREATE TYPE motive.reservation_kind AS ENUM ('SOURCE_GRANT', 'GRANT_ATTEMPT', 'ATTEMPT_REQUEST');
CREATE TYPE motive.reservation_status AS ENUM ('HELD', 'SETTLED', 'RELEASED', 'UNKNOWN');
CREATE TYPE motive.journal_direction AS ENUM ('DEBIT', 'CREDIT');
CREATE TYPE motive.usage_kind AS ENUM ('SETTLEMENT', 'LATE_ADJUSTMENT');
CREATE TYPE motive.incident_kind AS ENUM ('UNKNOWN_ISSUANCE', 'RESERVATION_OVERRUN', 'LATE_USAGE', 'RECOVERY_FREEZE');
CREATE TYPE motive.claim_origin AS ENUM ('HOSTED', 'EXTERNAL');
CREATE TYPE motive.claim_status AS ENUM ('ACTIVE', 'RELEASED', 'EXPIRED', 'REVOKED');
CREATE TYPE motive.submission_origin AS ENUM ('HOSTED', 'EXTERNAL');
CREATE TYPE motive.submission_status AS ENUM ('RECEIVED', 'RETAINED_LATE', 'PENDING_EVALUATION', 'ACCEPTED', 'REJECTED', 'INCONCLUSIVE');

CREATE TABLE motive.controller_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  generation BIGINT NOT NULL DEFAULT 1 CHECK (generation > 0),
  spending_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  freeze_reason TEXT,
  frozen_at TIMESTAMPTZ,
  changed_by TEXT,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO motive.controller_state (singleton, spending_enabled, freeze_reason)
VALUES (TRUE, FALSE, 'INITIALIZATION_REQUIRED')
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE motive.projects (
  id UUID PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE CHECK (slug = lower(slug) AND slug ~ '^[a-z0-9][a-z0-9-]{0,127}$'),
  visibility motive.project_visibility NOT NULL,
  current_revision INTEGER NOT NULL DEFAULT 0 CHECK (current_revision >= 0),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE motive.project_revisions (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES motive.projects(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  format TEXT NOT NULL,
  content JSONB NOT NULL,
  content_digest TEXT NOT NULL CHECK (content_digest ~ '^sha256:[a-f0-9]{64}$'),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (project_id, revision)
);

CREATE TABLE motive.memberships (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES motive.projects(id) ON DELETE RESTRICT,
  actor_id TEXT NOT NULL,
  role motive.membership_role NOT NULL,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  granted_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  revoked_at TIMESTAMPTZ,
  UNIQUE (project_id, actor_id)
);
CREATE INDEX memberships_active_actor_idx ON motive.memberships (actor_id, project_id) WHERE revoked_at IS NULL;

CREATE TABLE motive.funding_sources (
  id UUID PRIMARY KEY,
  owner_actor_id TEXT NOT NULL,
  controller_actor_id TEXT NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  authorized_amount NUMERIC(30,12) NOT NULL CHECK (authorized_amount >= 0),
  allocated_amount NUMERIC(30,12) NOT NULL DEFAULT 0 CHECK (allocated_amount >= 0),
  consumed_amount NUMERIC(30,12) NOT NULL DEFAULT 0 CHECK (consumed_amount >= 0),
  status motive.funding_source_status NOT NULL DEFAULT 'ACTIVE',
  expires_at TIMESTAMPTZ,
  frozen_at TIMESTAMPTZ,
  freeze_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE motive.grants (
  id UUID PRIMARY KEY,
  source_id UUID NOT NULL REFERENCES motive.funding_sources(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES motive.projects(id) ON DELETE RESTRICT,
  issuer_actor_id TEXT NOT NULL,
  beneficiary_actor_id TEXT,
  currency CHAR(3) NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  limit_amount NUMERIC(30,12) NOT NULL CHECK (limit_amount > 0),
  consumed_amount NUMERIC(30,12) NOT NULL DEFAULT 0 CHECK (consumed_amount >= 0),
  attempt_held_amount NUMERIC(30,12) NOT NULL DEFAULT 0 CHECK (attempt_held_amount >= 0),
  status motive.grant_status NOT NULL DEFAULT 'ACTIVE',
  admission_closed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, source_id)
);
CREATE INDEX grants_issuer_idx ON motive.grants (issuer_actor_id, created_at DESC);
CREATE INDEX grants_project_idx ON motive.grants (project_id, status);

CREATE TABLE motive.work_orders (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES motive.projects(id) ON DELETE RESTRICT,
  work_order_key TEXT NOT NULL CHECK (work_order_key ~ '^[a-z0-9][a-z0-9-]{0,127}$'),
  revision INTEGER NOT NULL CHECK (revision > 0),
  project_revision INTEGER NOT NULL CHECK (project_revision > 0),
  terms_format TEXT NOT NULL CHECK (terms_format = 'motive.work-order/0.1'),
  terms JSONB NOT NULL,
  terms_digest TEXT NOT NULL CHECK (terms_digest ~ '^sha256:[a-f0-9]{64}$'),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (project_id, work_order_key, revision),
  UNIQUE (id, project_id),
  FOREIGN KEY (project_id, project_revision) REFERENCES motive.project_revisions(project_id, revision) ON DELETE RESTRICT
);

CREATE TABLE motive.work_order_states (
  work_order_id UUID PRIMARY KEY REFERENCES motive.work_orders(id) ON DELETE RESTRICT,
  state motive.work_order_state NOT NULL DEFAULT 'DRAFT',
  state_revision INTEGER NOT NULL DEFAULT 1 CHECK (state_revision > 0),
  admission_closed_at TIMESTAMPTZ,
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE motive.attempts (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES motive.projects(id) ON DELETE RESTRICT,
  work_order_id UUID NOT NULL,
  grant_id UUID NOT NULL,
  source_id UUID NOT NULL,
  terms_digest TEXT NOT NULL CHECK (terms_digest ~ '^sha256:[a-f0-9]{64}$'),
  profile_digest TEXT NOT NULL CHECK (profile_digest ~ '^sha256:[a-f0-9]{64}$'),
  input_digest TEXT NOT NULL CHECK (input_digest ~ '^sha256:[a-f0-9]{64}$'),
  ceiling_amount NUMERIC(30,12) NOT NULL CHECK (ceiling_amount > 0),
  consumed_amount NUMERIC(30,12) NOT NULL DEFAULT 0 CHECK (consumed_amount >= 0),
  request_held_amount NUMERIC(30,12) NOT NULL DEFAULT 0 CHECK (request_held_amount >= 0),
  execution_status motive.attempt_execution_status NOT NULL DEFAULT 'RESERVED',
  lease_epoch INTEGER NOT NULL DEFAULT 1 CHECK (lease_epoch > 0),
  controller_generation BIGINT NOT NULL CHECK (controller_generation > 0),
  next_request_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_request_sequence > 0),
  admission_closed_at TIMESTAMPTZ,
  cancellation_requested_at TIMESTAMPTZ,
  cancellation_reason TEXT,
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (work_order_id, project_id) REFERENCES motive.work_orders(id, project_id) ON DELETE RESTRICT,
  FOREIGN KEY (grant_id, source_id) REFERENCES motive.grants(id, source_id) ON DELETE RESTRICT
);
CREATE INDEX attempts_grant_idx ON motive.attempts (grant_id, execution_status);
CREATE INDEX attempts_project_idx ON motive.attempts (project_id, execution_status);

CREATE TABLE motive.request_operations (
  provider_operation_id UUID PRIMARY KEY,
  attempt_id UUID NOT NULL REFERENCES motive.attempts(id) ON DELETE RESTRICT,
  grant_id UUID NOT NULL REFERENCES motive.grants(id) ON DELETE RESTRICT,
  source_id UUID NOT NULL REFERENCES motive.funding_sources(id) ON DELETE RESTRICT,
  request_sequence INTEGER NOT NULL CHECK (request_sequence > 0),
  request_body_digest TEXT NOT NULL CHECK (request_body_digest ~ '^sha256:[a-f0-9]{64}$'),
  profile_digest TEXT NOT NULL CHECK (profile_digest ~ '^sha256:[a-f0-9]{64}$'),
  reserved_amount NUMERIC(30,12) NOT NULL CHECK (reserved_amount > 0),
  actual_cost NUMERIC(30,12),
  late_adjustment_amount NUMERIC(30,12) NOT NULL DEFAULT 0 CHECK (late_adjustment_amount >= 0),
  status motive.operation_status NOT NULL DEFAULT 'ISSUING',
  provider_request_id TEXT,
  provider_response_id TEXT,
  provider_usage_id TEXT,
  raw_provider_amount TEXT,
  raw_provider_usage JSONB,
  unknown_reason TEXT,
  admitted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  dispatched_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (attempt_id, request_sequence)
);
-- P1 supports one potentially billable operation per attempt. UNKNOWN remains
-- blocking until reconciliation; it is never treated as a zero-cost timeout.
CREATE UNIQUE INDEX one_billable_operation_per_attempt_idx
  ON motive.request_operations (attempt_id)
  WHERE status IN ('ISSUING', 'IN_FLIGHT', 'UNKNOWN');
CREATE INDEX request_operations_status_idx ON motive.request_operations (status, admitted_at);

CREATE TABLE motive.reservations (
  id UUID PRIMARY KEY,
  kind motive.reservation_kind NOT NULL,
  source_id UUID NOT NULL REFERENCES motive.funding_sources(id) ON DELETE RESTRICT,
  grant_id UUID NOT NULL REFERENCES motive.grants(id) ON DELETE RESTRICT,
  attempt_id UUID REFERENCES motive.attempts(id) ON DELETE RESTRICT,
  operation_id UUID REFERENCES motive.request_operations(provider_operation_id) ON DELETE RESTRICT,
  original_amount NUMERIC(30,12) NOT NULL CHECK (original_amount > 0),
  held_amount NUMERIC(30,12) NOT NULL CHECK (held_amount >= 0),
  settled_amount NUMERIC(30,12) NOT NULL DEFAULT 0 CHECK (settled_amount >= 0),
  released_amount NUMERIC(30,12) NOT NULL DEFAULT 0 CHECK (released_amount >= 0),
  status motive.reservation_status NOT NULL DEFAULT 'HELD',
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  resolved_at TIMESTAMPTZ,
  CHECK (
    (kind = 'SOURCE_GRANT' AND attempt_id IS NULL AND operation_id IS NULL)
    OR (kind = 'GRANT_ATTEMPT' AND attempt_id IS NOT NULL AND operation_id IS NULL)
    OR (kind = 'ATTEMPT_REQUEST' AND attempt_id IS NOT NULL AND operation_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX one_source_grant_reservation_idx ON motive.reservations (grant_id) WHERE kind = 'SOURCE_GRANT';
CREATE UNIQUE INDEX one_attempt_envelope_reservation_idx ON motive.reservations (attempt_id) WHERE kind = 'GRANT_ATTEMPT';
CREATE UNIQUE INDEX one_request_reservation_idx ON motive.reservations (operation_id) WHERE kind = 'ATTEMPT_REQUEST';
CREATE INDEX reservations_open_idx ON motive.reservations (grant_id, status) WHERE held_amount > 0;

CREATE TABLE motive.usage_records (
  id UUID PRIMARY KEY,
  operation_id UUID NOT NULL REFERENCES motive.request_operations(provider_operation_id) ON DELETE RESTRICT,
  source_id UUID NOT NULL REFERENCES motive.funding_sources(id) ON DELETE RESTRICT,
  grant_id UUID NOT NULL REFERENCES motive.grants(id) ON DELETE RESTRICT,
  attempt_id UUID NOT NULL REFERENCES motive.attempts(id) ON DELETE RESTRICT,
  kind motive.usage_kind NOT NULL,
  provider_usage_id TEXT NOT NULL,
  amount NUMERIC(30,12) NOT NULL CHECK (amount >= 0),
  raw_provider_amount TEXT,
  raw_usage JSONB,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (source_id, provider_usage_id)
);
CREATE UNIQUE INDEX one_initial_usage_per_operation_idx ON motive.usage_records (operation_id) WHERE kind = 'SETTLEMENT';

CREATE TABLE motive.ledger_transactions (
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL,
  source_id UUID REFERENCES motive.funding_sources(id) ON DELETE RESTRICT,
  grant_id UUID REFERENCES motive.grants(id) ON DELETE RESTRICT,
  attempt_id UUID REFERENCES motive.attempts(id) ON DELETE RESTRICT,
  operation_id UUID REFERENCES motive.request_operations(provider_operation_id) ON DELETE RESTRICT,
  reference_type TEXT NOT NULL,
  reference_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE motive.ledger_entries (
  id UUID PRIMARY KEY,
  journal_id UUID NOT NULL REFERENCES motive.ledger_transactions(id) ON DELETE RESTRICT,
  account TEXT NOT NULL,
  direction motive.journal_direction NOT NULL,
  amount NUMERIC(30,12) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ledger_entries_journal_idx ON motive.ledger_entries (journal_id);

CREATE TABLE motive.events (
  id UUID PRIMARY KEY,
  project_id UUID REFERENCES motive.projects(id) ON DELETE RESTRICT,
  aggregate_type TEXT NOT NULL,
  aggregate_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  actor_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX events_project_cursor_idx ON motive.events (project_id, created_at, id);

CREATE TABLE motive.outbox (
  id UUID PRIMARY KEY,
  event_id UUID NOT NULL UNIQUE REFERENCES motive.events(id) ON DELETE RESTRICT,
  aggregate_type TEXT NOT NULL,
  aggregate_id UUID NOT NULL,
  topic TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL,
  available_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  claimed_at TIMESTAMPTZ,
  claimed_by TEXT,
  delivered_at TIMESTAMPTZ,
  delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX outbox_pending_idx ON motive.outbox (available_at, id) WHERE delivered_at IS NULL;

CREATE TABLE motive.accounting_incidents (
  id UUID PRIMARY KEY,
  kind motive.incident_kind NOT NULL,
  source_id UUID NOT NULL REFERENCES motive.funding_sources(id) ON DELETE RESTRICT,
  grant_id UUID REFERENCES motive.grants(id) ON DELETE RESTRICT,
  attempt_id UUID REFERENCES motive.attempts(id) ON DELETE RESTRICT,
  operation_id UUID REFERENCES motive.request_operations(provider_operation_id) ON DELETE RESTRICT,
  amount NUMERIC(30,12) CHECK (amount >= 0),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX accounting_incidents_open_idx ON motive.accounting_incidents (source_id, created_at DESC) WHERE resolved_at IS NULL;

CREATE TABLE motive.idempotency_records (
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  body_digest TEXT NOT NULL CHECK (body_digest ~ '^sha256:[a-f0-9]{64}$'),
  resource_type TEXT,
  resource_id UUID,
  response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor_id, action, idempotency_key)
);

CREATE TABLE motive.work_claims (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES motive.projects(id) ON DELETE RESTRICT,
  work_order_id UUID NOT NULL REFERENCES motive.work_orders(id) ON DELETE RESTRICT,
  attempt_id UUID REFERENCES motive.attempts(id) ON DELETE RESTRICT,
  operator_actor_id TEXT NOT NULL,
  origin motive.claim_origin NOT NULL,
  slot INTEGER NOT NULL CHECK (slot > 0),
  lease_epoch INTEGER NOT NULL DEFAULT 1 CHECK (lease_epoch > 0),
  terms_digest TEXT NOT NULL CHECK (terms_digest ~ '^sha256:[a-f0-9]{64}$'),
  status motive.claim_status NOT NULL DEFAULT 'ACTIVE',
  expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((origin = 'HOSTED' AND attempt_id IS NOT NULL) OR (origin = 'EXTERNAL' AND attempt_id IS NULL))
);
CREATE UNIQUE INDEX one_active_claim_per_slot_idx ON motive.work_claims (work_order_id, slot) WHERE status = 'ACTIVE';
CREATE INDEX work_claims_operator_idx ON motive.work_claims (operator_actor_id, status, expires_at);

CREATE TABLE motive.submissions (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES motive.projects(id) ON DELETE RESTRICT,
  work_order_id UUID NOT NULL REFERENCES motive.work_orders(id) ON DELETE RESTRICT,
  work_order_revision INTEGER NOT NULL CHECK (work_order_revision > 0),
  origin motive.submission_origin NOT NULL,
  operator_actor_id TEXT NOT NULL,
  attempt_id UUID REFERENCES motive.attempts(id) ON DELETE RESTRICT,
  claim_id UUID REFERENCES motive.work_claims(id) ON DELETE RESTRICT,
  lease_epoch INTEGER,
  format TEXT NOT NULL CHECK (format = 'motive.submission/0.1'),
  base_commit TEXT NOT NULL,
  artifact_manifest_digest TEXT NOT NULL CHECK (artifact_manifest_digest ~ '^sha256:[a-f0-9]{64}$'),
  provenance JSONB NOT NULL,
  usage_status TEXT NOT NULL CHECK (usage_status IN ('metered_motive', 'unmetered_external')),
  license_acceptance_ref TEXT NOT NULL,
  status motive.submission_status NOT NULL DEFAULT 'RECEIVED',
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (origin = 'EXTERNAL' AND attempt_id IS NULL AND usage_status = 'unmetered_external')
    OR (origin = 'HOSTED' AND attempt_id IS NOT NULL AND usage_status = 'metered_motive')
  )
);
CREATE INDEX submissions_work_order_idx ON motive.submissions (work_order_id, created_at DESC);
CREATE INDEX submissions_operator_idx ON motive.submissions (operator_actor_id, created_at DESC);

CREATE OR REPLACE FUNCTION motive.reject_immutable_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'motive.% rows are immutable', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION motive.guard_funding_source_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.owner_actor_id IS DISTINCT FROM OLD.owner_actor_id
    OR NEW.controller_actor_id IS DISTINCT FROM OLD.controller_actor_id
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.authorized_amount IS DISTINCT FROM OLD.authorized_amount
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'funding source identity and authorization are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION motive.guard_grant_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.source_id IS DISTINCT FROM OLD.source_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.issuer_actor_id IS DISTINCT FROM OLD.issuer_actor_id
    OR NEW.beneficiary_actor_id IS DISTINCT FROM OLD.beneficiary_actor_id
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.limit_amount IS DISTINCT FROM OLD.limit_amount
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'grant authorization terms are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION motive.guard_attempt_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.work_order_id IS DISTINCT FROM OLD.work_order_id
    OR NEW.grant_id IS DISTINCT FROM OLD.grant_id
    OR NEW.source_id IS DISTINCT FROM OLD.source_id
    OR NEW.terms_digest IS DISTINCT FROM OLD.terms_digest
    OR NEW.profile_digest IS DISTINCT FROM OLD.profile_digest
    OR NEW.input_digest IS DISTINCT FROM OLD.input_digest
    OR NEW.ceiling_amount IS DISTINCT FROM OLD.ceiling_amount
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'attempt authorization terms are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION motive.guard_reservation_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.source_id IS DISTINCT FROM OLD.source_id
    OR NEW.grant_id IS DISTINCT FROM OLD.grant_id
    OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
    OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
    OR NEW.original_amount IS DISTINCT FROM OLD.original_amount
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'reservation authorization identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION motive.guard_operation_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.provider_operation_id IS DISTINCT FROM OLD.provider_operation_id
    OR NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
    OR NEW.grant_id IS DISTINCT FROM OLD.grant_id
    OR NEW.source_id IS DISTINCT FROM OLD.source_id
    OR NEW.request_sequence IS DISTINCT FROM OLD.request_sequence
    OR NEW.request_body_digest IS DISTINCT FROM OLD.request_body_digest
    OR NEW.profile_digest IS DISTINCT FROM OLD.profile_digest
    OR NEW.reserved_amount IS DISTINCT FROM OLD.reserved_amount
    OR NEW.admitted_at IS DISTINCT FROM OLD.admitted_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'operation admission identity is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION motive.assert_journal_balance()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_journal UUID;
  debit_total NUMERIC(30,12);
  credit_total NUMERIC(30,12);
BEGIN
  target_journal := COALESCE(NEW.journal_id, OLD.journal_id);
  SELECT
    COALESCE(SUM(amount) FILTER (WHERE direction = 'DEBIT'), 0),
    COALESCE(SUM(amount) FILTER (WHERE direction = 'CREDIT'), 0)
  INTO debit_total, credit_total
  FROM motive.ledger_entries WHERE journal_id = target_journal;
  IF debit_total <> credit_total THEN
    RAISE EXCEPTION 'journal % is not balanced (debit %, credit %)', target_journal, debit_total, credit_total USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER funding_sources_identity_immutable
  BEFORE UPDATE ON motive.funding_sources FOR EACH ROW EXECUTE FUNCTION motive.guard_funding_source_identity();
CREATE TRIGGER grants_identity_immutable
  BEFORE UPDATE ON motive.grants FOR EACH ROW EXECUTE FUNCTION motive.guard_grant_identity();
CREATE TRIGGER attempts_identity_immutable
  BEFORE UPDATE ON motive.attempts FOR EACH ROW EXECUTE FUNCTION motive.guard_attempt_identity();
CREATE TRIGGER reservations_identity_immutable
  BEFORE UPDATE ON motive.reservations FOR EACH ROW EXECUTE FUNCTION motive.guard_reservation_identity();
CREATE TRIGGER request_operations_identity_immutable
  BEFORE UPDATE ON motive.request_operations FOR EACH ROW EXECUTE FUNCTION motive.guard_operation_identity();

CREATE TRIGGER project_revisions_immutable
  BEFORE UPDATE OR DELETE ON motive.project_revisions FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();
CREATE TRIGGER work_orders_immutable
  BEFORE UPDATE OR DELETE ON motive.work_orders FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();
CREATE TRIGGER usage_records_immutable
  BEFORE UPDATE OR DELETE ON motive.usage_records FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();
CREATE TRIGGER ledger_transactions_immutable
  BEFORE UPDATE OR DELETE ON motive.ledger_transactions FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();
CREATE TRIGGER ledger_entries_immutable
  BEFORE UPDATE OR DELETE ON motive.ledger_entries FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();
CREATE TRIGGER events_immutable
  BEFORE UPDATE OR DELETE ON motive.events FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();
CREATE TRIGGER submissions_immutable
  BEFORE UPDATE OR DELETE ON motive.submissions FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();

CREATE CONSTRAINT TRIGGER ledger_entries_must_balance
  AFTER INSERT OR UPDATE OR DELETE ON motive.ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION motive.assert_journal_balance();

REVOKE ALL ON ALL TABLES IN SCHEMA motive FROM PUBLIC;
