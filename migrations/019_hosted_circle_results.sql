-- Exact data-only circle evaluation and independent project review. The
-- existing evaluations table remains reserved for Lean comparator evidence.

CREATE TYPE motive.hosted_circle_result_status AS ENUM ('VALID', 'REJECTED');
CREATE TYPE motive.hosted_circle_review_decision AS ENUM ('ACCEPTED', 'REJECTED');

CREATE TABLE motive.hosted_circle_results (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES motive.projects(id) ON DELETE RESTRICT,
  work_order_id UUID NOT NULL,
  attempt_id UUID NOT NULL UNIQUE,
  artifact_environment_id UUID NOT NULL,
  artifact_manifest_digest TEXT NOT NULL CHECK (artifact_manifest_digest ~ '^sha256:[a-f0-9]{64}$'),
  artifact_receipt_id TEXT NOT NULL CHECK (char_length(artifact_receipt_id) BETWEEN 1 AND 512),
  candidate_relative_path TEXT NOT NULL CHECK (candidate_relative_path = 'candidate.json'),
  candidate_media_type TEXT NOT NULL CHECK (candidate_media_type = 'application/json'),
  candidate_object_key TEXT NOT NULL CHECK (char_length(candidate_object_key) BETWEEN 1 AND 2048),
  candidate_digest TEXT NOT NULL CHECK (candidate_digest ~ '^sha256:[a-f0-9]{64}$'),
  terms_digest TEXT NOT NULL CHECK (terms_digest ~ '^sha256:[a-f0-9]{64}$'),
  input_digest TEXT NOT NULL CHECK (input_digest ~ '^sha256:[a-f0-9]{64}$'),
  inference_profile_digest TEXT NOT NULL CHECK (inference_profile_digest ~ '^sha256:[a-f0-9]{64}$'),
  evaluation_profile_digest TEXT NOT NULL CHECK (evaluation_profile_digest ~ '^sha256:[a-f0-9]{64}$'),
  model_id TEXT NOT NULL CHECK (char_length(model_id) BETWEEN 3 AND 256),
  research_actor_id TEXT NOT NULL CHECK (char_length(research_actor_id) BETWEEN 1 AND 512),
  report_bytes BYTEA NOT NULL CHECK (octet_length(report_bytes) BETWEEN 1 AND 262144),
  report_digest TEXT NOT NULL CHECK (report_digest ~ '^sha256:[a-f0-9]{64}$'),
  report_body JSONB NOT NULL CHECK (jsonb_typeof(report_body) = 'object'),
  status motive.hosted_circle_result_status NOT NULL,
  exact_score TEXT CHECK (exact_score IS NULL OR exact_score ~ '^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$'),
  exceeds_reference BOOLEAN,
  artifact_available BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (work_order_id, project_id, terms_digest)
    REFERENCES motive.work_orders(id, project_id, terms_digest) ON DELETE RESTRICT,
  FOREIGN KEY (attempt_id, work_order_id, project_id, terms_digest)
    REFERENCES motive.attempts(id, work_order_id, project_id, terms_digest) ON DELETE RESTRICT,
  FOREIGN KEY (artifact_environment_id, attempt_id, artifact_manifest_digest, artifact_receipt_id)
    REFERENCES motive.orchestration_artifact_seals(environment_id, attempt_id, manifest_digest, receipt_id) ON DELETE RESTRICT,
  FOREIGN KEY (attempt_id) REFERENCES motive.provider_budget_activations(attempt_id) ON DELETE RESTRICT,
  CHECK ((report_body ->> 'format') IS NOT DISTINCT FROM 'motive.csqv.evaluator-report/0.1'),
  CHECK ((report_body ->> 'outcome') IS NOT DISTINCT FROM status::text),
  CHECK ((report_body #>> '{binding,project_id}') IS NOT DISTINCT FROM project_id::text),
  CHECK ((report_body #>> '{binding,work_order_id}') IS NOT DISTINCT FROM work_order_id::text),
  CHECK ((report_body #>> '{binding,attempt_id}') IS NOT DISTINCT FROM attempt_id::text),
  CHECK ((report_body #>> '{binding,worker_environment_id}') IS NOT DISTINCT FROM artifact_environment_id::text),
  CHECK ((report_body #>> '{binding,terms_digest}') IS NOT DISTINCT FROM terms_digest),
  CHECK ((report_body #>> '{binding,input_digest}') IS NOT DISTINCT FROM input_digest),
  CHECK ((report_body #>> '{binding,inference_profile_digest}') IS NOT DISTINCT FROM inference_profile_digest),
  CHECK ((report_body #>> '{binding,artifact_manifest_digest}') IS NOT DISTINCT FROM artifact_manifest_digest),
  CHECK ((report_body #>> '{binding,candidate_digest}') IS NOT DISTINCT FROM candidate_digest),
  CHECK ((report_body #>> '{binding,evaluation_profile_digest}') IS NOT DISTINCT FROM evaluation_profile_digest),
  CHECK ((report_body -> 'human_acceptance') IS NOT DISTINCT FROM '{"status":"PENDING","decision_id":null}'::jsonb),
  CHECK (
    (status = 'VALID'
      AND (report_body #>> '{result,ok}') = 'true'
      AND exact_score IS NOT NULL AND exceeds_reference IS NOT NULL
      AND (report_body #>> '{result,report,objective,exact_decimal}') IS NOT DISTINCT FROM exact_score
      AND exceeds_reference IS NOT DISTINCT FROM ((report_body #>> '{result,report,objective,versus_frozen_reference_5_29109518547430697}') = 'greater'))
    OR
    (status = 'REJECTED'
      AND (report_body #>> '{result,ok}') = 'false'
      AND exact_score IS NULL AND exceeds_reference IS NULL)
  ),
  CHECK (artifact_available IS NOT DISTINCT FROM (
    status = 'VALID' OR (report_body #>> '{result,error,code}') IN ('NONPOSITIVE_RADIUS','OUT_OF_BOUNDS','OVERLAP')
  ))
);
CREATE INDEX hosted_circle_results_project_created_idx
  ON motive.hosted_circle_results(project_id, created_at DESC, id);

CREATE TABLE motive.hosted_circle_result_reviews (
  id UUID PRIMARY KEY,
  result_id UUID NOT NULL UNIQUE REFERENCES motive.hosted_circle_results(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES motive.projects(id) ON DELETE RESTRICT,
  decision motive.hosted_circle_review_decision NOT NULL,
  reviewer_actor_id TEXT NOT NULL CHECK (char_length(reviewer_actor_id) BETWEEN 1 AND 512),
  rationale TEXT NOT NULL CHECK (octet_length(rationale) BETWEEN 1 AND 4096 AND rationale !~ '[[:cntrl:]]'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX hosted_circle_reviews_project_created_idx
  ON motive.hosted_circle_result_reviews(project_id, created_at DESC, result_id);

CREATE OR REPLACE FUNCTION motive.guard_hosted_circle_result()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, motive AS $$
DECLARE attempt_record motive.attempts%ROWTYPE;
DECLARE work_record motive.work_orders%ROWTYPE;
DECLARE seal_record motive.orchestration_artifact_seals%ROWTYPE;
DECLARE activation_record motive.provider_budget_activations%ROWTYPE;
DECLARE budget_record motive.provider_project_budgets%ROWTYPE;
DECLARE expected_key TEXT;
BEGIN
  SELECT * INTO attempt_record FROM motive.attempts WHERE id=NEW.attempt_id FOR KEY SHARE;
  SELECT * INTO work_record FROM motive.work_orders WHERE id=NEW.work_order_id FOR KEY SHARE;
  SELECT * INTO seal_record FROM motive.orchestration_artifact_seals
    WHERE environment_id=NEW.artifact_environment_id AND attempt_id=NEW.attempt_id FOR KEY SHARE;
  SELECT * INTO activation_record FROM motive.provider_budget_activations WHERE attempt_id=NEW.attempt_id FOR KEY SHARE;
  SELECT * INTO budget_record FROM motive.provider_project_budgets WHERE id=activation_record.budget_id FOR KEY SHARE;
  expected_key := 'projects/' || NEW.project_id::text || '/attempts/' || NEW.attempt_id::text
    || '/seals/' || NEW.artifact_environment_id::text
    || '/files/a2ce32b4f23bbd97594d26707bcfb2c7d0090893f7ead7edf49394e00a7111da';
  IF attempt_record.id IS NULL OR work_record.id IS NULL OR seal_record.environment_id IS NULL
    OR activation_record.budget_id IS NULL OR budget_record.id IS NULL
    OR attempt_record.project_id IS DISTINCT FROM NEW.project_id
    OR attempt_record.work_order_id IS DISTINCT FROM NEW.work_order_id
    OR attempt_record.terms_digest IS DISTINCT FROM NEW.terms_digest
    OR attempt_record.input_digest IS DISTINCT FROM NEW.input_digest
    OR attempt_record.profile_digest IS DISTINCT FROM NEW.inference_profile_digest
    OR work_record.project_id IS DISTINCT FROM NEW.project_id
    OR work_record.terms_digest IS DISTINCT FROM NEW.terms_digest
    OR (work_record.terms #>> '{evaluation,profile_digest}') IS DISTINCT FROM NEW.evaluation_profile_digest
    OR (work_record.terms #>> '{evaluation,human_acceptance_required}') IS DISTINCT FROM 'true'
    OR (work_record.terms #>> '{hosted,enabled}') IS DISTINCT FROM 'true'
    OR (work_record.terms #>> '{hosted,inference,profile_digest}') IS DISTINCT FROM NEW.inference_profile_digest
    OR seal_record.status <> 'SEALED' OR seal_record.manifest_digest IS DISTINCT FROM NEW.artifact_manifest_digest
    OR seal_record.receipt_id IS DISTINCT FROM NEW.artifact_receipt_id
    OR activation_record.profile_digest IS DISTINCT FROM NEW.inference_profile_digest
    OR activation_record.beneficiary_actor_id IS DISTINCT FROM NEW.research_actor_id
    OR budget_record.model_id IS DISTINCT FROM NEW.model_id
    OR budget_record.work_order_id IS DISTINCT FROM NEW.work_order_id
    OR NEW.candidate_object_key IS DISTINCT FROM expected_key
    OR NOT EXISTS (SELECT 1 FROM motive.orchestration_environments environment
      WHERE environment.id=NEW.artifact_environment_id AND environment.attempt_id=NEW.attempt_id
        AND environment.kind='WORKER' AND environment.state='TERMINATED')
    OR convert_from(NEW.report_bytes, 'UTF8')::jsonb IS DISTINCT FROM NEW.report_body
  THEN
    RAISE EXCEPTION 'hosted circle result does not match its immutable attempt, seal, profile, model and report'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION motive.guard_hosted_circle_review()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, motive AS $$
DECLARE result_record motive.hosted_circle_results%ROWTYPE;
BEGIN
  SELECT * INTO result_record FROM motive.hosted_circle_results WHERE id=NEW.result_id FOR KEY SHARE;
  IF result_record.id IS NULL OR result_record.project_id IS DISTINCT FROM NEW.project_id
    OR result_record.research_actor_id IS NOT DISTINCT FROM NEW.reviewer_actor_id
    OR NOT EXISTS (SELECT 1 FROM motive.memberships membership
      WHERE membership.project_id=NEW.project_id AND membership.actor_id=NEW.reviewer_actor_id
        AND membership.revoked_at IS NULL AND membership.role IN ('OWNER','STEWARD'))
    OR (NEW.decision='ACCEPTED' AND result_record.status <> 'VALID')
    OR EXISTS (SELECT 1 FROM motive.orchestration_environments environment
      WHERE environment.attempt_id=result_record.attempt_id AND environment.kind IN ('WORKER','EVALUATOR')
        AND environment.state NOT IN ('TERMINATED','ABANDONED'))
  THEN
    RAISE EXCEPTION 'hosted circle review requires an independent current owner or steward and terminal execution'
      USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION motive.append_hosted_circle_result_event()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, motive AS $$
DECLARE event_id UUID := md5('motive:hosted-circle-result:' || NEW.id::text)::uuid;
BEGIN
  INSERT INTO motive.events(id,project_id,aggregate_type,aggregate_id,event_type,payload,actor_id)
  VALUES(event_id,NEW.project_id,'hosted_circle_result',NEW.id,'hosted_circle.result_recorded',
    jsonb_build_object('result_id',NEW.id::text,'attempt_id',NEW.attempt_id::text,'status',NEW.status::text,
      'model_id',NEW.model_id,'report_digest',NEW.report_digest,'candidate_digest',NEW.candidate_digest,
      'exact_score',NEW.exact_score,'exceeds_reference',NEW.exceeds_reference),NULL);
  INSERT INTO motive.outbox(id,event_id,aggregate_type,aggregate_id,topic,dedupe_key,payload)
  VALUES(md5('motive:outbox:hosted-circle-result:' || NEW.id::text)::uuid,event_id,'hosted_circle_result',NEW.id,
    'hosted_circle.result_recorded','hosted_circle.result_recorded:' || NEW.id::text,
    jsonb_build_object('result_id',NEW.id::text,'attempt_id',NEW.attempt_id::text,'status',NEW.status::text,
      'model_id',NEW.model_id,'report_digest',NEW.report_digest));
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION motive.append_hosted_circle_review_event()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, motive AS $$
DECLARE event_id UUID := md5('motive:hosted-circle-review:' || NEW.id::text)::uuid;
BEGIN
  INSERT INTO motive.events(id,project_id,aggregate_type,aggregate_id,event_type,payload,actor_id)
  VALUES(event_id,NEW.project_id,'hosted_circle_result_review',NEW.id,'hosted_circle.review_decided',
    jsonb_build_object('review_id',NEW.id::text,'result_id',NEW.result_id::text,'decision',NEW.decision::text),NEW.reviewer_actor_id);
  INSERT INTO motive.outbox(id,event_id,aggregate_type,aggregate_id,topic,dedupe_key,payload)
  VALUES(md5('motive:outbox:hosted-circle-review:' || NEW.id::text)::uuid,event_id,'hosted_circle_result_review',NEW.id,
    'hosted_circle.review_decided','hosted_circle.review_decided:' || NEW.id::text,
    jsonb_build_object('review_id',NEW.id::text,'result_id',NEW.result_id::text,'decision',NEW.decision::text));
  RETURN NEW;
END $$;

CREATE TRIGGER hosted_circle_results_guard BEFORE INSERT ON motive.hosted_circle_results
  FOR EACH ROW EXECUTE FUNCTION motive.guard_hosted_circle_result();
CREATE TRIGGER hosted_circle_results_immutable BEFORE UPDATE OR DELETE ON motive.hosted_circle_results
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();
CREATE TRIGGER hosted_circle_results_event AFTER INSERT ON motive.hosted_circle_results
  FOR EACH ROW EXECUTE FUNCTION motive.append_hosted_circle_result_event();
CREATE TRIGGER hosted_circle_reviews_guard BEFORE INSERT ON motive.hosted_circle_result_reviews
  FOR EACH ROW EXECUTE FUNCTION motive.guard_hosted_circle_review();
CREATE TRIGGER hosted_circle_reviews_immutable BEFORE UPDATE OR DELETE ON motive.hosted_circle_result_reviews
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();
CREATE TRIGGER hosted_circle_reviews_event AFTER INSERT ON motive.hosted_circle_result_reviews
  FOR EACH ROW EXECUTE FUNCTION motive.append_hosted_circle_review_event();

REVOKE ALL ON motive.hosted_circle_results FROM PUBLIC;
REVOKE ALL ON motive.hosted_circle_result_reviews FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_hosted_circle_result() FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_hosted_circle_review() FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.append_hosted_circle_result_event() FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.append_hosted_circle_review_event() FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='motive_control_reader') THEN
    EXECUTE 'REVOKE ALL ON motive.hosted_circle_results FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON motive.hosted_circle_result_reviews FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_hosted_circle_result() FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_hosted_circle_review() FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.append_hosted_circle_result_event() FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.append_hosted_circle_review_event() FROM motive_control_reader';
  END IF;
END $$;
