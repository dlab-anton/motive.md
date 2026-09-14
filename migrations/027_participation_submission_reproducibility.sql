-- One immutable, bounded pair of contributor-supplied reproducibility files may
-- be appended to a checked participation submission. These bytes are separate
-- from the frozen checker artifact manifest and are never executed by Motive.

CREATE TABLE motive.participation_submission_reproducibility (
  submission_id UUID PRIMARY KEY REFERENCES motive.participation_submission_artifacts(submission_id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES motive.projects(id) ON DELETE RESTRICT,
  agent_token_id UUID NOT NULL REFERENCES motive.participation_agent_tokens(id) ON DELETE RESTRICT,
  report_digest TEXT NOT NULL CHECK (report_digest ~ '^sha256:[a-f0-9]{64}$'),
  solver_source_bytes BYTEA NOT NULL CHECK (octet_length(solver_source_bytes) BETWEEN 1 AND 16384),
  solver_source_digest TEXT NOT NULL CHECK (solver_source_digest ~ '^sha256:[a-f0-9]{64}$'
    AND solver_source_digest='sha256:' || pg_catalog.encode(pg_catalog.sha256(solver_source_bytes),'hex')),
  trial_results_bytes BYTEA NOT NULL CHECK (octet_length(trial_results_bytes) BETWEEN 1 AND 32768),
  trial_results_digest TEXT NOT NULL CHECK (trial_results_digest ~ '^sha256:[a-f0-9]{64}$'
    AND trial_results_digest='sha256:' || pg_catalog.encode(pg_catalog.sha256(trial_results_bytes),'hex')),
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  disposition TEXT NOT NULL DEFAULT 'AGENT_DECLARED_UNVERIFIED' CHECK (disposition='AGENT_DECLARED_UNVERIFIED'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (octet_length(solver_source_bytes) + octet_length(trial_results_bytes) <= 49152)
);
CREATE INDEX participation_reproducibility_project_created_idx
  ON motive.participation_submission_reproducibility(project_id,created_at DESC,submission_id);

CREATE OR REPLACE FUNCTION motive.guard_participation_submission_reproducibility()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
DECLARE artifact motive.participation_submission_artifacts%ROWTYPE;
BEGIN
  SELECT * INTO artifact FROM motive.participation_submission_artifacts item
  WHERE item.submission_id=NEW.submission_id FOR KEY SHARE;
  IF artifact.submission_id IS NULL OR artifact.project_id IS DISTINCT FROM NEW.project_id
    OR artifact.agent_token_id IS DISTINCT FROM NEW.agent_token_id
    OR artifact.report_digest IS DISTINCT FROM NEW.report_digest
  THEN
    RAISE EXCEPTION 'reproducibility files require the exact submission credential and checker report' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER participation_submission_reproducibility_guard
  BEFORE INSERT ON motive.participation_submission_reproducibility
  FOR EACH ROW EXECUTE FUNCTION motive.guard_participation_submission_reproducibility();
CREATE TRIGGER participation_submission_reproducibility_immutable
  BEFORE UPDATE OR DELETE ON motive.participation_submission_reproducibility
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();

REVOKE ALL ON motive.participation_submission_reproducibility FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_participation_submission_reproducibility() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    EXECUTE 'REVOKE ALL ON motive.participation_submission_reproducibility FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    EXECUTE 'REVOKE ALL ON motive.participation_submission_reproducibility FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='motive_control_reader') THEN
    EXECUTE 'REVOKE ALL ON motive.participation_submission_reproducibility FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_participation_submission_reproducibility() FROM motive_control_reader';
  END IF;
END $$;
