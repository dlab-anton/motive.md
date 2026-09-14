-- A real owner or steward may approve one narrowly-bound, revocable policy that
-- lets an original participation credential explicitly deliver draft + neutral
-- research records. The policy is authority, not a scheduler or account actor.

CREATE TABLE motive.project_research_delivery_policies (
  id UUID PRIMARY KEY,
  format TEXT NOT NULL CHECK (format='motive.project-research-delivery-policy/0.1'),
  project_id UUID NOT NULL REFERENCES motive.projects(id) ON DELETE RESTRICT,
  project_revision INTEGER NOT NULL CHECK (project_revision>0),
  work_order_id UUID NOT NULL REFERENCES motive.work_orders(id) ON DELETE RESTRICT,
  work_order_revision INTEGER NOT NULL CHECK (work_order_revision>0),
  work_order_terms_digest TEXT NOT NULL CHECK (work_order_terms_digest ~ '^sha256:[a-f0-9]{64}$'),
  scope_id UUID NOT NULL,
  scope_configuration_digest TEXT NOT NULL CHECK (scope_configuration_digest ~ '^sha256:[a-f0-9]{64}$'),
  engine_api_base_url TEXT NOT NULL CHECK (char_length(engine_api_base_url) BETWEEN 12 AND 2048),
  engine_api_version TEXT NOT NULL CHECK (char_length(engine_api_version) BETWEEN 1 AND 64),
  reviewed_contract_digest TEXT NOT NULL CHECK (reviewed_contract_digest ~ '^sha256:[a-f0-9]{64}$'),
  reviewed_contract_version TEXT NOT NULL CHECK (char_length(reviewed_contract_version) BETWEEN 1 AND 128),
  reviewed_contract_surface_digest TEXT NOT NULL CHECK (reviewed_contract_surface_digest ~ '^[a-f0-9]{64}$'),
  reviewed_implementation_digest TEXT NOT NULL CHECK (reviewed_implementation_digest ~ '^[a-f0-9]{64}$'),
  permitted_operations TEXT[] NOT NULL CHECK (permitted_operations=ARRAY['DRAFT_HYPOTHESIS','NEUTRAL_EVIDENCE']::TEXT[]),
  approved_by_actor_id TEXT NOT NULL CHECK (approved_by_actor_id ~ '^account:[A-Za-z0-9._~-]+$'),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200 AND idempotency_key ~ '^[A-Za-z0-9._~-]+$'),
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(approved_by_actor_id,idempotency_key),
  FOREIGN KEY(scope_id,project_id) REFERENCES motive.project_research_scopes(id,project_id) ON DELETE RESTRICT
);

CREATE TABLE motive.project_research_delivery_policy_revocations (
  policy_id UUID PRIMARY KEY REFERENCES motive.project_research_delivery_policies(id) ON DELETE RESTRICT,
  revoked_by_actor_id TEXT NOT NULL CHECK (revoked_by_actor_id ~ '^account:[A-Za-z0-9._~-]+$'),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200 AND idempotency_key ~ '^[A-Za-z0-9._~-]+$'),
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(revoked_by_actor_id,idempotency_key)
);

CREATE TABLE motive.agent_research_sync_requests (
  id UUID PRIMARY KEY,
  agent_token_id UUID NOT NULL REFERENCES motive.participation_agent_tokens(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES motive.projects(id) ON DELETE RESTRICT,
  policy_id UUID NOT NULL REFERENCES motive.project_research_delivery_policies(id) ON DELETE RESTRICT,
  submission_id UUID NOT NULL REFERENCES motive.participation_submission_artifacts(submission_id) ON DELETE RESTRICT,
  report_digest TEXT NOT NULL CHECK (report_digest ~ '^sha256:[a-f0-9]{64}$'),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200 AND idempotency_key ~ '^[A-Za-z0-9._~-]+$'),
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(agent_token_id,idempotency_key)
);

CREATE INDEX project_research_delivery_policies_current_idx
  ON motive.project_research_delivery_policies(project_id,scope_id,work_order_id,created_at DESC,id);

