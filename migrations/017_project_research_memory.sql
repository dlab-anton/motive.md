-- Operator-verified, read-only Hypothesis workspace/channel bindings and
-- immutable bounded context snapshots. Credentials remain private and encrypted.

CREATE TABLE motive.project_research_scopes (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES motive.projects(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider = 'hypothesis-engine'),
  api_base_url TEXT NOT NULL CHECK (char_length(api_base_url) BETWEEN 12 AND 2048),
  tenant_id UUID NOT NULL,
  channel_id UUID NOT NULL,
  channel_name TEXT NOT NULL CHECK (char_length(channel_name) BETWEEN 1 AND 100),
  channel_snapshot JSONB NOT NULL CHECK (jsonb_typeof(channel_snapshot) = 'object'),
  channel_snapshot_digest TEXT NOT NULL CHECK (channel_snapshot_digest ~ '^sha256:[a-f0-9]{64}$'),
  encrypted_api_key BYTEA NOT NULL CHECK (octet_length(encrypted_api_key) BETWEEN 30 AND 16448),
  credential_fingerprint TEXT NOT NULL CHECK (credential_fingerprint ~ '^sha256:[a-f0-9]{64}$'),
  configuration_digest TEXT NOT NULL CHECK (configuration_digest ~ '^sha256:[a-f0-9]{64}$'),
  api_version TEXT NOT NULL CHECK (char_length(api_version) BETWEEN 1 AND 64),
  inspected_source_revision TEXT NOT NULL CHECK (inspected_source_revision ~ '^[a-f0-9]{40}$'),
  status TEXT NOT NULL CHECK (status IN ('REPLACEMENT_PENDING','CONNECTED','REPLACED')),
  bound_by TEXT NOT NULL CHECK (char_length(bound_by) BETWEEN 1 AND 512),
  verified_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  replaced_at TIMESTAMPTZ,
  replaced_by UUID REFERENCES motive.project_research_scopes(id) ON DELETE RESTRICT,
  CHECK ((status IN ('REPLACEMENT_PENDING','CONNECTED') AND replaced_at IS NULL AND replaced_by IS NULL)
    OR (status='REPLACED' AND replaced_at IS NOT NULL AND replaced_by IS NOT NULL))
);
ALTER TABLE motive.project_research_scopes ADD CONSTRAINT project_research_scope_id_project_unique UNIQUE(id,project_id);
CREATE UNIQUE INDEX one_connected_research_scope_per_project_idx
  ON motive.project_research_scopes(project_id) WHERE status='CONNECTED';
CREATE INDEX project_research_scope_history_idx ON motive.project_research_scopes(project_id,created_at DESC);

CREATE TABLE motive.research_context_snapshots (
  id UUID PRIMARY KEY,
  scope_id UUID NOT NULL,
  project_id UUID NOT NULL REFERENCES motive.projects(id) ON DELETE RESTRICT,
  snapshot_digest TEXT NOT NULL CHECK (snapshot_digest ~ '^sha256:[a-f0-9]{64}$'),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  api_version TEXT NOT NULL CHECK (char_length(api_version) BETWEEN 1 AND 64),
  retrieved_at TIMESTAMPTZ NOT NULL,
  UNIQUE(scope_id,snapshot_digest),
  FOREIGN KEY(scope_id,project_id) REFERENCES motive.project_research_scopes(id,project_id) ON DELETE RESTRICT
);
CREATE INDEX research_context_project_idx ON motive.research_context_snapshots(project_id,retrieved_at DESC);

CREATE OR REPLACE FUNCTION motive.guard_project_research_scope()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.provider IS DISTINCT FROM OLD.provider OR NEW.api_base_url IS DISTINCT FROM OLD.api_base_url
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.channel_id IS DISTINCT FROM OLD.channel_id
    OR NEW.channel_name IS DISTINCT FROM OLD.channel_name OR NEW.channel_snapshot IS DISTINCT FROM OLD.channel_snapshot
    OR NEW.channel_snapshot_digest IS DISTINCT FROM OLD.channel_snapshot_digest
    OR NEW.encrypted_api_key IS DISTINCT FROM OLD.encrypted_api_key
    OR NEW.credential_fingerprint IS DISTINCT FROM OLD.credential_fingerprint
    OR NEW.configuration_digest IS DISTINCT FROM OLD.configuration_digest
    OR NEW.api_version IS DISTINCT FROM OLD.api_version OR NEW.inspected_source_revision IS DISTINCT FROM OLD.inspected_source_revision
    OR NEW.bound_by IS DISTINCT FROM OLD.bound_by OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN RAISE EXCEPTION 'research scope binding content is immutable' USING ERRCODE='55000';
  END IF;
  IF NOT ((OLD.status='CONNECTED' AND NEW.status='REPLACED' AND NEW.replaced_at IS NOT NULL AND NEW.replaced_by IS NOT NULL)
    OR (OLD.status='REPLACEMENT_PENDING' AND NEW.status='CONNECTED' AND NEW.replaced_at IS NULL AND NEW.replaced_by IS NULL))
  THEN RAISE EXCEPTION 'research scope binding transition is invalid' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER project_research_scope_guard BEFORE UPDATE ON motive.project_research_scopes
  FOR EACH ROW EXECUTE FUNCTION motive.guard_project_research_scope();
CREATE TRIGGER project_research_scope_no_delete BEFORE DELETE ON motive.project_research_scopes
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();
CREATE TRIGGER research_context_immutable BEFORE UPDATE OR DELETE ON motive.research_context_snapshots
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();

REVOKE ALL ON motive.project_research_scopes FROM PUBLIC;
REVOKE ALL ON motive.research_context_snapshots FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_project_research_scope() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='motive_control_reader') THEN
    EXECUTE 'REVOKE ALL ON motive.project_research_scopes FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON motive.research_context_snapshots FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_project_research_scope() FROM motive_control_reader';
  END IF;
END $$;
