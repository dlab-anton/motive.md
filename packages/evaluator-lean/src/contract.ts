import { createHash } from 'node:crypto';
import { validateArtifactRelativePath } from '../../artifact-storage/src/sealer.ts';
import { assertDigest, digestCanonicalJson, type Digest } from '../../domain/src/contracts.ts';

/**
 * This is a static, fully pinned profile. It is deliberately distinct from
 * `profiles/p0-evaluator-lean-unresolved.json`, which records a blocked host
 * preflight and is not an executable evaluator profile.
 */
export const LEAN_COMPARATOR_PROFILE_FORMAT = 'motive.lean-comparator-profile/0.1' as const;
export const LEAN_COMPARATOR_REPORT_FORMAT = 'motive.lean-comparator-report/0.1' as const;
export const LEAN_COMPARATOR_ASSESSMENT_FORMAT = 'motive.lean-comparator-assessment/0.1' as const;

/** Trusted Motive report JSON is bounded before decoding or parsing. */
export const MAX_RAW_COMPARATOR_REPORT_BYTES = 256 * 1024;

export type VersionedTool = {
  version: string;
  digest: Digest;
};

export type SourcePinnedTool = {
  commit: string;
  digest: Digest;
};

/** Every executable/configuration component that affects export or checking. */
export type ComparatorToolchain = {
  lean: VersionedTool;
  lake: VersionedTool;
  landrun: SourcePinnedTool;
  lean4export: VersionedTool;
  comparator: SourcePinnedTool;
  export_config_digest: Digest;
  comparator_config_digest: Digest;
};

export type TrustedComparatorProfile = {
  format: typeof LEAN_COMPARATOR_PROFILE_FORMAT;
  profile_id: string;
  challenge: {
    challenge_digest: Digest;
    dependency_lock_digest: Digest;
    trusted_build_config_digest: Digest;
    challenge_module: string;
    solution_module: string;
    theorem_names: readonly string[];
    allowed_solution_paths: readonly string[];
  };
  toolchain: ComparatorToolchain;
  /** Exact, sorted policy set. An empty set is a valid policy. */
  permitted_axioms: readonly string[];
  isolation: {
    host_os: 'linux';
    user: 'nonprivileged';
    outer_restriction: 'systemd-run --user --property=RestrictAddressFamilies=~AF_UNIX';
    candidate_oleans: 'forbidden';
  };
};

export const REQUIRED_COMPARATOR_CHECKS = [
  'trusted_challenge',
  'trusted_dependencies',
  'candidate_source_only',
  'toolchain_and_export',
  'protected_build',
  'exported_terms',
  'statement_comparison',
  'transitive_axioms',
  'kernel_replay',
] as const;

export type ComparatorCheckId = typeof REQUIRED_COMPARATOR_CHECKS[number];
export type ComparatorCheckStatus = 'PASS' | 'FAIL' | 'UNRESOLVED';
export type ComparatorChecks = Record<ComparatorCheckId, ComparatorCheckStatus>;
export type ComparatorOutcome = 'VERIFIED' | 'REJECTED' | 'INCONCLUSIVE';

/**
 * The decoded representation of the bytes captured by a trusted evaluator
 * collector. It has no acceptance field and intentionally excludes worker
 * process status and exit-code claims.
 */
export type ComparatorReport = {
  format: typeof LEAN_COMPARATOR_REPORT_FORMAT;
  evaluator_profile_digest: Digest;
  challenge_digest: Digest;
  dependency_lock_digest: Digest;
  trusted_build_config_digest: Digest;
  solution_artifact_manifest_digest: Digest;
  toolchain: ComparatorToolchain;
  /** Exact policy used by the evaluator, not merely a subset it claims to allow. */
  permitted_axioms: readonly string[];
  /** Actual direct and transitive axioms; null means checking never established
   * the set. Unknown is distinct from a successfully established empty set. */
  used_transitive_axioms: readonly string[] | null;
  checks: ComparatorChecks;
  outcome: ComparatorOutcome;
};

