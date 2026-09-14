import { createHash } from 'node:crypto';
import { assertDigest, digestCanonicalJson, type Digest } from '../../domain/src/contracts.ts';
import { EvaluatorContractError, LEAN_COMPARATOR_PROFILE_FORMAT, LEAN_COMPARATOR_REPORT_FORMAT,
  MAX_RAW_COMPARATOR_REPORT_BYTES, REQUIRED_COMPARATOR_CHECKS, validateTrustedComparatorReport,
  type ComparatorAssessment, type ComparatorChecks, type TrustedComparatorReportCapture } from './contract.ts';
import { decodeComparatorFacts, FACT_CHECKS, MAX_COMPARATOR_FACTS_BYTES } from './facts.ts';
import { requireFrozenRuntimeBoundProfile, type ComparatorRuntimeIdentity } from './runtime-profile.ts';

export const RUNTIME_BOUND_REPORT_FORMAT = 'motive.lean-comparator-report/0.2' as const;
export const RUNTIME_BOUND_ASSESSMENT_FORMAT = 'motive.lean-comparator-assessment/0.2' as const;
export const RUNTIME_PREFLIGHT_CHECKS = ['af_unix_denied', 'landlock_enforced', 'namespace_identity',
  'descendants_reaped', 'protected_report_capture'] as const;
export const INPUT_PREFLIGHT_CHECKS = ['trusted_challenge', 'trusted_dependencies', 'candidate_source_only'] as const;
export type RuntimePreflight = Record<typeof RUNTIME_PREFLIGHT_CHECKS[number], boolean>;
export type InputPreflight = Record<typeof INPUT_PREFLIGHT_CHECKS[number], boolean>;

/** Written by the trusted launcher/collector, never by the candidate. Booleans
 * describe independently observed preflight results, not checker assertions. */
export type RuntimeBoundComparatorReport = {
  format: typeof RUNTIME_BOUND_REPORT_FORMAT;
  evaluator_profile_digest: Digest;
  challenge_digest: Digest;
  dependency_lock_digest: Digest;
  trusted_build_config_digest: Digest;
  solution_artifact_manifest_digest: Digest;
  runtime_digest: Digest;
  runtime_preflight: RuntimePreflight;
  input_preflight: InputPreflight;
  /** Null represents unavailable facts, including a timeout or missing file. */
  facts_capture: { bytes_base64: string; digest: Digest } | null;
};
export type RuntimeBoundComparatorAssessment = Omit<ComparatorAssessment, 'format'> & {
  format: typeof RUNTIME_BOUND_ASSESSMENT_FORMAT;
  runtime: ComparatorRuntimeIdentity;
  runtime_preflight: RuntimePreflight;
  input_preflight: InputPreflight;
  raw_facts_digest: Digest | null;
};

function fail(message: string): never { throw new EvaluatorContractError('RAW_REPORT_INVALID', message); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Report object required.');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || !keys.every(key => Object.hasOwn(record, key))) fail('Unexpected or missing report fields.');
  return record;
}
function booleans<K extends string>(value: unknown, keys: readonly K[]): Record<K, boolean> {
  const record = object(value, keys);
  for (const key of keys) if (typeof record[key] !== 'boolean') fail('Preflight observations must be booleans.');
  return record as Record<K, boolean>;
}
function sha256(bytes: Uint8Array): Digest { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }
function assertBinding(actual: unknown, expected: Digest, field: string) {
  if (actual !== expected) throw new EvaluatorContractError('BINDING_MISMATCH', `Captured ${field} differs from the frozen input.`);
}

/** This pure validator does not authenticate its caller or capture channel.
 * Dispatch composition and the private evidence store enforce that boundary. */
