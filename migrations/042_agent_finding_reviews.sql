-- An ordinary participation credential may review one pinned finding only after
-- completing its own immutable replication evidence. Existing account reviews
-- and historical package 0.1 rows retain their original authority and shape.

ALTER TABLE motive.finding_review_decisions
  ADD COLUMN reviewer_agent_token_id UUID REFERENCES motive.participation_agent_tokens(id) ON DELETE RESTRICT,
  ADD COLUMN review_submission_id UUID REFERENCES motive.submissions(id) ON DELETE RESTRICT,
  ADD CONSTRAINT finding_review_agent_provenance_pair
    CHECK ((reviewer_agent_token_id IS NULL)=(review_submission_id IS NULL));

CREATE UNIQUE INDEX finding_review_agent_submission_once_idx
  ON motive.finding_review_decisions(review_submission_id)
  WHERE review_submission_id IS NOT NULL;
CREATE UNIQUE INDEX finding_review_agent_idempotency_idx
  ON motive.finding_review_decisions(reviewer_agent_token_id,idempotency_key)
  WHERE reviewer_agent_token_id IS NOT NULL;

CREATE OR REPLACE FUNCTION motive.valid_agent_finding_review_proof(
  reviewer_actor TEXT, reviewer_token UUID, review_submission UUID,
  target_submission UUID, review_project UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SET search_path=pg_catalog,motive AS $$
  SELECT reviewer_token IS NOT NULL AND review_submission IS NOT NULL AND EXISTS (
    SELECT 1
    FROM motive.participation_agent_tokens token
    JOIN motive.projects project ON project.id=token.project_id
      AND project.id=review_project AND project.slug='circle-packing' AND project.visibility='PUBLIC'
    JOIN motive.memberships membership ON membership.project_id=project.id
      AND membership.actor_id=token.owner_actor_id AND membership.revoked_at IS NULL
    JOIN motive.account_identities owner_identity ON owner_identity.actor_id=token.owner_actor_id
      AND owner_identity.status='ACTIVE'
    JOIN motive.submissions review_item ON review_item.id=review_submission
      AND review_item.project_id=project.id AND review_item.origin='EXTERNAL'
      AND review_item.operator_actor_id='agent:'||token.id::TEXT
    JOIN motive.work_claims review_claim ON review_claim.id=review_item.claim_id
      AND review_claim.project_id=project.id AND review_claim.work_order_id=review_item.work_order_id
      AND review_claim.lease_epoch=review_item.lease_epoch
      AND review_claim.operator_actor_id='agent:'||token.id::TEXT
    JOIN motive.work_orders review_work ON review_work.id=review_item.work_order_id
      AND review_work.project_id=project.id AND review_work.revision=review_item.work_order_revision
      AND review_work.project_revision=project.current_revision
    JOIN motive.participation_submission_artifacts review_artifact
      ON review_artifact.submission_id=review_item.id AND review_artifact.project_id=project.id
      AND review_artifact.agent_token_id=token.id
    JOIN motive.participation_claim_completions review_completion
      ON review_completion.submission_id=review_item.id AND review_completion.claim_id=review_claim.id
    JOIN motive.participation_post_check_assessments review_post
      ON review_post.submission_id=review_item.id AND review_post.project_id=project.id
      AND review_post.agent_token_id=token.id AND review_post.report_digest=review_artifact.report_digest
    JOIN motive.participation_submission_reproducibility review_repro
      ON review_repro.submission_id=review_item.id AND review_repro.project_id=project.id
      AND review_repro.agent_token_id=token.id AND review_repro.report_digest=review_artifact.report_digest
    JOIN motive.participation_claim_intents review_intent ON review_intent.claim_id=review_claim.id
      AND review_intent.project_id=project.id AND review_intent.work_order_id=review_work.id
      AND review_intent.work_order_revision=review_work.revision
      AND review_intent.work_order_terms_digest=review_work.terms_digest
      AND review_intent.lease_epoch=review_claim.lease_epoch AND review_intent.agent_token_id=token.id
    JOIN motive.submissions target ON target.id=target_submission
      AND target.project_id=project.id AND target.origin='EXTERNAL'
    JOIN motive.participation_submission_artifacts target_artifact
      ON target_artifact.submission_id=target.id AND target_artifact.project_id=project.id
    JOIN motive.participation_agent_tokens target_token ON target_token.id=target_artifact.agent_token_id
      AND target_token.project_id=project.id
    JOIN motive.participation_claim_completions target_completion
      ON target_completion.submission_id=target.id AND target_completion.claim_id=target.claim_id
    JOIN motive.participation_post_check_assessments target_post
      ON target_post.submission_id=target.id AND target_post.project_id=project.id
      AND target_post.agent_token_id=target_artifact.agent_token_id
      AND target_post.report_digest=target_artifact.report_digest
    JOIN motive.participation_submission_reproducibility target_repro
      ON target_repro.submission_id=target.id AND target_repro.project_id=project.id
      AND target_repro.agent_token_id=target_artifact.agent_token_id
      AND target_repro.report_digest=target_artifact.report_digest
    WHERE token.id=reviewer_token AND token.owner_actor_id=reviewer_actor
      AND token.revoked_at IS NULL AND token.expires_at>statement_timestamp()
      AND target_token.owner_actor_id<>token.owner_actor_id
      AND review_intent.experiment_protocol->>'format'='motive.experiment-protocol.v1'
      AND review_intent.experiment_protocol->>'purpose'='REPLICATION'
      AND (SELECT count(*) FROM jsonb_array_elements(review_intent.experiment_protocol->'inputs') entry
        WHERE entry->>'name'='review_target_submission_id'
          AND entry->>'value'=target.id::TEXT)=1
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(review_intent.motive_references) reference
        WHERE reference->>'submissionId'=target.id::TEXT
          AND reference->>'reportDigest'=target_artifact.report_digest
          AND reference->>'artifactDigest'=target_artifact.witness_digest)
  );
