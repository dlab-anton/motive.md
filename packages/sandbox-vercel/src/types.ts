import type { NetworkPolicy } from '@vercel/sandbox';
import type { ProtectedWorkerRuntime } from './protected-runtime.ts';
import type { ProviderUntrustedDataRuntime } from './execution-boundary.ts';

export const SANDBOX_PROFILE_FORMAT = 'motive.sandbox-profile/0.1' as const;
export const MAX_SANDBOX_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
export const MAX_COMMAND_TIMEOUT_MS = 60 * 60 * 1_000;
export const MAX_SANDBOX_VCPUS = 8;
export const MAX_OWNED_SANDBOX_DISCOVERY = 1_000;
export const WORKSPACE_ROOT = '/vercel/sandbox/workspace';

export type Digest = `sha256:${string}`;
export type ProviderSandboxStatus =
  | 'pending'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'aborted'
  | 'snapshotting';

export type SandboxState =
  | 'PROVISIONING'
  | 'RUNNING'
  | 'STOPPING'
  | 'STOPPED'
  | 'FAILED';

type TrustedSourceIdentity =
  | { sourceCommit: string; sourceSnapshotDigest?: never }
  | { sourceSnapshotDigest: Digest; sourceCommit?: never };

export type TrustedSource =
  | ({
      kind: 'snapshot';
      snapshotId: string;
      materialDigest: Digest;
      buildRecipeDigest: Digest;
    } & TrustedSourceIdentity)
  | ({
      kind: 'image';
      /** A VCR reference pinned with @sha256:<64 lowercase hex>. */
      image: string;
      materialDigest: Digest;
      buildRecipeDigest: Digest;
    } & TrustedSourceIdentity);

export type EgressRule = {
  /** HTTPS URL without credentials, query, or fragment. */
  url: string;
  methods: readonly ('GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE')[];
  pathMatch: 'exact' | 'prefix';
};

export type VercelGatewayProxy = {
  format: 'motive.vercel-gateway-proxy/0.1';
  /** Same-origin fixed endpoint that enforces the original request method and path. */
  url: string;
};

export type SandboxExecutionProfile = {
  format: typeof SANDBOX_PROFILE_FORMAT;
  profileDigest: Digest;
  /** Required for new worker effects; omitted legacy profiles are cleanup-only. */
  protectedRuntime?: ProtectedWorkerRuntime;
  /** Circle-only provider session. This makes no filesystem or output-trust claim. */
  providerUntrustedDataRuntime?: ProviderUntrustedDataRuntime;
  trustedSource: TrustedSource;
  timeoutMs: number;
  commandTimeoutMs: number;
  vcpus: number;
  allowedExecutables: readonly string[];
  egress: {
    gateway: readonly EgressRule[];
    artifacts: readonly EgressRule[];
    /** Optional selected remote MCP endpoints; absent means no additional access. */
    mcp?: readonly EgressRule[];
    /** Required only for provider-untrusted circle data; all gateway-host traffic is forwarded here. */
    gatewayProxy?: VercelGatewayProxy;
  };
  artifacts: {
    maxFiles: number;
    maxFileBytes: number;
    maxTotalBytes: number;
  };
};

export type RecordedIntent = {
  status: 'RECORDED';
  operationId: string;
};

export type ProvisionSandboxRequest = {
  attemptId: string;
  leaseEpoch: number;
  runCapability: string;
  intent: RecordedIntent;
};

export type SandboxHandle = {
  provider: 'vercel';
  attemptId: string;
  leaseEpoch: number;
  sandboxId: string;
  sessionId: string;
  profileDigest: Digest;
};

export type StartCommandRequest = {
  intent: RecordedIntent;
  executable: string;
  args: readonly string[];
  /** Relative to WORKSPACE_ROOT. Omit for the workspace root. */
  cwd?: string;
};

export type CommandHandle = SandboxHandle & {
  commandId: string;
  commandOperationId: string;
};

export type CommandObservation = {
  commandId: string;
  state: 'RUNNING' | 'EXITED';
  exitCode: number | null;
  durationMs?: number;
};

export type SandboxObservation = {
  handle: SandboxHandle;
  state: SandboxState;
  providerStatus: ProviderSandboxStatus;
  persistent: false;
  expiresAt: Date | null;
  observedAt: Date;
};

export type OwnedSandboxObservation = {
  sandboxId: string;
  sessionId: string;
  state: SandboxState;
  providerStatus: ProviderSandboxStatus;
  persistent: boolean;
  expiresAt: Date | null;
  tags: Record<string, string>;
  observedAt: Date;
};

export type OwnedSandboxDiscovery = {
  sandboxes: readonly OwnedSandboxObservation[];
  complete: boolean;
  maximumResults: typeof MAX_OWNED_SANDBOX_DISCOVERY;
};

export type StopObservation = {
  sandboxId: string;
  state: SandboxState;
  providerStatus: ProviderSandboxStatus;
  alreadyTerminal: boolean;
};

export type ArtifactExportPlan = {
  sandboxId: string;
  workspaceRoot: typeof WORKSPACE_ROOT;
  files: readonly { relativePath: string; sourcePath: string }[];
  maxFileBytes: number;
  maxTotalBytes: number;
  requiresLstatNoFollow: true;
  sealedStorageRequired: true;
};

export type SdkCreateRequestBase = {
  name: string;
  persistent: false;
  timeout: number;
  resources: { vcpus: number };
  ports: readonly [];
  networkPolicy: NetworkPolicy;
  env: Record<string, string>;
  tags: Record<string, string>;
};

export type SdkCreateRequest = SdkCreateRequestBase & (
  | { source: { type: 'snapshot'; snapshotId: string }; image?: never }
  | { image: string; source?: never }
);

export type SdkCommandRequest = {
  cmd: string;
  args: string[];
  cwd: string;
  detached: true;
  /** Only the fixed protected launcher may use true. Child code loses privilege first. */
  sudo: boolean;
  timeoutMs: number;
};

export type SdkCommand = {
  cmdId: string;
  exitCode: number | null;
  durationMs?: number;
};

export type SdkSandbox = {
  name: string;
  sessionId: string;
  persistent: boolean;
  status: ProviderSandboxStatus;
  expiresAt?: Date;
  sourceSnapshotId?: string;
  image?: string;
  tags?: Record<string, string>;
  startCommand(request: SdkCommandRequest): Promise<SdkCommand>;
  getCommand(commandId: string): Promise<SdkCommand>;
  stop(): Promise<{ status: ProviderSandboxStatus }>;
};

export type SdkSandboxSummary = Pick<
  SdkSandbox,
  'name' | 'persistent' | 'status' | 'expiresAt' | 'sourceSnapshotId' | 'image' | 'tags'
> & { sessionId: string };

export type SdkOwnedSandboxDiscovery = {
  sandboxes: readonly SdkSandboxSummary[];
  complete: boolean;
};

export type SandboxSdkFactory = {
  create(request: SdkCreateRequest): Promise<SdkSandbox>;
  get(request: { name: string; resume: false }): Promise<SdkSandbox>;
  listOwned(request: {
    namePrefix: string;
    tags: { 'motive-owner': 'control' };
    maximumResults: typeof MAX_OWNED_SANDBOX_DISCOVERY;
  }): Promise<SdkOwnedSandboxDiscovery>;
};

export type SandboxAdapterOptions = {
  /** Must be selected only by a controller with durable intent/handle recovery. */
  effects?: 'suspended' | 'durable-controller';
  now?: () => Date;
};
