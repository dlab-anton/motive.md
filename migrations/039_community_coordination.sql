-- Finite community-supplied coordination sessions produce public advisory plans.
-- They do not create work orders, grants, reviews, delivery policy or engine writes.

CREATE TABLE motive.community_coordination_grants (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES motive.projects(id) ON DELETE RESTRICT,
  agent_token_id UUID NOT NULL REFERENCES motive.participation_agent_tokens(id) ON DELETE RESTRICT,
  owner_actor_id TEXT NOT NULL CHECK (owner_actor_id ~ '^account:[A-Za-z0-9._~-]+$'),
  max_turns SMALLINT NOT NULL CHECK (max_turns BETWEEN 1 AND 5),
  issuance_idempotency_key TEXT NOT NULL CHECK (char_length(issuance_idempotency_key) BETWEEN 8 AND 200
    AND issuance_idempotency_key ~ '^[A-Za-z0-9._~-]+$'),
  issuance_request_digest TEXT NOT NULL CHECK (issuance_request_digest ~ '^sha256:[a-f0-9]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(owner_actor_id,issuance_idempotency_key),
  CHECK (expires_at>created_at AND expires_at<=created_at+interval '1 hour'),
  CHECK (revoked_at IS NULL OR revoked_at>=created_at),
  CHECK ((first_seen_at IS NULL AND last_seen_at IS NULL) OR
    (first_seen_at IS NOT NULL AND last_seen_at IS NOT NULL AND last_seen_at>=first_seen_at))
);
CREATE INDEX community_coordination_grants_owner_created_idx
  ON motive.community_coordination_grants(owner_actor_id,created_at DESC,id DESC);
CREATE INDEX community_coordination_grants_token_created_idx
  ON motive.community_coordination_grants(agent_token_id,created_at DESC,id DESC);
CREATE TABLE motive.community_coordination_turns (
  id UUID PRIMARY KEY,
  grant_id UUID NOT NULL REFERENCES motive.community_coordination_grants(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES motive.projects(id) ON DELETE RESTRICT,
  project_revision INTEGER NOT NULL CHECK (project_revision>=1),
  research_signal_digest TEXT NOT NULL CHECK (research_signal_digest ~ '^sha256:[a-f0-9]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  hard_expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  release_reason TEXT CHECK (release_reason IS NULL OR char_length(release_reason) BETWEEN 1 AND 500
    AND release_reason=btrim(release_reason)),
  expired_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,grant_id),
  CHECK (expires_at>created_at AND expires_at<=hard_expires_at AND hard_expires_at<=created_at+interval '30 minutes'),
  CHECK (last_seen_at IS NULL OR last_seen_at>=created_at),
  CHECK ((released_at IS NULL AND release_reason IS NULL) OR
    (released_at IS NOT NULL AND release_reason IS NOT NULL AND released_at>=created_at)),
  CHECK (expired_at IS NULL OR expired_at>=created_at),
  CHECK (completed_at IS NULL OR completed_at>=created_at),
  CHECK (((released_at IS NOT NULL)::integer+(expired_at IS NOT NULL)::integer+(completed_at IS NOT NULL)::integer)<=1)
);
CREATE UNIQUE INDEX community_coordination_one_open_project_turn_idx
  ON motive.community_coordination_turns(project_id)
  WHERE released_at IS NULL AND expired_at IS NULL AND completed_at IS NULL;
CREATE INDEX community_coordination_turns_grant_created_idx
  ON motive.community_coordination_turns(grant_id,created_at DESC,id DESC);

CREATE TABLE motive.community_coordination_plans (
  id UUID PRIMARY KEY,
  turn_id UUID NOT NULL UNIQUE,
  grant_id UUID NOT NULL,
  project_id UUID NOT NULL REFERENCES motive.projects(id) ON DELETE RESTRICT,
  project_revision INTEGER NOT NULL CHECK (project_revision>=1),
  research_signal_digest TEXT NOT NULL CHECK (research_signal_digest ~ '^sha256:[a-f0-9]{64}$'),
  -- jsonb text adds spaces; the service enforces the exact 16 KiB submitted JSON limit.
  plan JSONB NOT NULL CHECK (jsonb_typeof(plan)='object' AND octet_length(plan::text)<=20000),
  plan_digest TEXT NOT NULL CHECK (plan_digest ~ '^sha256:[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(turn_id,grant_id) REFERENCES motive.community_coordination_turns(id,grant_id) ON DELETE RESTRICT
);
CREATE INDEX community_coordination_plans_project_created_idx
  ON motive.community_coordination_plans(project_id,created_at DESC,id DESC);

CREATE TABLE motive.community_coordination_requests (
  id UUID PRIMARY KEY,
  actor_id TEXT NOT NULL CHECK (actor_id ~ '^account:[A-Za-z0-9._~-]+$'),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200
    AND idempotency_key ~ '^[A-Za-z0-9._~-]+$'),
  operation TEXT NOT NULL CHECK (operation IN ('GRANT','REVOKE','CLAIM','RENEW','RELEASE','COMPLETE')),
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  outcome TEXT NOT NULL CHECK (outcome IN ('CREATED','REVOKED','ASSIGNED','WAITING','EXHAUSTED','RENEWED','RELEASED','COMPLETED')),
  resource_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(actor_id,idempotency_key),
  CHECK ((outcome IN ('WAITING','EXHAUSTED') AND resource_id IS NULL)
    OR (outcome NOT IN ('WAITING','EXHAUSTED') AND resource_id IS NOT NULL))
);

CREATE OR REPLACE FUNCTION motive.guard_community_coordination_grant()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
BEGIN
  IF TG_OP='INSERT' AND NOT EXISTS (
    SELECT 1 FROM motive.participation_agent_tokens token
    JOIN motive.memberships membership ON membership.project_id=token.project_id AND membership.actor_id=token.owner_actor_id
    JOIN motive.account_identities identity ON identity.actor_id=token.owner_actor_id
    JOIN motive.projects project ON project.id=token.project_id
    WHERE token.id=NEW.agent_token_id AND token.project_id=NEW.project_id AND token.owner_actor_id=NEW.owner_actor_id
      AND token.revoked_at IS NULL AND token.expires_at>clock_timestamp()
      AND membership.revoked_at IS NULL AND membership.role IN ('OWNER','STEWARD','REVIEWER')
      AND identity.status='ACTIVE' AND project.slug='circle-packing' AND project.visibility='PUBLIC'
  ) THEN RAISE EXCEPTION 'community coordination requires an active approved account and exact participant token' USING ERRCODE='42501'; END IF;
  IF TG_OP='UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.agent_token_id IS DISTINCT FROM OLD.agent_token_id OR NEW.owner_actor_id IS DISTINCT FROM OLD.owner_actor_id
    OR NEW.max_turns IS DISTINCT FROM OLD.max_turns OR NEW.issuance_idempotency_key IS DISTINCT FROM OLD.issuance_idempotency_key
    OR NEW.issuance_request_digest IS DISTINCT FROM OLD.issuance_request_digest OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
    OR (OLD.first_seen_at IS NOT NULL AND NEW.first_seen_at IS DISTINCT FROM OLD.first_seen_at)
    OR (OLD.last_seen_at IS NOT NULL AND (NEW.last_seen_at IS NULL OR NEW.last_seen_at<OLD.last_seen_at)))
  THEN RAISE EXCEPTION 'community coordination grant bindings are immutable' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION motive.guard_community_coordination_turn()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
