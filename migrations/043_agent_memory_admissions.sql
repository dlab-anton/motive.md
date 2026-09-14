-- An accepted finding backed by an ordinary contributor's exact, completed
-- replication may admit the target's immutable delivery package for retention.
-- It grants no project role, delivery policy, or engine execution authority.

ALTER TABLE motive.hypothesis_submission_delivery_admission_decisions
  ADD COLUMN finding_decision_id UUID REFERENCES motive.finding_review_decisions(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX hypothesis_submission_admission_finding_once_idx
  ON motive.hypothesis_submission_delivery_admission_decisions(finding_decision_id)
  WHERE finding_decision_id IS NOT NULL;

CREATE OR REPLACE FUNCTION motive.valid_agent_memory_admission_proof(
  reviewer_actor TEXT, finding_decision UUID, target_delivery UUID
)
RETURNS BOOLEAN LANGUAGE sql STABLE SET search_path=pg_catalog,motive AS $$
  SELECT finding_decision IS NOT NULL AND EXISTS (
    SELECT 1
    FROM motive.finding_review_decisions finding
    JOIN motive.hypothesis_submission_deliveries delivery ON delivery.id=target_delivery
      AND delivery.project_id=finding.project_id
      AND delivery.source_submission_id=finding.source_submission_id
    JOIN motive.project_research_delivery_policies policy ON ('policy:'||policy.id::TEXT)=delivery.created_by_actor_id
      AND policy.project_id=delivery.project_id AND policy.scope_id=delivery.scope_id
      AND policy.reviewed_contract_digest=delivery.reviewed_contract_digest
      AND policy.reviewed_contract_version=delivery.reviewed_contract_version
      AND policy.reviewed_contract_surface_digest=delivery.reviewed_contract_surface_digest
      AND policy.reviewed_implementation_digest=delivery.reviewed_implementation_digest
      AND policy.engine_api_base_url=delivery.engine_api_base_url
      AND policy.engine_api_version=delivery.engine_api_version
      AND policy.scope_configuration_digest=delivery.scope_configuration_digest
    LEFT JOIN motive.project_research_delivery_policy_revocations revocation ON revocation.policy_id=policy.id
    JOIN motive.projects project ON project.id=policy.project_id AND project.current_revision=policy.project_revision
    JOIN motive.work_orders work ON work.id=policy.work_order_id AND work.project_id=project.id
      AND work.project_revision=policy.project_revision AND work.revision=policy.work_order_revision
      AND work.terms_digest=policy.work_order_terms_digest
    JOIN motive.project_research_scopes scope ON scope.id=policy.scope_id AND scope.project_id=project.id
      AND scope.status='CONNECTED' AND scope.configuration_digest=policy.scope_configuration_digest
      AND scope.api_base_url=policy.engine_api_base_url AND scope.api_version=policy.engine_api_version
    JOIN motive.memberships approver_membership ON approver_membership.project_id=project.id
      AND approver_membership.actor_id=policy.approved_by_actor_id AND approver_membership.revoked_at IS NULL
      AND approver_membership.role IN ('OWNER','STEWARD')
    JOIN motive.account_identities approver ON approver.actor_id=policy.approved_by_actor_id AND approver.status='ACTIVE'
    JOIN motive.submissions target ON target.id=finding.source_submission_id
      AND target.project_id=project.id AND target.work_order_id=work.id AND target.work_order_revision=work.revision
    JOIN motive.participation_submission_artifacts target_artifact ON target_artifact.submission_id=target.id
      AND target_artifact.project_id=project.id
    JOIN motive.participation_agent_tokens target_token ON target_token.id=target_artifact.agent_token_id
      AND target_token.project_id=project.id AND target_token.revoked_at IS NULL
      AND target_token.expires_at>statement_timestamp()
    JOIN motive.memberships target_membership ON target_membership.project_id=project.id
      AND target_membership.actor_id=target_token.owner_actor_id AND target_membership.revoked_at IS NULL
    JOIN motive.account_identities target_identity ON target_identity.actor_id=target_token.owner_actor_id
      AND target_identity.status='ACTIVE'
    JOIN motive.participation_post_check_assessments target_post ON target_post.submission_id=target.id
      AND target_post.project_id=project.id AND target_post.agent_token_id=target_token.id
      AND target_post.report_digest=target_artifact.report_digest
    WHERE finding.id=finding_decision AND finding.reviewer_actor_id=reviewer_actor
      AND finding.decision='ACCEPT'
      AND finding.reviewer_agent_token_id IS NOT NULL
      AND finding.review_submission_id IS NOT NULL
      AND finding.review_package->>'format'='motive.finding-review-package/0.2'
      AND NOT EXISTS (SELECT 1 FROM motive.finding_review_decisions successor
        WHERE successor.previous_decision_id=finding.id)
      AND revocation.policy_id IS NULL
      AND policy.permitted_operations=ARRAY['DRAFT_HYPOTHESIS','NEUTRAL_EVIDENCE']::TEXT[]
      AND motive.valid_agent_finding_review_proof(finding.reviewer_actor_id,
        finding.reviewer_agent_token_id,finding.review_submission_id,
        finding.source_submission_id,finding.project_id)
  );
$$;

-- Populated provenance is checked unconditionally. A contributor who also has
-- a privileged project role cannot use that role to bypass an invalid proof.
CREATE OR REPLACE FUNCTION motive.guard_agent_memory_admission_provenance()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
BEGIN
  IF NEW.finding_decision_id IS NOT NULL AND (NEW.decision<>'ADMIT'
    OR NOT motive.valid_agent_memory_admission_proof(NEW.reviewer_actor_id,NEW.finding_decision_id,NEW.delivery_id)) THEN
    RAISE EXCEPTION 'agent memory admission requires a current accepted exact replication proof'
      USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER hypothesis_submission_admission_agent_provenance_guard
  BEFORE INSERT ON motive.hypothesis_submission_delivery_admission_decisions
  FOR EACH ROW EXECUTE FUNCTION motive.guard_agent_memory_admission_provenance();

-- Extend exactly the current migration-031 reviewer-role predicate. Every
-- immutable package/source check in that guard remains unchanged.
DO $$
DECLARE definition TEXT;
DECLARE needle TEXT:=$match$AND reviewer_membership.role IN ('OWNER','STEWARD','REVIEWER')$match$;
DECLARE replacement TEXT:=$match$AND (reviewer_membership.role IN ('OWNER','STEWARD','REVIEWER')
        OR motive.valid_agent_memory_admission_proof(NEW.reviewer_actor_id,
          NEW.finding_decision_id,NEW.delivery_id))$match$;
DECLARE occurrences INTEGER;
BEGIN
  SELECT pg_get_functiondef('motive.guard_hypothesis_submission_delivery_admission()'::regprocedure)
    INTO definition;
  occurrences:=(length(definition)-length(replace(definition,needle,'')))/length(needle);
  IF occurrences<>1 THEN
    RAISE EXCEPTION 'expected exactly one current memory admission reviewer role predicate, found %',occurrences;
  END IF;
  EXECUTE replace(definition,needle,replacement);
END $$;

REVOKE ALL ON FUNCTION motive.valid_agent_memory_admission_proof(TEXT,UUID,UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_agent_memory_admission_provenance() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION motive.valid_agent_memory_admission_proof(TEXT,UUID,UUID) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_agent_memory_admission_provenance() FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION motive.valid_agent_memory_admission_proof(TEXT,UUID,UUID) FROM authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_agent_memory_admission_provenance() FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='motive_control_reader') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION motive.valid_agent_memory_admission_proof(TEXT,UUID,UUID) FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_agent_memory_admission_provenance() FROM motive_control_reader';
  END IF;
END $$;