export function validateRuntimeBoundComparatorReport(input: {
  evaluator_profile: unknown; frozen_evaluator_profile_digest: Digest;
  solution_artifact_manifest_digest: Digest; captured_report: TrustedComparatorReportCapture;
}): RuntimeBoundComparatorAssessment {
  const profile = requireFrozenRuntimeBoundProfile(input.evaluator_profile, input.frozen_evaluator_profile_digest);
  const manifest = assertDigest(input.solution_artifact_manifest_digest, 'sealed manifest');
  const captured = input.captured_report;
  if (!captured || !(captured.bytes instanceof Uint8Array) || captured.bytes.byteLength === 0
    || captured.bytes.byteLength > MAX_RAW_COMPARATOR_REPORT_BYTES) fail('Report byte limit.');
  const rawReportDigest = sha256(captured.bytes);
  if (rawReportDigest !== captured.expected_raw_report_digest) throw new EvaluatorContractError('RAW_REPORT_DIGEST_MISMATCH', 'Captured report digest differs from its immutable receipt.');
  let decoded: unknown;
  try { decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(captured.bytes)); }
  catch { fail('Malformed report UTF-8 or JSON.'); }
  const report = object(decoded, ['format', 'evaluator_profile_digest', 'challenge_digest', 'dependency_lock_digest',
    'trusted_build_config_digest', 'solution_artifact_manifest_digest', 'runtime_digest', 'runtime_preflight', 'input_preflight', 'facts_capture']);
  if (report.format !== RUNTIME_BOUND_REPORT_FORMAT) fail('Unsupported runtime report format.');
  assertBinding(report.evaluator_profile_digest, input.frozen_evaluator_profile_digest, 'profile');
  assertBinding(report.challenge_digest, profile.challenge.challenge_digest, 'challenge');
  assertBinding(report.dependency_lock_digest, profile.challenge.dependency_lock_digest, 'dependency lock');
  assertBinding(report.trusted_build_config_digest, profile.challenge.trusted_build_config_digest, 'build configuration');
  assertBinding(report.solution_artifact_manifest_digest, manifest, 'sealed manifest');
  assertBinding(report.runtime_digest, digestCanonicalJson(profile.runtime), 'runtime');
  const runtime = booleans(report.runtime_preflight, RUNTIME_PREFLIGHT_CHECKS);
  const inputs = booleans(report.input_preflight, INPUT_PREFLIGHT_CHECKS);
  let facts: ReturnType<typeof decodeComparatorFacts> | null = null;
  let rawFactsDigest: Digest | null = null;
  if (report.facts_capture !== null) {
    const capture = object(report.facts_capture, ['bytes_base64', 'digest']);
    if (typeof capture.bytes_base64 !== 'string' || capture.bytes_base64.length > 4 * Math.ceil(MAX_COMPARATOR_FACTS_BYTES / 3)) fail('Facts capture byte limit.');
    const bytes = Buffer.from(capture.bytes_base64, 'base64');
    if (bytes.toString('base64') !== capture.bytes_base64) fail('Facts base64 must be canonical.');
    rawFactsDigest = sha256(bytes);
    if (capture.digest !== rawFactsDigest) fail('Facts digest differs from captured bytes.');
    try { facts = decodeComparatorFacts(bytes); } catch { fail('Captured checker facts are invalid.'); }
  }
  const trusted = Object.values(runtime).every(Boolean) && Object.values(inputs).every(Boolean);
  const checks = Object.fromEntries(REQUIRED_COMPARATOR_CHECKS.map(key => [key, 'UNRESOLVED'])) as ComparatorChecks;
  INPUT_PREFLIGHT_CHECKS.forEach(key => { checks[key] = inputs[key] ? 'PASS' : 'UNRESOLVED'; });
  if (trusted && facts) {
    for (const key of FACT_CHECKS) checks[key] = facts[key] ? 'PASS' : facts.rejection_stage === key ? 'FAIL' : 'UNRESOLVED';
  }

  // Reuse the historical challenge/axiom/outcome consistency validator without
  // relabeling any real capture as stock evidence. Only this internal derived
  // object uses the old format. The returned digest is the actual 0.2 envelope.
  const { runtime: _runtime, ...profileFields } = profile;
  const stockProfile = { ...profileFields, format: LEAN_COMPARATOR_PROFILE_FORMAT };
  const stockDigest = digestCanonicalJson(stockProfile);
  const derived = Buffer.from(JSON.stringify({
    format: LEAN_COMPARATOR_REPORT_FORMAT, evaluator_profile_digest: stockDigest,
    challenge_digest: profile.challenge.challenge_digest, dependency_lock_digest: profile.challenge.dependency_lock_digest,
    trusted_build_config_digest: profile.challenge.trusted_build_config_digest, solution_artifact_manifest_digest: manifest,
    toolchain: profile.toolchain, permitted_axioms: profile.permitted_axioms,
    used_transitive_axioms: trusted && facts ? facts.used_transitive_axioms === null ? null : [...facts.used_transitive_axioms].sort() : null,
    checks, outcome: trusted && facts ? facts.outcome : 'INCONCLUSIVE',
  }));
  const assessment = validateTrustedComparatorReport({ evaluator_profile: stockProfile, frozen_evaluator_profile_digest: stockDigest,
    solution_artifact_manifest_digest: manifest, captured_report: { bytes: derived, expected_raw_report_digest: sha256(derived) } });
  return { ...assessment, format: RUNTIME_BOUND_ASSESSMENT_FORMAT, evaluator_profile_digest: input.frozen_evaluator_profile_digest,
    raw_report_digest: rawReportDigest, runtime: profile.runtime, runtime_preflight: runtime, input_preflight: inputs, raw_facts_digest: rawFactsDigest };
}
