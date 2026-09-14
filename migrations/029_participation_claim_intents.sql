-- One immutable contributor-declared plan may be recorded for an active
-- external claim before Motive accepts any submission for that claim. It is a
-- timestamped declaration, not proof that outside execution had not started.

CREATE TABLE motive.participation_claim_intents (
  claim_id UUID PRIMARY KEY REFERENCES motive.work_claims(id) ON DELETE RESTRICT,
  project_id UUID NOT NULL REFERENCES motive.projects(id) ON DELETE RESTRICT,
  work_order_id UUID NOT NULL REFERENCES motive.work_orders(id) ON DELETE RESTRICT,
  work_order_revision INTEGER NOT NULL CHECK (work_order_revision > 0),
  work_order_terms_digest TEXT NOT NULL CHECK (work_order_terms_digest ~ '^sha256:[a-f0-9]{64}$'),
  lease_epoch INTEGER NOT NULL CHECK (lease_epoch > 0),
  agent_token_id UUID NOT NULL REFERENCES motive.participation_agent_tokens(id) ON DELETE RESTRICT,
  proposal TEXT NOT NULL CHECK (char_length(proposal) BETWEEN 1 AND 2000 AND proposal=btrim(proposal)),
  expectation TEXT NOT NULL CHECK (char_length(expectation) BETWEEN 1 AND 1000 AND expectation=btrim(expectation)),
  conditions TEXT[] NOT NULL CHECK (cardinality(conditions) BETWEEN 1 AND 12),
  research_context JSONB CHECK (research_context IS NULL OR jsonb_typeof(research_context)='object'),
  research_references JSONB CHECK (research_references IS NULL OR jsonb_typeof(research_references)='array'),
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX participation_claim_intents_project_created_idx
  ON motive.participation_claim_intents(project_id,created_at DESC,claim_id);

CREATE OR REPLACE FUNCTION motive.guard_participation_claim_intent()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,motive AS $$
DECLARE item TEXT;
BEGIN
  -- This exact row lock also serializes a declaration against submission.
  PERFORM 1 FROM motive.work_claims claim WHERE claim.id=NEW.claim_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'claim intent requires an existing claim' USING ERRCODE='23514';
  END IF;
  FOREACH item IN ARRAY NEW.conditions LOOP
    IF item IS NULL OR char_length(item) NOT BETWEEN 1 AND 500 OR item<>btrim(item) THEN
      RAISE EXCEPTION 'claim intent condition is invalid' USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF NEW.research_references IS NOT NULL
    AND (jsonb_array_length(NEW.research_references) NOT BETWEEN 1 AND 10) THEN
    RAISE EXCEPTION 'claim intent research references are invalid' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM motive.work_claims claim
    JOIN motive.work_orders work ON work.id=claim.work_order_id AND work.project_id=claim.project_id
    JOIN motive.work_order_states state ON state.work_order_id=work.id
    JOIN motive.projects project ON project.id=claim.project_id
    JOIN motive.participation_agent_tokens token ON token.id=NEW.agent_token_id
      AND token.project_id=claim.project_id AND claim.operator_actor_id='agent:' || token.id::text
    JOIN motive.memberships membership ON membership.project_id=claim.project_id
      AND membership.actor_id=token.owner_actor_id
    JOIN motive.account_identities account ON account.actor_id=token.owner_actor_id
    WHERE claim.id=NEW.claim_id AND claim.origin='EXTERNAL' AND claim.status='ACTIVE'
      AND claim.expires_at>clock_timestamp() AND claim.lease_epoch=NEW.lease_epoch
      AND claim.project_id=NEW.project_id AND claim.work_order_id=NEW.work_order_id
      AND claim.terms_digest=NEW.work_order_terms_digest
      AND work.revision=NEW.work_order_revision AND work.terms_digest=NEW.work_order_terms_digest
      AND work.project_revision=project.current_revision AND project.visibility='PUBLIC' AND state.state='READY'
      AND token.revoked_at IS NULL AND token.expires_at>clock_timestamp()
      AND membership.revoked_at IS NULL AND account.status='ACTIVE'
      AND NOT EXISTS (SELECT 1 FROM motive.submissions submission WHERE submission.claim_id=claim.id)
  ) THEN
    RAISE EXCEPTION 'claim intent requires the exact current claim, credential, account, membership, and work terms before submission'
      USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER participation_claim_intent_guard BEFORE INSERT ON motive.participation_claim_intents
  FOR EACH ROW EXECUTE FUNCTION motive.guard_participation_claim_intent();
CREATE TRIGGER participation_claim_intents_immutable BEFORE UPDATE OR DELETE ON motive.participation_claim_intents
  FOR EACH ROW EXECUTE FUNCTION motive.reject_immutable_mutation();

REVOKE ALL ON motive.participation_claim_intents FROM PUBLIC;
REVOKE ALL ON FUNCTION motive.guard_participation_claim_intent() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    EXECUTE 'REVOKE ALL ON motive.participation_claim_intents FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    EXECUTE 'REVOKE ALL ON motive.participation_claim_intents FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='motive_control_reader') THEN
    EXECUTE 'REVOKE ALL ON motive.participation_claim_intents FROM motive_control_reader';
    EXECUTE 'REVOKE ALL ON FUNCTION motive.guard_participation_claim_intent() FROM motive_control_reader';
  END IF;
END $$;
