-- Allow one additional data-only witness format for the second public project.
-- Each project's work order still pins exactly one format through its checker
-- profile; the table constraint only lists the formats any admitted project may
-- retain. Existing rows are all 'motive.csqv.witness.v1' and stay valid.
ALTER TABLE motive.participation_submission_artifacts
  DROP CONSTRAINT participation_submission_artifacts_witness_format_check;
ALTER TABLE motive.participation_submission_artifacts
  ADD CONSTRAINT participation_submission_artifacts_witness_format_check
  CHECK (witness_format IN ('motive.csqv.witness.v1', 'motive.matmul.witness.v1'));
