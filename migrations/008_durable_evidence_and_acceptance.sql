-- P3 durable evaluator evidence and named human acceptance. Evaluations are
-- private immutable records. They do not alter ledger settlement, provider
-- lifecycle, submissions, or public projections.

CREATE TYPE motive.evaluation_outcome AS ENUM ('VERIFIED', 'REJECTED', 'INCONCLUSIVE');
CREATE TYPE motive.acceptance_decision AS ENUM ('ACCEPTED', 'REJECTED');

-- These redundant candidate keys let evidence bind the entire frozen chain by
-- foreign key rather than trusting a caller to combine otherwise valid IDs.
ALTER TABLE motive.work_orders
  ADD CONSTRAINT work_orders_id_project_terms_unique UNIQUE (id, project_id, terms_digest);
ALTER TABLE motive.attempts
  ADD CONSTRAINT attempts_id_work_order_project_terms_unique UNIQUE (id, work_order_id, project_id, terms_digest);
ALTER TABLE motive.orchestration_environments
  ADD CONSTRAINT orchestration_environments_id_attempt_unique UNIQUE (id, attempt_id);
ALTER TABLE motive.orchestration_artifact_seals
  ADD CONSTRAINT orchestration_artifact_seals_binding_unique
  UNIQUE (environment_id, attempt_id, manifest_digest, receipt_id);

