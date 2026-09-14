-- One target-aware neutral append to a pre-test observed Hypothesis thread.
-- Historical draft deliveries, policy requests, packages, operations, and results
-- retain their original shapes and default to NEW_DRAFT.

CREATE TABLE motive.participation_claim_research_targets (
  claim_id UUID PRIMARY KEY REFERENCES motive.participation_claim_intents(claim_id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES motive.projects(id) ON DELETE RESTRICT,
  binding JSONB NOT NULL CHECK (jsonb_typeof(binding)='object'),
  binding_digest TEXT NOT NULL CHECK (binding_digest ~ '^sha256:[a-f0-9]{64}$'),
  intent_request_digest TEXT NOT NULL CHECK (intent_request_digest ~ '^sha256:[a-f0-9]{64}$'),
  declared_at TIMESTAMPTZ NOT NULL
);

CREATE OR REPLACE FUNCTION motive.guard_participation_claim_research_target()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
BEGIN
  IF ARRAY(SELECT key FROM jsonb_object_keys(NEW.binding) key ORDER BY key)
      <>ARRAY['channelId','format','hypothesisContentDigest','scopeConfigurationDigest','selection','statementDigest']::TEXT[]
    OR NEW.binding->>'format'<>'motive.research-delivery-target/0.1'
    OR ARRAY(SELECT key FROM jsonb_object_keys(NEW.binding->'selection') key ORDER BY key)
      <>ARRAY['hypothesisId','mode','observedUpdatedAt','scopeId','snapshotDigest','snapshotId']::TEXT[]
    OR NEW.binding#>>'{selection,mode}'<>'APPEND_EXISTING'
    OR NEW.binding_digest<>'sha256:'||encode(sha256(convert_to(
      motive.finding_review_canonical_json(NEW.binding),'UTF8')),'hex')
    OR NOT EXISTS (
      SELECT 1 FROM motive.participation_claim_intents intent
      JOIN motive.work_claims claim ON claim.id=intent.claim_id AND claim.project_id=intent.project_id
        AND claim.work_order_id=intent.work_order_id AND claim.lease_epoch=intent.lease_epoch
      JOIN motive.project_research_scopes scope ON scope.id=(NEW.binding#>>'{selection,scopeId}')::UUID
        AND scope.project_id=intent.project_id
      JOIN motive.research_context_snapshots snapshot ON snapshot.id=(NEW.binding#>>'{selection,snapshotId}')::UUID
        AND snapshot.scope_id=scope.id AND snapshot.project_id=intent.project_id
      WHERE intent.claim_id=NEW.claim_id AND intent.project_id=NEW.project_id
        AND intent.request_digest=NEW.intent_request_digest
        AND intent.request_digest='sha256:'||encode(sha256(convert_to(motive.finding_review_canonical_json(
          jsonb_build_object('assignmentId',intent.work_order_id::TEXT,'leaseEpoch',intent.lease_epoch,
            'proposal',intent.proposal,'expectation',intent.expectation,'conditions',to_jsonb(intent.conditions))
          ||CASE WHEN intent.research_context IS NULL THEN '{}'::JSONB ELSE jsonb_build_object('researchContext',intent.research_context) END
          ||CASE WHEN intent.research_references IS NULL THEN '{}'::JSONB ELSE jsonb_build_object('researchReferences',intent.research_references) END
          ||CASE WHEN intent.motive_references IS NULL THEN '{}'::JSONB ELSE jsonb_build_object('motiveReferences',intent.motive_references) END
          ||CASE WHEN intent.experiment_protocol IS NULL THEN '{}'::JSONB ELSE jsonb_build_object('experimentProtocol',intent.experiment_protocol) END
          ||jsonb_build_object('researchDeliveryTarget',NEW.binding->'selection')),'UTF8')),'hex')
        AND date_trunc('milliseconds',intent.created_at)=date_trunc('milliseconds',NEW.declared_at)
        AND claim.status='ACTIVE' AND claim.expires_at>statement_timestamp()
        AND NOT EXISTS(SELECT 1 FROM motive.submissions submitted WHERE submitted.claim_id=intent.claim_id)
        AND scope.channel_id=(NEW.binding->>'channelId')::UUID
        AND scope.configuration_digest=NEW.binding->>'scopeConfigurationDigest'
        AND snapshot.snapshot_digest=NEW.binding#>>'{selection,snapshotDigest}'
        AND snapshot.snapshot_digest='sha256:'||encode(sha256(convert_to(
          motive.finding_review_canonical_json(snapshot.payload),'UTF8')),'hex')
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(snapshot.payload->'hypotheses') hypothesis
          WHERE hypothesis->>'id'=NEW.binding#>>'{selection,hypothesisId}'
            AND hypothesis->>'updatedAt'=NEW.binding#>>'{selection,observedUpdatedAt}'
            AND hypothesis->>'contentDigest'=NEW.binding->>'hypothesisContentDigest'
            AND NEW.binding->>'statementDigest'='sha256:'||encode(sha256(convert_to(hypothesis->>'statement','UTF8')),'hex'))
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(intent.research_references) reference
          WHERE reference->>'scopeId'=NEW.binding#>>'{selection,scopeId}'
            AND reference->>'snapshotId'=NEW.binding#>>'{selection,snapshotId}'
            AND reference->>'snapshotDigest'=NEW.binding#>>'{selection,snapshotDigest}'
            AND reference->>'hypothesisId'=NEW.binding#>>'{selection,hypothesisId}'
            AND reference->>'observedUpdatedAt'=NEW.binding#>>'{selection,observedUpdatedAt}')
    ) THEN
    RAISE EXCEPTION 'research target requires an exact pre-test retained same-scope observation' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
EXCEPTION WHEN invalid_text_representation THEN
  RAISE EXCEPTION 'research target identity is invalid' USING ERRCODE='23514';
END $$;

CREATE TRIGGER participation_claim_research_target_guard BEFORE INSERT ON motive.participation_claim_research_targets
  FOR EACH ROW EXECUTE FUNCTION motive.guard_participation_claim_research_target();
CREATE TRIGGER participation_claim_research_targets_immutable BEFORE UPDATE OR DELETE ON motive.participation_claim_research_targets
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();

CREATE OR REPLACE FUNCTION motive.guard_submission_research_target_carrythrough()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
DECLARE retained JSONB;
BEGIN
  IF NEW.origin<>'EXTERNAL' OR NEW.attempt_id IS NOT NULL THEN RETURN NEW; END IF;
  SELECT target.binding->'selection' INTO retained
    FROM motive.participation_claim_research_targets target
    WHERE target.claim_id=NEW.claim_id AND target.project_id=NEW.project_id;
  IF (retained IS NULL AND NEW.provenance#>'{investigation,investigation,researchDeliveryTarget}' IS NOT NULL)
    OR (retained IS NOT NULL AND NEW.provenance#>'{investigation,investigation,researchDeliveryTarget}' IS DISTINCT FROM retained) THEN
    RAISE EXCEPTION 'submission research delivery target must equal its immutable pre-test claim target' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER submission_research_target_carrythrough_guard BEFORE INSERT ON motive.submissions
  FOR EACH ROW EXECUTE FUNCTION motive.guard_submission_research_target_carrythrough();

ALTER TABLE motive.project_research_delivery_policies
  ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'NEW_DRAFT',
  ADD COLUMN target_selection_rule TEXT;
DO $$ DECLARE item NAME; BEGIN
  SELECT conname INTO item FROM pg_constraint WHERE conrelid='motive.project_research_delivery_policies'::regclass
    AND contype='c' AND pg_get_constraintdef(oid) LIKE '%permitted_operations%';
  IF item IS NULL THEN RAISE EXCEPTION 'delivery policy operations constraint not found'; END IF;
  EXECUTE format('ALTER TABLE motive.project_research_delivery_policies DROP CONSTRAINT %I',item);
END $$;
ALTER TABLE motive.project_research_delivery_policies ADD CONSTRAINT project_research_delivery_policy_mode_check CHECK (
  (delivery_mode='NEW_DRAFT' AND target_selection_rule IS NULL
    AND permitted_operations=ARRAY['DRAFT_HYPOTHESIS','NEUTRAL_EVIDENCE']::TEXT[])
  OR (delivery_mode='APPEND_EXISTING' AND target_selection_rule='PRETEST_RETAINED_SAME_CHANNEL'
    AND reviewed_contract_version='hypothesis-http-writeback-capabilities/3'
    AND permitted_operations=ARRAY['NEUTRAL_EVIDENCE']::TEXT[]));

ALTER TABLE motive.hypothesis_submission_deliveries
  ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'NEW_DRAFT',
  ADD COLUMN target_binding JSONB,
  ADD COLUMN target_binding_digest TEXT;
ALTER TABLE motive.hypothesis_submission_deliveries ADD CONSTRAINT hypothesis_submission_delivery_mode_check CHECK (
  (delivery_mode='NEW_DRAFT' AND target_binding IS NULL AND target_binding_digest IS NULL)
  OR (delivery_mode='APPEND_EXISTING' AND jsonb_typeof(target_binding)='object'
    AND target_binding_digest ~ '^sha256:[a-f0-9]{64}$'
    AND reviewed_contract_version='hypothesis-http-writeback-capabilities/3'));

CREATE OR REPLACE FUNCTION motive.guard_hypothesis_submission_delivery_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM motive.hypothesis_writeback_intents intent
    JOIN motive.project_research_scopes scope ON scope.id=intent.scope_id AND scope.project_id=intent.project_id
    JOIN motive.submissions submission ON submission.id=intent.source_submission_id
    LEFT JOIN motive.participation_claim_research_targets target ON target.claim_id=submission.claim_id
    WHERE intent.id=NEW.source_intent_id AND intent.project_id=NEW.project_id
      AND intent.scope_id=NEW.scope_id AND intent.source_submission_id=NEW.source_submission_id
      AND intent.payload_digest=NEW.source_intent_payload_digest AND intent.engine_actor=NEW.engine_actor
      AND (intent.payload #>> '{scope,configurationDigest}')=NEW.scope_configuration_digest
      AND (intent.payload #>> '{scope,apiVersion}')=NEW.engine_api_version
      AND scope.status='CONNECTED' AND scope.configuration_digest=NEW.scope_configuration_digest
      AND scope.api_version=NEW.engine_api_version AND scope.api_base_url=NEW.engine_api_base_url
      AND ((NEW.delivery_mode='NEW_DRAFT' AND target.claim_id IS NULL
          AND NEW.target_binding IS NULL AND NEW.target_binding_digest IS NULL)
        OR (NEW.delivery_mode='APPEND_EXISTING' AND target.project_id=NEW.project_id
          AND target.binding=NEW.target_binding AND target.binding_digest=NEW.target_binding_digest
          AND target.binding#>>'{selection,scopeId}'=NEW.scope_id::TEXT
          AND target.binding->>'scopeConfigurationDigest'=NEW.scope_configuration_digest
          AND NEW.target_binding_digest='sha256:'||encode(sha256(convert_to(
            motive.finding_review_canonical_json(NEW.target_binding),'UTF8')),'hex')))
  ) THEN
    RAISE EXCEPTION 'submission delivery requires its winning immutable intent, target, and current connected scope'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION motive.guard_existing_thread_delivery_operation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM motive.hypothesis_submission_deliveries delivery WHERE delivery.id=NEW.delivery_id
    AND ((delivery.delivery_mode='NEW_DRAFT') OR
      (delivery.delivery_mode='APPEND_EXISTING' AND NEW.operation='NEUTRAL_EVIDENCE'
        AND NEW.target_hypothesis_id=(delivery.target_binding#>>'{selection,hypothesisId}')::UUID
        AND NEW.request_body->>'expected_channel_id'=delivery.target_binding->>'channelId'))) THEN
    RAISE EXCEPTION 'delivery operation does not match its immutable mode and target' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER existing_thread_delivery_operation_guard BEFORE INSERT ON motive.hypothesis_submission_delivery_operations
  FOR EACH ROW EXECUTE FUNCTION motive.guard_existing_thread_delivery_operation();

CREATE TABLE motive.research_delivery_observation_manifests (
  delivery_id UUID PRIMARY KEY REFERENCES motive.hypothesis_submission_deliveries(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES motive.projects(id) ON DELETE RESTRICT,
  source_submission_id UUID NOT NULL REFERENCES motive.submissions(id) ON DELETE RESTRICT,
  manifest JSONB NOT NULL CHECK (jsonb_typeof(manifest)='object'),
  manifest_bytes BYTEA NOT NULL CHECK (octet_length(manifest_bytes) BETWEEN 1 AND 131072),
  manifest_digest TEXT NOT NULL CHECK (manifest_digest ~ '^sha256:[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE OR REPLACE FUNCTION motive.guard_research_delivery_observation_manifest()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
BEGIN
  IF convert_from(NEW.manifest_bytes,'UTF8')<>motive.finding_review_canonical_json(NEW.manifest)
    OR NEW.manifest_digest<>'sha256:'||encode(sha256(NEW.manifest_bytes),'hex')
    OR NOT EXISTS (SELECT 1 FROM motive.hypothesis_submission_deliveries delivery
      WHERE delivery.id=NEW.delivery_id AND delivery.project_id=NEW.project_id
        AND delivery.source_submission_id=NEW.source_submission_id AND delivery.delivery_mode='APPEND_EXISTING'
        AND NEW.manifest#>>'{delivery,id}'=delivery.id::TEXT
        AND NEW.manifest#>>'{delivery,targetBindingDigest}'=delivery.target_binding_digest
        AND NEW.manifest#>'{delivery,target}'=delivery.target_binding) THEN
    RAISE EXCEPTION 'observation manifest must preserve exact canonical append source' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER research_delivery_observation_manifest_guard BEFORE INSERT ON motive.research_delivery_observation_manifests
  FOR EACH ROW EXECUTE FUNCTION motive.guard_research_delivery_observation_manifest();
CREATE TRIGGER research_delivery_observation_manifests_immutable BEFORE UPDATE OR DELETE ON motive.research_delivery_observation_manifests
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();

CREATE TABLE motive.research_delivery_operation_blocks (
  delivery_id UUID NOT NULL,
  operation TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  reason TEXT NOT NULL CHECK (reason='TARGET_PRECONDITION_CONFLICT'),
  http_status INTEGER NOT NULL CHECK (http_status=409),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(delivery_id,operation),
  FOREIGN KEY(delivery_id,operation) REFERENCES motive.hypothesis_submission_delivery_operations(delivery_id,operation) ON DELETE RESTRICT
);
CREATE OR REPLACE FUNCTION motive.guard_research_delivery_operation_block()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM motive.hypothesis_submission_delivery_operations operation
    JOIN motive.hypothesis_submission_deliveries delivery ON delivery.id=operation.delivery_id
    WHERE operation.delivery_id=NEW.delivery_id AND operation.operation=NEW.operation
      AND operation.request_digest=NEW.request_digest AND operation.operation='NEUTRAL_EVIDENCE'
      AND delivery.delivery_mode='APPEND_EXISTING'
      AND NOT EXISTS(SELECT 1 FROM motive.hypothesis_submission_delivery_results result
        WHERE result.delivery_id=operation.delivery_id AND result.operation=operation.operation)) THEN
    RAISE EXCEPTION 'operation block requires the exact unresolved append request' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER research_delivery_operation_block_guard BEFORE INSERT ON motive.research_delivery_operation_blocks
  FOR EACH ROW EXECUTE FUNCTION motive.guard_research_delivery_operation_block();
CREATE TRIGGER research_delivery_operation_blocks_immutable BEFORE UPDATE OR DELETE ON motive.research_delivery_operation_blocks
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();

-- Expand the admission package format while leaving historical package JSON unchanged.
DO $$ DECLARE item NAME; BEGIN
  SELECT conname INTO item FROM pg_constraint WHERE conrelid='motive.hypothesis_submission_delivery_admission_decisions'::regclass
    AND contype='c' AND pg_get_constraintdef(oid) LIKE '%research-delivery-review-package/0.1%';
  IF item IS NULL THEN RAISE EXCEPTION 'research admission package constraint not found'; END IF;
  EXECUTE format('ALTER TABLE motive.hypothesis_submission_delivery_admission_decisions DROP CONSTRAINT %I',item);
END $$;
ALTER TABLE motive.hypothesis_submission_delivery_admission_decisions ADD CONSTRAINT research_delivery_review_package_v2_check
  CHECK (coalesce((review_package->>'format') IN ('motive.research-delivery-review-package/0.1',
    'motive.research-delivery-review-package/0.2'),FALSE));

-- Make the existing admission source validator mode-aware. Its reviewer-role
-- predicate, including migration043's unconditional agent proof, is retained.
DO $$
DECLARE definition TEXT; DECLARE old_join TEXT; DECLARE old_ops TEXT; DECLARE occurrences INTEGER;
BEGIN
  SELECT pg_get_functiondef('motive.guard_hypothesis_submission_delivery_admission()'::regprocedure) INTO definition;
  old_join:=$match$JOIN motive.hypothesis_submission_delivery_operations draft ON draft.delivery_id=delivery.id
      AND draft.operation='DRAFT_HYPOTHESIS'$match$;
  occurrences:=(length(definition)-length(replace(definition,old_join,'')))/length(old_join);
  IF occurrences<>1 THEN RAISE EXCEPTION 'expected admission draft join once, found %',occurrences; END IF;
  definition:=replace(definition,old_join,$match$LEFT JOIN motive.hypothesis_submission_delivery_operations draft ON draft.delivery_id=delivery.id
      AND draft.operation='DRAFT_HYPOTHESIS'$match$);
  old_ops:=$match$AND (NEW.review_package#>>'{operations,draft,bodyDigest}')=draft.request_body_digest
      AND (NEW.review_package#>>'{operations,draft,requestDigest}')=draft.request_digest
      AND (NEW.review_package#>>'{operations,draft,method}')='POST'
      AND (NEW.review_package#>>'{operations,draft,path}')=draft.request_path
      AND (NEW.review_package#>'{operations,draft,body}')=draft.request_body$match$;
  occurrences:=(length(definition)-length(replace(definition,old_ops,'')))/length(old_ops);
  IF occurrences<>1 THEN RAISE EXCEPTION 'expected admission draft predicates once, found %',occurrences; END IF;
  definition:=replace(definition,old_ops,$match$AND ((delivery.delivery_mode='NEW_DRAFT'
        AND (NEW.review_package->>'format')='motive.research-delivery-review-package/0.1'
        AND (NEW.review_package#>>'{operations,draft,bodyDigest}')=draft.request_body_digest
        AND (NEW.review_package#>>'{operations,draft,requestDigest}')=draft.request_digest
        AND (NEW.review_package#>>'{operations,draft,method}')='POST'
        AND (NEW.review_package#>>'{operations,draft,path}')=draft.request_path
        AND (NEW.review_package#>'{operations,draft,body}')=draft.request_body)
      OR (delivery.delivery_mode='APPEND_EXISTING'
        AND (NEW.review_package->>'format')='motive.research-delivery-review-package/0.2'))$match$);
  EXECUTE definition;
END $$;

CREATE OR REPLACE FUNCTION motive.guard_append_research_delivery_admission()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
BEGIN
  IF NEW.review_package->>'format'='motive.research-delivery-review-package/0.2' AND NOT EXISTS (
    SELECT 1 FROM motive.hypothesis_submission_deliveries delivery
    JOIN motive.hypothesis_submission_delivery_operations operation ON operation.delivery_id=delivery.id
      AND operation.operation='NEUTRAL_EVIDENCE'
    JOIN motive.research_delivery_observation_manifests manifest ON manifest.delivery_id=delivery.id
    WHERE delivery.id=NEW.delivery_id AND delivery.delivery_mode='APPEND_EXISTING'
      AND NEW.review_package#>>'{delivery,mode}'='APPEND_EXISTING'
      AND NEW.review_package#>'{delivery,target}'=delivery.target_binding
      AND NEW.review_package#>>'{delivery,targetBindingDigest}'=delivery.target_binding_digest
      AND NEW.review_package#>>'{observationManifest,digest}'=manifest.manifest_digest
      AND NEW.review_package#>'{observationManifest,body}'=manifest.manifest
      AND NEW.review_package#>>'{operations,neutralEvidence,path}'=operation.request_path
      AND NEW.review_package#>>'{operations,neutralEvidence,bodyDigest}'=operation.request_body_digest
      AND NEW.review_package#>>'{operations,neutralEvidence,requestDigest}'=operation.request_digest
      AND NEW.review_package#>'{operations,neutralEvidence,body}'=operation.request_body
      AND NOT EXISTS (SELECT 1 FROM motive.hypothesis_submission_delivery_operations other
        WHERE other.delivery_id=delivery.id AND other.operation<>'NEUTRAL_EVIDENCE')) THEN
    RAISE EXCEPTION 'append admission must bind the exact target, manifest, and sole evidence operation' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER append_research_delivery_admission_guard BEFORE INSERT ON motive.hypothesis_submission_delivery_admission_decisions
  FOR EACH ROW EXECUTE FUNCTION motive.guard_append_research_delivery_admission();

-- Add target-aware native finding package 0.3 while retaining 0.1/0.2 validators.
DO $$ DECLARE item NAME; BEGIN
  SELECT conname INTO item FROM pg_constraint WHERE conrelid='motive.finding_review_decisions'::regclass
    AND contype='c' AND pg_get_constraintdef(oid) LIKE '%motive.finding-review-package/0.2%';
  IF item IS NULL THEN RAISE EXCEPTION 'finding package format constraint not found'; END IF;
  EXECUTE format('ALTER TABLE motive.finding_review_decisions DROP CONSTRAINT %I',item);
END $$;
ALTER TABLE motive.finding_review_decisions ADD CONSTRAINT finding_review_package_format_v3_check CHECK (
  coalesce((review_package->>'format') IN ('motive.finding-review-package/0.1','motive.finding-review-package/0.2',
    'motive.finding-review-package/0.3'),FALSE));

DO $$ DECLARE definition TEXT; DECLARE needle TEXT; DECLARE replacement TEXT; DECLARE occurrences INTEGER; BEGIN
  SELECT pg_get_functiondef('motive.guard_motive_native_finding_review_decision()'::regprocedure) INTO definition;
  needle:=$match$=ARRAY['artifact','attribution','declaredIntent','investigation','postCheck','references','report','reproducibility','submission']::TEXT[]$match$;
  replacement:=$match$=CASE WHEN NEW.review_package->>'format'='motive.finding-review-package/0.3'
          THEN ARRAY['artifact','attribution','declaredIntent','investigation','postCheck','references','report','reproducibility','submission','target']::TEXT[]
          ELSE ARRAY['artifact','attribution','declaredIntent','investigation','postCheck','references','report','reproducibility','submission']::TEXT[] END$match$;
  occurrences:=(length(definition)-length(replace(definition,needle,'')))/length(needle);
  IF occurrences<>1 THEN RAISE EXCEPTION 'expected native source key check once, found %',occurrences; END IF;
  EXECUTE replace(definition,needle,replacement);
END $$;
CREATE TRIGGER finding_review_decision_guard_v3 BEFORE INSERT ON motive.finding_review_decisions
  FOR EACH ROW WHEN ((NEW.review_package->>'format')='motive.finding-review-package/0.3')
  EXECUTE FUNCTION motive.guard_motive_native_finding_review_decision();

CREATE OR REPLACE FUNCTION motive.guard_append_finding_review_target()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
BEGIN
  IF NEW.review_package->>'format'='motive.finding-review-package/0.2' AND EXISTS (
    SELECT 1 FROM motive.submissions submission
    JOIN motive.participation_claim_research_targets target ON target.claim_id=submission.claim_id
    WHERE submission.id=NEW.source_submission_id AND submission.project_id=NEW.project_id) THEN
    RAISE EXCEPTION 'targeted finding cannot use the untargeted native package' USING ERRCODE='23514';
  END IF;
  IF NEW.review_package->>'format'='motive.finding-review-package/0.3' AND NOT EXISTS (
    SELECT 1 FROM motive.submissions submission
    JOIN motive.participation_claim_research_targets target ON target.claim_id=submission.claim_id
      AND target.project_id=submission.project_id
    WHERE submission.id=NEW.source_submission_id AND submission.project_id=NEW.project_id
      AND NEW.review_package#>'{source,target}'=target.binding
      AND target.binding_digest='sha256:'||encode(sha256(convert_to(
        motive.finding_review_canonical_json(NEW.review_package#>'{source,target}'),'UTF8')),'hex')) THEN
    RAISE EXCEPTION 'target-aware finding package must bind the source pre-test target' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER append_finding_review_target_guard BEFORE INSERT ON motive.finding_review_decisions
  FOR EACH ROW EXECUTE FUNCTION motive.guard_append_finding_review_target();

-- Exact replication proof for target-aware packages: both completed claims must
-- carry the same pre-test target binding. The historical 0.2 branch is unchanged.
CREATE OR REPLACE FUNCTION motive.guard_agent_finding_review_provenance()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
BEGIN
  IF NEW.reviewer_agent_token_id IS NOT NULL AND (
    NEW.review_package->>'format' NOT IN ('motive.finding-review-package/0.2','motive.finding-review-package/0.3')
    OR NOT motive.valid_agent_finding_review_proof(NEW.reviewer_actor_id,
      NEW.reviewer_agent_token_id,NEW.review_submission_id,NEW.source_submission_id,NEW.project_id)
    OR (NEW.review_package->>'format'='motive.finding-review-package/0.3' AND NOT EXISTS (
      SELECT 1 FROM motive.submissions source_item
      JOIN motive.participation_claim_research_targets source_target ON source_target.claim_id=source_item.claim_id
      JOIN motive.submissions review_item ON review_item.id=NEW.review_submission_id
      JOIN motive.participation_claim_research_targets review_target ON review_target.claim_id=review_item.claim_id
      WHERE source_item.id=NEW.source_submission_id AND source_item.project_id=NEW.project_id
        AND review_item.project_id=NEW.project_id AND source_target.binding=review_target.binding
        AND NEW.review_package#>'{source,target}'=source_target.binding))) THEN
    RAISE EXCEPTION 'agent finding review requires exact current target-bound replication proof' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;

-- Strengthen automatic admission proof with exact mode/package/target policy.
DO $$ DECLARE definition TEXT; DECLARE needle TEXT; DECLARE replacement TEXT; DECLARE occurrences INTEGER; BEGIN
  SELECT pg_get_functiondef('motive.valid_agent_memory_admission_proof(text,uuid,uuid)'::regprocedure) INTO definition;
  needle:=$match$finding.review_package->>'format'='motive.finding-review-package/0.2'$match$;
  replacement:=$match$((finding.review_package->>'format'='motive.finding-review-package/0.2'
        AND delivery.delivery_mode='NEW_DRAFT' AND policy.delivery_mode='NEW_DRAFT')
      OR (finding.review_package->>'format'='motive.finding-review-package/0.3'
        AND delivery.delivery_mode='APPEND_EXISTING' AND policy.delivery_mode='APPEND_EXISTING'
        AND policy.target_selection_rule='PRETEST_RETAINED_SAME_CHANNEL'
        AND finding.review_package#>'{source,target}'=delivery.target_binding))$match$;
  occurrences:=(length(definition)-length(replace(definition,needle,'')))/length(needle);
  IF occurrences<>1 THEN RAISE EXCEPTION 'expected memory finding format once, found %',occurrences; END IF;
  definition:=replace(definition,needle,replacement);
  needle:=$match$policy.permitted_operations=ARRAY['DRAFT_HYPOTHESIS','NEUTRAL_EVIDENCE']::TEXT[]$match$;
  replacement:=$match$((policy.delivery_mode='NEW_DRAFT' AND policy.permitted_operations=ARRAY['DRAFT_HYPOTHESIS','NEUTRAL_EVIDENCE']::TEXT[])
        OR (policy.delivery_mode='APPEND_EXISTING' AND policy.permitted_operations=ARRAY['NEUTRAL_EVIDENCE']::TEXT[]))$match$;
  occurrences:=(length(definition)-length(replace(definition,needle,'')))/length(needle);
  IF occurrences<>1 THEN RAISE EXCEPTION 'expected memory policy operations once, found %',occurrences; END IF;
  EXECUTE replace(definition,needle,replacement);
END $$;

-- Existing sync-request trigger accepts either exact policy mode.
DO $$ DECLARE definition TEXT; DECLARE needle TEXT; DECLARE replacement TEXT; DECLARE occurrences INTEGER; BEGIN
  SELECT pg_get_functiondef('motive.guard_agent_research_sync_request()'::regprocedure) INTO definition;
  needle:=$match$policy.permitted_operations=ARRAY['DRAFT_HYPOTHESIS','NEUTRAL_EVIDENCE']::TEXT[]$match$;
  replacement:=$match$((policy.delivery_mode='NEW_DRAFT' AND policy.permitted_operations=ARRAY['DRAFT_HYPOTHESIS','NEUTRAL_EVIDENCE']::TEXT[])
        OR (policy.delivery_mode='APPEND_EXISTING' AND policy.permitted_operations=ARRAY['NEUTRAL_EVIDENCE']::TEXT[]))$match$;
  occurrences:=(length(definition)-length(replace(definition,needle,'')))/length(needle);
  IF occurrences<>1 THEN RAISE EXCEPTION 'expected sync policy operations once, found %',occurrences; END IF;
  EXECUTE replace(definition,needle,replacement);
END $$;

REVOKE ALL ON motive.participation_claim_research_targets,motive.research_delivery_observation_manifests,
  motive.research_delivery_operation_blocks FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_participation_claim_research_target() FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_submission_research_target_carrythrough() FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_existing_thread_delivery_operation() FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_research_delivery_observation_manifest() FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_research_delivery_operation_block() FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_append_research_delivery_admission() FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_append_finding_review_target() FROM PUBLIC;
DO $$ DECLARE role_name TEXT; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','motive_control_reader'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON motive.participation_claim_research_targets,motive.research_delivery_observation_manifests,motive.research_delivery_operation_blocks FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION motive.guard_participation_claim_research_target() FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION motive.guard_submission_research_target_carrythrough() FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION motive.guard_existing_thread_delivery_operation() FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION motive.guard_research_delivery_observation_manifest() FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION motive.guard_research_delivery_operation_block() FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION motive.guard_append_research_delivery_admission() FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION motive.guard_append_finding_review_target() FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