DECLARE grant_row motive.community_coordination_grants%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.grant_id IS DISTINCT FROM OLD.grant_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.project_revision IS DISTINCT FROM OLD.project_revision
    OR NEW.research_signal_digest IS DISTINCT FROM OLD.research_signal_digest OR NEW.hard_expires_at IS DISTINCT FROM OLD.hard_expires_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.expires_at<OLD.expires_at OR NEW.expires_at>NEW.hard_expires_at
    OR (OLD.released_at IS NOT NULL AND (NEW.released_at IS DISTINCT FROM OLD.released_at OR NEW.release_reason IS DISTINCT FROM OLD.release_reason))
    OR (OLD.expired_at IS NOT NULL AND NEW.expired_at IS DISTINCT FROM OLD.expired_at)
    OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at)
    OR (OLD.last_seen_at IS NOT NULL AND (NEW.last_seen_at IS NULL OR NEW.last_seen_at<OLD.last_seen_at)))
  THEN RAISE EXCEPTION 'community coordination turn bindings and terminal state are immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO grant_row FROM motive.community_coordination_grants WHERE id=NEW.grant_id FOR SHARE;
  IF NOT FOUND OR grant_row.project_id<>NEW.project_id OR NEW.hard_expires_at>grant_row.expires_at
  THEN RAISE EXCEPTION 'community coordination turn requires its exact grant' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' AND (grant_row.revoked_at IS NOT NULL OR grant_row.expires_at<=clock_timestamp()
    OR (SELECT count(*) FROM motive.community_coordination_turns used WHERE used.grant_id=grant_row.id)>=grant_row.max_turns
    OR NOT EXISTS (SELECT 1 FROM motive.participation_agent_tokens token
      JOIN motive.memberships membership ON membership.project_id=token.project_id AND membership.actor_id=token.owner_actor_id
      JOIN motive.account_identities identity ON identity.actor_id=token.owner_actor_id
      WHERE token.id=grant_row.agent_token_id AND token.project_id=grant_row.project_id AND token.owner_actor_id=grant_row.owner_actor_id
        AND token.revoked_at IS NULL AND token.expires_at>clock_timestamp() AND membership.revoked_at IS NULL
        AND membership.role IN ('OWNER','STEWARD','REVIEWER') AND identity.status='ACTIVE'))
  THEN RAISE EXCEPTION 'community coordination turn requires current authority and remaining quota' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION motive.guard_community_coordination_plan()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