$$;

-- Populated agent provenance is always validated, even when the owner also has
-- an OWNER/STEWARD/REVIEWER role. This prevents the legacy role branch from
-- admitting forged or stale proof.
CREATE OR REPLACE FUNCTION motive.guard_agent_finding_review_provenance()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
BEGIN
  IF NEW.reviewer_agent_token_id IS NOT NULL AND (
    NEW.review_package->>'format'<>'motive.finding-review-package/0.2'
    OR NOT motive.valid_agent_finding_review_proof(NEW.reviewer_actor_id,
      NEW.reviewer_agent_token_id,NEW.review_submission_id,
      NEW.source_submission_id,NEW.project_id)
  ) THEN
    RAISE EXCEPTION 'agent finding review requires exact current replication proof'
      USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER finding_review_agent_provenance_guard
  BEFORE INSERT ON motive.finding_review_decisions
  FOR EACH ROW EXECUTE FUNCTION motive.guard_agent_finding_review_provenance();

-- Replace exactly the native-0.2 role predicate introduced by migration 041.
-- All other package, history, CAS, duplicate, digest, and evidence checks remain
-- the same function text. Migration 034 is deliberately not rewritten.
DO $$
DECLARE definition TEXT;
DECLARE needle TEXT:=$match$AND reviewer_membership.role IN ('OWNER','STEWARD','REVIEWER')$match$;
DECLARE replacement TEXT:=$match$AND (reviewer_membership.role IN ('OWNER','STEWARD','REVIEWER')
        OR motive.valid_agent_finding_review_proof(NEW.reviewer_actor_id,
          NEW.reviewer_agent_token_id,NEW.review_submission_id,
          NEW.source_submission_id,NEW.project_id))$match$;
DECLARE occurrences INTEGER;
BEGIN
  SELECT pg_get_functiondef('motive.guard_motive_native_finding_review_decision()'::regprocedure)
    INTO definition;
  occurrences:=(length(definition)-length(replace(definition,needle,'')))/length(needle);
  IF occurrences<>1 THEN
    RAISE EXCEPTION 'expected exactly one migration 041 native reviewer role predicate, found %',occurrences;
  END IF;
  EXECUTE replace(definition,needle,replacement);
END $$;

REVOKE ALL ON FUNCTION motive.valid_agent_finding_review_proof(TEXT,UUID,UUID,UUID,UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_agent_finding_review_provenance() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION motive.valid_agent_finding_review_proof(TEXT,UUID,UUID,UUID,UUID) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_agent_finding_review_provenance() FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION motive.valid_agent_finding_review_proof(TEXT,UUID,UUID,UUID,UUID) FROM authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_agent_finding_review_provenance() FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='motive_control_reader') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION motive.valid_agent_finding_review_proof(TEXT,UUID,UUID,UUID,UUID) FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_agent_finding_review_provenance() FROM motive_control_reader';
  END IF;
END $$;
