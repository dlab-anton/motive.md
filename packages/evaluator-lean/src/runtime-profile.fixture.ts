import { digestCanonicalJson } from '../../domain/src/contracts.ts';
import { RUNTIME_BOUND_PROFILE_FORMAT, type RuntimeBoundComparatorProfile } from './runtime-profile.ts';

export const hash = digestCanonicalJson('synthetic runtime test identity');
export const changedHash = digestCanonicalJson('changed runtime test identity');
export const profile: RuntimeBoundComparatorProfile = {
  format: RUNTIME_BOUND_PROFILE_FORMAT, profile_id: 'synthetic-runtime-test',
  challenge: { challenge_digest: hash, dependency_lock_digest: hash, trusted_build_config_digest: hash,
    challenge_module: 'Challenge', solution_module: 'Solution', theorem_names: ['target'], allowed_solution_paths: ['Solution.lean'] },
  toolchain: { lean: { version: 'test', digest: hash }, lake: { version: 'test', digest: hash },
    landrun: { commit: 'a'.repeat(40), digest: hash }, lean4export: { version: 'test', digest: hash },
    comparator: { commit: 'b'.repeat(40), digest: hash }, export_config_digest: hash, comparator_config_digest: hash },
  permitted_axioms: [], isolation: { host_os: 'linux', user: 'nonprivileged', candidate_oleans: 'forbidden',
    outer_restriction: 'systemd-run --user --property=RestrictAddressFamilies=~AF_UNIX' },
  runtime: {
    format: 'motive.lean-comparator-runtime/0.1', host_kind: 'local-qemu-review', image_digest: hash, rootfs_digest: hash, review_evidence_digest: hash,
    kernel: { release: '6.12.107-test', digest: hash }, systemd: { version: 'test', digest: hash },
    util_linux: { version: 'test', setpriv_digest: hash, unshare_digest: hash },
    supervisor: { format: 'motive.namespace-supervisor/0.1', binary_digest: hash, source_digest: hash },
    reporter: { format: 'motive.comparator-facts/0.1', binary_digest: hash, instrumentation_digest: hash, generated_module_digest: hash },
    launcher: { format: 'motive.comparator-launcher/0.1', entrypoint_digest: hash },
    egress: 'none', report_path: '/work/trusted-reports/report.json',
  },
};

