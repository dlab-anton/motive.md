-- Immutable Motive-side preparation for a future Hypothesis write interface.
-- This table is an intent ledger only: no row means or claims remote delivery.

CREATE TABLE motive.hypothesis_writeback_intents (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES motive.projects(id) ON DELETE RESTRICT,
  scope_id UUID NOT NULL,
  source_submission_id UUID NOT NULL REFERENCES motive.participation_submission_artifacts(submission_id) ON DELETE RESTRICT,
  prepared_by_actor_id TEXT NOT NULL CHECK (char_length(prepared_by_actor_id) BETWEEN 1 AND 512),
  idempotency_key TEXT NOT NULL CHECK (
    char_length(idempotency_key) BETWEEN 8 AND 200
    AND idempotency_key ~ '^[A-Za-z0-9._~-]+$'
  ),
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_digest TEXT NOT NULL CHECK (payload_digest ~ '^sha256:[a-f0-9]{64}$'),
  engine_actor TEXT NOT NULL CHECK (engine_actor = 'motive:project:' || project_id::text),
  disposition TEXT NOT NULL CHECK (disposition = 'PROPOSED_UNREVIEWED'),
  state TEXT NOT NULL CHECK (state = 'ENGINE_WRITE_UNAVAILABLE'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (prepared_by_actor_id, idempotency_key),
  FOREIGN KEY (scope_id, project_id)
    REFERENCES motive.project_research_scopes(id, project_id) ON DELETE RESTRICT,
  CHECK ((payload ->> 'format') IS NOT DISTINCT FROM 'motive.hypothesis-writeback-preparation/0.1'),
  CHECK ((payload ->> 'disposition') IS NOT DISTINCT FROM disposition),
  CHECK ((payload ->> 'state') IS NOT DISTINCT FROM state),
  CHECK ((payload #>> '{scope,scopeId}') IS NOT DISTINCT FROM scope_id::text),
  CHECK ((payload #>> '{scope,projectId}') IS NOT DISTINCT FROM project_id::text),
  CHECK ((payload #>> '{attribution,engineActor}') IS NOT DISTINCT FROM engine_actor),
  CHECK ((payload #>> '{source,submission,id}') IS NOT DISTINCT FROM source_submission_id::text),
  CHECK ((payload #>> '{assessment,hypothesisSupport}') IS NOT DISTINCT FROM 'UNASSESSED'),
  CHECK ((payload #>> '{assessment,conclusionApproval}') IS NOT DISTINCT FROM 'UNASSESSED')
);

CREATE INDEX hypothesis_writeback_intents_project_created_idx
  ON motive.hypothesis_writeback_intents(project_id, created_at DESC, id);
CREATE INDEX hypothesis_writeback_intents_submission_idx
  ON motive.hypothesis_writeback_intents(source_submission_id, created_at DESC, id);

CREATE OR REPLACE FUNCTION motive.guard_hypothesis_writeback_intent_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM motive.project_research_scopes scope
    WHERE scope.id=NEW.scope_id AND scope.project_id=NEW.project_id AND scope.status='CONNECTED'
  ) OR NOT EXISTS (
    SELECT 1
    FROM motive.submissions submission
    JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=submission.id
    WHERE submission.id=NEW.source_submission_id AND submission.project_id=NEW.project_id
      AND artifact.project_id=NEW.project_id
  ) THEN
    RAISE EXCEPTION 'writeback intent requires the connected project scope and its immutable submission artifact'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER hypothesis_writeback_intents_insert_guard
  BEFORE INSERT ON motive.hypothesis_writeback_intents
  FOR EACH ROW EXECUTE FUNCTION motive.guard_hypothesis_writeback_intent_insert();
CREATE TRIGGER hypothesis_writeback_intents_immutable
  BEFORE UPDATE OR DELETE ON motive.hypothesis_writeback_intents
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();

REVOKE ALL ON motive.hypothesis_writeback_intents FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_hypothesis_writeback_intent_insert() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='motive_control_reader') THEN
    EXECUTE 'REVOKE ALL ON motive.hypothesis_writeback_intents FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_hypothesis_writeback_intent_insert() FROM motive_control_reader';
  END IF;
END $$;
