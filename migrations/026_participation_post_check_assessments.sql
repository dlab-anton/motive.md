-- One immutable contributor interpretation may be appended after a protected
-- participation check. It remains separate from the checker report and review.

CREATE TABLE motive.participation_post_check_assessments (
  submission_id UUID PRIMARY KEY REFERENCES motive.participation_submission_artifacts(submission_id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES motive.projects(id) ON DELETE RESTRICT,
  agent_token_id UUID NOT NULL REFERENCES motive.participation_agent_tokens(id) ON DELETE RESTRICT,
  report_digest TEXT NOT NULL CHECK (report_digest ~ '^sha256:[a-f0-9]{64}$'),
  assessment TEXT NOT NULL CHECK (char_length(assessment) BETWEEN 1 AND 2000 AND assessment = btrim(assessment)),
  next_action TEXT NOT NULL CHECK (char_length(next_action) BETWEEN 1 AND 1000 AND next_action = btrim(next_action)),
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  disposition TEXT NOT NULL DEFAULT 'AGENT_DECLARED_UNVERIFIED' CHECK (disposition = 'AGENT_DECLARED_UNVERIFIED'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX participation_post_check_project_created_idx
  ON motive.participation_post_check_assessments(project_id, created_at DESC, submission_id);

CREATE OR REPLACE FUNCTION motive.guard_participation_post_check_assessment()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, motive AS $$
DECLARE artifact motive.participation_submission_artifacts%ROWTYPE;
BEGIN
  SELECT * INTO artifact FROM motive.participation_submission_artifacts item
  WHERE item.submission_id = NEW.submission_id FOR KEY SHARE;
  IF artifact.submission_id IS NULL OR artifact.project_id IS DISTINCT FROM NEW.project_id
    OR artifact.agent_token_id IS DISTINCT FROM NEW.agent_token_id
    OR artifact.report_digest IS DISTINCT FROM NEW.report_digest
  THEN
    RAISE EXCEPTION 'post-check assessment requires the exact submission credential and checker report' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER participation_post_check_assessment_guard
  BEFORE INSERT ON motive.participation_post_check_assessments
  FOR EACH ROW EXECUTE FUNCTION motive.guard_participation_post_check_assessment();
CREATE TRIGGER participation_post_check_assessment_immutable
  BEFORE UPDATE OR DELETE ON motive.participation_post_check_assessments
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();

REVOKE ALL ON motive.participation_post_check_assessments FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_participation_post_check_assessment() FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    EXECUTE 'REVOKE ALL ON motive.participation_post_check_assessments FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    EXECUTE 'REVOKE ALL ON motive.participation_post_check_assessments FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='motive_control_reader') THEN
    EXECUTE 'REVOKE ALL ON motive.participation_post_check_assessments FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_participation_post_check_assessment() FROM motive_control_reader';
  END IF;
END $$;
