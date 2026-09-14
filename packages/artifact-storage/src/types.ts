import type { AttemptProjection } from '../../accounting/src/kernel.ts';
import type { Digest } from '../../domain/src/contracts.ts';
import type { WorkerArtifactOutcome, WorkerLaunchPlan } from '../../orchestration/src/coordinator.ts';
import type { EnvironmentProjection } from '../../orchestration/src/store-types.ts';
import type { SandboxHandle } from '../../sandbox-vercel/src/types.ts';

export const ARTIFACT_MANIFEST_FORMAT = 'motive.artifact-manifest/0.1' as const;

export type ArtifactFileKind =
  | 'regular'
  | 'directory'
  | 'symlink'
  | 'hardlink'
  | 'block-device'
  | 'character-device'
  | 'fifo'
  | 'socket'
  | 'unknown';

/** Immutable bytes plus an explicit account of how the collector resolved them. */
type SafeArtifactSnapshotBase = {
  relativePath: string;
  kind: ArtifactFileKind;
  linkCount: number;
  declaredBytes: number;
  identityToken: string;
  immutableSnapshot: true;
  read(): AsyncIterable<Uint8Array>;
};

export type SafeArtifactSnapshot = SafeArtifactSnapshotBase & (
  | {
      /** Native collection opened beneath the workspace without following links. */
      kind: 'regular';
      linkCount: 1;
      resolution: 'beneath-workspace-no-follow';
    }
  | {
      /**
       * Bytes returned by the provider for one exact path in one already-owned
       * non-persistent session. This makes no filesystem link or file-kind
       * claim; consumers must treat the bytes as untrusted data.
       */
      kind: 'unknown';
      linkCount: 0;
      resolution: 'exact-provider-session-fixed-path';
    }
);

export type SafeArtifactReaderCapability =
  | 'native-beneath-workspace-no-follow-v1'
  | 'provider-session-untrusted-data-v1'
  | 'provider-session-untrusted-data-v2';

export type SafeArtifactReader = {
  assertReady(input: { signal: AbortSignal }): Promise<{ capability: SafeArtifactReaderCapability }>;
  capture(input: {
    handle: SandboxHandle;
    relativePath: string;
    maximumBytes: number;
    maximumChunkBytes: number;
    signal: AbortSignal;
  }): Promise<SafeArtifactSnapshot | null>;
};

export type ApprovedArtifactPath = {
  relativePath: string;
  mediaType: string;
  /** Missing bytes are sealable only for a non-success outcome when explicitly allowed. */
  availability: 'REQUIRED' | 'OPTIONAL_ON_FAILURE';
};

/** The list is resolved from an operator-reviewed registry, never worker output. */
export type ArtifactApprovalPolicy = {
  approvedPaths(input: {
    attempt: AttemptProjection;
    environment: EnvironmentProjection;
    plan: WorkerLaunchPlan;
    signal: AbortSignal;
  }): Promise<readonly ApprovedArtifactPath[]>;
  assertReady(
    plan: WorkerLaunchPlan,
    input: { signal: AbortSignal },
  ): Promise<{ capability: 'trusted-operator-artifact-policy-v1' }>;
};

export type ImmutableObjectStore = {
  putIfAbsent(input: {
    objectKey: string;
    body: AsyncIterable<Uint8Array>;
    contentType: string;
    expectedBytes: number;
    expectedDigest: Digest;
    signal: AbortSignal;
  }): Promise<{ status: 'CREATED' | 'EXISTS'; objectId: string }>;
  readObject(input: {
    objectKey: string;
    maximumBytes: number;
    maximumChunkBytes: number;
    signal: AbortSignal;
  }): Promise<{ body: AsyncIterable<Uint8Array>; declaredBytes: number | null } | null>;
};

export type ArtifactManifestFile = {
  relative_path: string;
  media_type: string;
  availability: ApprovedArtifactPath['availability'];
  bytes: number;
  digest: Digest;
  object_key: string;
};

export type ArtifactManifestMissingFile = {
  relative_path: string;
  media_type: string;
  availability: 'OPTIONAL_ON_FAILURE';
};

export type ArtifactManifest = {
  format: typeof ARTIFACT_MANIFEST_FORMAT;
  project_id: string;
  work_order_id: string;
  attempt_id: string;
  environment_id: string;
  terms_digest: Digest;
  input_digest: Digest;
  inference_profile_digest: Digest;
  sandbox_profile_digest: Digest;
  launch_plan_digest: Digest;
  command_digest: Digest;
  controller_observed_outcome: WorkerArtifactOutcome;
  capture_status: 'COMPLETE' | 'PARTIAL';
  files: readonly ArtifactManifestFile[];
  missing_files: readonly ArtifactManifestMissingFile[];
  total_bytes: number;
  human_acceptance: {
    status: 'PENDING';
    decision_id: null;
  };
};

export type SealArtifactsInput = {
  attempt: AttemptProjection;
  environment: EnvironmentProjection;
  handle: SandboxHandle;
  plan: WorkerLaunchPlan;
  outcome: WorkerArtifactOutcome;
};

export type ArtifactSealReceipt = {
  manifestDigest: Digest;
  receiptId: string;
};