CREATE OR REPLACE FUNCTION motive.guard_project_research_delivery_policy()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM motive.projects project
    JOIN motive.work_orders work ON work.id=NEW.work_order_id AND work.project_id=project.id
    JOIN motive.project_research_scopes scope ON scope.id=NEW.scope_id AND scope.project_id=project.id
    JOIN motive.memberships membership ON membership.project_id=project.id AND membership.actor_id=NEW.approved_by_actor_id
    JOIN motive.account_identities account ON account.actor_id=NEW.approved_by_actor_id
    WHERE project.id=NEW.project_id AND project.current_revision=NEW.project_revision
      AND work.project_revision=NEW.project_revision AND work.revision=NEW.work_order_revision
      AND work.terms_digest=NEW.work_order_terms_digest
      AND scope.status='CONNECTED' AND scope.configuration_digest=NEW.scope_configuration_digest
      AND scope.api_base_url=NEW.engine_api_base_url AND scope.api_version=NEW.engine_api_version
      AND membership.revoked_at IS NULL AND membership.role IN ('OWNER','STEWARD') AND account.status='ACTIVE'
  ) THEN
    RAISE EXCEPTION 'research delivery policy requires exact current project, work, scope, contract approver authority'
      USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION motive.guard_project_research_delivery_policy_revocation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM motive.project_research_delivery_policies policy
    JOIN motive.memberships membership ON membership.project_id=policy.project_id AND membership.actor_id=NEW.revoked_by_actor_id
    JOIN motive.account_identities account ON account.actor_id=NEW.revoked_by_actor_id
    WHERE policy.id=NEW.policy_id AND membership.revoked_at IS NULL
      AND membership.role IN ('OWNER','STEWARD') AND account.status='ACTIVE'
  ) THEN
    RAISE EXCEPTION 'research delivery policy revocation requires a current owner or steward' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION motive.guard_agent_research_sync_request()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM motive.participation_agent_tokens token
    JOIN motive.memberships contributor_membership ON contributor_membership.project_id=token.project_id
      AND contributor_membership.actor_id=token.owner_actor_id
    JOIN motive.account_identities contributor ON contributor.actor_id=token.owner_actor_id
    JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=NEW.submission_id
      AND artifact.project_id=token.project_id AND artifact.agent_token_id=token.id
      AND artifact.report_digest=NEW.report_digest
    JOIN motive.participation_post_check_assessments assessment ON assessment.submission_id=artifact.submission_id
      AND assessment.project_id=artifact.project_id AND assessment.agent_token_id=token.id
      AND assessment.report_digest=artifact.report_digest
    JOIN motive.project_research_delivery_policies policy ON policy.id=NEW.policy_id
      AND policy.project_id=token.project_id
    LEFT JOIN motive.project_research_delivery_policy_revocations revocation ON revocation.policy_id=policy.id
    JOIN motive.projects project ON project.id=policy.project_id AND project.current_revision=policy.project_revision
    JOIN motive.work_orders work ON work.id=policy.work_order_id AND work.project_id=project.id
      AND work.revision=policy.work_order_revision AND work.project_revision=policy.project_revision
      AND work.terms_digest=policy.work_order_terms_digest
    JOIN motive.submissions submission ON submission.id=artifact.submission_id AND submission.work_order_id=work.id
      AND submission.work_order_revision=work.revision
    JOIN motive.project_research_scopes scope ON scope.id=policy.scope_id AND scope.project_id=project.id
      AND scope.status='CONNECTED' AND scope.configuration_digest=policy.scope_configuration_digest
      AND scope.api_base_url=policy.engine_api_base_url AND scope.api_version=policy.engine_api_version
    JOIN motive.memberships approver_membership ON approver_membership.project_id=project.id
      AND approver_membership.actor_id=policy.approved_by_actor_id
    JOIN motive.account_identities approver ON approver.actor_id=policy.approved_by_actor_id
    WHERE token.id=NEW.agent_token_id AND token.project_id=NEW.project_id
      AND token.revoked_at IS NULL AND token.expires_at>clock_timestamp()
      AND contributor_membership.revoked_at IS NULL AND contributor.status='ACTIVE'
      AND revocation.policy_id IS NULL AND approver_membership.revoked_at IS NULL
      AND approver_membership.role IN ('OWNER','STEWARD') AND approver.status='ACTIVE'
      AND policy.permitted_operations=ARRAY['DRAFT_HYPOTHESIS','NEUTRAL_EVIDENCE']::TEXT[]
  ) THEN
    RAISE EXCEPTION 'agent research sync requires the exact current credential, report, post-check, and policy authority'
      USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER project_research_delivery_policy_guard BEFORE INSERT ON motive.project_research_delivery_policies
  FOR EACH ROW EXECUTE FUNCTION motive.guard_project_research_delivery_policy();
CREATE TRIGGER project_research_delivery_policies_immutable BEFORE UPDATE OR DELETE ON motive.project_research_delivery_policies
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();
CREATE TRIGGER project_research_delivery_policy_revocation_guard BEFORE INSERT ON motive.project_research_delivery_policy_revocations
  FOR EACH ROW EXECUTE FUNCTION motive.guard_project_research_delivery_policy_revocation();
CREATE TRIGGER project_research_delivery_policy_revocations_immutable BEFORE UPDATE OR DELETE ON motive.project_research_delivery_policy_revocations
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();
CREATE TRIGGER agent_research_sync_request_guard BEFORE INSERT ON motive.agent_research_sync_requests
  FOR EACH ROW EXECUTE FUNCTION motive.guard_agent_research_sync_request();
CREATE TRIGGER agent_research_sync_requests_immutable BEFORE UPDATE OR DELETE ON motive.agent_research_sync_requests
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();

REVOKE ALL ON motive.project_research_delivery_policies,motive.project_research_delivery_policy_revocations,motive.agent_research_sync_requests FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_project_research_delivery_policy() FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_project_research_delivery_policy_revocation() FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_agent_research_sync_request() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    EXECUTE 'REVOKE ALL ON motive.project_research_delivery_policies,motive.project_research_delivery_policy_revocations,motive.agent_research_sync_requests FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    EXECUTE 'REVOKE ALL ON motive.project_research_delivery_policies,motive.project_research_delivery_policy_revocations,motive.agent_research_sync_requests FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='motive_control_reader') THEN
    EXECUTE 'REVOKE ALL ON motive.project_research_delivery_policies,motive.project_research_delivery_policy_revocations,motive.agent_research_sync_requests FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_project_research_delivery_policy() FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_project_research_delivery_policy_revocation() FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_agent_research_sync_request() FROM motive_control_reader';
  END IF;
END $$;
