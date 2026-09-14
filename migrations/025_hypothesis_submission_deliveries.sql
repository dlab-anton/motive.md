-- Durable, operator-triggered delivery of immutable checked participation submissions.
-- Requests and successful responses are separate immutable records so an unknown
-- remote outcome can be retried with the same engine idempotency key and body.

CREATE TABLE motive.hypothesis_submission_deliveries (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES motive.projects(id) ON DELETE RESTRICT,
  scope_id UUID NOT NULL,
  source_submission_id UUID NOT NULL REFERENCES motive.participation_submission_artifacts(submission_id) ON DELETE RESTRICT,
  source_intent_id UUID NOT NULL REFERENCES motive.hypothesis_writeback_intents(id) ON DELETE RESTRICT,
  source_intent_payload_digest TEXT NOT NULL CHECK (source_intent_payload_digest ~ '^sha256:[a-f0-9]{64}$'),
  engine_actor TEXT NOT NULL CHECK (engine_actor = 'motive:project:' || project_id::text),
  engine_api_base_url TEXT NOT NULL CHECK (char_length(engine_api_base_url) BETWEEN 12 AND 2048),
  scope_configuration_digest TEXT NOT NULL CHECK (scope_configuration_digest ~ '^sha256:[a-f0-9]{64}$'),
  engine_api_version TEXT NOT NULL CHECK (char_length(engine_api_version) BETWEEN 1 AND 64),
  reviewed_contract_digest TEXT NOT NULL CHECK (reviewed_contract_digest ~ '^sha256:[a-f0-9]{64}$'),
  reviewed_contract_version TEXT NOT NULL CHECK (char_length(reviewed_contract_version) BETWEEN 1 AND 128),
  reviewed_contract_surface_digest TEXT NOT NULL CHECK (reviewed_contract_surface_digest ~ '^[a-f0-9]{64}$'),
  reviewed_implementation_digest TEXT NOT NULL CHECK (reviewed_implementation_digest ~ '^[a-f0-9]{64}$'),
  created_by_actor_id TEXT NOT NULL CHECK (char_length(created_by_actor_id) BETWEEN 1 AND 512),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(scope_id, source_submission_id),
  UNIQUE(source_intent_id),
  FOREIGN KEY(scope_id,project_id) REFERENCES motive.project_research_scopes(id,project_id) ON DELETE RESTRICT
);

CREATE TABLE motive.hypothesis_submission_delivery_operations (
  delivery_id UUID NOT NULL REFERENCES motive.hypothesis_submission_deliveries(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK (operation IN ('DRAFT_HYPOTHESIS','NEUTRAL_EVIDENCE')),
  target_hypothesis_id UUID,
  request_path TEXT NOT NULL CHECK (char_length(request_path) BETWEEN 1 AND 500),
  idempotency_key TEXT NOT NULL UNIQUE CHECK (char_length(idempotency_key) BETWEEN 1 AND 200 AND idempotency_key ~ '^[!-~]+$'),
  request_body JSONB NOT NULL CHECK (jsonb_typeof(request_body)='object'),
  request_body_digest TEXT NOT NULL CHECK (request_body_digest ~ '^sha256:[a-f0-9]{64}$'),
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(delivery_id,operation),
  CHECK ((operation='DRAFT_HYPOTHESIS' AND target_hypothesis_id IS NULL AND request_path='/api/v1/hypotheses'
      AND idempotency_key='motive-delivery:' || delivery_id::text || ':draft')
    OR (operation='NEUTRAL_EVIDENCE' AND target_hypothesis_id IS NOT NULL
      AND request_path='/api/v1/hypotheses/' || target_hypothesis_id::text || '/evidence'
      AND idempotency_key='motive-delivery:' || delivery_id::text || ':evidence'))
);

CREATE TABLE motive.hypothesis_submission_delivery_results (
  delivery_id UUID NOT NULL,
  operation TEXT NOT NULL,
  resource_id UUID NOT NULL,
  response_body JSONB NOT NULL CHECK (jsonb_typeof(response_body)='object'),
  response_digest TEXT NOT NULL CHECK (response_digest ~ '^sha256:[a-f0-9]{64}$'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(delivery_id,operation),
  FOREIGN KEY(delivery_id,operation)
    REFERENCES motive.hypothesis_submission_delivery_operations(delivery_id,operation) ON DELETE RESTRICT
);

CREATE INDEX hypothesis_submission_deliveries_project_created_idx
  ON motive.hypothesis_submission_deliveries(project_id,created_at DESC,id);
CREATE INDEX hypothesis_submission_deliveries_submission_idx
  ON motive.hypothesis_submission_deliveries(source_submission_id,id);

CREATE OR REPLACE FUNCTION motive.guard_hypothesis_submission_delivery_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM motive.hypothesis_writeback_intents intent
    JOIN motive.project_research_scopes scope ON scope.id=intent.scope_id AND scope.project_id=intent.project_id
    WHERE intent.id=NEW.source_intent_id AND intent.project_id=NEW.project_id
      AND intent.scope_id=NEW.scope_id AND intent.source_submission_id=NEW.source_submission_id
      AND intent.payload_digest=NEW.source_intent_payload_digest AND intent.engine_actor=NEW.engine_actor
      AND (intent.payload #>> '{scope,configurationDigest}')=NEW.scope_configuration_digest
      AND (intent.payload #>> '{scope,apiVersion}')=NEW.engine_api_version
      AND scope.status='CONNECTED' AND scope.configuration_digest=NEW.scope_configuration_digest
      AND scope.api_version=NEW.engine_api_version AND scope.api_base_url=NEW.engine_api_base_url
  ) THEN
    RAISE EXCEPTION 'submission delivery requires its winning immutable intent and current connected scope'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER hypothesis_submission_delivery_insert_guard
  BEFORE INSERT ON motive.hypothesis_submission_deliveries
  FOR EACH ROW EXECUTE FUNCTION motive.guard_hypothesis_submission_delivery_insert();
CREATE TRIGGER hypothesis_submission_deliveries_immutable
  BEFORE UPDATE OR DELETE ON motive.hypothesis_submission_deliveries
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();
CREATE TRIGGER hypothesis_submission_delivery_operations_immutable
  BEFORE UPDATE OR DELETE ON motive.hypothesis_submission_delivery_operations
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();
CREATE TRIGGER hypothesis_submission_delivery_results_immutable
  BEFORE UPDATE OR DELETE ON motive.hypothesis_submission_delivery_results
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();

REVOKE ALL ON motive.hypothesis_submission_deliveries FROM PUBLIC;
REVOKE ALL ON motive.hypothesis_submission_delivery_operations FROM PUBLIC;
REVOKE ALL ON motive.hypothesis_submission_delivery_results FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_hypothesis_submission_delivery_insert() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='motive_control_reader') THEN
    EXECUTE 'REVOKE ALL ON motive.hypothesis_submission_deliveries FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON motive.hypothesis_submission_delivery_operations FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON motive.hypothesis_submission_delivery_results FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_hypothesis_submission_delivery_insert() FROM motive_control_reader';
  END IF;
END $$;
