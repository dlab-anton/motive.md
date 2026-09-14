-- Personal external-agent credentials and immutable circle-packing evidence.
-- Work authority remains in work_orders/work_claims/submissions; these tables
-- add authentication and data-only assessment without enabling hosted spend.

CREATE TYPE motive.participation_report_status AS ENUM ('VALID', 'REJECTED', 'INCONCLUSIVE');
CREATE TYPE motive.participation_review_decision AS ENUM ('ACCEPTED', 'REJECTED');

CREATE TABLE motive.participation_agent_tokens (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES motive.projects(id) ON DELETE RESTRICT,
  owner_actor_id TEXT NOT NULL CHECK (owner_actor_id ~ '^account:[A-Za-z0-9._~-]+$' AND char_length(owner_actor_id) BETWEEN 9 AND 488),
  agent_name TEXT NOT NULL CHECK (char_length(agent_name) BETWEEN 1 AND 120),
  model_name TEXT CHECK (model_name IS NULL OR char_length(model_name) BETWEEN 1 AND 160),
  public_display_name TEXT CHECK (public_display_name IS NULL OR char_length(public_display_name) BETWEEN 1 AND 120),
  token_digest TEXT NOT NULL UNIQUE CHECK (token_digest ~ '^sha256:[a-f0-9]{64}$'),
  token_hint TEXT NOT NULL CHECK (token_hint ~ '^[a-f0-9]{12}$'),
  license_acceptance_ref TEXT NOT NULL CHECK (char_length(license_acceptance_ref) BETWEEN 1 AND 256),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > created_at)
);
CREATE INDEX participation_agent_owner_idx ON motive.participation_agent_tokens(owner_actor_id, project_id, created_at DESC);

