import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Digest } from '../../domain/src/contracts.ts';
import {
  LEAN_COMPARATOR_PROFILE_FORMAT,
  LEAN_COMPARATOR_REPORT_FORMAT,
  MAX_RAW_COMPARATOR_REPORT_BYTES,
  digestTrustedComparatorProfile,
  validateTrustedComparatorReport,
  type ComparatorChecks,
  type TrustedComparatorProfile,
} from './contract.ts';

function digest(value: string): Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

const digests = {
  challenge: digest('challenge'),
  dependencyLock: digest('dependency-lock'),
  buildConfig: digest('trusted-build-config'),
  artifactManifest: digest('sealed-artifact-manifest'),
  lean: digest('lean'),
  lake: digest('lake'),
  landrun: digest('landrun'),
  lean4export: digest('lean4export'),
  comparator: digest('comparator'),
  exportConfig: digest('export-config'),
  comparatorConfig: digest('comparator-config'),
};

const profile: TrustedComparatorProfile = {
  format: LEAN_COMPARATOR_PROFILE_FORMAT,
  profile_id: 'lean-comparator-test-profile',
  challenge: {
    challenge_digest: digests.challenge,
    dependency_lock_digest: digests.dependencyLock,
    trusted_build_config_digest: digests.buildConfig,
    challenge_module: 'Motive.Challenge',
    solution_module: 'Motive.Solution',
    theorem_names: ['Motive.Challenge.target'],
    allowed_solution_paths: ['Motive/Solution.lean'],
  },
  toolchain: {
    lean: { version: 'v4.23.0', digest: digests.lean },
    lake: { version: 'v4.23.0', digest: digests.lake },
    landrun: { commit: 'a'.repeat(40), digest: digests.landrun },
    lean4export: { version: 'v4.23.0', digest: digests.lean4export },
    comparator: { commit: 'b'.repeat(40), digest: digests.comparator },
    export_config_digest: digests.exportConfig,
    comparator_config_digest: digests.comparatorConfig,
  },
  permitted_axioms: ['Classical.choice', 'propext'],
  isolation: {
    host_os: 'linux',
    user: 'nonprivileged',
    outer_restriction: 'systemd-run --user --property=RestrictAddressFamilies=~AF_UNIX',
    candidate_oleans: 'forbidden',
  },
};

const passingChecks: ComparatorChecks = {
  trusted_challenge: 'PASS',
  trusted_dependencies: 'PASS',
  candidate_source_only: 'PASS',
  toolchain_and_export: 'PASS',
  protected_build: 'PASS',
  exported_terms: 'PASS',
  statement_comparison: 'PASS',
  transitive_axioms: 'PASS',
  kernel_replay: 'PASS',
};

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: LEAN_COMPARATOR_REPORT_FORMAT,
    evaluator_profile_digest: digestTrustedComparatorProfile(profile),
    challenge_digest: profile.challenge.challenge_digest,
    dependency_lock_digest: profile.challenge.dependency_lock_digest,
    trusted_build_config_digest: profile.challenge.trusted_build_config_digest,
    solution_artifact_manifest_digest: digests.artifactManifest,
    toolchain: profile.toolchain,
    permitted_axioms: profile.permitted_axioms,
    // A proof may use fewer axioms than policy allows.
    used_transitive_axioms: ['Classical.choice'],
    checks: passingChecks,
    outcome: 'VERIFIED',
    ...overrides,
  };
}

function captured(value: unknown, expectedRawReportDigest?: Digest) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return {
    bytes,
    expected_raw_report_digest: expectedRawReportDigest ?? `sha256:${createHash('sha256').update(bytes).digest('hex')}` as Digest,
  };
}

function validate(value: unknown, options: { expectedRawReportDigest?: Digest; artifactManifestDigest?: Digest } = {}) {
  return validateTrustedComparatorReport({
    evaluator_profile: profile,
    frozen_evaluator_profile_digest: digestTrustedComparatorProfile(profile),
    solution_artifact_manifest_digest: options.artifactManifestDigest ?? digests.artifactManifest,
    captured_report: captured(value, options.expectedRawReportDigest),
  });
}

