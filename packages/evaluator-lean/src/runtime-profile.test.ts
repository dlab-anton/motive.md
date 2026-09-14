import { describe, expect, it } from 'vitest';
import { digestCanonicalJson } from '../../domain/src/contracts.ts';
import { validateTrustedComparatorProfile } from './contract.ts';
import { digestRuntimeBoundComparatorProfile, requireFrozenRuntimeBoundProfile,
  validateRuntimeBoundComparatorProfile } from './runtime-profile.ts';

import { profile, hash, changedHash } from './runtime-profile.fixture.ts';

describe('runtime-bound evaluator profile', () => {
  it('uses a separate digest and refuses both directions of silent stock-profile reuse', () => {
    const frozen = digestRuntimeBoundComparatorProfile(profile);
    expect(requireFrozenRuntimeBoundProfile(profile, frozen)).toEqual(profile);
    expect(() => validateTrustedComparatorProfile(profile)).toThrow();
    const { runtime: _runtime, ...base } = profile;
    const stock = { ...base, format: 'motive.lean-comparator-profile/0.1' };
    expect(() => validateRuntimeBoundComparatorProfile(stock)).toThrow();
    expect(digestCanonicalJson(validateTrustedComparatorProfile(stock))).not.toBe(frozen);
  });
  it('fences substitutions of every added executable, source, image, and host identity', () => {
    const frozen = digestRuntimeBoundComparatorProfile(profile);
    const paths = [
      ['image_digest'], ['rootfs_digest'], ['review_evidence_digest'], ['kernel', 'digest'], ['systemd', 'digest'],
      ['util_linux', 'setpriv_digest'], ['util_linux', 'unshare_digest'], ['supervisor', 'binary_digest'],
      ['supervisor', 'source_digest'], ['reporter', 'binary_digest'], ['reporter', 'instrumentation_digest'],
      ['reporter', 'generated_module_digest'], ['launcher', 'entrypoint_digest'],
    ];
    for (const path of paths) {
      const changed = structuredClone(profile);
      const runtime = changed.runtime as unknown as Record<string, unknown>;
      if (path.length === 1) runtime[path[0]] = changedHash;
      else (runtime[path[0]] as Record<string, unknown>)[path[1]] = changedHash;
      expect(() => requireFrozenRuntimeBoundProfile(changed, frozen), path.join('.')).toThrow(/differs from the frozen profile/);
    }
    expect(() => requireFrozenRuntimeBoundProfile({ ...profile, runtime: { ...profile.runtime, host_kind: 'vercel-sandbox' } }, frozen)).toThrow();
  });
  it('refuses weaker isolation, candidate report locations, missing identities, and unknown fields', () => {
    for (const runtime of [
      { ...profile.runtime, egress: 'all' }, { ...profile.runtime, report_path: '/work/prepared/Solution.json' },
      { ...profile.runtime, kernel: { ...profile.runtime.kernel, release: '6.6.0' } },
      { ...profile.runtime, kernel: { ...profile.runtime.kernel, release: 'unknown' } },
      { ...profile.runtime, reporter: { ...profile.runtime.reporter, instrumentation_digest: undefined } },
      { ...profile.runtime, supervisor: { ...profile.runtime.supervisor, allow_fallback: true } },
    ]) expect(() => validateRuntimeBoundComparatorProfile({ ...profile, runtime })).toThrow();
  });
  it('retains challenge/source policy checks and returns an independent validated snapshot', () => {
    expect(() => validateRuntimeBoundComparatorProfile({ ...profile, challenge: { ...profile.challenge, allowed_solution_paths: ['Challenge.lean', 'Solution.lean'] } })).toThrow();
    const snapshot = validateRuntimeBoundComparatorProfile(profile);
    snapshot.runtime.reporter.binary_digest = changedHash;
    snapshot.challenge.allowed_solution_paths = ['Other.lean'];
    expect(profile.runtime.reporter.binary_digest).toBe(hash);
    expect(profile.challenge.allowed_solution_paths).toEqual(['Solution.lean']);
  });
});
