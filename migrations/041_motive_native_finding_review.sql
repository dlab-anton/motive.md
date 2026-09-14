-- Finding review package 0.2 binds an assessment directly to Motive's
-- completed immutable evidence. Hypothesis delivery remains an optional,
-- separately reviewed memory attachment. The historical 0.1 guard is retained
-- unchanged and continues to validate stored 0.1 correction chains.

DO $$
DECLARE old_format_constraint NAME;
DECLARE matching_constraints INTEGER;
BEGIN
  SELECT count(*),min(constraint_row.conname)
    INTO matching_constraints,old_format_constraint
  FROM pg_constraint constraint_row
  WHERE constraint_row.conrelid='motive.finding_review_decisions'::regclass
    AND constraint_row.contype='c'
    AND pg_get_constraintdef(constraint_row.oid) LIKE '%motive.finding-review-package/0.1%';
  IF matching_constraints<>1 THEN
    RAISE EXCEPTION 'expected one historical finding review package format constraint';
  END IF;
  EXECUTE format('ALTER TABLE motive.finding_review_decisions DROP CONSTRAINT %I',old_format_constraint);
END $$;

ALTER TABLE motive.finding_review_decisions
  ADD CONSTRAINT finding_review_package_format_v2_check
  CHECK (coalesce((review_package->>'format') IN
    ('motive.finding-review-package/0.1','motive.finding-review-package/0.2'),FALSE));

-- Keep the original 0.1 trigger function and all of its delivery/engine checks
-- byte-for-byte. Limit that historical validator to historical packages.
DROP TRIGGER finding_review_decision_guard ON motive.finding_review_decisions;
CREATE TRIGGER finding_review_decision_guard BEFORE INSERT ON motive.finding_review_decisions
  FOR EACH ROW WHEN ((NEW.review_package->>'format')='motive.finding-review-package/0.1')
  EXECUTE FUNCTION motive.guard_finding_review_decision();

-- Match packages/domain canonicalJson for the deliberately bounded v0.2 data
-- subset: controlled ASCII object keys, JSON safe integers, strings, booleans,
-- nulls, and arrays. Unsupported keys and numbers fail closed. This lets the
-- database bind nested investigation and whole-package digests without a broad
-- ECMAScript-number or UTF-16 key-order serializer.
CREATE OR REPLACE FUNCTION motive.finding_review_canonical_json(value JSONB)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=pg_catalog,motive AS $$
DECLARE kind TEXT;
DECLARE rendered TEXT;
BEGIN
  kind:=jsonb_typeof(value);
  IF kind='object' THEN
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(value) item(key)
      WHERE octet_length(item.key)<>char_length(item.key)) THEN
      RAISE EXCEPTION 'finding review canonical JSON only supports controlled ASCII object keys'
        USING ERRCODE='23514';
    END IF;
    SELECT '{'||coalesce(string_agg(to_jsonb(item.key)::TEXT||':'
      ||motive.finding_review_canonical_json(value->item.key),',' ORDER BY item.key COLLATE "C"),'')||'}'
      INTO rendered FROM jsonb_object_keys(value) item(key);
    RETURN rendered;
  ELSIF kind='array' THEN
    SELECT '['||coalesce(string_agg(motive.finding_review_canonical_json(item.value),',' ORDER BY item.ordinal),'')||']'
      INTO rendered FROM jsonb_array_elements(value) WITH ORDINALITY item(value,ordinal);
    RETURN rendered;
  ELSIF kind='number' THEN
    IF (value::TEXT)::NUMERIC<>trunc((value::TEXT)::NUMERIC)
      OR (value::TEXT)::NUMERIC NOT BETWEEN -9007199254740991 AND 9007199254740991 THEN
      RAISE EXCEPTION 'finding review canonical JSON only supports JSON safe integers'
        USING ERRCODE='23514';
    END IF;
    RETURN trunc((value::TEXT)::NUMERIC)::TEXT;
  END IF;
  RETURN value::TEXT;
END $$;

