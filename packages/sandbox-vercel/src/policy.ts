import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { posix } from 'node:path';
import type { NetworkPolicy, NetworkPolicyRule } from '@vercel/sandbox';
import { SandboxAdapterError } from './errors.ts';
import { validateProtectedRuntime } from './protected-runtime.ts';
import { validateProviderUntrustedDataRuntime } from './execution-boundary.ts';
import {
  MAX_COMMAND_TIMEOUT_MS,
  MAX_SANDBOX_TIMEOUT_MS,
  MAX_SANDBOX_VCPUS,
  SANDBOX_PROFILE_FORMAT,
  WORKSPACE_ROOT,
  type Digest,
  type EgressRule,
  type SandboxExecutionProfile,
  type TrustedSource,
} from './types.ts';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SNAPSHOT_ID = /^snap_[A-Za-z0-9][A-Za-z0-9_-]{5,255}$/;
const IMAGE_BY_DIGEST = /^.+@sha256:[a-f0-9]{64}$/;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const EXECUTABLE = /^(?:\/[A-Za-z0-9._+-]+)+$/;
const PRIVATE_CIDRS = [
  '127.0.0.0/8',
  '10.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
] as const;
const PROVIDER_SUPPORTED_PRIVATE_CIDRS = PRIVATE_CIDRS.filter(cidr => !cidr.includes(':'));

function invalid(message: string): never {
  throw new SandboxAdapterError('SANDBOX_POLICY_INVALID', message);
}

export function assertDigest(value: string, field: string): asserts value is Digest {
  if (!DIGEST.test(value)) invalid(`${field} must be a lowercase sha256 digest.`);
}

export function assertRecordedOperationId(value: string): void {
  if (!OPERATION_ID.test(value)) invalid('A recorded intent must contain a stable operationId.');
}

/** Validates truthful source provenance: a real Git commit or a manifest snapshot digest, never both. */
export function validateTrustedSourceIdentity(source: TrustedSource): void {
  const hasCommit = Object.prototype.hasOwnProperty.call(source, 'sourceCommit');
  const hasSnapshotDigest = Object.prototype.hasOwnProperty.call(source, 'sourceSnapshotDigest');
  if (hasCommit === hasSnapshotDigest) invalid('trustedSource must contain exactly one source identity.');
  if (hasCommit) {
    if (typeof source.sourceCommit !== 'string' || !COMMIT.test(source.sourceCommit)) {
      invalid('trustedSource.sourceCommit must be a full lowercase 40- or 64-character Git commit ID.');
    }
    return;
  }
  if (typeof source.sourceSnapshotDigest !== 'string') {
    invalid('trustedSource.sourceSnapshotDigest must be a lowercase sha256 digest.');
  }
  assertDigest(source.sourceSnapshotDigest, 'trustedSource.sourceSnapshotDigest');
}

function assertFiniteInteger(value: number, field: string, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalid(`${field} must be an integer between ${minimum} and ${maximum}.`);
  }
}

function parseEgressRule(rule: EgressRule, field: string): { host: string; rule: NetworkPolicyRule } {
  let url: URL;
  try {
    url = new URL(rule.url);
  } catch {
    return invalid(`${field}.url must be a valid URL.`);
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    invalid(`${field}.url must be an HTTPS URL with no credentials, port, query, or fragment.`);
  }
  if (
    url.hostname === 'localhost' ||
    url.hostname.includes('*') ||
    !url.hostname.includes('.') ||
    isIP(url.hostname) !== 0
  ) {
    invalid(`${field}.url must name an explicit public DNS host.`);
  }
  if (rule.methods.length === 0 || new Set(rule.methods).size !== rule.methods.length) {
    invalid(`${field}.methods must be a non-empty list without duplicates.`);
  }
  if (rule.pathMatch === 'prefix' && !url.pathname.endsWith('/')) {
    invalid(`${field} prefix URLs must end in / so sibling paths are not admitted.`);
  }
  return {
    host: url.hostname,
    rule: {
      match: {
        method: [...rule.methods],
        path: rule.pathMatch === 'exact'
          ? { exact: url.pathname }
          : { startsWith: url.pathname },
      },
      // The SDK's record form requires a rule action. An empty transform keeps
      // the request unchanged while retaining L7 method/path matching.
      transform: [],
    },
  };
}

