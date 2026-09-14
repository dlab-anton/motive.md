import { assertDigest, digestCanonicalJson, type Digest } from '../../domain/src/contracts.ts';
import { EvaluatorContractError, LEAN_COMPARATOR_PROFILE_FORMAT, validateTrustedComparatorProfile, type TrustedComparatorProfile } from './contract.ts';
import { COMPARATOR_FACTS_FORMAT } from './facts.ts';

/** A distinct profile format: historical stock profiles cannot identify the
 * additional reporter, namespace supervisor, launcher, or host runtime. */
export const RUNTIME_BOUND_PROFILE_FORMAT = 'motive.lean-comparator-profile/0.2' as const;
export type ComparatorRuntimeIdentity = {
  format: 'motive.lean-comparator-runtime/0.1';
  host_kind: 'local-qemu-review' | 'vercel-sandbox';
  image_digest: Digest;
  rootfs_digest: Digest;
  review_evidence_digest: Digest;
  kernel: { release: string; digest: Digest };
  systemd: { version: string; digest: Digest };
  util_linux: { version: string; setpriv_digest: Digest; unshare_digest: Digest };
  supervisor: { format: 'motive.namespace-supervisor/0.1'; binary_digest: Digest; source_digest: Digest };
  reporter: { format: typeof COMPARATOR_FACTS_FORMAT; binary_digest: Digest; instrumentation_digest: Digest; generated_module_digest: Digest };
  launcher: { format: 'motive.comparator-launcher/0.1'; entrypoint_digest: Digest };
  egress: 'none';
  report_path: '/work/trusted-reports/report.json';
};
export type RuntimeBoundComparatorProfile = Omit<TrustedComparatorProfile, 'format'> & {
  format: typeof RUNTIME_BOUND_PROFILE_FORMAT;
  runtime: ComparatorRuntimeIdentity;
};

function fail(path: string): never { throw new EvaluatorContractError('PROFILE_INVALID', `Invalid runtime-bound evaluator profile: ${path}.`); }
function object(input: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail(path);
  const record = input as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || !keys.every(key => Object.hasOwn(record, key))) fail(`${path} fields`);
  return record;
}
function digest(value: unknown, path: string): Digest {
  try { return assertDigest(value, path); } catch { return fail(path); }
}
function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.length || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) fail(path);
  return value;
}

export function validateComparatorRuntimeIdentity(input: unknown): ComparatorRuntimeIdentity {
  const value = object(input, 'runtime', ['format', 'host_kind', 'image_digest', 'rootfs_digest', 'review_evidence_digest',
    'kernel', 'systemd', 'util_linux', 'supervisor', 'reporter', 'launcher', 'egress', 'report_path']);
  if (value.format !== 'motive.lean-comparator-runtime/0.1'
    || (value.host_kind !== 'local-qemu-review' && value.host_kind !== 'vercel-sandbox')
    || value.egress !== 'none' || value.report_path !== '/work/trusted-reports/report.json') fail('runtime policy');
  const kernel = object(value.kernel, 'kernel', ['release', 'digest']);
  const release = text(kernel.release, 'kernel.release');
  const match = /^(\d+)\.(\d+)(?:\.|-)/u.exec(release);
  if (!match || Number(match[1]) < 6 || (Number(match[1]) === 6 && Number(match[2]) < 7)) fail('kernel minimum 6.7');
  const systemd = object(value.systemd, 'systemd', ['version', 'digest']);
  const util = object(value.util_linux, 'util_linux', ['version', 'setpriv_digest', 'unshare_digest']);
  const supervisor = object(value.supervisor, 'supervisor', ['format', 'binary_digest', 'source_digest']);
  const reporter = object(value.reporter, 'reporter', ['format', 'binary_digest', 'instrumentation_digest', 'generated_module_digest']);
  const launcher = object(value.launcher, 'launcher', ['format', 'entrypoint_digest']);
  if (supervisor.format !== 'motive.namespace-supervisor/0.1' || reporter.format !== COMPARATOR_FACTS_FORMAT
    || launcher.format !== 'motive.comparator-launcher/0.1') fail('runtime component format');
  return {
    format: value.format, host_kind: value.host_kind,
    image_digest: digest(value.image_digest, 'image_digest'), rootfs_digest: digest(value.rootfs_digest, 'rootfs_digest'),
    review_evidence_digest: digest(value.review_evidence_digest, 'review_evidence_digest'),
    kernel: { release, digest: digest(kernel.digest, 'kernel.digest') },
    systemd: { version: text(systemd.version, 'systemd.version'), digest: digest(systemd.digest, 'systemd.digest') },
    util_linux: { version: text(util.version, 'util_linux.version'), setpriv_digest: digest(util.setpriv_digest, 'setpriv_digest'), unshare_digest: digest(util.unshare_digest, 'unshare_digest') },
    supervisor: { format: supervisor.format, binary_digest: digest(supervisor.binary_digest, 'supervisor.binary_digest'), source_digest: digest(supervisor.source_digest, 'supervisor.source_digest') },
    reporter: { format: reporter.format, binary_digest: digest(reporter.binary_digest, 'reporter.binary_digest'), instrumentation_digest: digest(reporter.instrumentation_digest, 'reporter.instrumentation_digest'), generated_module_digest: digest(reporter.generated_module_digest, 'reporter.generated_module_digest') },
    launcher: { format: launcher.format, entrypoint_digest: digest(launcher.entrypoint_digest, 'launcher.entrypoint_digest') },
    egress: value.egress, report_path: value.report_path,
  };
}

/** Structural validation does not authorize dispatch. A reviewed registry must
 * supply the independently frozen digest and verify actual preflight evidence. */
export function validateRuntimeBoundComparatorProfile(input: unknown): RuntimeBoundComparatorProfile {
  const value = object(input, 'profile', ['format', 'profile_id', 'challenge', 'toolchain', 'permitted_axioms', 'isolation', 'runtime']);
  if (value.format !== RUNTIME_BOUND_PROFILE_FORMAT) fail('profile format');
  const { runtime, ...stockFields } = value;
  const stock = validateTrustedComparatorProfile({ ...stockFields, format: LEAN_COMPARATOR_PROFILE_FORMAT });
  return { ...stock, format: RUNTIME_BOUND_PROFILE_FORMAT, runtime: validateComparatorRuntimeIdentity(runtime) };
}

export function digestRuntimeBoundComparatorProfile(input: unknown): Digest {
  return digestCanonicalJson(validateRuntimeBoundComparatorProfile(input));
}

export function requireFrozenRuntimeBoundProfile(input: unknown, frozenDigest: Digest): RuntimeBoundComparatorProfile {
  const profile = validateRuntimeBoundComparatorProfile(input);
  if (digestCanonicalJson(profile) !== assertDigest(frozenDigest, 'frozen evaluator profile')) {
    throw new EvaluatorContractError('BINDING_MISMATCH', 'Evaluator runtime or challenge differs from the frozen profile.');
  }
  return profile;
}