describe('trusted Lean Comparator report contract', () => {
  it('rejects contradictory candidate-source and module policies before a profile can be frozen', () => {
    const invalidProfiles = [
      {
        label: 'compiled candidate evidence',
        mutate: () => ({ ...profile, challenge: { ...profile.challenge, allowed_solution_paths: ['Motive/Solution.olean'] } }),
        error: /curated .lean source file/,
      },
      {
        label: 'Lake build configuration',
        mutate: () => ({ ...profile, challenge: { ...profile.challenge, allowed_solution_paths: ['Lakefile.lean'] } }),
        error: /Lake, dependency, VCS, or build-control/,
      },
      {
        label: 'Lean toolchain control file',
        mutate: () => ({ ...profile, challenge: { ...profile.challenge, allowed_solution_paths: ['lean-toolchain'] } }),
        error: /curated .lean source file/,
      },
      {
        label: 'Lake manifest control file',
        mutate: () => ({ ...profile, challenge: { ...profile.challenge, allowed_solution_paths: ['lake-manifest.json'] } }),
        error: /curated .lean source file/,
      },
      {
        label: 'generated build source directory',
        mutate: () => ({ ...profile, challenge: { ...profile.challenge, allowed_solution_paths: ['build/Solution.lean'] } }),
        error: /Lake, dependency, VCS, or build-control/,
      },
      {
        label: 'collector path bound bypass',
        mutate: () => ({ ...profile, challenge: { ...profile.challenge, allowed_solution_paths: [`${'界'.repeat(600)}.lean`] } }),
        error: /trusted artifact relative-path policy/,
      },
      {
        label: 'trusted challenge source',
        mutate: () => ({ ...profile, challenge: { ...profile.challenge, allowed_solution_paths: ['Motive/Challenge.lean', 'Motive/Solution.lean'] } }),
        error: /may not include the trusted challenge module source path/,
      },
      {
        label: 'same challenge and solution module',
        mutate: () => ({ ...profile, challenge: { ...profile.challenge, solution_module: 'Motive.Challenge' } }),
        error: /must differ from challenge_module/,
      },
      {
        label: 'shell-like module name',
        mutate: () => ({ ...profile, challenge: { ...profile.challenge, solution_module: 'Motive.Solution;rm' } }),
        error: /ASCII qualified Lean identifier/,
      },
      {
        label: 'unreviewed Unicode module grammar',
        mutate: () => ({ ...profile, challenge: { ...profile.challenge, solution_module: 'Motive.Δ' } }),
        error: /ASCII qualified Lean identifier/,
      },
      {
        label: 'solution module not represented by allowed source',
        mutate: () => ({ ...profile, challenge: { ...profile.challenge, solution_module: 'Motive.Other' } }),
        error: /must include the curated solution_module source path/,
      },
    ];

    for (const invalid of invalidProfiles) {
      expect(() => digestTrustedComparatorProfile(invalid.mutate())).toThrow(invalid.error);
    }
  });

  it('records a structurally verified report with a computed raw digest and pending human acceptance', () => {
    const raw = report();
    const assessment = validate(raw);

    expect(assessment.outcome).toBe('VERIFIED');
    expect(assessment.used_transitive_axioms).toEqual(['Classical.choice']);
    expect(assessment.human_acceptance).toEqual({ status: 'PENDING', decision_id: null });
    expect(assessment.raw_report_digest).toBe(captured(raw).expected_raw_report_digest);
  });

  it('requires the full challenge, export, statement, transitive-axiom, and kernel check set before VERIFIED', () => {
    for (const missingCheck of ['exported_terms', 'statement_comparison', 'transitive_axioms']) {
      const missingRequiredCheck = report({
        checks: Object.fromEntries(Object.entries(passingChecks).filter(([id]) => id !== missingCheck)),
      });
      expect(() => validate(missingRequiredCheck)).toThrow(new RegExp(`${missingCheck} is required`));
    }

    const unresolvedExport = report({ checks: { ...passingChecks, exported_terms: 'UNRESOLVED' } });
    expect(() => validate(unresolvedExport)).toThrow(/VERIFIED Comparator assessment requires every required/);
  });

  it('binds the report to the frozen challenge, sealed artifact manifest, and exact export/comparator toolchain', () => {
    expect(() => validate(report({ challenge_digest: digest('altered-challenge') }))).toThrow(/does not bind exactly/);
    expect(() => validate(report({ dependency_lock_digest: digest('altered-lock') }))).toThrow(/does not bind exactly/);
    expect(() => validate(report({ solution_artifact_manifest_digest: digest('other-artifact') }))).toThrow(/does not bind exactly/);
    expect(() => validate(report({
      toolchain: {
        ...profile.toolchain,
        comparator: { ...profile.toolchain.comparator, digest: digest('altered-comparator') },
        export_config_digest: digest('altered-export-config'),
      },
    }))).toThrow(/does not bind exactly/);
    expect(() => validateTrustedComparatorReport({
      evaluator_profile: profile,
      frozen_evaluator_profile_digest: digest('different-profile'),
      solution_artifact_manifest_digest: digests.artifactManifest,
      captured_report: captured(report()),
    })).toThrow(/does not match the frozen profile digest/);
  });

  it('computes the raw report digest from the captured bytes and rejects a mismatched collector record', () => {
    expect(() => validate(report(), { expectedRawReportDigest: digest('not-the-captured-report') })).toThrow(/do not match the trusted collector digest/);
    const tooLarge = new Uint8Array(MAX_RAW_COMPARATOR_REPORT_BYTES + 1);
    expect(() => validateTrustedComparatorReport({
      evaluator_profile: profile,
      frozen_evaluator_profile_digest: digestTrustedComparatorProfile(profile),
      solution_artifact_manifest_digest: digests.artifactManifest,
      captured_report: { bytes: tooLarge, expected_raw_report_digest: `sha256:${createHash('sha256').update(tooLarge).digest('hex')}` as Digest },
    })).toThrow(/must contain between 1 and/);
  });

  it('uses the exact pinned policy while allowing a proof to use only a subset, and records a known unapproved axiom as rejected', () => {
    const rejectedChecks: ComparatorChecks = { ...passingChecks, transitive_axioms: 'FAIL' };
    const rejected = validate(report({
      outcome: 'REJECTED',
      checks: rejectedChecks,
      used_transitive_axioms: ['Classical.choice', 'Unapproved.magic'],
    }));
    expect(rejected.outcome).toBe('REJECTED');
    expect(rejected.human_acceptance).toEqual({ status: 'PENDING', decision_id: null });

    expect(() => validate(report({
      permitted_axioms: ['Classical.choice'],
    }))).toThrow(/does not bind exactly/);
    expect(() => validate(report({
      used_transitive_axioms: ['Classical.choice', 'Unapproved.magic'],
    }))).toThrow(/cannot use an axiom outside/);
  });

  it('refuses worker exit/status and acceptance claims instead of treating them as evaluator or human proof', () => {
    expect(() => validate(report({ worker_exit_code: 0 }))).toThrow(/worker_exit_code is not a supported property/);
    expect(() => validate(report({ worker_status: 'succeeded' }))).toThrow(/worker_status is not a supported property/);
    expect(() => validate(report({ accepted: true }))).toThrow(/accepted is not a supported property/);
    expect(() => validate(report({ human_acceptance: { status: 'ACCEPTED', decision_id: 'forged' } }))).toThrow(/human_acceptance is not a supported property/);
  });

  it('preserves an unknown axiom set after failed or incomplete evaluation without treating it as empty', () => {
    const incomplete = validate(report({ outcome: 'INCONCLUSIVE', used_transitive_axioms: null,
      checks: { ...passingChecks, exported_terms: 'UNRESOLVED', transitive_axioms: 'UNRESOLVED', kernel_replay: 'UNRESOLVED' } }));
    expect(incomplete.used_transitive_axioms).toBeNull();
    expect(incomplete.outcome).toBe('INCONCLUSIVE');
    const rejected = validate(report({ outcome: 'REJECTED', used_transitive_axioms: null,
      checks: { ...passingChecks, protected_build: 'FAIL', transitive_axioms: 'UNRESOLVED', kernel_replay: 'UNRESOLVED' } }));
    expect(rejected.used_transitive_axioms).toBeNull();
    expect(rejected.human_acceptance.status).toBe('PENDING');
    expect(() => validate(report({ used_transitive_axioms: null }))).toThrow(/unknown transitive axiom set/);
    expect(() => validate(report({ outcome: 'INCONCLUSIVE', used_transitive_axioms: null,
      checks: { ...passingChecks, kernel_replay: 'UNRESOLVED' } }))).toThrow(/unknown transitive axiom set/);
    expect(validate(report({ used_transitive_axioms: [] })).used_transitive_axioms).toEqual([]);
  });
});