export function buildNetworkPolicy(profile: SandboxExecutionProfile): NetworkPolicy {
  const entries = [...profile.egress.gateway, ...profile.egress.artifacts, ...(profile.egress.mcp ?? [])];
  if (profile.providerUntrustedDataRuntime !== undefined) {
    validateProviderUntrustedDataRuntime(profile.providerUntrustedDataRuntime);
    if (profile.egress.gateway.length !== 1 || profile.egress.gateway[0]?.pathMatch !== 'exact'
        || profile.egress.gateway[0].methods.length !== 1 || profile.egress.gateway[0].methods[0] !== 'POST') {
      invalid('Provider-untrusted circle data requires exactly one exact POST gateway rule.');
    }
    if (profile.egress.artifacts.length !== 0 || (profile.egress.mcp?.length ?? 0) !== 0) {
      invalid('Provider-untrusted circle data forbids artifact and MCP egress.');
    }
    const gateway = profile.egress.gateway[0]!;
    const parsed = parseEgressRule(gateway, 'egress.gateway[0]');
    const proxy = profile.egress.gatewayProxy;
    if (!proxy || Object.keys(proxy).sort().join(',') !== 'format,url'
        || proxy.format !== 'motive.vercel-gateway-proxy/0.1') {
      invalid('Provider-untrusted circle data requires the closed Vercel gateway proxy contract.');
    }
    const expectedProxy = new URL('/api/sandbox-egress', gateway.url).href;
    if (proxy.url !== expectedProxy) {
      invalid('The Vercel gateway proxy must be the fixed same-origin /api/sandbox-egress endpoint.');
    }
    return {
      allow: { [parsed.host]: [{ forwardURL: proxy.url }] },
      // The provider API rejected IPv6 CIDRs with HTTP 400 on 2026-09-08.
      // Its domain allow map still excludes literal IPv6 destinations.
      subnets: { deny: [...PROVIDER_SUPPORTED_PRIVATE_CIDRS] },
    };
  } else {
    if (profile.egress.gatewayProxy !== undefined) invalid('The Vercel gateway proxy is only valid for provider-untrusted circle data.');
    if (profile.egress.gateway.length === 0) invalid('At least one gateway egress rule is required.');
    if (profile.egress.artifacts.length === 0) invalid('At least one artifact egress rule is required.');
  }
  const allow: Record<string, NetworkPolicyRule[]> = {};
  entries.forEach((entry, index) => {
    const parsed = parseEgressRule(entry, `egress rule ${index}`);
    (allow[parsed.host] ??= []).push(parsed.rule);
  });
  return { allow, subnets: { deny: [...PRIVATE_CIDRS] } };
}

