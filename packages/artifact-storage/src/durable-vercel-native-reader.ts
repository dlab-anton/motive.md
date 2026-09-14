import { canonicalJson } from '../../domain/src/contracts.ts';
import type { ControllerLease, NativeCollectionStore, WorkerWorkspaceBindingStore } from '../../orchestration/src/store-types.ts';
import { ClaimedNativeCollectorExecutor } from './claimed-native-collector.ts';
import { requireProtectedRuntime, type SandboxHandle } from '../../sandbox-vercel/src/index.ts';
import { ArtifactStorageError, validateArtifactRelativePath } from './sealer.ts';
import type { SafeArtifactReader, SafeArtifactSnapshot } from './types.ts';
import {
  StaticReviewedVercelNativeArtifactRuntimeRegistry,
  VercelNativeArtifactReader,
  type FrozenVercelNativeWorkspaceBinding,
  type VercelNativeArtifactReaderOptions,
} from './vercel-native-reader.ts';

export type DurableVercelNativeArtifactReaderOptions = Omit<VercelNativeArtifactReaderOptions, 'bindings'> & {
  store: WorkerWorkspaceBindingStore;
  /** One collector instance is scoped to one persisted environment and lease. */
  context: { lease: ControllerLease; environmentId: string; handle: SandboxHandle };
};

/** Persists the first protected marker before any candidate bytes are captured.
 * A restarted collector uses the saved identity; it cannot silently adopt a
 * replacement. Native transport activation remains suspended by default. */
export class DurableVercelNativeArtifactReader implements SafeArtifactReader {
  private readonly options: DurableVercelNativeArtifactReaderOptions;

  constructor(options: DurableVercelNativeArtifactReaderOptions) {
    const profile = structuredClone(options.profile);
    const runtime = options.runtimeRegistry.resolve(profile);
    if (!runtime) throw new ArtifactStorageError('VERCEL_NATIVE_RUNTIME_UNREVIEWED', 'Native collector runtime is unreviewed.');
    this.options = { ...options, profile, context: structuredClone(options.context),
      runtimeRegistry: new StaticReviewedVercelNativeArtifactRuntimeRegistry([runtime]) };
    // Validate the full registry/profile/protected launcher contract before
    // any database or provider access, even while activation is suspended.
    this.reader([]);
    if (this.options.context.lease.attemptId !== this.options.context.handle.attemptId) {
      throw new ArtifactStorageError('VERCEL_NATIVE_HANDLE_INVALID', 'Collector lease belongs to a different attempt.');
    }
  }

  assertReady(input: { signal: AbortSignal }): ReturnType<SafeArtifactReader['assertReady']> {
    return this.reader([]).assertReady(input);
  }

  async capture(input: Parameters<SafeArtifactReader['capture']>[0]): Promise<SafeArtifactSnapshot | null> {
    const { store, context, profile } = this.options;
    await this.assertReady({ signal: input.signal });
    this.assertNotAborted(input.signal);
    validateArtifactRelativePath(input.relativePath);
    if (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes < 1 || input.maximumBytes > 8 * 1024 * 1024
      || !Number.isSafeInteger(input.maximumChunkBytes) || input.maximumChunkBytes < 1 || input.maximumChunkBytes > 8 * 1024 * 1024) {
      throw new ArtifactStorageError('VERCEL_NATIVE_LIMIT_INVALID', 'Native capture limits must be finite and bounded.');
    }
    if (canonicalJson(input.handle) !== canonicalJson(context.handle)) {
      throw new ArtifactStorageError('VERCEL_NATIVE_HANDLE_INVALID', 'Collector is scoped to a different worker session.');
    }
    let saved = await store.getWorkerWorkspaceBinding(context.lease, context.environmentId);
    this.assertNotAborted(input.signal);
    const workerRuntimeDigest = requireProtectedRuntime(profile).runtimeDigest;
    if (!saved) {
      const binding = await this.reader([]).readBootstrap({ handle: context.handle, signal: input.signal });
      this.assertNotAborted(input.signal);
      if (this.options.collectorExecutor) {
        // The claimed bootstrap atomically completed and persisted its binding.
        saved = await store.getWorkerWorkspaceBinding(context.lease, context.environmentId);
        if (!saved || canonicalJson(saved.binding) !== canonicalJson(binding)) {
          throw new ArtifactStorageError('VERCEL_NATIVE_BINDING_INVALID', 'Claimed bootstrap binding was not committed.');
        }
      } else {
        saved = await store.recordWorkerWorkspaceBinding(context.lease, context.environmentId, { binding, workerRuntimeDigest });
      }
      this.assertNotAborted(input.signal);
    }
    if (saved.workerRuntimeDigest !== workerRuntimeDigest
      || canonicalJson(saved.binding.handle) !== canonicalJson(context.handle)) {
      throw new ArtifactStorageError('VERCEL_NATIVE_BINDING_INVALID', 'Persisted native binding belongs to a different runtime or session.');
    }
    return this.reader([saved.binding]).capture(input);
  }

  private reader(bindings: readonly FrozenVercelNativeWorkspaceBinding[]): VercelNativeArtifactReader {
    return new VercelNativeArtifactReader({ ...this.options, bindings });
  }

  private assertNotAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new ArtifactStorageError('VERCEL_NATIVE_LOG_DEADLINE', 'Native collection was cancelled.');
  }
}

/** Requires migration 012 and a collection plan frozen before VM creation.
 * Remains suspended by default, like the underlying native transport. */
export class ClaimedVercelNativeArtifactReader extends DurableVercelNativeArtifactReader {
  constructor(options: Omit<DurableVercelNativeArtifactReaderOptions, 'store' | 'collectorExecutor'> & {
    store: WorkerWorkspaceBindingStore & NativeCollectionStore;
  }) {
    super({ ...options, collectorExecutor: new ClaimedNativeCollectorExecutor(options.store, options.context) });
  }
}
