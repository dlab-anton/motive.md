-- Optional exact protocol fingerprints help contributors find declared work with
-- the same opaque procedure and inputs. Matches are advisory and never reserve
-- an idea or establish geometric or scientific equivalence.

ALTER TABLE motive.participation_claim_intents
  ADD COLUMN experiment_protocol JSONB,
  ADD COLUMN protocol_fingerprint TEXT,
  ADD CONSTRAINT participation_claim_intent_protocol_pair
    CHECK ((experiment_protocol IS NULL) = (protocol_fingerprint IS NULL)),
  ADD CONSTRAINT participation_claim_intent_protocol_fingerprint_shape
    CHECK (protocol_fingerprint IS NULL OR protocol_fingerprint ~ '^sha256:[a-f0-9]{64}$');

CREATE INDEX participation_claim_intents_protocol_matches_idx
  ON motive.participation_claim_intents
    (project_id,work_order_id,work_order_revision,protocol_fingerprint,created_at DESC,claim_id DESC)
  WHERE protocol_fingerprint IS NOT NULL;

CREATE OR REPLACE FUNCTION motive.guard_participation_experiment_protocol()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
DECLARE item JSONB;
DECLARE prior_name TEXT;
DECLARE item_name TEXT;
DECLARE item_value TEXT;
DECLARE compact_inputs TEXT;
DECLARE compact_protocol TEXT;
BEGIN
  IF NEW.experiment_protocol IS NULL THEN RETURN NEW; END IF;
  IF jsonb_typeof(NEW.experiment_protocol) IS DISTINCT FROM 'object'
    OR ARRAY(SELECT key FROM jsonb_object_keys(NEW.experiment_protocol) key ORDER BY key)
      IS DISTINCT FROM ARRAY['format','inputs','procedure','purpose']::TEXT[]
    OR jsonb_typeof(NEW.experiment_protocol->'format') IS DISTINCT FROM 'string'
    OR NEW.experiment_protocol->>'format' IS DISTINCT FROM 'motive.experiment-protocol.v1'
    OR jsonb_typeof(NEW.experiment_protocol->'purpose') IS DISTINCT FROM 'string'
    OR NEW.experiment_protocol->>'purpose' IS NULL
    OR NEW.experiment_protocol->>'purpose' NOT IN ('EXPLORATORY','REPLICATION','CONTROL')
    OR jsonb_typeof(NEW.experiment_protocol->'procedure') IS DISTINCT FROM 'string'
    OR char_length(NEW.experiment_protocol->>'procedure') NOT BETWEEN 1 AND 240
    OR NEW.experiment_protocol->>'procedure' <> btrim(NEW.experiment_protocol->>'procedure')
    OR NEW.experiment_protocol->>'procedure' COLLATE "C" ~
      ('[' || chr(1) || '-' || chr(31) || chr(127) || '-' || chr(159) || chr(8232) || chr(8233) || ']')
    OR ascii(left(NEW.experiment_protocol->>'procedure',1)) IN
      (32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8239,8287,12288,65279)
    OR ascii(right(NEW.experiment_protocol->>'procedure',1)) IN
      (32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8239,8287,12288,65279)
    OR jsonb_typeof(NEW.experiment_protocol->'inputs') IS DISTINCT FROM 'array'
    OR jsonb_array_length(NEW.experiment_protocol->'inputs') NOT BETWEEN 1 AND 32 THEN
    RAISE EXCEPTION 'claim intent experiment protocol is invalid' USING ERRCODE='23514';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(NEW.experiment_protocol->'inputs') LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object'
      OR ARRAY(SELECT key FROM jsonb_object_keys(item) key ORDER BY key)
        IS DISTINCT FROM ARRAY['name','value']::TEXT[]
      OR jsonb_typeof(item->'name') IS DISTINCT FROM 'string'
      OR jsonb_typeof(item->'value') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'claim intent experiment protocol input is invalid' USING ERRCODE='23514';
    END IF;
    item_name := item->>'name'; item_value := item->>'value';
    IF item_name COLLATE "C" !~ '^[a-z][a-z0-9_.-]{0,63}$'
      OR (prior_name IS NOT NULL AND item_name COLLATE "C" <= prior_name COLLATE "C")
      OR char_length(item_value) NOT BETWEEN 1 AND 512
      OR item_value <> btrim(item_value)
      OR item_value COLLATE "C" ~
        ('[' || chr(1) || '-' || chr(31) || chr(127) || '-' || chr(159) || chr(8232) || chr(8233) || ']')
      OR ascii(left(item_value,1)) IN
        (32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8239,8287,12288,65279)
      OR ascii(right(item_value,1)) IN
        (32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8239,8287,12288,65279) THEN
      RAISE EXCEPTION 'claim intent experiment protocol input is invalid or noncanonical' USING ERRCODE='23514';
    END IF;
    prior_name := item_name;
  END LOOP;
  SELECT string_agg('{"name":' || to_jsonb(entry->>'name')::TEXT || ',"value":'
      || to_jsonb(entry->>'value')::TEXT || '}',',' ORDER BY ordinal)
    INTO compact_inputs
    FROM jsonb_array_elements(NEW.experiment_protocol->'inputs') WITH ORDINALITY AS listed(entry,ordinal);
  compact_protocol := '{"format":' || to_jsonb(NEW.experiment_protocol->>'format')::TEXT
    || ',"procedure":' || to_jsonb(NEW.experiment_protocol->>'procedure')::TEXT
    || ',"inputs":[' || compact_inputs || '],"purpose":'
    || to_jsonb(NEW.experiment_protocol->>'purpose')::TEXT || '}';
  IF octet_length(compact_protocol) > 4096 THEN
    RAISE EXCEPTION 'claim intent experiment protocol exceeds 4096 UTF-8 bytes' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER participation_claim_intent_experiment_protocol_guard
  BEFORE INSERT ON motive.participation_claim_intents
  FOR EACH ROW EXECUTE FUNCTION motive.guard_participation_experiment_protocol();

