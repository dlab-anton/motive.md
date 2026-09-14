import type { CoordinatorDependencies, WorkerLaunchPlan } from '../../orchestration/src/coordinator.ts';
import type { NativeCollectionStore, WorkerWorkspaceBindingStore } from '../../orchestration/src/store-types.ts';
import { ClaimedVercelNativeArtifactReader } from './durable-vercel-native-reader.ts';
import { ArtifactSealer, ArtifactStorageError, validateArtifactRelativePath } from './sealer.ts';
import type { ImmutableObjectStore, SafeArtifactReader } from './types.ts';
import { VercelNativeArtifactReader, type VercelNativeArtifactReaderOptions } from './vercel-native-reader.ts';

export type ClaimedNativeCollectorServiceOptions = Pick<VercelNativeArtifactReaderOptions,
  'runtimeRegistry' | 'transport' | 'activation' | 'commandTimeoutMs' | 'logTimeoutMs'> & {
  store: WorkerWorkspaceBindingStore & NativeCollectionStore;
  objectStore: ImmutableObjectStore;
};

/** Connects the coordinator's current lease, frozen file budget, claimed native
 * reader and immutable object sealer. Provider activation remains suspended
 * unless the caller explicitly selects the local-test mode. */
export function createClaimedNativeArtifactCollector(options: ClaimedNativeCollectorServiceOptions): CoordinatorDependencies['artifacts'] {
  function configuration(input: WorkerLaunchPlan): WorkerLaunchPlan {
    const plan = structuredClone(input);
    const collection = plan.nativeCollection;
    const runtime = options.runtimeRegistry.resolve(plan.sandbox);
    const limits = plan.sandbox.artifacts;
    if (!collection || !runtime || collection.collectorRuntimeDigest !== runtime.runtimeDigest
      || !Number.isSafeInteger(collection.maximumFileBytes) || collection.maximumFileBytes < 1
      || collection.maximumFileBytes > Math.min(limits.maxFileBytes, 8 * 1024 * 1024)
      || !Number.isSafeInteger(collection.maximumTotalBytes) || collection.maximumTotalBytes < collection.maximumFileBytes
      || collection.maximumTotalBytes > Math.min(limits.maxTotalBytes, 2_147_483_647)
      || !Array.isArray(collection.approvedPaths) || collection.approvedPaths.length < 1
      || collection.approvedPaths.length > limits.maxFiles) fail();
    const seen = new Set<string>(); let total = 0;
    for (const path of collection.approvedPaths) {
      validateArtifactRelativePath(path.relativePath);
      if (seen.has(path.relativePath) || path.relativePath === 'manifest.json'
        || !Number.isSafeInteger(path.maximumBytes) || path.maximumBytes < 1 || path.maximumBytes > collection.maximumFileBytes
        || (path.availability !== 'REQUIRED' && path.availability !== 'OPTIONAL_ON_FAILURE')
        || typeof path.mediaType !== 'string' || path.mediaType.length > 255
        || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(path.mediaType)) fail();
      seen.add(path.relativePath); total += path.maximumBytes;
    }
    if (!Number.isSafeInteger(total) || total > collection.maximumTotalBytes) fail();
    // Constructor verification binds the registry, source and protected runtime
    // before any database lookup or provider operation.
    new VercelNativeArtifactReader({ ...options, profile: plan.sandbox, bindings: [] });
    return plan;
  }

  function sealer(plan: WorkerLaunchPlan, reader: SafeArtifactReader): ArtifactSealer {
    const approved = plan.nativeCollection!.approvedPaths;
    return new ArtifactSealer({ store: options.objectStore,
      reader: {
        assertReady: input => reader.assertReady(input),
        capture(input) {
          const path = approved.find(path => path.relativePath === input.relativePath);
          if (!path || path.maximumBytes > input.maximumBytes) fail();
          return reader.capture({ ...input, maximumBytes: path.maximumBytes });
        },
      },
      policy: {
        async assertReady() { return { capability: 'trusted-operator-artifact-policy-v1' }; },
        async approvedPaths() { return approved.map(({ relativePath, mediaType, availability }) => ({ relativePath, mediaType, availability })); },
      },
    });
  }

  return {
    async assertReady(input) {
      const plan = configuration(input);
      const reader = new VercelNativeArtifactReader({ ...options, profile: plan.sandbox, bindings: [] });
      await sealer(plan, reader).assertReady(plan);
    },
    async seal(input) {
      const plan = configuration(input.plan);
      const reader = new ClaimedVercelNativeArtifactReader({ ...options, profile: plan.sandbox,
        context: { lease: input.lease, environmentId: input.environment.id, handle: input.handle } });
      return sealer(plan, reader).seal({ ...input, plan });
    },
  };
}

function fail(): never {
  throw new ArtifactStorageError('VERCEL_NATIVE_COLLECTION_PLAN_INVALID', 'Native collection requires an exact reviewed finite path budget.');
}
