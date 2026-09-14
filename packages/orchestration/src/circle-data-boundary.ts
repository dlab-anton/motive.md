import type { SandboxExecutionProfile } from '../../sandbox-vercel/src/types.ts';
import type { FreezeNativeCollectionPlanInput } from './store-types.ts';

export const CIRCLE_CANDIDATE_COLLECTOR = 'sha256:7c61c00cc179a9e31b54e76e6164ae96edf53551e4467207e9d3ec68a312655a';
export const CIRCLE_LEARNING_COLLECTOR = 'sha256:94752a6e677741a93bebfe13fe97d8525bfbe1d13582e55d39d03837f9300415';

/** Exact data-only collection contracts allowed to cross the provider-untrusted boundary. */
export function isExactProviderCircleCollection(
  profile: SandboxExecutionProfile,
  collection: FreezeNativeCollectionPlanInput | undefined,
): boolean {
  if (!collection || collection.maximumFileBytes !== 32 * 1024) return false;
  const [candidate, investigation] = collection.approvedPaths;
  const exactCandidate = candidate?.relativePath === 'candidate.json'
    && candidate.mediaType === 'application/json' && candidate.availability === 'REQUIRED'
    && candidate.maximumBytes === 32 * 1024;
  if (!exactCandidate) return false;
  if (collection.collectorRuntimeDigest === CIRCLE_CANDIDATE_COLLECTOR) {
    return collection.maximumTotalBytes === 32 * 1024 && collection.approvedPaths.length === 1
      && profile.artifacts.maxFiles === 1 && profile.artifacts.maxFileBytes === 32 * 1024
      && profile.artifacts.maxTotalBytes === 32 * 1024;
  }
  return collection.collectorRuntimeDigest === CIRCLE_LEARNING_COLLECTOR
    && collection.maximumTotalBytes === 48 * 1024 && collection.approvedPaths.length === 2
    && investigation?.relativePath === 'investigation.json' && investigation.mediaType === 'application/json'
    && investigation.availability === 'OPTIONAL_ON_FAILURE' && investigation.maximumBytes === 16 * 1024
    && profile.artifacts.maxFiles === 2 && profile.artifacts.maxFileBytes === 32 * 1024
    && profile.artifacts.maxTotalBytes === 48 * 1024;
}
