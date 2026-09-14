import { createHash } from 'node:crypto';
import { canonicalJson } from '../../domain/src/contracts.ts';
import type { ControllerLease, NativeCollectionStore } from '../../orchestration/src/store-types.ts';
import type { SandboxHandle } from '../../sandbox-vercel/src/index.ts';
import { ArtifactStorageError } from './sealer.ts';
import {
  decodeNativeArtifactAsciiFrame, decodeNativeCollectorBootstrapFrame,
  VERCEL_NATIVE_WORKSPACE_BINDING_FORMAT,
  type VercelNativeCollectorExecutor, type VercelNativeCollectorResult,
} from './vercel-native-reader.ts';

/** One-shot helper execution against a plan frozen before worker VM creation.
 * Completed captures are recovered through the sealed artifact manifest. This
 * executor deliberately offers no provider log replay or replacement dispatch. */
export class ClaimedNativeCollectorExecutor implements VercelNativeCollectorExecutor {
  private readonly context: { lease: ControllerLease; environmentId: string; handle: SandboxHandle };

  constructor(private readonly store: NativeCollectionStore,
    context: { lease: ControllerLease; environmentId: string; handle: SandboxHandle }) {
    this.context = structuredClone(context);
  }

  async execute(input: Parameters<VercelNativeCollectorExecutor['execute']>[0]): Promise<VercelNativeCollectorResult> {
    const { lease, environmentId, handle } = this.context;
    assertActive(input.signal);
    if (canonicalJson(input.handle) !== canonicalJson(handle)) fail('VERCEL_NATIVE_HANDLE_INVALID');
    const plan = await this.store.getNativeCollectionPlan(lease, environmentId);
    assertActive(input.signal);
    if (!plan || plan.attemptId !== handle.attemptId || plan.leaseEpoch !== handle.leaseEpoch
      || plan.controllerGeneration !== lease.controllerGeneration
      || plan.profileDigest !== handle.profileDigest || plan.collectorRuntimeDigest !== input.runtimeDigest) {
      fail('VERCEL_NATIVE_COLLECTION_PLAN_MISMATCH');
    }
    if (input.intent.kind === 'CAPTURE') {
      const relativePath = input.intent.relativePath;
      const path = plan.paths.find(item => item.relativePath === relativePath);
      if (!path || path.maximumBytes !== input.intent.maximumBytes) fail('VERCEL_NATIVE_COLLECTION_PATH_MISMATCH');
    }
    const { effect } = input.intent.kind === 'BOOTSTRAP'
      ? await this.store.planNativeBootstrap(lease, environmentId)
      : await this.store.planNativeCapture(lease, environmentId, { relativePath: input.intent.relativePath });
    assertActive(input.signal);
    if (effect.provider !== 'vercel' || effect.environmentId !== environmentId || effect.attemptId !== handle.attemptId
      || effect.externalId !== handle.sandboxId || effect.sessionId !== handle.sessionId
      || effect.profileDigest !== handle.profileDigest || effect.leaseEpoch !== handle.leaseEpoch
      || effect.collectionPlanDigest !== plan.collectionPlanDigest || effect.collectorRuntimeDigest !== input.runtimeDigest
      || effect.workerRuntimeDigest !== plan.workerRuntimeDigest || effect.controllerGeneration !== plan.controllerGeneration
      || effect.kind !== input.intent.kind || (input.intent.kind === 'CAPTURE'
        && (effect.workspaceIdentity !== input.intent.workspaceIdentity || effect.relativePath !== input.intent.relativePath
          || effect.maximumBytes !== input.intent.maximumBytes))) fail('VERCEL_NATIVE_COLLECTION_EFFECT_MISMATCH');
    const claim = await this.store.claimNativeCollectionEffect(lease, effect.effectId);
    if (!claim.claimed || claim.effectId !== effect.effectId) fail('VERCEL_NATIVE_COLLECTION_ALREADY_CLAIMED');
    try {
      assertActive(input.signal);
      const result = await input.run(async commandId => {
        await this.store.recordNativeCollectionStarted(lease, effect.effectId, {
          providerCommandId: commandId,
        });
        assertActive(input.signal);
      });
      assertActive(input.signal);
      if (!Number.isSafeInteger(result.exitCode) || result.exitCode === null || result.stderrBytes !== 0) {
        fail('VERCEL_NATIVE_COLLECTION_RESULT_INVALID');
      }
      const metadata = { exitCode: result.exitCode,
        stdoutDigest: `sha256:${createHash('sha256').update(result.stdout, 'ascii').digest('hex')}` as const,
        stdoutBytes: Buffer.byteLength(result.stdout, 'ascii') };
      if (input.intent.kind === 'BOOTSTRAP') {
        if (result.exitCode !== 0) fail('VERCEL_NATIVE_COLLECTION_BOOTSTRAP_FAILED');
        const workspaceIdentity = decodeNativeCollectorBootstrapFrame(result.stdout);
        await this.store.recordNativeBootstrapBinding(lease, effect.effectId, {
          ...metadata, binding: { format: VERCEL_NATIVE_WORKSPACE_BINDING_FORMAT,
            handle, runtimeDigest: input.runtimeDigest, workspaceIdentity },
        });
      } else {
        // Validate success bytes before recording completion; an absent-file
        // result is accepted only with the helper's empty output contract.
        if (result.exitCode === 0) decodeNativeArtifactAsciiFrame(result.stdout, input.intent.relativePath,
          input.intent.maximumBytes, input.intent.maximumBytes);
        else if (result.exitCode !== 3 || result.stdout !== '') fail('VERCEL_NATIVE_COLLECTION_CAPTURE_FAILED');
        await this.store.recordNativeCollectionCompleted(lease, effect.effectId, metadata);
      }
      return result;
    } catch (error) {
      // A failed unknown-record write cannot justify another dispatch: the
      // original claim remains consumed in PostgreSQL regardless.
      try { await boundedUnknownRecord(() => this.store.markNativeCollectionUnknown(
        lease, effect.effectId, 'NATIVE_COLLECTION_OUTCOME_UNCONFIRMED')); }
      catch { /* Preserve the initiating error; never retry the provider. */ }
      throw error;
    }
  }
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) fail('VERCEL_NATIVE_LOG_DEADLINE');
}
function fail(code: string): never { throw new ArtifactStorageError(code, 'Native collector command could not be confirmed.'); }

/** Unknown metadata is best effort after dispatch; a stuck DB connection must
 * not indefinitely delay the caller's teardown path. A late result is observed
 * and cannot reopen the consumed dispatch claim. */
async function boundedUnknownRecord(work: () => Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.resolve().then(work), new Promise<void>(resolve => {
      timer = setTimeout(resolve, 5_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