/**
 * `expected_raw_report_digest` must come from the trusted collector's
 * immutable capture record. The validator recomputes it from `bytes`; it never
 * trusts a digest embedded in report JSON.
 *
 * The type does not authenticate the collector. The caller must establish that
 * boundary before calling this pure module.
 */
export type TrustedComparatorReportCapture = {
  bytes: Uint8Array;
  expected_raw_report_digest: Digest;
};

export type ValidateTrustedComparatorReportInput = {
  /** The reviewed profile bytes decoded by the trusted control plane. */
  evaluator_profile: unknown;
  /** Frozen work-order/profile-registry digest, independently supplied. */
  frozen_evaluator_profile_digest: Digest;
  /** Receipt digest from the trusted artifact collector, independently supplied. */
  solution_artifact_manifest_digest: Digest;
  /** Bytes captured from the isolated evaluator's report channel. */
  captured_report: TrustedComparatorReportCapture;
};

/**
 * This is an evaluator assessment, not an acceptance decision. A human decision
 * lives in a separate record and always starts pending here.
 */
export type ComparatorAssessment = {
  format: typeof LEAN_COMPARATOR_ASSESSMENT_FORMAT;
  outcome: ComparatorOutcome;
  evaluator_profile_digest: Digest;
  challenge_digest: Digest;
  dependency_lock_digest: Digest;
  trusted_build_config_digest: Digest;
  solution_artifact_manifest_digest: Digest;
  toolchain: ComparatorToolchain;
  permitted_axioms: readonly string[];
  used_transitive_axioms: readonly string[] | null;
  checks: ComparatorChecks;
  raw_report_digest: Digest;
  human_acceptance: {
    status: 'PENDING';
    decision_id: null;
  };
};

export type EvaluatorContractErrorCode =
  | 'PROFILE_INVALID'
  | 'CAPTURE_INVALID'
  | 'RAW_REPORT_INVALID'
  | 'RAW_REPORT_DIGEST_MISMATCH'
  | 'BINDING_MISMATCH'
  | 'OUTCOME_INVALID';

export class EvaluatorContractError extends Error {
  constructor(readonly code: EvaluatorContractErrorCode, message: string) {
    super(message);
    this.name = 'EvaluatorContractError';
  }
}

type JsonRecord = Record<string, unknown>;

function fail(code: EvaluatorContractErrorCode, message: string): never {
  throw new EvaluatorContractError(code, message);
}

function isPlainRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function requireRecord(value: unknown, path: string, code: EvaluatorContractErrorCode): JsonRecord {
  if (!isPlainRecord(value)) fail(code, `${path} must be a plain JSON object.`);
  return value;
}

function requireExactKeys(value: JsonRecord, path: string, keys: readonly string[], code: EvaluatorContractErrorCode): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(code, `${path}.${key} is not a supported property.`);
  }
  for (const key of keys) {
    if (!(key in value)) fail(code, `${path}.${key} is required.`);
  }
}

function requireText(value: unknown, path: string, code: EvaluatorContractErrorCode, maximum = 4_096): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(code, `${path} must be a non-empty text value no longer than ${maximum} characters.`);
  }
  return value;
}

function requireDigest(value: unknown, path: string, code: EvaluatorContractErrorCode): Digest {
  try {
    return assertDigest(value, path);
  } catch {
    return fail(code, `${path} must be a sha256 digest.`);
  }
}

function requireCommit(value: unknown, path: string, code: EvaluatorContractErrorCode): string {
  const commit = requireText(value, path, code, 64);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) {
    fail(code, `${path} must be a full lowercase 40- or 64-character commit identifier.`);
  }
  return commit;
}

function isSortedUnique(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1] >= values[index]) return false;
  }
  return true;
}

function requireSortedUniqueTextArray(
  value: unknown,
  path: string,
  code: EvaluatorContractErrorCode,
  options: { minimum: number; maximum: number; textMaximum?: number },
): string[] {
  if (!Array.isArray(value) || value.length < options.minimum || value.length > options.maximum) {
    fail(code, `${path} must contain between ${options.minimum} and ${options.maximum} entries.`);
  }
  const values = value.map((entry, index) => requireText(entry, `${path}[${index}]`, code, options.textMaximum));
  if (!isSortedUnique(values)) fail(code, `${path} must be sorted and contain no duplicate entries.`);
  return values;
}