CREATE OR REPLACE FUNCTION motive.guard_motive_native_finding_review_decision()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
BEGIN
  -- Completion rows are the stable subject locks. Sorting keeps source and
  -- duplicate decisions in the same order for concurrent cross-references.
  PERFORM completion.submission_id FROM motive.participation_claim_completions completion
    WHERE completion.submission_id IN (NEW.source_submission_id,NEW.duplicate_of_submission_id)
    ORDER BY completion.submission_id FOR UPDATE;

  IF NEW.previous_decision_id IS NULL THEN
    IF EXISTS (SELECT 1 FROM motive.finding_review_decisions item
      WHERE item.source_submission_id=NEW.source_submission_id) THEN
      RAISE EXCEPTION 'finding review expected decision is stale' USING ERRCODE='40001';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM motive.finding_review_decisions prior
    WHERE prior.id=NEW.previous_decision_id AND prior.project_id=NEW.project_id
      AND prior.source_submission_id=NEW.source_submission_id
      AND NOT EXISTS(SELECT 1 FROM motive.finding_review_decisions successor
        WHERE successor.previous_decision_id=prior.id)
  ) THEN
    RAISE EXCEPTION 'finding review expected decision is stale' USING ERRCODE='40001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM motive.submissions submission
    JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=submission.id
      AND artifact.project_id=submission.project_id
    JOIN motive.participation_agent_tokens token ON token.id=artifact.agent_token_id
      AND token.project_id=submission.project_id
    JOIN motive.participation_claim_completions completion ON completion.submission_id=submission.id
      AND completion.claim_id=submission.claim_id
    JOIN motive.participation_post_check_assessments assessment ON assessment.submission_id=submission.id
      AND assessment.project_id=submission.project_id AND assessment.agent_token_id=artifact.agent_token_id
      AND assessment.report_digest=artifact.report_digest
    JOIN motive.memberships reviewer_membership ON reviewer_membership.project_id=submission.project_id
      AND reviewer_membership.actor_id=NEW.reviewer_actor_id AND reviewer_membership.revoked_at IS NULL
      AND reviewer_membership.role IN ('OWNER','STEWARD','REVIEWER')
    JOIN motive.account_identities reviewer ON reviewer.actor_id=NEW.reviewer_actor_id AND reviewer.status='ACTIVE'
    WHERE submission.id=NEW.source_submission_id AND submission.project_id=NEW.project_id
  ) THEN
    RAISE EXCEPTION 'finding review requires a completed immutable investigation and current reviewer authority'
      USING ERRCODE='42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM motive.submissions submission
    JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=submission.id
    JOIN motive.participation_agent_tokens token ON token.id=artifact.agent_token_id
    WHERE submission.id=NEW.source_submission_id AND NEW.reviewer_actor_id<>token.owner_actor_id
  ) THEN
    RAISE EXCEPTION 'finding review requires an independent reviewer' USING ERRCODE='42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM motive.submissions submission
    JOIN motive.projects project ON project.id=submission.project_id
      AND project.slug='circle-packing' AND project.visibility='PUBLIC'
    JOIN motive.work_orders work ON work.id=submission.work_order_id AND work.project_id=submission.project_id
    JOIN motive.work_claims claim ON claim.id=submission.claim_id AND claim.project_id=submission.project_id
    JOIN motive.participation_claim_completions completion ON completion.submission_id=submission.id
      AND completion.claim_id=submission.claim_id
    JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=submission.id
      AND artifact.project_id=submission.project_id
    JOIN motive.participation_agent_tokens token ON token.id=artifact.agent_token_id
      AND token.project_id=submission.project_id
    JOIN motive.participation_post_check_assessments post_check ON post_check.submission_id=submission.id
      AND post_check.project_id=submission.project_id AND post_check.agent_token_id=artifact.agent_token_id
      AND post_check.report_digest=artifact.report_digest
    LEFT JOIN motive.participation_submission_reproducibility repro ON repro.submission_id=submission.id
      AND repro.project_id=submission.project_id AND repro.agent_token_id=artifact.agent_token_id
      AND repro.report_digest=artifact.report_digest
    LEFT JOIN motive.participation_claim_intents claim_intent ON claim_intent.claim_id=claim.id
      AND claim_intent.project_id=submission.project_id AND claim_intent.work_order_id=work.id
      AND claim_intent.work_order_revision=work.revision AND claim_intent.work_order_terms_digest=work.terms_digest
      AND claim_intent.lease_epoch=claim.lease_epoch AND claim_intent.agent_token_id=artifact.agent_token_id
    WHERE submission.id=NEW.source_submission_id AND submission.project_id=NEW.project_id
      AND submission.origin='EXTERNAL'
      AND ARRAY(SELECT key FROM jsonb_object_keys(NEW.review_package) key ORDER BY key)
        =ARRAY['assessment','claim','findingId','format','project','source','workOrder']::TEXT[]
      AND ARRAY(SELECT key FROM jsonb_object_keys(NEW.review_package->'source') key ORDER BY key)
        =ARRAY['artifact','attribution','declaredIntent','investigation','postCheck','references','report','reproducibility','submission']::TEXT[]
      AND ARRAY(SELECT key FROM jsonb_object_keys(NEW.review_package#>'{source,submission}') key ORDER BY key)
        =ARRAY['artifactManifestDigest','baseCommit','createdAt','format','id','licenseAcceptanceRef']::TEXT[]
      AND NEW.review_package->'assessment'=jsonb_build_object(
        'engineHypothesisSupport','UNASSESSED','engineConclusionApproval','UNASSESSED')
      AND NEW.review_package->'project'=jsonb_build_object(
        'id',submission.project_id::TEXT,'slug',project.slug,'revision',work.project_revision)
      AND NEW.review_package#>>'{workOrder,id}'=work.id::TEXT
      AND (NEW.review_package#>>'{workOrder,revision}')::INTEGER=work.revision
      AND (NEW.review_package#>>'{workOrder,projectRevision}')::INTEGER=work.project_revision
      AND NEW.review_package#>>'{workOrder,termsDigest}'=work.terms_digest
      AND NEW.review_package#>'{workOrder,terms}'=work.terms
      AND ARRAY(SELECT key FROM jsonb_object_keys(NEW.review_package->'workOrder') key ORDER BY key)
        =ARRAY['id','projectRevision','revision','terms','termsDigest']::TEXT[]
      AND NEW.review_package#>>'{claim,id}'=claim.id::TEXT
      AND (NEW.review_package#>>'{claim,leaseEpoch}')::INTEGER=claim.lease_epoch
      AND NEW.review_package#>>'{claim,termsDigest}'=claim.terms_digest
      AND (NEW.review_package#>>'{claim,completedAt}')::TIMESTAMPTZ=date_trunc('milliseconds',completion.completed_at)
      AND ARRAY(SELECT key FROM jsonb_object_keys(NEW.review_package->'claim') key ORDER BY key)
        =ARRAY['completedAt','id','leaseEpoch','termsDigest']::TEXT[]
      AND NEW.review_package#>>'{source,submission,id}'=submission.id::TEXT
      AND NEW.review_package#>>'{source,submission,format}'=submission.format
      AND (NEW.review_package#>>'{source,submission,createdAt}')::TIMESTAMPTZ=date_trunc('milliseconds',submission.created_at)
      AND NEW.review_package#>>'{source,submission,baseCommit}'=submission.base_commit
      AND NEW.review_package#>>'{source,submission,artifactManifestDigest}'=submission.artifact_manifest_digest
      AND NEW.review_package#>>'{source,submission,licenseAcceptanceRef}'=submission.license_acceptance_ref
      AND NEW.review_package#>'{source,attribution}'=jsonb_build_object(
        'contributorActorId',token.owner_actor_id,'agentTokenId',token.id::TEXT,'agentName',token.agent_name)
      AND ((claim_intent.claim_id IS NULL AND NEW.review_package#>'{source,declaredIntent}'='null'::JSONB)
        OR (claim_intent.claim_id IS NOT NULL
          AND NEW.review_package#>'{source,declaredIntent}'=(
            jsonb_build_object(
              'proposal',claim_intent.proposal,
              'expectation',claim_intent.expectation,
              'conditions',to_jsonb(claim_intent.conditions),
              'researchContext',coalesce(claim_intent.research_context,'null'::JSONB),
              'researchReferences',coalesce(claim_intent.research_references,'null'::JSONB),
              'motiveReferences',coalesce(claim_intent.motive_references,'null'::JSONB),
              'declaredAt',to_char(date_trunc('milliseconds',claim_intent.created_at) AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'requestDigest',claim_intent.request_digest)
            || CASE WHEN claim_intent.experiment_protocol IS NULL THEN '{}'::JSONB
              ELSE jsonb_build_object('experimentProtocol',claim_intent.experiment_protocol) END)))
      AND ARRAY(SELECT key FROM jsonb_object_keys(NEW.review_package#>'{source,investigation}') key ORDER BY key)
        =ARRAY['assessment','conditions','digest','expectation','nextAction','observations','proposal']::TEXT[]
      AND NEW.review_package#>>'{source,investigation,proposal}'
        =submission.provenance#>>'{investigation,investigation,proposal}'
      AND NEW.review_package#>>'{source,investigation,expectation}'
        =submission.provenance#>>'{investigation,investigation,expectation}'
      AND NEW.review_package#>'{source,investigation,conditions}'
        =submission.provenance#>'{investigation,investigation,conditions}'
      AND NEW.review_package#>'{source,investigation,observations}'
        =submission.provenance#>'{investigation,investigation,observations}'
      AND NEW.review_package#>>'{source,investigation,assessment}'
        =submission.provenance#>>'{investigation,investigation,assessment}'
      AND NEW.review_package#>>'{source,investigation,nextAction}'
        =submission.provenance#>>'{investigation,investigation,nextAction}'
      AND NEW.review_package#>>'{source,investigation,digest}'=
        'sha256:'||encode(sha256(convert_to(motive.finding_review_canonical_json(
          submission.provenance#>'{investigation,investigation}'),'UTF8')),'hex')
      AND NEW.review_package#>'{source,references}'=jsonb_build_object(
        'researchContext',CASE
          WHEN submission.provenance#>'{investigation,investigation,researchContext}' IS NULL THEN 'null'::JSONB
          ELSE jsonb_build_object('timing',CASE
            WHEN submission.provenance#>'{investigation,investigation,researchContext}'=claim_intent.research_context
              THEN 'PRE_TEST_INTENT' ELSE 'SUBMISSION_NOTES' END,
            'value',submission.provenance#>'{investigation,investigation,researchContext}') END,
        'researchReferences',CASE
          WHEN submission.provenance#>'{investigation,investigation,researchReferences}' IS NULL THEN 'null'::JSONB
          ELSE jsonb_build_object('timing',CASE
            WHEN submission.provenance#>'{investigation,investigation,researchReferences}'=claim_intent.research_references
              THEN 'PRE_TEST_INTENT' ELSE 'SUBMISSION_NOTES' END,
            'value',submission.provenance#>'{investigation,investigation,researchReferences}') END,
        'motiveReferences',CASE
          WHEN submission.provenance#>'{investigation,investigation,motiveReferences}' IS NULL THEN 'null'::JSONB
          ELSE jsonb_build_object('timing',CASE
            WHEN submission.provenance#>'{investigation,investigation,motiveReferences}'=claim_intent.motive_references
              THEN 'PRE_TEST_INTENT' ELSE 'SUBMISSION_NOTES' END,
            'value',submission.provenance#>'{investigation,investigation,motiveReferences}') END)
      AND NEW.review_package#>'{source,artifact}'=jsonb_build_object(
        'format',artifact.witness_format,'witness',convert_from(artifact.witness_bytes,'UTF8'),'digest',artifact.witness_digest)
      AND NEW.review_package#>'{source,report}'=jsonb_build_object(
        'status',artifact.report::TEXT,'body',artifact.report_body,'digest',artifact.report_digest)
      AND NEW.review_package#>>'{source,postCheck,requestDigest}'=post_check.request_digest
      AND NEW.review_package#>>'{source,postCheck,reportDigest}'=post_check.report_digest
      AND NEW.review_package#>>'{source,postCheck,assessment}'=post_check.assessment
      AND NEW.review_package#>>'{source,postCheck,nextAction}'=post_check.next_action
      AND (NEW.review_package#>>'{source,postCheck,createdAt}')::TIMESTAMPTZ=date_trunc('milliseconds',post_check.created_at)
      AND ARRAY(SELECT key FROM jsonb_object_keys(NEW.review_package#>'{source,postCheck}') key ORDER BY key)
        =CASE WHEN post_check.public_question IS NULL
          THEN ARRAY['assessment','createdAt','nextAction','reportDigest','requestDigest']::TEXT[]
          ELSE ARRAY['assessment','createdAt','nextAction','publicSummary','reportDigest','requestDigest']::TEXT[] END
      AND (post_check.public_question IS NULL OR NEW.review_package#>'{source,postCheck,publicSummary}'=
        jsonb_build_object('question',post_check.public_question,'finding',post_check.public_finding))
      AND ((repro.submission_id IS NULL AND NEW.review_package#>'{source,reproducibility}'='null'::JSONB)
        OR (repro.submission_id IS NOT NULL AND NEW.review_package#>'{source,reproducibility}'=jsonb_build_object(
          'requestDigest',repro.request_digest,'solverSourceDigest',repro.solver_source_digest,
          'trialResultsDigest',repro.trial_results_digest)))
      AND NEW.review_package_digest='sha256:'||encode(sha256(convert_to(
        motive.finding_review_canonical_json(NEW.review_package),'UTF8')),'hex')
  ) THEN
    RAISE EXCEPTION 'finding review package does not match the completed immutable Motive investigation'
      USING ERRCODE='23514';
  END IF;

  IF NEW.novelty='DUPLICATE' AND NOT EXISTS (
    SELECT 1 FROM motive.finding_review_decisions target
    WHERE target.id=NEW.duplicate_of_decision_id AND target.project_id=NEW.project_id
      AND target.source_submission_id=NEW.duplicate_of_submission_id
      AND target.decision='ACCEPT' AND target.novelty='DISTINCT'
      AND NOT EXISTS(SELECT 1 FROM motive.finding_review_decisions successor
        WHERE successor.previous_decision_id=target.id)
  ) THEN
    RAISE EXCEPTION 'duplicate finding target must be a current accepted distinct finding' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER finding_review_decision_guard_v2 BEFORE INSERT ON motive.finding_review_decisions
  FOR EACH ROW WHEN ((NEW.review_package->>'format')='motive.finding-review-package/0.2')
  EXECUTE FUNCTION motive.guard_motive_native_finding_review_decision();

-- Package version is part of the append-only chain identity. Enforce this for
-- both directions without changing either version-specific package validator.
CREATE OR REPLACE FUNCTION motive.guard_finding_review_package_version_chain()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
BEGIN
  IF NEW.previous_decision_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM motive.finding_review_decisions prior
    WHERE prior.id=NEW.previous_decision_id
      AND prior.project_id=NEW.project_id
      AND prior.source_submission_id=NEW.source_submission_id
      AND prior.review_package->>'format'=NEW.review_package->>'format'
  ) THEN
    RAISE EXCEPTION 'finding review correction must preserve its package version' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER finding_review_package_version_chain_guard BEFORE INSERT ON motive.finding_review_decisions
  FOR EACH ROW EXECUTE FUNCTION motive.guard_finding_review_package_version_chain();

REVOKE ALL ON FUNCTION motive.finding_review_canonical_json(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_motive_native_finding_review_decision() FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_finding_review_package_version_chain() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION motive.finding_review_canonical_json(JSONB) FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_motive_native_finding_review_decision() FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_finding_review_package_version_chain() FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION motive.finding_review_canonical_json(JSONB) FROM authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_motive_native_finding_review_decision() FROM authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_finding_review_package_version_chain() FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='motive_control_reader') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION motive.finding_review_canonical_json(JSONB) FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_motive_native_finding_review_decision() FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_finding_review_package_version_chain() FROM motive_control_reader';
  END IF;
END $$;
