import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { validateProfile } from '../../packages/sandbox-vercel/src/policy.ts';
import { requireWorkerExecutionBoundary } from '../../packages/sandbox-vercel/src/execution-boundary.ts';
import type { SandboxExecutionProfile } from '../../packages/sandbox-vercel/src/types.ts';

const MAX_RUNTIME_BUNDLE_BYTES = 512 * 1024;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const GLOB_META_OR_CONTROL = /[:*?()[\]{}!\x00-\x1f\x7f]/;
const FORBIDDEN_SEGMENT = /^(?:\.env.*|node_modules|\.git|\.vercel|artifacts?|archives?)$/i;
const SECRET_NAME = /(?:^|[._-])(?:secret|token|password|credential|private[-_]?key|service[-_]?role)(?:[._-]|$)/i;
const CANDIDATE_COLLECTOR = 'sha256:7c61c00cc179a9e31b54e76e6164ae96edf53551e4467207e9d3ec68a312655a';
const LEARNING_COLLECTOR = 'sha256:94752a6e677741a93bebfe13fe97d8525bfbe1d13582e55d39d03837f9300415';

type EnvironmentSource = Readonly<Record<string, string | undefined>>;

export type TriggerRuntimeAsset = Readonly<{
  /** Project-root-relative path retained by Trigger's additionalFiles extension. */
  relativePath: string;
  /** Exact non-glob matcher passed to additionalFiles. */
  matcher: string;
  digest: `sha256:${string}`;
}>;

function fail(reason: string): never {
  throw new Error(`TRIGGER_RUNTIME_ASSET_INVALID:${reason}`);
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function exactKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return required.every(key => keys.includes(key))
    && keys.every(key => required.includes(key) || optional.includes(key));
}

function acceptedRuntime(value: unknown): boolean {
  const top = ['format', 'gatewayUrl', 'inferenceProfileDigest', 'sandbox', 'infrastructureAuthorizationId',
    'maximumCostUsd', 'capabilityTtlSeconds', 'nativeCollection'] as const;
  if (!exactKeys(value, top)) return false;
  const runtime = value;
  if (runtime.format !== 'motive.circle-project-run-runtime/0.1'
      || typeof runtime.gatewayUrl !== 'string'
      || typeof runtime.inferenceProfileDigest !== 'string' || !SHA256.test(runtime.inferenceProfileDigest)
      || typeof runtime.infrastructureAuthorizationId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runtime.infrastructureAuthorizationId)
      || typeof runtime.maximumCostUsd !== 'string'
      || !/^(?=.*[1-9])(?:0|[1-9]\d*)(?:\.\d{1,12})?$/.test(runtime.maximumCostUsd)
      || !Number.isSafeInteger(runtime.capabilityTtlSeconds)
      || (runtime.capabilityTtlSeconds as number) < 30 || (runtime.capabilityTtlSeconds as number) > 300) return false;
  try {
    const url = new URL(runtime.gatewayUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
        || url.hostname === 'localhost' || !url.hostname.includes('.') || isIP(url.hostname) !== 0) return false;
  } catch { return false; }

  if (!exactKeys(runtime.sandbox, ['format', 'profileDigest', 'trustedSource', 'timeoutMs',
    'commandTimeoutMs', 'vcpus', 'allowedExecutables', 'egress', 'artifacts'],
    ['protectedRuntime', 'providerUntrustedDataRuntime'])) return false;
  const sandbox = runtime.sandbox;
  const protectedBoundary = Object.hasOwn(sandbox, 'protectedRuntime');
  const providerBoundary = Object.hasOwn(sandbox, 'providerUntrustedDataRuntime');
  if (protectedBoundary === providerBoundary) return false;
  if (protectedBoundary && !exactKeys(sandbox.protectedRuntime, ['format', 'policy', 'runtimeDigest', 'launcherPath', 'launcherDigest',
    'workerUid', 'workerGid', 'workspaceRoot', 'homeRoot', 'temporaryRoot', 'codexHome', 'codexSqliteHome'])) return false;
  if (providerBoundary && !exactKeys(sandbox.providerUntrustedDataRuntime,
    ['format', 'provider', 'purpose', 'filesystemClaim', 'outputTrust', 'runtimeDigest'])) return false;
  if (!exactKeys(sandbox.trustedSource, ['kind', 'materialDigest', 'buildRecipeDigest'],
    ['snapshotId', 'image', 'sourceCommit', 'sourceSnapshotDigest'])) return false;
  const source = sandbox.trustedSource;
  const sourceVariant = source.kind === 'snapshot'
    ? exactKeys(source, ['kind', 'snapshotId', 'materialDigest', 'buildRecipeDigest'], ['sourceCommit', 'sourceSnapshotDigest'])
    : source.kind === 'image'
      && exactKeys(source, ['kind', 'image', 'materialDigest', 'buildRecipeDigest'], ['sourceCommit', 'sourceSnapshotDigest']);
  if (!sourceVariant || !exactKeys(sandbox.egress, ['gateway', 'artifacts'], ['mcp', 'gatewayProxy'])
      || !exactKeys(sandbox.artifacts, ['maxFiles', 'maxFileBytes', 'maxTotalBytes'])) return false;
  const egress = sandbox.egress;
  if (egress.gatewayProxy !== undefined && !exactKeys(egress.gatewayProxy, ['format', 'url'])) return false;
  for (const group of [egress.gateway, egress.artifacts, ...(egress.mcp === undefined ? [] : [egress.mcp])]) {
    if (!Array.isArray(group) || group.some(rule => !exactKeys(rule, ['url', 'methods', 'pathMatch']))) return false;
  }
  try {
    validateProfile(sandbox as unknown as SandboxExecutionProfile);
    requireWorkerExecutionBoundary(sandbox as unknown as SandboxExecutionProfile);
  } catch { return false; }
  if (!(sandbox.allowedExecutables as unknown[]).includes('/usr/local/bin/codex')
      || !(egress.gateway as unknown[]).some(rule => (rule as Record<string, unknown>).url === runtime.gatewayUrl
        && (rule as Record<string, unknown>).pathMatch === 'exact'
        && JSON.stringify((rule as Record<string, unknown>).methods) === '["POST"]')) return false;

  if (!exactKeys(runtime.nativeCollection,
    ['collectorRuntimeDigest', 'maximumFileBytes', 'maximumTotalBytes', 'approvedPaths'])) return false;
  const collection = runtime.nativeCollection;
  if (typeof collection.collectorRuntimeDigest !== 'string' || !SHA256.test(collection.collectorRuntimeDigest)
      || collection.maximumFileBytes !== 32 * 1024 || !Array.isArray(collection.approvedPaths)) return false;
  if (collection.approvedPaths.some(path => !exactKeys(path,
    ['relativePath', 'mediaType', 'availability', 'maximumBytes']))) return false;
  const candidate = collection.approvedPaths[0] as Record<string, unknown> | undefined;
  if (candidate?.relativePath !== 'candidate.json' || candidate.mediaType !== 'application/json'
      || candidate.availability !== 'REQUIRED' || candidate.maximumBytes !== 32 * 1024) return false;
  if (collection.approvedPaths.length === 1) {
    return collection.collectorRuntimeDigest === CANDIDATE_COLLECTOR
      && collection.maximumTotalBytes === 32 * 1024;
  }
  const investigation = collection.approvedPaths[1] as Record<string, unknown> | undefined;
  return collection.approvedPaths.length === 2 && collection.collectorRuntimeDigest === LEARNING_COLLECTOR
    && collection.maximumTotalBytes === 48 * 1024
    && investigation?.relativePath === 'investigation.json' && investigation.mediaType === 'application/json'
    && investigation.availability === 'OPTIONAL_ON_FAILURE' && investigation.maximumBytes === 16 * 1024;
}

