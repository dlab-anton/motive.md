import { canonicalJson, digestCanonicalJson } from '../../domain/src/contracts.ts';
import { SandboxAdapterError } from './errors.ts';
import { validateProtectedRuntime } from './protected-runtime.ts';
import type { Digest, SandboxExecutionProfile } from './types.ts';

export const PROVIDER_UNTRUSTED_DATA_RUNTIME_FORMAT = 'motive.circle-provider-untrusted-runtime/0.1' as const;

export type ProviderUntrustedDataRuntime = {
  format: typeof PROVIDER_UNTRUSTED_DATA_RUNTIME_FORMAT;
  provider: 'vercel';
  purpose: 'circle-packing-data';
  filesystemClaim: 'none';
  outputTrust: 'untrusted';
  runtimeDigest: Digest;
};

export type WorkerExecutionBoundary =
  | { kind: 'protected-runtime'; runtimeDigest: Digest }
  | { kind: 'provider-untrusted-circle-data'; runtimeDigest: Digest };

function invalid(): never {
  throw new SandboxAdapterError('SANDBOX_POLICY_INVALID', 'Worker execution requires exactly one valid execution boundary.');
}

export function defineProviderUntrustedDataRuntime(): ProviderUntrustedDataRuntime {
  const contract = { format: PROVIDER_UNTRUSTED_DATA_RUNTIME_FORMAT, provider: 'vercel' as const,
    purpose: 'circle-packing-data' as const, filesystemClaim: 'none' as const, outputTrust: 'untrusted' as const };
  return { ...contract, runtimeDigest: digestCanonicalJson(contract) };
}

export function validateProviderUntrustedDataRuntime(value: unknown): asserts value is ProviderUntrustedDataRuntime {
  const expected = defineProviderUntrustedDataRuntime();
  try { if (canonicalJson(value) !== canonicalJson(expected)) invalid(); }
  catch { invalid(); }
}

export function requireWorkerExecutionBoundary(profile: SandboxExecutionProfile): WorkerExecutionBoundary {
  const hasProtected = profile.protectedRuntime !== undefined;
  const hasProvider = profile.providerUntrustedDataRuntime !== undefined;
  if (hasProtected === hasProvider) invalid();
  if (hasProtected) {
    validateProtectedRuntime(profile.protectedRuntime);
    return { kind: 'protected-runtime', runtimeDigest: profile.protectedRuntime.runtimeDigest };
  }
  validateProviderUntrustedDataRuntime(profile.providerUntrustedDataRuntime);
  return { kind: 'provider-untrusted-circle-data', runtimeDigest: profile.providerUntrustedDataRuntime.runtimeDigest };
}