/**
 * Curated profiles intentionally use a narrow ASCII subset of Lean qualified
 * names. It is sufficient for the initial challenge registry and avoids passing
 * arbitrary shell-like strings through a future evaluator adapter. A profile
 * that needs Unicode Lean identifiers needs a deliberate grammar revision.
 */
const CURATED_QUALIFIED_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

const RESERVED_SOLUTION_BASENAMES = new Set([
  'lakefile.lean',
  'lean-toolchain',
  'lake-manifest.json',
  'lake-manifest.toml',
  'manifest.json',
]);

const RESERVED_SOLUTION_DIRECTORIES = new Set(['.git', '.lake', 'build', 'lake-packages']);

function requireCuratedQualifiedIdentifier(value: unknown, path: string, code: EvaluatorContractErrorCode): string {
  const identifier = requireText(value, path, code, 512);
  if (!CURATED_QUALIFIED_IDENTIFIER.test(identifier)) {
    fail(code, `${path} must be an ASCII qualified Lean identifier for this curated profile.`);
  }
  return identifier;
}

function moduleSourcePath(moduleName: string): string {
  return `${moduleName.replaceAll('.', '/')}.lean`;
}

function requireSolutionPath(value: string, path: string, code: EvaluatorContractErrorCode): void {
  try {
    validateArtifactRelativePath(value);
  } catch {
    fail(code, `${path} must satisfy the trusted artifact relative-path policy.`);
  }
  if (!value.endsWith('.lean')) {
    fail(code, `${path} must name a curated .lean source file, never a compiled or configuration file.`);
  }
  const segments = value.split('/');
  const basename = segments.at(-1)!.toLowerCase();
  if (RESERVED_SOLUTION_BASENAMES.has(basename)
      || segments.slice(0, -1).some(segment => RESERVED_SOLUTION_DIRECTORIES.has(segment.toLowerCase()))) {
    fail(code, `${path} may not target Lake, dependency, VCS, or build-control files/directories.`);
  }
}

function parseVersionedTool(value: unknown, path: string, code: EvaluatorContractErrorCode): VersionedTool {
  const record = requireRecord(value, path, code);
  requireExactKeys(record, path, ['version', 'digest'], code);
  return {
    version: requireText(record.version, `${path}.version`, code, 512),
    digest: requireDigest(record.digest, `${path}.digest`, code),
  };
}

function parseSourcePinnedTool(value: unknown, path: string, code: EvaluatorContractErrorCode): SourcePinnedTool {
  const record = requireRecord(value, path, code);
  requireExactKeys(record, path, ['commit', 'digest'], code);
  return {
    commit: requireCommit(record.commit, `${path}.commit`, code),
    digest: requireDigest(record.digest, `${path}.digest`, code),
  };
}

function parseToolchain(value: unknown, path: string, code: EvaluatorContractErrorCode): ComparatorToolchain {
  const record = requireRecord(value, path, code);
  requireExactKeys(record, path, [
    'lean', 'lake', 'landrun', 'lean4export', 'comparator', 'export_config_digest', 'comparator_config_digest',
  ], code);
  return {
    lean: parseVersionedTool(record.lean, `${path}.lean`, code),
    lake: parseVersionedTool(record.lake, `${path}.lake`, code),
    landrun: parseSourcePinnedTool(record.landrun, `${path}.landrun`, code),
    lean4export: parseVersionedTool(record.lean4export, `${path}.lean4export`, code),
    comparator: parseSourcePinnedTool(record.comparator, `${path}.comparator`, code),
    export_config_digest: requireDigest(record.export_config_digest, `${path}.export_config_digest`, code),
    comparator_config_digest: requireDigest(record.comparator_config_digest, `${path}.comparator_config_digest`, code),
  };
}