/**
 * Resolves the one reviewed runtime bundle copied into a Trigger build.
 * The operator supplies both its project-relative path and a digest of its exact bytes.
 */
export function resolveTriggerRuntimeAsset(
  env: EnvironmentSource = process.env,
  projectRoot = process.cwd(),
): TriggerRuntimeAsset {
  const configuredPath = env.MOTIVE_CIRCLE_RUN_RUNTIME_FILE?.trim();
  const configuredDigest = env.MOTIVE_CIRCLE_RUN_RUNTIME_SHA256?.trim();
  if (!configuredPath) fail('MOTIVE_CIRCLE_RUN_RUNTIME_FILE_REQUIRED');
  if (!configuredDigest || !SHA256.test(configuredDigest)) fail('MOTIVE_CIRCLE_RUN_RUNTIME_SHA256_REQUIRED');
  if (isAbsolute(configuredPath) || GLOB_META_OR_CONTROL.test(configuredPath)) {
    fail('PATH_MUST_BE_ONE_RELATIVE_FILE');
  }

  const normalizedInput = configuredPath.replaceAll('\\', '/').replace(/^\.\//, '');
  const segments = normalizedInput.split('/');
  if (segments.length === 0 || segments.some(segment => !segment || segment === '.' || segment === '..')) {
    fail('PATH_MUST_BE_ONE_RELATIVE_FILE');
  }
  if (!normalizedInput.endsWith('.json') || segments.some(segment => FORBIDDEN_SEGMENT.test(segment))
      || SECRET_NAME.test(segments.at(-1) ?? '')) {
    fail('PATH_NOT_ALLOWED');
  }

  const root = resolve(projectRoot);
  const absolute = resolve(root, ...segments);
  const inside = relative(root, absolute);
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    fail('PATH_OUTSIDE_PROJECT');
  }

  let cursor = root;
  for (const segment of segments) {
    cursor = resolve(cursor, segment);
    let stat;
    try { stat = lstatSync(cursor); } catch { fail('FILE_NOT_FOUND'); }
    if (stat.isSymbolicLink()) fail('SYMLINK_NOT_ALLOWED');
  }
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.size < 2 || stat.size > MAX_RUNTIME_BUNDLE_BYTES) fail('REGULAR_FILE_REQUIRED');

  const bytes = readFileSync(absolute);
  const actualDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;
  if (actualDigest !== configuredDigest) fail('DIGEST_MISMATCH');

  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('JSON_INVALID'); }
  if (!exactObject(parsed, ['format', 'runtime'])
      || parsed.format !== 'motive.circle-project-run-deployment/0.1'
      || !acceptedRuntime(parsed.runtime)) {
    fail('ACCEPTED_WRAPPER_REQUIRED');
  }

  return Object.freeze({
    relativePath: normalizedInput,
    matcher: `./${normalizedInput}`,
    digest: actualDigest,
  });
}