DECLARE turn_row motive.community_coordination_turns%ROWTYPE;
DECLARE reference JSONB;
BEGIN
  SELECT * INTO turn_row FROM motive.community_coordination_turns WHERE id=NEW.turn_id AND grant_id=NEW.grant_id FOR UPDATE;
  IF NOT FOUND OR turn_row.project_id<>NEW.project_id OR turn_row.project_revision<>NEW.project_revision
    OR turn_row.research_signal_digest<>NEW.research_signal_digest OR turn_row.released_at IS NOT NULL OR turn_row.expired_at IS NOT NULL
    OR turn_row.completed_at IS NOT NULL OR turn_row.expires_at<=clock_timestamp()
  THEN RAISE EXCEPTION 'community coordination plan requires its exact active turn' USING ERRCODE='42501'; END IF;
  IF NEW.plan->>'format'<>'motive.community-coordination-plan.v1' OR jsonb_typeof(NEW.plan->'priorities')<>'array'
    OR jsonb_array_length(NEW.plan->'priorities') NOT BETWEEN 1 AND 3
  THEN RAISE EXCEPTION 'community coordination plan shape is invalid' USING ERRCODE='23514'; END IF;
  FOR reference IN SELECT ref FROM jsonb_array_elements(NEW.plan->'priorities') p
    CROSS JOIN LATERAL jsonb_array_elements(p->'motiveReferences') ref LOOP
    IF NOT EXISTS (SELECT 1 FROM motive.participation_submission_artifacts artifact
      JOIN motive.submissions submission ON submission.id=artifact.submission_id AND submission.project_id=artifact.project_id
      WHERE artifact.project_id=NEW.project_id AND artifact.submission_id=(reference->>'submissionId')::uuid
        AND artifact.report_digest=reference->>'reportDigest' AND artifact.witness_digest=reference->>'artifactDigest')
    THEN RAISE EXCEPTION 'community coordination reference must match same-project immutable evidence' USING ERRCODE='23514'; END IF;
  END LOOP;
  RETURN NEW;
END $$;

CREATE TRIGGER community_coordination_grant_guard BEFORE INSERT OR UPDATE ON motive.community_coordination_grants
  FOR EACH ROW EXECUTE FUNCTION motive.guard_community_coordination_grant();
CREATE TRIGGER community_coordination_grant_no_delete BEFORE DELETE ON motive.community_coordination_grants
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();
CREATE TRIGGER community_coordination_turn_guard BEFORE INSERT OR UPDATE ON motive.community_coordination_turns
  FOR EACH ROW EXECUTE FUNCTION motive.guard_community_coordination_turn();
CREATE TRIGGER community_coordination_turn_no_delete BEFORE DELETE ON motive.community_coordination_turns
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();
CREATE TRIGGER community_coordination_plan_guard BEFORE INSERT ON motive.community_coordination_plans
  FOR EACH ROW EXECUTE FUNCTION motive.guard_community_coordination_plan();
CREATE TRIGGER community_coordination_plan_immutable BEFORE UPDATE OR DELETE ON motive.community_coordination_plans
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();
CREATE TRIGGER community_coordination_request_immutable BEFORE UPDATE OR DELETE ON motive.community_coordination_requests
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();

ALTER TABLE motive.community_coordination_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE motive.community_coordination_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE motive.community_coordination_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE motive.community_coordination_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON motive.community_coordination_grants,motive.community_coordination_turns,
  motive.community_coordination_plans,motive.community_coordination_requests FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_community_coordination_grant(),motive.guard_community_coordination_turn(),
  motive.guard_community_coordination_plan() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON motive.community_coordination_grants,motive.community_coordination_turns,
      motive.community_coordination_plans,motive.community_coordination_requests FROM anon;
    REVOKE ALL ON FUNCTION motive.guard_community_coordination_grant(),motive.guard_community_coordination_turn(),
      motive.guard_community_coordination_plan() FROM anon;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON motive.community_coordination_grants,motive.community_coordination_turns,
      motive.community_coordination_plans,motive.community_coordination_requests FROM authenticated;
    REVOKE ALL ON FUNCTION motive.guard_community_coordination_grant(),motive.guard_community_coordination_turn(),
      motive.guard_community_coordination_plan() FROM authenticated;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='motive_control_reader') THEN
    REVOKE ALL ON motive.community_coordination_grants,motive.community_coordination_turns,
      motive.community_coordination_plans,motive.community_coordination_requests FROM motive_control_reader;
    REVOKE ALL ON FUNCTION motive.guard_community_coordination_grant(),motive.guard_community_coordination_turn(),
      motive.guard_community_coordination_plan() FROM motive_control_reader;
  END IF;
END $$;
