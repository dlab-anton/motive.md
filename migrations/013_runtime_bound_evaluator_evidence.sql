-- Preserve immutable historical 0.1 assessments while admitting the distinct
-- reporter/supervisor/host-bound 0.2 contract through the same private store.
ALTER TABLE motive.evaluations
  DROP CONSTRAINT evaluations_assessment_check1;

ALTER TABLE motive.evaluations
  ADD CONSTRAINT evaluations_supported_assessment_format CHECK ((
    ((assessment ->> 'format') = 'motive.lean-comparator-assessment/0.1'
      AND (evaluator_profile ->> 'format') = 'motive.lean-comparator-profile/0.1')
    OR
    ((assessment ->> 'format') = 'motive.lean-comparator-assessment/0.2'
      AND (evaluator_profile ->> 'format') = 'motive.lean-comparator-profile/0.2'
      AND jsonb_typeof(evaluator_profile -> 'runtime') = 'object'
      AND (assessment -> 'runtime') IS NOT DISTINCT FROM (evaluator_profile -> 'runtime')
      AND jsonb_typeof(assessment -> 'runtime_preflight') = 'object'
      AND jsonb_typeof(assessment -> 'input_preflight') = 'object'
      AND assessment ? 'raw_facts_digest'
      AND ((assessment -> 'raw_facts_digest') = 'null'::jsonb
        OR (assessment ->> 'raw_facts_digest') ~ '^sha256:[a-f0-9]{64}$'))
  ) IS TRUE);

ALTER TABLE motive.evaluations
  ADD CONSTRAINT evaluations_runtime_verified_preflight CHECK ((
    (assessment ->> 'format') <> 'motive.lean-comparator-assessment/0.2'
    OR outcome <> 'VERIFIED'
    OR (
      (assessment -> 'runtime_preflight') @> '{"af_unix_denied":true,"landlock_enforced":true,"namespace_identity":true,"descendants_reaped":true,"protected_report_capture":true}'::jsonb
      AND (assessment -> 'input_preflight') @> '{"trusted_challenge":true,"trusted_dependencies":true,"candidate_source_only":true}'::jsonb
      AND (assessment ->> 'raw_facts_digest') ~ '^sha256:[a-f0-9]{64}$'
    )
  ) IS TRUE);