function sameToolchain(left: ComparatorToolchain, right: ComparatorToolchain): boolean {
  return left.lean.version === right.lean.version
    && left.lean.digest === right.lean.digest
    && left.lake.version === right.lake.version
    && left.lake.digest === right.lake.digest
    && left.landrun.commit === right.landrun.commit
    && left.landrun.digest === right.landrun.digest
    && left.lean4export.version === right.lean4export.version
    && left.lean4export.digest === right.lean4export.digest
    && left.comparator.commit === right.comparator.commit
    && left.comparator.digest === right.comparator.digest
    && left.export_config_digest === right.export_config_digest
    && left.comparator_config_digest === right.comparator_config_digest;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseCheckStatus(value: unknown, path: string, code: EvaluatorContractErrorCode): ComparatorCheckStatus {
  if (value !== 'PASS' && value !== 'FAIL' && value !== 'UNRESOLVED') {
    fail(code, `${path} must be PASS, FAIL, or UNRESOLVED.`);
  }
  return value;
}

function parseChecks(value: unknown, path: string, code: EvaluatorContractErrorCode): ComparatorChecks {
  const record = requireRecord(value, path, code);
  requireExactKeys(record, path, REQUIRED_COMPARATOR_CHECKS, code);
  return {
    trusted_challenge: parseCheckStatus(record.trusted_challenge, `${path}.trusted_challenge`, code),
    trusted_dependencies: parseCheckStatus(record.trusted_dependencies, `${path}.trusted_dependencies`, code),
    candidate_source_only: parseCheckStatus(record.candidate_source_only, `${path}.candidate_source_only`, code),
    toolchain_and_export: parseCheckStatus(record.toolchain_and_export, `${path}.toolchain_and_export`, code),
    protected_build: parseCheckStatus(record.protected_build, `${path}.protected_build`, code),
    exported_terms: parseCheckStatus(record.exported_terms, `${path}.exported_terms`, code),
    statement_comparison: parseCheckStatus(record.statement_comparison, `${path}.statement_comparison`, code),
    transitive_axioms: parseCheckStatus(record.transitive_axioms, `${path}.transitive_axioms`, code),
    kernel_replay: parseCheckStatus(record.kernel_replay, `${path}.kernel_replay`, code),
  };
}

export function validateTrustedComparatorProfile(input: unknown): TrustedComparatorProfile {
  const code = 'PROFILE_INVALID' as const;
  const value = requireRecord(input, 'evaluator profile', code);
  requireExactKeys(value, 'evaluator profile', ['format', 'profile_id', 'challenge', 'toolchain', 'permitted_axioms', 'isolation'], code);
  if (value.format !== LEAN_COMPARATOR_PROFILE_FORMAT) {
    fail(code, `evaluator profile.format must be ${LEAN_COMPARATOR_PROFILE_FORMAT}.`);
  }

  const challenge = requireRecord(value.challenge, 'evaluator profile.challenge', code);
  requireExactKeys(challenge, 'evaluator profile.challenge', [
    'challenge_digest', 'dependency_lock_digest', 'trusted_build_config_digest', 'challenge_module', 'solution_module',
    'theorem_names', 'allowed_solution_paths',
  ], code);
  const theoremNames = requireSortedUniqueTextArray(challenge.theorem_names, 'evaluator profile.challenge.theorem_names', code, {
    minimum: 1,
    maximum: 1_024,
    textMaximum: 512,
  });
  theoremNames.forEach((theoremName, index) => {
    requireCuratedQualifiedIdentifier(theoremName, `evaluator profile.challenge.theorem_names[${index}]`, code);
  });
  const allowedSolutionPaths = requireSortedUniqueTextArray(challenge.allowed_solution_paths, 'evaluator profile.challenge.allowed_solution_paths', code, {
    minimum: 1,
    maximum: 1_024,
    textMaximum: 1_024,
  });
  allowedSolutionPaths.forEach((candidatePath, index) => {
    requireSolutionPath(candidatePath, `evaluator profile.challenge.allowed_solution_paths[${index}]`, code);
  });
  const challengeModule = requireCuratedQualifiedIdentifier(challenge.challenge_module, 'evaluator profile.challenge.challenge_module', code);
  const solutionModule = requireCuratedQualifiedIdentifier(challenge.solution_module, 'evaluator profile.challenge.solution_module', code);
  if (challengeModule === solutionModule) {
    fail(code, 'evaluator profile.challenge.solution_module must differ from challenge_module.');
  }
  const challengeSourcePath = moduleSourcePath(challengeModule);
  const solutionSourcePath = moduleSourcePath(solutionModule);
  if (allowedSolutionPaths.includes(challengeSourcePath)) {
    fail(code, 'evaluator profile.challenge.allowed_solution_paths may not include the trusted challenge module source path.');
  }
  if (!allowedSolutionPaths.includes(solutionSourcePath)) {
    fail(code, 'evaluator profile.challenge.allowed_solution_paths must include the curated solution_module source path.');
  }

  const isolation = requireRecord(value.isolation, 'evaluator profile.isolation', code);
  requireExactKeys(isolation, 'evaluator profile.isolation', ['host_os', 'user', 'outer_restriction', 'candidate_oleans'], code);
  if (isolation.host_os !== 'linux' || isolation.user !== 'nonprivileged'
      || isolation.outer_restriction !== 'systemd-run --user --property=RestrictAddressFamilies=~AF_UNIX'
      || isolation.candidate_oleans !== 'forbidden') {
    fail(code, 'evaluator profile.isolation must require Linux, a nonprivileged user, the AF_UNIX restriction, and forbidden candidate .olean inputs.');
  }

  return {
    format: LEAN_COMPARATOR_PROFILE_FORMAT,
    profile_id: requireText(value.profile_id, 'evaluator profile.profile_id', code, 256),
    challenge: {
      challenge_digest: requireDigest(challenge.challenge_digest, 'evaluator profile.challenge.challenge_digest', code),
      dependency_lock_digest: requireDigest(challenge.dependency_lock_digest, 'evaluator profile.challenge.dependency_lock_digest', code),
      trusted_build_config_digest: requireDigest(challenge.trusted_build_config_digest, 'evaluator profile.challenge.trusted_build_config_digest', code),
      challenge_module: challengeModule,
      solution_module: solutionModule,
      theorem_names: theoremNames,
      allowed_solution_paths: allowedSolutionPaths,
    },
    toolchain: parseToolchain(value.toolchain, 'evaluator profile.toolchain', code),
    permitted_axioms: requireSortedUniqueTextArray(value.permitted_axioms, 'evaluator profile.permitted_axioms', code, {
      minimum: 0,
      maximum: 1_024,
      textMaximum: 1_024,
    }),
    isolation: {
      host_os: 'linux',
      user: 'nonprivileged',
      outer_restriction: 'systemd-run --user --property=RestrictAddressFamilies=~AF_UNIX',
      candidate_oleans: 'forbidden',
    },
  };
}

/** The canonical profile digest that must match a frozen work-order/registry reference. */
export function digestTrustedComparatorProfile(input: unknown): Digest {
  return digestCanonicalJson(validateTrustedComparatorProfile(input));
}

function parseComparatorReport(value: unknown): ComparatorReport {
  const code = 'RAW_REPORT_INVALID' as const;
  const report = requireRecord(value, 'Comparator report', code);
  requireExactKeys(report, 'Comparator report', [
    'format', 'evaluator_profile_digest', 'challenge_digest', 'dependency_lock_digest', 'trusted_build_config_digest',
    'solution_artifact_manifest_digest', 'toolchain', 'permitted_axioms', 'used_transitive_axioms', 'checks', 'outcome',
  ], code);
  if (report.format !== LEAN_COMPARATOR_REPORT_FORMAT) {
    fail(code, `Comparator report.format must be ${LEAN_COMPARATOR_REPORT_FORMAT}.`);
  }
  if (report.outcome !== 'VERIFIED' && report.outcome !== 'REJECTED' && report.outcome !== 'INCONCLUSIVE') {
    fail(code, 'Comparator report.outcome must be VERIFIED, REJECTED, or INCONCLUSIVE.');
  }
  return {
    format: LEAN_COMPARATOR_REPORT_FORMAT,
    evaluator_profile_digest: requireDigest(report.evaluator_profile_digest, 'Comparator report.evaluator_profile_digest', code),
    challenge_digest: requireDigest(report.challenge_digest, 'Comparator report.challenge_digest', code),
    dependency_lock_digest: requireDigest(report.dependency_lock_digest, 'Comparator report.dependency_lock_digest', code),
    trusted_build_config_digest: requireDigest(report.trusted_build_config_digest, 'Comparator report.trusted_build_config_digest', code),
    solution_artifact_manifest_digest: requireDigest(report.solution_artifact_manifest_digest, 'Comparator report.solution_artifact_manifest_digest', code),
    toolchain: parseToolchain(report.toolchain, 'Comparator report.toolchain', code),
    permitted_axioms: requireSortedUniqueTextArray(report.permitted_axioms, 'Comparator report.permitted_axioms', code, {
      minimum: 0,
      maximum: 1_024,
      textMaximum: 1_024,
    }),
    used_transitive_axioms: report.used_transitive_axioms === null ? null : requireSortedUniqueTextArray(report.used_transitive_axioms, 'Comparator report.used_transitive_axioms', code, {
      minimum: 0,
      maximum: 4_096,
      textMaximum: 1_024,
    }),
    checks: parseChecks(report.checks, 'Comparator report.checks', code),
    outcome: report.outcome,
  };
}

function digestRawReport(bytes: Uint8Array): Digest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function parseTrustedCapture(input: unknown): { report: ComparatorReport; rawReportDigest: Digest } {
  const code = 'CAPTURE_INVALID' as const;
  const capture = requireRecord(input, 'trusted Comparator capture', code);
  requireExactKeys(capture, 'trusted Comparator capture', ['bytes', 'expected_raw_report_digest'], code);
  if (!(capture.bytes instanceof Uint8Array)) fail(code, 'trusted Comparator capture.bytes must be a Uint8Array.');
  if (capture.bytes.byteLength === 0 || capture.bytes.byteLength > MAX_RAW_COMPARATOR_REPORT_BYTES) {
    fail(code, `trusted Comparator capture.bytes must contain between 1 and ${MAX_RAW_COMPARATOR_REPORT_BYTES} bytes.`);
  }
  // Copy before hashing and decoding so a caller cannot mutate a shared view
  // between the immutable-byte digest calculation and JSON parsing.
  const bytes = new Uint8Array(capture.bytes);
  const expectedDigest = requireDigest(capture.expected_raw_report_digest, 'trusted Comparator capture.expected_raw_report_digest', code);
  const rawReportDigest = digestRawReport(bytes);
  if (rawReportDigest !== expectedDigest) {
    fail('RAW_REPORT_DIGEST_MISMATCH', 'Captured Comparator report bytes do not match the trusted collector digest.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail('RAW_REPORT_INVALID', 'Captured Comparator report bytes must be valid UTF-8 JSON.');
  }
  return { report: parseComparatorReport(parsed), rawReportDigest };
}

function assertBindings(
  report: ComparatorReport,
  profile: TrustedComparatorProfile,
  frozenProfileDigest: Digest,
  solutionArtifactManifestDigest: Digest,
): void {
  if (report.evaluator_profile_digest !== frozenProfileDigest
      || report.challenge_digest !== profile.challenge.challenge_digest
      || report.dependency_lock_digest !== profile.challenge.dependency_lock_digest
      || report.trusted_build_config_digest !== profile.challenge.trusted_build_config_digest
      || report.solution_artifact_manifest_digest !== solutionArtifactManifestDigest
      || !sameToolchain(report.toolchain, profile.toolchain)
      || !sameStringArray(report.permitted_axioms, profile.permitted_axioms)) {
    fail('BINDING_MISMATCH', 'Comparator report does not bind exactly to the frozen profile, trusted challenge/configuration, sealed solution manifest, toolchain, or axiom policy.');
  }
}

function assertOutcomeIsConsistent(report: ComparatorReport): void {
  const statuses = REQUIRED_COMPARATOR_CHECKS.map(check => report.checks[check]);
  const allPass = statuses.every(status => status === 'PASS');
  const anyFailure = statuses.some(status => status === 'FAIL');
  const anyUnresolved = statuses.some(status => status === 'UNRESOLVED');
  const policyViolation = report.used_transitive_axioms?.some(axiom => !report.permitted_axioms.includes(axiom)) ?? false;
  if (report.used_transitive_axioms === null
    && (report.checks.transitive_axioms === 'PASS' || report.outcome === 'VERIFIED')) {
    fail('OUTCOME_INVALID', 'An unknown transitive axiom set cannot pass the axiom check or produce VERIFIED.');
  }

  if (report.outcome === 'VERIFIED') {
    if (!allPass) {
      fail('OUTCOME_INVALID', 'A VERIFIED Comparator assessment requires every required challenge, export, statement, transitive-axiom, and kernel check to pass.');
    }
    if (policyViolation) {
      fail('OUTCOME_INVALID', 'A VERIFIED Comparator assessment cannot use an axiom outside the exact permitted policy.');
    }
    return;
  }

  if (report.outcome === 'REJECTED') {
    if (!anyFailure) fail('OUTCOME_INVALID', 'A REJECTED Comparator assessment must record at least one failed required check.');
    if (policyViolation && report.checks.transitive_axioms !== 'FAIL') {
      fail('OUTCOME_INVALID', 'An unapproved used/transitive axiom must fail the transitive_axioms check.');
    }
    return;
  }

  if (anyFailure || !anyUnresolved) {
    fail('OUTCOME_INVALID', 'An INCONCLUSIVE Comparator assessment requires an unresolved check and no failed required check.');
  }
  if (policyViolation) {
    fail('OUTCOME_INVALID', 'A known unapproved used/transitive axiom is a rejection, not an inconclusive result.');
  }
}

/**
 * Validates a report captured by a trusted evaluator collector. It establishes
 * only structural consistency of captured evidence: this pure function cannot
 * prove that Comparator or Landrun actually ran, that the collector was trusted,
 * or that the report did not originate from a worker-controlled channel.
 */
export function validateTrustedComparatorReport(input: ValidateTrustedComparatorReportInput): ComparatorAssessment {
  const profile = validateTrustedComparatorProfile(input.evaluator_profile);
  const actualProfileDigest = digestCanonicalJson(profile);
  const frozenProfileDigest = requireDigest(input.frozen_evaluator_profile_digest, 'frozen_evaluator_profile_digest', 'BINDING_MISMATCH');
  const solutionArtifactManifestDigest = requireDigest(
    input.solution_artifact_manifest_digest,
    'solution_artifact_manifest_digest',
    'BINDING_MISMATCH',
  );
  if (actualProfileDigest !== frozenProfileDigest) {
    fail('BINDING_MISMATCH', 'The supplied evaluator profile does not match the frozen profile digest.');
  }
  const { report, rawReportDigest } = parseTrustedCapture(input.captured_report);
  assertBindings(report, profile, frozenProfileDigest, solutionArtifactManifestDigest);
  assertOutcomeIsConsistent(report);

  return {
    format: LEAN_COMPARATOR_ASSESSMENT_FORMAT,
    outcome: report.outcome,
    evaluator_profile_digest: frozenProfileDigest,
    challenge_digest: report.challenge_digest,
    dependency_lock_digest: report.dependency_lock_digest,
    trusted_build_config_digest: report.trusted_build_config_digest,
    solution_artifact_manifest_digest: report.solution_artifact_manifest_digest,
    toolchain: report.toolchain,
    permitted_axioms: [...report.permitted_axioms],
    used_transitive_axioms: report.used_transitive_axioms === null ? null : [...report.used_transitive_axioms],
    checks: { ...report.checks },
    raw_report_digest: rawReportDigest,
    human_acceptance: { status: 'PENDING', decision_id: null },
  };
}
