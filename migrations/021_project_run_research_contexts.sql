-- One immutable retained research snapshot and exact bounded prompt per hosted
-- learning attempt. Remote research memory is data, never execution authority.

CREATE UNIQUE INDEX research_context_snapshot_binding_unique
  ON motive.research_context_snapshots(id,scope_id,project_id,snapshot_digest);

CREATE TABLE motive.project_run_research_contexts (
  attempt_id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES motive.projects(id) ON DELETE RESTRICT,
  work_order_id UUID NOT NULL,
  terms_digest TEXT NOT NULL CHECK (terms_digest ~ '^sha256:[a-f0-9]{64}$'),
  input_digest TEXT NOT NULL CHECK (input_digest ~ '^sha256:[a-f0-9]{64}$'),
  inference_profile_digest TEXT NOT NULL CHECK (inference_profile_digest ~ '^sha256:[a-f0-9]{64}$'),
  scope_id UUID NOT NULL,
  snapshot_id UUID NOT NULL,
  snapshot_digest TEXT NOT NULL CHECK (snapshot_digest ~ '^sha256:[a-f0-9]{64}$'),
  context_bytes BYTEA NOT NULL CHECK (octet_length(context_bytes) BETWEEN 1 AND 12000),
  context_digest TEXT NOT NULL CHECK (context_digest ~ '^sha256:[a-f0-9]{64}$'),
  context_body JSONB NOT NULL CHECK (jsonb_typeof(context_body)='object'),
  prompt_text TEXT NOT NULL CHECK (octet_length(prompt_text) BETWEEN 1 AND 16384),
  prompt_digest TEXT NOT NULL CHECK (prompt_digest ~ '^sha256:[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(attempt_id,work_order_id,project_id,terms_digest)
    REFERENCES motive.attempts(id,work_order_id,project_id,terms_digest) ON DELETE RESTRICT,
  FOREIGN KEY(scope_id,project_id)
    REFERENCES motive.project_research_scopes(id,project_id) ON DELETE RESTRICT,
  FOREIGN KEY(snapshot_id,scope_id,project_id,snapshot_digest)
    REFERENCES motive.research_context_snapshots(id,scope_id,project_id,snapshot_digest) ON DELETE RESTRICT,
  CHECK (convert_from(context_bytes,'UTF8')::jsonb IS NOT DISTINCT FROM context_body),
  CHECK (encode(sha256(context_bytes),'hex') IS NOT DISTINCT FROM substring(context_digest FROM 8)),
  CHECK (encode(sha256(convert_to(prompt_text,'UTF8')),'hex') IS NOT DISTINCT FROM substring(prompt_digest FROM 8))
);
CREATE INDEX project_run_research_context_project_idx
  ON motive.project_run_research_contexts(project_id,created_at DESC,attempt_id);

CREATE OR REPLACE FUNCTION motive.guard_project_run_research_context()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
DECLARE attempt_record motive.attempts%ROWTYPE;
DECLARE snapshot_record motive.research_context_snapshots%ROWTYPE;
DECLARE scope_record motive.project_research_scopes%ROWTYPE;
BEGIN
  SELECT * INTO attempt_record FROM motive.attempts WHERE id=NEW.attempt_id FOR KEY SHARE;
  SELECT * INTO snapshot_record FROM motive.research_context_snapshots WHERE id=NEW.snapshot_id FOR KEY SHARE;
  SELECT * INTO scope_record FROM motive.project_research_scopes
    WHERE id=NEW.scope_id AND project_id=NEW.project_id AND status='CONNECTED' FOR SHARE;
  IF attempt_record.id IS NULL OR snapshot_record.id IS NULL
    OR attempt_record.project_id IS DISTINCT FROM NEW.project_id
    OR attempt_record.work_order_id IS DISTINCT FROM NEW.work_order_id
    OR attempt_record.terms_digest IS DISTINCT FROM NEW.terms_digest
    OR attempt_record.input_digest IS DISTINCT FROM NEW.input_digest
    OR attempt_record.profile_digest IS DISTINCT FROM NEW.inference_profile_digest
    OR snapshot_record.scope_id IS DISTINCT FROM NEW.scope_id
    OR snapshot_record.project_id IS DISTINCT FROM NEW.project_id
    OR snapshot_record.snapshot_digest IS DISTINCT FROM NEW.snapshot_digest
    OR scope_record.id IS NULL
  THEN
    RAISE EXCEPTION 'project-run research context does not match attempt and connected retained snapshot'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER project_run_research_context_guard BEFORE INSERT ON motive.project_run_research_contexts
  FOR EACH ROW EXECUTE FUNCTION motive.guard_project_run_research_context();
CREATE TRIGGER project_run_research_context_immutable BEFORE UPDATE OR DELETE ON motive.project_run_research_contexts
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();

REVOKE ALL ON motive.project_run_research_contexts FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_project_run_research_context() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='motive_control_reader') THEN
    EXECUTE 'REVOKE ALL ON motive.project_run_research_contexts FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_project_run_research_context() FROM motive_control_reader';
  END IF;
END $$;
