import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { digestCanonicalJson, type Digest } from '../../domain/src/contracts.ts';
import { COMPARATOR_FACTS_FORMAT } from './facts.ts';
import { profile, hash, changedHash } from './runtime-profile.fixture.ts';
import { digestRuntimeBoundComparatorProfile } from './runtime-profile.ts';
import { INPUT_PREFLIGHT_CHECKS, RUNTIME_PREFLIGHT_CHECKS, RUNTIME_BOUND_REPORT_FORMAT,
  validateRuntimeBoundComparatorReport, type RuntimeBoundComparatorReport } from './runtime-report.ts';

const sha = (bytes: Uint8Array): Digest => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const passing = { format: COMPARATOR_FACTS_FORMAT, outcome: 'VERIFIED', current_stage: 'complete', rejection_stage: null,
  protected_build: true, toolchain_and_export: true, exported_terms: true, statement_comparison: true,
  transitive_axioms: true, kernel_replay: true, used_transitive_axioms: [] };
function report(facts: unknown = passing): RuntimeBoundComparatorReport {
  const bytes = Buffer.from(JSON.stringify(facts));
  return { format: RUNTIME_BOUND_REPORT_FORMAT, evaluator_profile_digest: digestRuntimeBoundComparatorProfile(profile),
    challenge_digest: hash, dependency_lock_digest: hash, trusted_build_config_digest: hash, solution_artifact_manifest_digest: hash,
    runtime_digest: digestCanonicalJson(profile.runtime),
    runtime_preflight: { af_unix_denied: true, landlock_enforced: true, namespace_identity: true, descendants_reaped: true, protected_report_capture: true },
    input_preflight: { trusted_challenge: true, trusted_dependencies: true, candidate_source_only: true },
    facts_capture: { bytes_base64: bytes.toString('base64'), digest: sha(bytes) } };
}
function validate(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  return validateRuntimeBoundComparatorReport({ evaluator_profile: profile,
    frozen_evaluator_profile_digest: digestRuntimeBoundComparatorProfile(profile), solution_artifact_manifest_digest: hash,
    captured_report: { bytes, expected_raw_report_digest: sha(bytes) } });
}
describe('runtime-bound protected report assessment', () => {
  it('binds the real envelope and facts digests while preserving pending human acceptance', () => {
    const captured = report();
    const assessment = validate(captured);
    expect(assessment.format).toBe('motive.lean-comparator-assessment/0.2');
    expect(assessment.outcome).toBe('VERIFIED');
    expect(assessment.evaluator_profile_digest).toBe(captured.evaluator_profile_digest);
    expect(assessment.raw_report_digest).toBe(sha(Buffer.from(JSON.stringify(captured))));
    expect(assessment.raw_facts_digest).toBe(captured.facts_capture!.digest);
    expect(assessment.runtime).toEqual(profile.runtime);
    expect(assessment.human_acceptance).toEqual({ status: 'PENDING', decision_id: null });
  });
  it('refuses substitutions of runtime, challenge, policy configuration, profile, and sealed manifest', () => {
    for (const key of ['runtime_digest', 'challenge_digest', 'dependency_lock_digest', 'trusted_build_config_digest',
      'evaluator_profile_digest', 'solution_artifact_manifest_digest']) {
      expect(() => validate({ ...report(), [key]: changedHash }), key).toThrow(/differs from the frozen input/);
    }
  });
  it('keeps successful checker claims inconclusive when any independent preflight is incomplete', () => {
    for (const key of RUNTIME_PREFLIGHT_CHECKS) {
      const value = report(); value.runtime_preflight[key] = false;
      const assessment = validate(value);
      expect(assessment.outcome, key).toBe('INCONCLUSIVE');
      expect(assessment.checks.kernel_replay).toBe('UNRESOLVED');
      expect(assessment.used_transitive_axioms).toBeNull();
    }
    for (const key of INPUT_PREFLIGHT_CHECKS) {
      const value = report(); value.input_preflight[key] = false;
      expect(validate(value).outcome, key).toBe('INCONCLUSIVE');
    }
  });
  it('preserves source rejection and unknown axioms, but does not trust a rejection without isolation', () => {
    const value = report({ ...passing, outcome: 'REJECTED', current_stage: 'transitive_axioms', rejection_stage: 'transitive_axioms',
      transitive_axioms: false, kernel_replay: false, used_transitive_axioms: null });
    expect(validate(value).outcome).toBe('REJECTED');
    expect(validate(value).checks.transitive_axioms).toBe('FAIL');
    expect(validate(value).used_transitive_axioms).toBeNull();
    value.runtime_preflight.descendants_reaped = false;
    expect(validate(value).outcome).toBe('INCONCLUSIVE');
  });
  it('represents unavailable facts as inconclusive and rejects policy-violating claimed verification', () => {
    const value = report(); value.facts_capture = null;
    expect(validate(value).outcome).toBe('INCONCLUSIVE');
    expect(validate(value).raw_facts_digest).toBeNull();
    expect(() => validate(report({ ...passing, used_transitive_axioms: ['Classical.choice'] }))).toThrow(/outside the exact permitted policy/);
  });
  it('rejects corrupt nested capture bytes, digests, encoding and extra acceptance fields', () => {
    const value = report();
    for (const capture of [{ ...value.facts_capture, digest: changedHash },
      { ...value.facts_capture, bytes_base64: value.facts_capture!.bytes_base64 + '\n' },
      { bytes_base64: 'e30=', digest: sha(Buffer.from('{}')) }]) {
      expect(() => validate({ ...value, facts_capture: capture })).toThrow();
    }
    expect(() => validate({ ...value, human_acceptance: 'ACCEPTED' })).toThrow();
    expect(() => validate(report({ ...passing, human_acceptance: 'ACCEPTED' }))).toThrow();
  });
  it('checks the independent envelope receipt before deriving any assessment', () => {
    expect(() => validateRuntimeBoundComparatorReport({ evaluator_profile: profile,
      frozen_evaluator_profile_digest: digestRuntimeBoundComparatorProfile(profile), solution_artifact_manifest_digest: hash,
      captured_report: { bytes: Buffer.from(JSON.stringify(report())), expected_raw_report_digest: changedHash } })).toThrow(/immutable receipt/);
  });
});
