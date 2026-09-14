import { statSync, writeFileSync } from 'node:fs';
import {
  EvaluatorContractError,
  LEAN_COMPARATOR_PROFILE_FORMAT,
  validateTrustedComparatorProfile,
  type TrustedComparatorProfile,
} from '../src/contract.ts';

const fixtureRoot = '/opt/evaluator/fixtures/sources';
const destination = '/work/prepared';
const digest = `sha256:${'0'.repeat(64)}` as const;

const baseline: TrustedComparatorProfile = {
  format: LEAN_COMPARATOR_PROFILE_FORMAT,
  profile_id: 'fixture-ingestion-policy',
  challenge: {
    challenge_digest: digest,
    dependency_lock_digest: digest,
    trusted_build_config_digest: digest,
    challenge_module: 'Challenge',
    solution_module: 'Solution',
    theorem_names: ['Challenge.target'],
    allowed_solution_paths: ['Solution.lean'],
  },
  toolchain: {
    lean: { version: 'v4.34.0-rc2', digest },
    lake: { version: '5.0.0-src+6a10ac8', digest },
    landrun: { commit: '5ed4a3db3a4ad930d577215c6b9abaa19df7f99f', digest },
    lean4export: { version: 'cacf989bd75f608700820f6afc595f32e7a99a4d', digest },
    comparator: { commit: '2312244ac716564a61cc0bf4e107d9abf1757a61', digest },
    export_config_digest: digest,
    comparator_config_digest: digest,
  },
  permitted_axioms: [],
  isolation: {
    host_os: 'linux',
    user: 'nonprivileged',
    outer_restriction: 'systemd-run --user --property=RestrictAddressFamilies=~AF_UNIX',
    candidate_oleans: 'forbidden',
  },
};

function requireFixture(relativePath: string): void {
  const stat = statSync(`${fixtureRoot}/${relativePath}`, { throwIfNoEntry: true });
  if (!stat.isFile()) throw new Error(`Fixture is not a regular file: ${relativePath}`);
}

function expectProfileRejection(
  caseId: string,
  relativeFixture: string,
  allowedSolutionPaths: readonly string[],
  expectedMessage: string,
): void {
  requireFixture(relativeFixture);
  try {
    validateTrustedComparatorProfile({
      ...baseline,
      challenge: { ...baseline.challenge, allowed_solution_paths: allowedSolutionPaths },
    });
  } catch (error) {
    if (!(error instanceof EvaluatorContractError)
        || error.code !== 'PROFILE_INVALID'
        || !error.message.includes(expectedMessage)) {
      throw error;
    }
    writeFileSync(
      `${destination}/${caseId}.status`,
      `REJECTED_PRE_EXECUTION PROFILE_INVALID: ${error.message}\n`,
      { encoding: 'utf8', mode: 0o444, flag: 'wx' },
    );
    return;
  }
  throw new Error(`${caseId} was accepted by the trusted evaluator profile policy`);
}

validateTrustedComparatorProfile(baseline);
expectProfileRejection(
  'altered-challenge',
  'altered-challenge/Challenge.lean',
  ['Challenge.lean', 'Solution.lean'],
  'may not include the trusted challenge module source path',
);
expectProfileRejection(
  'modified-build-or-checker',
  'modified-build-or-checker/lakefile.toml',
  ['Solution.lean', 'lakefile.toml'],
  'must name a curated .lean source file',
);