CREATE OR REPLACE FUNCTION motive.guard_external_submission_experiment_protocol()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
DECLARE declared_protocol JSONB;
DECLARE final_protocol JSONB;
DECLARE intent_found BOOLEAN := FALSE;
BEGIN
  IF NEW.origin <> 'EXTERNAL' THEN RETURN NEW; END IF;
  final_protocol := NEW.provenance#>'{investigation,investigation,experimentProtocol}';
  SELECT intent.experiment_protocol,TRUE INTO declared_protocol,intent_found
  FROM motive.participation_claim_intents intent WHERE intent.claim_id=NEW.claim_id FOR KEY SHARE;
  IF final_protocol IS NOT NULL OR declared_protocol IS NOT NULL THEN
    IF NOT intent_found OR final_protocol IS DISTINCT FROM declared_protocol THEN
      RAISE EXCEPTION 'external submission experiment protocol must equal its immutable claim intent' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER submission_experiment_protocol_guard
  BEFORE INSERT ON motive.submissions
  FOR EACH ROW EXECUTE FUNCTION motive.guard_external_submission_experiment_protocol();

CREATE OR REPLACE FUNCTION motive.guard_finding_review_experiment_protocol()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
DECLARE declared_protocol JSONB;
DECLARE packaged_protocol JSONB;
DECLARE intent_found BOOLEAN := FALSE;
BEGIN
  SELECT intent.experiment_protocol,TRUE INTO declared_protocol,intent_found
  FROM motive.participation_claim_intents intent
  WHERE intent.claim_id=(NEW.review_package#>>'{claim,id}')::UUID
    AND intent.project_id=NEW.project_id FOR KEY SHARE;
  packaged_protocol := NEW.review_package#>'{source,declaredIntent,experimentProtocol}';
  IF intent_found THEN
    IF declared_protocol IS NULL THEN
      IF packaged_protocol IS NOT NULL THEN
        RAISE EXCEPTION 'historical finding review package cannot add an experiment protocol' USING ERRCODE='23514';
      END IF;
    ELSIF packaged_protocol IS DISTINCT FROM declared_protocol THEN
      RAISE EXCEPTION 'finding review package experiment protocol must equal its immutable claim intent' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER finding_review_experiment_protocol_guard
  BEFORE INSERT ON motive.finding_review_decisions
  FOR EACH ROW EXECUTE FUNCTION motive.guard_finding_review_experiment_protocol();

REVOKE ALL ON FUNCTION motive.guard_participation_experiment_protocol() FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_external_submission_experiment_protocol() FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_finding_review_experiment_protocol() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_participation_experiment_protocol() FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_external_submission_experiment_protocol() FROM anon';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_finding_review_experiment_protocol() FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_participation_experiment_protocol() FROM authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_external_submission_experiment_protocol() FROM authenticated';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_finding_review_experiment_protocol() FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='motive_control_reader') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_participation_experiment_protocol() FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_external_submission_experiment_protocol() FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_finding_review_experiment_protocol() FROM motive_control_reader';
  END IF;
END $$;