CREATE TABLE motive.evaluations (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES motive.projects(id) ON DELETE RESTRICT,
  work_order_id UUID NOT NULL,
  attempt_id UUID NOT NULL,
  artifact_environment_id UUID NOT NULL,
  evaluator_environment_id UUID NOT NULL,
  artifact_manifest_digest TEXT NOT NULL CHECK (artifact_manifest_digest ~ '^sha256:[a-f0-9]{64}$'),
  artifact_receipt_id TEXT NOT NULL CHECK (char_length(artifact_receipt_id) BETWEEN 1 AND 512),
  terms_digest TEXT NOT NULL CHECK (terms_digest ~ '^sha256:[a-f0-9]{64}$'),
  evaluator_profile_digest TEXT NOT NULL CHECK (evaluator_profile_digest ~ '^sha256:[a-f0-9]{64}$'),
  evaluator_profile JSONB NOT NULL CHECK (jsonb_typeof(evaluator_profile) = 'object'),
  challenge_digest TEXT NOT NULL CHECK (challenge_digest ~ '^sha256:[a-f0-9]{64}$'),
  dependency_lock_digest TEXT NOT NULL CHECK (dependency_lock_digest ~ '^sha256:[a-f0-9]{64}$'),
  trusted_build_config_digest TEXT NOT NULL CHECK (trusted_build_config_digest ~ '^sha256:[a-f0-9]{64}$'),
  raw_report_digest TEXT NOT NULL CHECK (raw_report_digest ~ '^sha256:[a-f0-9]{64}$'),
  assessment_digest TEXT NOT NULL CHECK (assessment_digest ~ '^sha256:[a-f0-9]{64}$'),
  assessment JSONB NOT NULL CHECK (jsonb_typeof(assessment) = 'object'),
  outcome motive.evaluation_outcome NOT NULL,
  evaluator_provider TEXT NOT NULL CHECK (char_length(evaluator_provider) BETWEEN 1 AND 128),
  evaluator_external_id TEXT NOT NULL CHECK (char_length(evaluator_external_id) BETWEEN 1 AND 512),
  evaluator_session_id TEXT NOT NULL CHECK (char_length(evaluator_session_id) BETWEEN 1 AND 512),
  evaluator_lease_epoch INTEGER NOT NULL CHECK (evaluator_lease_epoch > 0),
  evaluator_controller_generation BIGINT NOT NULL CHECK (evaluator_controller_generation > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  -- PostgreSQL CHECK accepts NULL, so null-safe equality makes a missing
  -- assessment key fail instead of silently satisfying the constraint.
  CHECK ((assessment ->> 'format') IS NOT DISTINCT FROM 'motive.lean-comparator-assessment/0.1'),
  CHECK ((assessment ->> 'outcome') IS NOT DISTINCT FROM outcome::text),
  CHECK ((assessment ->> 'evaluator_profile_digest') IS NOT DISTINCT FROM evaluator_profile_digest),
  CHECK ((assessment ->> 'challenge_digest') IS NOT DISTINCT FROM challenge_digest),
  CHECK ((assessment ->> 'dependency_lock_digest') IS NOT DISTINCT FROM dependency_lock_digest),
  CHECK ((assessment ->> 'trusted_build_config_digest') IS NOT DISTINCT FROM trusted_build_config_digest),
  CHECK ((assessment ->> 'solution_artifact_manifest_digest') IS NOT DISTINCT FROM artifact_manifest_digest),
  CHECK ((assessment ->> 'raw_report_digest') IS NOT DISTINCT FROM raw_report_digest),
  CHECK ((assessment -> 'human_acceptance') IS NOT DISTINCT FROM '{"status":"PENDING","decision_id":null}'::jsonb),
  UNIQUE (attempt_id, raw_report_digest),
  UNIQUE (
    id, project_id, work_order_id, attempt_id, artifact_manifest_digest,
    terms_digest, evaluator_profile_digest, raw_report_digest
  ),
  FOREIGN KEY (work_order_id, project_id, terms_digest)
    REFERENCES motive.work_orders(id, project_id, terms_digest) ON DELETE RESTRICT,
  FOREIGN KEY (attempt_id, work_order_id, project_id, terms_digest)
    REFERENCES motive.attempts(id, work_order_id, project_id, terms_digest) ON DELETE RESTRICT,
  FOREIGN KEY (artifact_environment_id, attempt_id, artifact_manifest_digest, artifact_receipt_id)
    REFERENCES motive.orchestration_artifact_seals(environment_id, attempt_id, manifest_digest, receipt_id) ON DELETE RESTRICT,
  FOREIGN KEY (evaluator_environment_id, attempt_id)
    REFERENCES motive.orchestration_environments(id, attempt_id) ON DELETE RESTRICT
);
CREATE INDEX evaluations_attempt_created_idx ON motive.evaluations (attempt_id, created_at, id);
CREATE INDEX evaluations_project_created_idx ON motive.evaluations (project_id, created_at, id);

CREATE TABLE motive.acceptance_decisions (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES motive.projects(id) ON DELETE RESTRICT,
  work_order_id UUID NOT NULL,
  -- 007 permits one sealed worker artifact per attempt. Multiple evaluator
  -- reports can be retained, but only one immutable human decision may cover
  -- that frozen attempt/artifact.
  attempt_id UUID NOT NULL UNIQUE,
  evaluation_id UUID NOT NULL UNIQUE,
  artifact_manifest_digest TEXT NOT NULL CHECK (artifact_manifest_digest ~ '^sha256:[a-f0-9]{64}$'),
  terms_digest TEXT NOT NULL CHECK (terms_digest ~ '^sha256:[a-f0-9]{64}$'),
  evaluator_profile_digest TEXT NOT NULL CHECK (evaluator_profile_digest ~ '^sha256:[a-f0-9]{64}$'),
  raw_report_digest TEXT NOT NULL CHECK (raw_report_digest ~ '^sha256:[a-f0-9]{64}$'),
  decision motive.acceptance_decision NOT NULL,
  decided_by_actor_id TEXT NOT NULL CHECK (char_length(decided_by_actor_id) BETWEEN 1 AND 512),
  rationale TEXT CHECK (
    rationale IS NULL OR (
      octet_length(rationale) BETWEEN 1 AND 4096
      AND rationale !~ '[[:cntrl:]]'
    )
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (
    evaluation_id, project_id, work_order_id, attempt_id, artifact_manifest_digest,
    terms_digest, evaluator_profile_digest, raw_report_digest
  ) REFERENCES motive.evaluations (
    id, project_id, work_order_id, attempt_id, artifact_manifest_digest,
    terms_digest, evaluator_profile_digest, raw_report_digest
  ) ON DELETE RESTRICT
);
CREATE INDEX acceptance_decisions_project_created_idx ON motive.acceptance_decisions (project_id, created_at, id);

-- A trusted application store validates Comparator bytes and profile structure.
-- This database guard additionally prevents a direct privileged write from
-- relabeling a worker as an evaluator or substituting its provider session.
CREATE OR REPLACE FUNCTION motive.guard_evaluation_provenance()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  artifact_kind motive.orchestration_environment_kind;
  evaluator_record motive.orchestration_environments%ROWTYPE;
  frozen_profile_digest TEXT;
BEGIN
  SELECT kind INTO artifact_kind
  FROM motive.orchestration_environments
  WHERE id = NEW.artifact_environment_id AND attempt_id = NEW.attempt_id
  FOR KEY SHARE;
  IF NOT FOUND OR artifact_kind <> 'WORKER' THEN
    RAISE EXCEPTION 'evaluation artifact must be a worker environment from the exact attempt' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO evaluator_record
  FROM motive.orchestration_environments
  WHERE id = NEW.evaluator_environment_id AND attempt_id = NEW.attempt_id
  FOR KEY SHARE;
  IF NOT FOUND
    OR evaluator_record.kind <> 'EVALUATOR'
    OR evaluator_record.state NOT IN ('ACTIVE', 'STOP_REQUESTED', 'UNKNOWN', 'TERMINATED')
    OR evaluator_record.provider IS NULL
    OR evaluator_record.external_id IS NULL
    OR evaluator_record.session_id IS NULL THEN
    RAISE EXCEPTION 'evaluation requires an observed evaluator environment from the exact attempt' USING ERRCODE = '23514';
  END IF;

  IF NEW.evaluator_provider IS DISTINCT FROM evaluator_record.provider
    OR NEW.evaluator_external_id IS DISTINCT FROM evaluator_record.external_id
    OR NEW.evaluator_session_id IS DISTINCT FROM evaluator_record.session_id
    OR NEW.evaluator_lease_epoch IS DISTINCT FROM evaluator_record.lease_epoch
    OR NEW.evaluator_controller_generation IS DISTINCT FROM evaluator_record.controller_generation
    OR NEW.evaluator_profile_digest IS DISTINCT FROM evaluator_record.profile_digest THEN
    RAISE EXCEPTION 'evaluation evaluator provenance or profile does not match the immutable environment identity' USING ERRCODE = '23514';
  END IF;

  SELECT terms #>> '{evaluation,profile_digest}' INTO frozen_profile_digest
  FROM motive.work_orders
  WHERE id = NEW.work_order_id AND project_id = NEW.project_id AND terms_digest = NEW.terms_digest
  FOR KEY SHARE;
  IF frozen_profile_digest IS DISTINCT FROM NEW.evaluator_profile_digest THEN
    RAISE EXCEPTION 'evaluation profile does not match frozen work-order terms' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION motive.guard_acceptance_decision_authority()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  evaluation_outcome_value motive.evaluation_outcome;
  membership_record motive.memberships%ROWTYPE;
  human_acceptance_required TEXT;
BEGIN
  -- Locking the attempt first fences a concurrent new evaluator reservation;
  -- its admission boundary is closed by the matching after-insert trigger.
  PERFORM 1 FROM motive.attempts
  WHERE id = NEW.attempt_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'acceptance attempt no longer exists' USING ERRCODE = '23514';
  END IF;

  SELECT outcome INTO evaluation_outcome_value
  FROM motive.evaluations
  WHERE id = NEW.evaluation_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'acceptance evaluation no longer exists' USING ERRCODE = '23514';
  END IF;

  SELECT terms #>> '{evaluation,human_acceptance_required}' INTO human_acceptance_required
  FROM motive.work_orders
  WHERE id = NEW.work_order_id AND project_id = NEW.project_id AND terms_digest = NEW.terms_digest
  FOR KEY SHARE;
  IF human_acceptance_required IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'frozen work-order terms do not permit a human acceptance decision' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO membership_record
  FROM motive.memberships
  WHERE project_id = NEW.project_id AND actor_id = NEW.decided_by_actor_id
  FOR UPDATE;
  IF NOT FOUND OR membership_record.revoked_at IS NOT NULL
    OR membership_record.role NOT IN ('OWNER', 'STEWARD') THEN
    RAISE EXCEPTION 'acceptance requires a current project owner or steward' USING ERRCODE = '42501';
  END IF;

  IF NEW.decision = 'ACCEPTED' AND evaluation_outcome_value <> 'VERIFIED' THEN
    RAISE EXCEPTION 'only a VERIFIED evaluator assessment may receive ACCEPTED' USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM motive.orchestration_environments
    WHERE attempt_id = NEW.attempt_id
      AND kind IN ('WORKER', 'EVALUATOR')
      AND state NOT IN ('TERMINATED', 'ABANDONED')
  ) THEN
    RAISE EXCEPTION 'human review is unavailable until every tracked worker and evaluator is terminal or abandoned' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION motive.close_attempt_admission_after_acceptance()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A final human decision must not race a fresh environment reservation. This
  -- is an admission closure only; it neither settles money nor changes provider
  -- stop state or promotes a submission/paid result.
  UPDATE motive.attempts
  SET admission_closed_at = COALESCE(admission_closed_at, clock_timestamp()),
      updated_at = clock_timestamp()
  WHERE id = NEW.attempt_id;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION motive.append_evaluation_event_outbox()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  event_id UUID := md5('motive:evaluation-recorded:' || NEW.id::text)::uuid;
BEGIN
  INSERT INTO motive.events (id, project_id, aggregate_type, aggregate_id, event_type, payload, actor_id)
  VALUES (
    event_id, NEW.project_id, 'evaluation', NEW.id, 'evaluation.recorded',
    jsonb_build_object(
      'evaluation_id', NEW.id::text,
      'attempt_id', NEW.attempt_id::text,
      'work_order_id', NEW.work_order_id::text,
      'artifact_manifest_digest', NEW.artifact_manifest_digest,
      'terms_digest', NEW.terms_digest,
      'evaluator_profile_digest', NEW.evaluator_profile_digest,
      'raw_report_digest', NEW.raw_report_digest,
      'assessment_digest', NEW.assessment_digest,
      'outcome', NEW.outcome::text
    ),
    NULL
  );
  INSERT INTO motive.outbox (id, event_id, aggregate_type, aggregate_id, topic, dedupe_key, payload)
  VALUES (
    md5('motive:outbox:evaluation-recorded:' || NEW.id::text)::uuid,
    event_id, 'evaluation', NEW.id, 'evaluation.recorded', 'evaluation.recorded:' || NEW.id::text,
    jsonb_build_object(
      'evaluation_id', NEW.id::text,
      'attempt_id', NEW.attempt_id::text,
      'work_order_id', NEW.work_order_id::text,
      'artifact_manifest_digest', NEW.artifact_manifest_digest,
      'terms_digest', NEW.terms_digest,
      'evaluator_profile_digest', NEW.evaluator_profile_digest,
      'raw_report_digest', NEW.raw_report_digest,
      'assessment_digest', NEW.assessment_digest,
      'outcome', NEW.outcome::text
    )
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION motive.append_acceptance_decision_event_outbox()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  event_id UUID := md5('motive:acceptance-decided:' || NEW.id::text)::uuid;
BEGIN
  INSERT INTO motive.events (id, project_id, aggregate_type, aggregate_id, event_type, payload, actor_id)
  VALUES (
    event_id, NEW.project_id, 'acceptance_decision', NEW.id, 'acceptance.decided',
    jsonb_build_object(
      'decision_id', NEW.id::text,
      'evaluation_id', NEW.evaluation_id::text,
      'attempt_id', NEW.attempt_id::text,
      'work_order_id', NEW.work_order_id::text,
      'artifact_manifest_digest', NEW.artifact_manifest_digest,
      'terms_digest', NEW.terms_digest,
      'evaluator_profile_digest', NEW.evaluator_profile_digest,
      'raw_report_digest', NEW.raw_report_digest,
      'decision', NEW.decision::text
    ),
    NEW.decided_by_actor_id
  );
  INSERT INTO motive.outbox (id, event_id, aggregate_type, aggregate_id, topic, dedupe_key, payload)
  VALUES (
    md5('motive:outbox:acceptance-decided:' || NEW.id::text)::uuid,
    event_id, 'acceptance_decision', NEW.id, 'acceptance.decided', 'acceptance.decided:' || NEW.id::text,
    jsonb_build_object(
      'decision_id', NEW.id::text,
      'evaluation_id', NEW.evaluation_id::text,
      'attempt_id', NEW.attempt_id::text,
      'work_order_id', NEW.work_order_id::text,
      'artifact_manifest_digest', NEW.artifact_manifest_digest,
      'terms_digest', NEW.terms_digest,
      'evaluator_profile_digest', NEW.evaluator_profile_digest,
      'raw_report_digest', NEW.raw_report_digest,
      'decision', NEW.decision::text
    )
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER evaluations_provenance_guard
  BEFORE INSERT ON motive.evaluations
  FOR EACH ROW EXECUTE FUNCTION motive.guard_evaluation_provenance();
CREATE TRIGGER evaluations_immutable
  BEFORE UPDATE OR DELETE ON motive.evaluations
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();
CREATE TRIGGER evaluations_event_outbox
  AFTER INSERT ON motive.evaluations
  FOR EACH ROW EXECUTE FUNCTION motive.append_evaluation_event_outbox();

CREATE TRIGGER acceptance_decisions_authority_guard
  BEFORE INSERT ON motive.acceptance_decisions
  FOR EACH ROW EXECUTE FUNCTION motive.guard_acceptance_decision_authority();
CREATE TRIGGER acceptance_decisions_immutable
  BEFORE UPDATE OR DELETE ON motive.acceptance_decisions
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();
CREATE TRIGGER acceptance_decisions_close_admission
  AFTER INSERT ON motive.acceptance_decisions
  FOR EACH ROW EXECUTE FUNCTION motive.close_attempt_admission_after_acceptance();
CREATE TRIGGER acceptance_decisions_event_outbox
  AFTER INSERT ON motive.acceptance_decisions
  FOR EACH ROW EXECUTE FUNCTION motive.append_acceptance_decision_event_outbox();

REVOKE ALL ON motive.evaluations FROM PUBLIC;
REVOKE ALL ON motive.acceptance_decisions FROM PUBLIC;
