-- Immutable agent-declared learning notes retained separately from exact
-- numerical evaluation and independent human acceptance.

CREATE TYPE motive.hosted_investigation_status AS ENUM ('VALID', 'INVALID', 'NOT_PROVIDED');

CREATE UNIQUE INDEX hosted_circle_results_id_project_unique ON motive.hosted_circle_results(id, project_id);

CREATE TABLE motive.hosted_circle_investigations (
  result_id UUID PRIMARY KEY REFERENCES motive.hosted_circle_results(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES motive.projects(id) ON DELETE RESTRICT,
  attempt_id UUID NOT NULL UNIQUE,
  artifact_environment_id UUID NOT NULL,
  artifact_manifest_digest TEXT NOT NULL CHECK (artifact_manifest_digest ~ '^sha256:[a-f0-9]{64}$'),
  investigation_relative_path TEXT CHECK (investigation_relative_path IS NULL OR investigation_relative_path='investigation.json'),
  investigation_media_type TEXT CHECK (investigation_media_type IS NULL OR investigation_media_type='application/json'),
  investigation_object_key TEXT CHECK (investigation_object_key IS NULL OR char_length(investigation_object_key) BETWEEN 1 AND 2048),
  investigation_digest TEXT CHECK (investigation_digest IS NULL OR investigation_digest ~ '^sha256:[a-f0-9]{64}$'),
  investigation_bytes BYTEA CHECK (investigation_bytes IS NULL OR octet_length(investigation_bytes) BETWEEN 1 AND 16384),
  investigation_body JSONB CHECK (investigation_body IS NULL OR jsonb_typeof(investigation_body)='object'),
  status motive.hosted_investigation_status NOT NULL,
  validation_code TEXT NOT NULL CHECK (validation_code IN ('VALID','NOT_PROVIDED','INVALID_STRUCTURE','INVALID_REFERENCE')),
  model_id TEXT NOT NULL CHECK (char_length(model_id) BETWEEN 3 AND 256),
  inference_profile_digest TEXT NOT NULL CHECK (inference_profile_digest ~ '^sha256:[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (result_id, project_id) REFERENCES motive.hosted_circle_results(id, project_id) ON DELETE RESTRICT,
  FOREIGN KEY (attempt_id) REFERENCES motive.provider_budget_activations(attempt_id) ON DELETE RESTRICT,
  CHECK (
    (status='NOT_PROVIDED' AND validation_code='NOT_PROVIDED'
      AND investigation_relative_path IS NULL AND investigation_media_type IS NULL AND investigation_object_key IS NULL
      AND investigation_digest IS NULL AND investigation_bytes IS NULL AND investigation_body IS NULL)
    OR
    (status='VALID' AND validation_code='VALID'
      AND investigation_relative_path IS NOT DISTINCT FROM 'investigation.json'
      AND investigation_media_type IS NOT DISTINCT FROM 'application/json'
      AND investigation_object_key IS NOT NULL AND investigation_digest IS NOT NULL AND investigation_bytes IS NOT NULL
      AND investigation_body IS NOT NULL
      AND (investigation_body ->> 'format') IS NOT DISTINCT FROM 'motive.investigation.v1')
    OR
    (status='INVALID' AND validation_code IN ('INVALID_STRUCTURE','INVALID_REFERENCE')
      AND investigation_relative_path IS NOT DISTINCT FROM 'investigation.json'
      AND investigation_media_type IS NOT DISTINCT FROM 'application/json'
      AND investigation_object_key IS NOT NULL AND investigation_digest IS NOT NULL AND investigation_bytes IS NOT NULL
      AND investigation_body IS NULL)
  )
);

CREATE INDEX hosted_circle_investigations_project_created_idx
  ON motive.hosted_circle_investigations(project_id, created_at DESC, result_id);

CREATE OR REPLACE FUNCTION motive.guard_hosted_circle_investigation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
DECLARE result_record motive.hosted_circle_results%ROWTYPE;
DECLARE expected_key TEXT;
BEGIN
  SELECT * INTO result_record FROM motive.hosted_circle_results WHERE id=NEW.result_id FOR KEY SHARE;
  expected_key := 'projects/' || NEW.project_id::text || '/attempts/' || NEW.attempt_id::text
    || '/seals/' || NEW.artifact_environment_id::text
    || '/files/d10feb13d4b19c689631615a1cbeac981392022f29fca8cb721eb9e006d34570';
  IF result_record.id IS NULL OR result_record.project_id IS DISTINCT FROM NEW.project_id
    OR result_record.attempt_id IS DISTINCT FROM NEW.attempt_id
    OR result_record.artifact_environment_id IS DISTINCT FROM NEW.artifact_environment_id
    OR result_record.artifact_manifest_digest IS DISTINCT FROM NEW.artifact_manifest_digest
    OR result_record.model_id IS DISTINCT FROM NEW.model_id
    OR result_record.inference_profile_digest IS DISTINCT FROM NEW.inference_profile_digest
    OR (NEW.status <> 'NOT_PROVIDED' AND NEW.investigation_object_key IS DISTINCT FROM expected_key)
    OR (NEW.investigation_bytes IS NOT NULL
      AND encode(sha256(NEW.investigation_bytes),'hex') IS DISTINCT FROM substring(NEW.investigation_digest FROM 8))
    OR (NEW.investigation_body IS NOT NULL
      AND convert_from(NEW.investigation_bytes,'UTF8')::jsonb IS DISTINCT FROM NEW.investigation_body)
  THEN
    RAISE EXCEPTION 'hosted investigation does not match its immutable result, seal, model and bytes'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION motive.append_hosted_circle_investigation_event()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
DECLARE event_id UUID := md5('motive:hosted-circle-investigation:' || NEW.result_id::text)::uuid;
BEGIN
  INSERT INTO motive.events(id,project_id,aggregate_type,aggregate_id,event_type,payload,actor_id)
  VALUES(event_id,NEW.project_id,'hosted_circle_investigation',NEW.result_id,'hosted_circle.investigation_recorded',
    jsonb_build_object('result_id',NEW.result_id::text,'attempt_id',NEW.attempt_id::text,'status',NEW.status::text,
      'validation_code',NEW.validation_code,'investigation_digest',NEW.investigation_digest),NULL);
  RETURN NEW;
END $$;

CREATE TRIGGER hosted_circle_investigations_guard BEFORE INSERT ON motive.hosted_circle_investigations
  FOR EACH ROW EXECUTE FUNCTION motive.guard_hosted_circle_investigation();
CREATE TRIGGER hosted_circle_investigations_immutable BEFORE UPDATE OR DELETE ON motive.hosted_circle_investigations
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();
CREATE TRIGGER hosted_circle_investigations_event AFTER INSERT ON motive.hosted_circle_investigations
  FOR EACH ROW EXECUTE FUNCTION motive.append_hosted_circle_investigation_event();

-- Results retained before the learning collector existed remain explicit.
INSERT INTO motive.hosted_circle_investigations
  (result_id,project_id,attempt_id,artifact_environment_id,artifact_manifest_digest,status,validation_code,model_id,inference_profile_digest)
SELECT id,project_id,attempt_id,artifact_environment_id,artifact_manifest_digest,'NOT_PROVIDED','NOT_PROVIDED',model_id,inference_profile_digest
FROM motive.hosted_circle_results;

REVOKE ALL ON motive.hosted_circle_investigations FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_hosted_circle_investigation() FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.append_hosted_circle_investigation_event() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='motive_control_reader') THEN
    EXECUTE 'REVOKE ALL ON motive.hosted_circle_investigations FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_hosted_circle_investigation() FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.append_hosted_circle_investigation_event() FROM motive_control_reader';
  END IF;
END $$;
