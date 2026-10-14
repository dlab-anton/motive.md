-- A structurally checked astronomy evidence bundle has no optimization score.
-- Retain the scored-family invariant exactly as before for circle packing and matmul.
ALTER TABLE motive.participation_submission_artifacts
  DROP CONSTRAINT participation_submission_artifacts_witness_format_check;
ALTER TABLE motive.participation_submission_artifacts
  ADD CONSTRAINT participation_submission_artifacts_witness_format_check
  CHECK (witness_format IN ('motive.csqv.witness.v1', 'motive.matmul.witness.v1',
    'motive.exoplanet.evidence.v1'));

DO $$
DECLARE old_constraint NAME;
BEGIN
  SELECT conname INTO old_constraint
    FROM pg_constraint
    WHERE conrelid='motive.participation_submission_artifacts'::regclass
      AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%report%VALID%exact_score%exceeds_reference%'
      AND pg_get_constraintdef(oid) NOT LIKE '%witness_format%';
  IF old_constraint IS NULL THEN
    RAISE EXCEPTION 'participation report/score constraint not found';
  END IF;
  EXECUTE format('ALTER TABLE motive.participation_submission_artifacts DROP CONSTRAINT %I', old_constraint);
END $$;

ALTER TABLE motive.participation_submission_artifacts
  ADD CONSTRAINT participation_exoplanet_report_score_check CHECK (
    (witness_format='motive.exoplanet.evidence.v1'
      AND exact_score IS NULL AND exceeds_reference IS NULL)
    OR (witness_format IN ('motive.csqv.witness.v1', 'motive.matmul.witness.v1')
      AND ((report='VALID' AND exact_score IS NOT NULL AND exceeds_reference IS NOT NULL)
        OR (report<>'VALID' AND exact_score IS NULL AND exceeds_reference IS NULL))));
