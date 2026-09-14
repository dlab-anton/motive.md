-- Direct references bind a BYO contributor's immutable claim intent and final
-- investigation to prior same-project Motive checker result. They are citations,
-- not acceptance, admission, hypothesis support, or delivery authority.

ALTER TABLE motive.participation_claim_intents
  ADD COLUMN motive_references JSONB
  CHECK (motive_references IS NULL OR jsonb_typeof(motive_references)='array');

CREATE OR REPLACE FUNCTION motive.guard_participation_motive_references()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
DECLARE reference JSONB;
DECLARE reference_ids TEXT[] := ARRAY[]::TEXT[];
DECLARE source_created_at TIMESTAMPTZ;
BEGIN
  IF NEW.motive_references IS NULL THEN RETURN NEW; END IF;
  IF jsonb_typeof(NEW.motive_references) IS DISTINCT FROM 'array'
    OR jsonb_array_length(NEW.motive_references) NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'claim intent Motive references must contain 1 to 10 items' USING ERRCODE='23514';
  END IF;
  FOR reference IN SELECT item FROM jsonb_array_elements(NEW.motive_references) item LOOP
    IF jsonb_typeof(reference) IS DISTINCT FROM 'object'
      OR ARRAY(SELECT key FROM jsonb_object_keys(reference) key ORDER BY key)
        IS DISTINCT FROM ARRAY['artifactDigest','reportDigest','submissionId']::TEXT[]
      OR jsonb_typeof(reference->'submissionId') IS DISTINCT FROM 'string'
      OR jsonb_typeof(reference->'reportDigest') IS DISTINCT FROM 'string'
      OR jsonb_typeof(reference->'artifactDigest') IS DISTINCT FROM 'string'
      OR (reference->>'submissionId') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
      OR (reference->>'reportDigest') !~ '^sha256:[a-f0-9]{64}$'
      OR (reference->>'artifactDigest') !~ '^sha256:[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'claim intent Motive reference shape is invalid' USING ERRCODE='23514';
    END IF;
    IF (reference->>'submissionId')=ANY(reference_ids) THEN
      RAISE EXCEPTION 'claim intent Motive reference submission ids must be unique' USING ERRCODE='23514';
    END IF;
    reference_ids := array_append(reference_ids,reference->>'submissionId');
    SELECT artifact.created_at INTO source_created_at
    FROM motive.participation_submission_artifacts artifact
    JOIN motive.submissions submission ON submission.id=artifact.submission_id
      AND submission.project_id=artifact.project_id
    WHERE artifact.submission_id=(reference->>'submissionId')::UUID
      AND artifact.project_id=NEW.project_id AND submission.origin='EXTERNAL'
      AND artifact.report_digest=reference->>'reportDigest'
      AND artifact.witness_digest=reference->>'artifactDigest'
    FOR KEY SHARE OF artifact,submission;
    IF source_created_at IS NULL OR source_created_at>=NEW.created_at THEN
      RAISE EXCEPTION 'claim intent Motive reference must match a prior same-project immutable result' USING ERRCODE='23514';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

CREATE TRIGGER participation_claim_intent_motive_references_guard
  BEFORE INSERT ON motive.participation_claim_intents
  FOR EACH ROW EXECUTE FUNCTION motive.guard_participation_motive_references();

CREATE OR REPLACE FUNCTION motive.guard_external_submission_motive_references()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
DECLARE declared_references JSONB;
DECLARE final_references JSONB;
DECLARE intent_found BOOLEAN := FALSE;
BEGIN
  IF NEW.origin<>'EXTERNAL' THEN RETURN NEW; END IF;
  final_references := NEW.provenance#>'{investigation,investigation,motiveReferences}';
  SELECT intent.motive_references,TRUE INTO declared_references,intent_found
  FROM motive.participation_claim_intents intent WHERE intent.claim_id=NEW.claim_id FOR KEY SHARE;
  IF final_references IS NOT NULL OR declared_references IS NOT NULL THEN
    IF NOT intent_found OR final_references IS DISTINCT FROM declared_references THEN
      RAISE EXCEPTION 'external submission Motive references must equal its immutable claim intent' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER submission_motive_references_guard
  BEFORE INSERT ON motive.submissions
  FOR EACH ROW EXECUTE FUNCTION motive.guard_external_submission_motive_references();

REVOKE ALL ON FUNCTION motive.guard_participation_motive_references() FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_external_submission_motive_references() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_participation_motive_references() FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_external_submission_motive_references() FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_participation_motive_references() FROM authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_external_submission_motive_references() FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='motive_control_reader') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_participation_motive_references() FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_external_submission_motive_references() FROM motive_control_reader';
  END IF;
END $$;
