-- Admit astronomy to the existing independent replication proof and native
-- finding-review package guards. Keep the exact claim, digest, provenance,
-- reviewer-independence, and target checks in those functions unchanged.
DO $$
DECLARE definition TEXT; needle TEXT := $match$project.slug='circle-packing'$match$;
DECLARE replacement TEXT := $match$project.slug IN ('circle-packing','exoplanet-hunting')$match$;
DECLARE occurrences INTEGER;
BEGIN
  SELECT pg_get_functiondef('motive.valid_agent_finding_review_proof(text,uuid,uuid,uuid,uuid)'::regprocedure)
    INTO definition;
  occurrences := (length(definition)-length(replace(definition,needle,'')))/length(needle);
  IF occurrences<>1 THEN
    RAISE EXCEPTION 'expected one agent replication project gate, found %',occurrences;
  END IF;
  EXECUTE replace(definition,needle,replacement);

  SELECT pg_get_functiondef('motive.guard_motive_native_finding_review_decision()'::regprocedure)
    INTO definition;
  occurrences := (length(definition)-length(replace(definition,needle,'')))/length(needle);
  IF occurrences<>1 THEN
    RAISE EXCEPTION 'expected one native finding-review project gate, found %',occurrences;
  END IF;
  EXECUTE replace(definition,needle,replacement);
END $$;