CREATE TABLE motive.participation_submission_artifacts (
  submission_id UUID PRIMARY KEY REFERENCES motive.submissions(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES motive.projects(id) ON DELETE RESTRICT,
  agent_token_id UUID NOT NULL REFERENCES motive.participation_agent_tokens(id) ON DELETE RESTRICT,
  witness_format TEXT NOT NULL CHECK (witness_format = 'motive.csqv.witness.v1'),
  witness_bytes BYTEA NOT NULL CHECK (octet_length(witness_bytes) BETWEEN 1 AND 32768),
  witness_digest TEXT NOT NULL CHECK (witness_digest ~ '^sha256:[a-f0-9]{64}$'),
  report motive.participation_report_status NOT NULL,
  report_body JSONB NOT NULL CHECK (jsonb_typeof(report_body) = 'object'),
  report_digest TEXT NOT NULL CHECK (report_digest ~ '^sha256:[a-f0-9]{64}$'),
  exact_score TEXT CHECK (exact_score IS NULL OR exact_score ~ '^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$'),
  exceeds_reference BOOLEAN,
  contributor_display_name TEXT CHECK (contributor_display_name IS NULL OR char_length(contributor_display_name) BETWEEN 1 AND 120),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK ((report = 'VALID' AND exact_score IS NOT NULL AND exceeds_reference IS NOT NULL)
    OR (report <> 'VALID' AND exact_score IS NULL AND exceeds_reference IS NULL))
);
CREATE INDEX participation_artifacts_project_created_idx ON motive.participation_submission_artifacts(project_id, created_at DESC, submission_id);

CREATE TABLE motive.participation_submission_reviews (
  submission_id UUID PRIMARY KEY REFERENCES motive.participation_submission_artifacts(submission_id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES motive.projects(id) ON DELETE RESTRICT,
  decision motive.participation_review_decision NOT NULL,
  reviewer_actor_id TEXT NOT NULL,
  rationale TEXT NOT NULL CHECK (char_length(rationale) BETWEEN 1 AND 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX participation_reviews_project_created_idx ON motive.participation_submission_reviews(project_id, created_at DESC, submission_id);

CREATE TABLE motive.participation_claim_completions (
  claim_id UUID PRIMARY KEY REFERENCES motive.work_claims(id) ON DELETE RESTRICT,
  submission_id UUID NOT NULL UNIQUE REFERENCES motive.participation_submission_artifacts(submission_id) ON DELETE RESTRICT,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION motive.guard_participation_agent_token()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, motive AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.owner_actor_id IS DISTINCT FROM OLD.owner_actor_id OR NEW.agent_name IS DISTINCT FROM OLD.agent_name
    OR NEW.model_name IS DISTINCT FROM OLD.model_name OR NEW.public_display_name IS DISTINCT FROM OLD.public_display_name
    OR NEW.token_digest IS DISTINCT FROM OLD.token_digest OR NEW.token_hint IS DISTINCT FROM OLD.token_hint
    OR NEW.license_acceptance_ref IS DISTINCT FROM OLD.license_acceptance_ref
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
    OR (OLD.last_used_at IS NOT NULL AND NEW.last_used_at < OLD.last_used_at)
  THEN
    RAISE EXCEPTION 'participation agent identity and token terms are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION motive.guard_participation_artifact()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, motive AS $$
DECLARE record motive.submissions%ROWTYPE;
DECLARE token motive.participation_agent_tokens%ROWTYPE;
BEGIN
  SELECT * INTO record FROM motive.submissions WHERE id = NEW.submission_id FOR KEY SHARE;
  SELECT * INTO token FROM motive.participation_agent_tokens WHERE id = NEW.agent_token_id FOR KEY SHARE;
  IF record.id IS NULL OR token.id IS NULL OR record.origin <> 'EXTERNAL' OR record.claim_id IS NULL
    OR record.project_id IS DISTINCT FROM NEW.project_id OR token.project_id IS DISTINCT FROM NEW.project_id
    OR record.operator_actor_id IS DISTINCT FROM ('agent:' || token.id::text)
    OR NOT EXISTS (SELECT 1 FROM motive.work_claims claim WHERE claim.id = record.claim_id
      AND claim.project_id = record.project_id AND claim.work_order_id = record.work_order_id
      AND claim.operator_actor_id = record.operator_actor_id AND claim.origin = 'EXTERNAL'
      AND claim.lease_epoch = record.lease_epoch)
  THEN
    RAISE EXCEPTION 'participation artifact requires its exact external submission, token and claim' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION motive.guard_participation_review()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, motive AS $$
DECLARE artifact motive.participation_submission_artifacts%ROWTYPE;
DECLARE contributor_actor TEXT;
BEGIN
  SELECT * INTO artifact FROM motive.participation_submission_artifacts item
  WHERE item.submission_id = NEW.submission_id FOR KEY SHARE;
  SELECT token.owner_actor_id INTO contributor_actor
  FROM motive.participation_agent_tokens token
  WHERE token.id = artifact.agent_token_id FOR KEY SHARE;
  IF artifact.submission_id IS NULL OR artifact.project_id IS DISTINCT FROM NEW.project_id
    OR contributor_actor IS NULL OR contributor_actor = NEW.reviewer_actor_id
    OR NOT EXISTS (SELECT 1 FROM motive.memberships membership WHERE membership.project_id = NEW.project_id
      AND membership.actor_id = NEW.reviewer_actor_id AND membership.revoked_at IS NULL
      AND membership.role IN ('OWNER', 'STEWARD'))
    OR (NEW.decision = 'ACCEPTED' AND artifact.report <> 'VALID')
  THEN
    RAISE EXCEPTION 'participation review requires an independent owner/steward and an acceptable report' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION motive.guard_participation_completion()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, motive AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM motive.work_claims claim
    JOIN motive.submissions submission ON submission.claim_id = claim.id
    JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id = submission.id
    WHERE claim.id = NEW.claim_id AND artifact.submission_id = NEW.submission_id
      AND claim.operator_actor_id = submission.operator_actor_id
      AND claim.lease_epoch = submission.lease_epoch)
  THEN
    RAISE EXCEPTION 'participation completion requires a valid submission from the exact claim epoch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER participation_agent_token_guard BEFORE UPDATE ON motive.participation_agent_tokens
  FOR EACH ROW EXECUTE FUNCTION motive.guard_participation_agent_token();
CREATE TRIGGER participation_artifact_guard BEFORE INSERT ON motive.participation_submission_artifacts
  FOR EACH ROW EXECUTE FUNCTION motive.guard_participation_artifact();
CREATE TRIGGER participation_artifact_immutable BEFORE UPDATE OR DELETE ON motive.participation_submission_artifacts
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();
CREATE TRIGGER participation_review_guard BEFORE INSERT ON motive.participation_submission_reviews
  FOR EACH ROW EXECUTE FUNCTION motive.guard_participation_review();
CREATE TRIGGER participation_review_immutable BEFORE UPDATE OR DELETE ON motive.participation_submission_reviews
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();
CREATE TRIGGER participation_completion_guard BEFORE INSERT ON motive.participation_claim_completions
  FOR EACH ROW EXECUTE FUNCTION motive.guard_participation_completion();
CREATE TRIGGER participation_completion_immutable BEFORE UPDATE OR DELETE ON motive.participation_claim_completions
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();

REVOKE ALL ON motive.participation_agent_tokens FROM PUBLIC;
REVOKE ALL ON motive.participation_submission_artifacts FROM PUBLIC;
REVOKE ALL ON motive.participation_submission_reviews FROM PUBLIC;
REVOKE ALL ON motive.participation_claim_completions FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_participation_agent_token() FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_participation_artifact() FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_participation_review() FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_participation_completion() FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'motive_control_reader') THEN
    EXECUTE 'REVOKE ALL ON motive.participation_agent_tokens FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON motive.participation_submission_artifacts FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON motive.participation_submission_reviews FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON motive.participation_claim_completions FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_participation_agent_token() FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_participation_artifact() FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_participation_review() FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_participation_completion() FROM motive_control_reader';
  END IF;
END $$;