export function validateProfile(profile: SandboxExecutionProfile): void {
  if (profile.format !== SANDBOX_PROFILE_FORMAT) invalid(`profile.format must be ${SANDBOX_PROFILE_FORMAT}.`);
  assertDigest(profile.profileDigest, 'profileDigest');
  if (profile.protectedRuntime !== undefined) validateProtectedRuntime(profile.protectedRuntime);
  if (profile.providerUntrustedDataRuntime !== undefined) validateProviderUntrustedDataRuntime(profile.providerUntrustedDataRuntime);
  if (profile.protectedRuntime !== undefined && profile.providerUntrustedDataRuntime !== undefined) {
    invalid('A sandbox profile cannot claim both protected and provider-untrusted execution boundaries.');
  }
  assertDigest(profile.trustedSource.materialDigest, 'trustedSource.materialDigest');
  assertDigest(profile.trustedSource.buildRecipeDigest, 'trustedSource.buildRecipeDigest');
  validateTrustedSourceIdentity(profile.trustedSource);
  if (profile.trustedSource.kind === 'snapshot') {
    if (!SNAPSHOT_ID.test(profile.trustedSource.snapshotId)) invalid('trustedSource.snapshotId is invalid.');
  } else if (!IMAGE_BY_DIGEST.test(profile.trustedSource.image)) {
    invalid('trustedSource.image must be pinned with @sha256:<64 lowercase hex>.');
  }
  assertFiniteInteger(profile.timeoutMs, 'timeoutMs', 1_000, MAX_SANDBOX_TIMEOUT_MS);
  assertFiniteInteger(profile.commandTimeoutMs, 'commandTimeoutMs', 1_000, MAX_COMMAND_TIMEOUT_MS);
  if (profile.commandTimeoutMs > profile.timeoutMs) invalid('commandTimeoutMs cannot exceed timeoutMs.');
  assertFiniteInteger(profile.vcpus, 'vcpus', 1, MAX_SANDBOX_VCPUS);
  assertFiniteInteger(profile.artifacts.maxFiles, 'artifacts.maxFiles', 1, 10_000);
  assertFiniteInteger(profile.artifacts.maxFileBytes, 'artifacts.maxFileBytes', 1, 2_147_483_647);
  assertFiniteInteger(profile.artifacts.maxTotalBytes, 'artifacts.maxTotalBytes', 1, 2_147_483_647);
  if (profile.artifacts.maxFileBytes > profile.artifacts.maxTotalBytes) {
    invalid('artifacts.maxFileBytes cannot exceed artifacts.maxTotalBytes.');
  }
  if (
    profile.allowedExecutables.length === 0 ||
    profile.allowedExecutables.some(value => !EXECUTABLE.test(value)) ||
    new Set(profile.allowedExecutables).size !== profile.allowedExecutables.length
  ) {
    invalid('allowedExecutables must contain unique absolute executable paths.');
  }
  buildNetworkPolicy(profile);
}

export function sandboxName(attemptId: string, leaseEpoch: number): string {
  if (attemptId.length === 0 || attemptId.length > 512) invalid('attemptId is invalid.');
  assertFiniteInteger(leaseEpoch, 'leaseEpoch', 1, 2_147_483_647);
  const identity = createHash('sha256').update(`${attemptId}\0${leaseEpoch}`).digest('hex').slice(0, 32);
  return `motive-w-${identity}`;
}

export function ownerTags(attemptId: string, leaseEpoch: number, profileDigest: Digest): Record<string, string> {
  const attemptHash = createHash('sha256').update(attemptId).digest('hex').slice(0, 16);
  return {
    'motive-owner': 'control',
    'motive-kind': 'worker',
    'motive-attempt': attemptHash,
    'motive-epoch': String(leaseEpoch),
    'motive-profile': profileDigest.slice(-16),
  };
}

export function resolveWorkspacePath(relativePath: string, field = 'path'): string {
  if (
    relativePath.length === 0 ||
    relativePath.length > 4_096 ||
    relativePath.includes('\\') ||
    relativePath.includes('\0') ||
    /[\u0000-\u001f\u007f]/.test(relativePath) ||
    posix.isAbsolute(relativePath)
  ) {
    throw new SandboxAdapterError('SANDBOX_ARTIFACT_PATH_INVALID', `${field} must be a bounded POSIX relative path.`);
  }
  const segments = relativePath.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new SandboxAdapterError('SANDBOX_ARTIFACT_PATH_INVALID', `${field} contains a forbidden path segment.`);
  }
  const resolved = posix.resolve(WORKSPACE_ROOT, relativePath);
  if (!resolved.startsWith(`${WORKSPACE_ROOT}/`)) {
    throw new SandboxAdapterError('SANDBOX_ARTIFACT_PATH_INVALID', `${field} escapes the workspace root.`);
  }
  return resolved;
}
