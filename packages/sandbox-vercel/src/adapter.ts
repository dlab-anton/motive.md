import {
  SandboxAdapterError,
  SandboxCommandEffectUnknownError,
  SandboxCreateEffectUnknownError,
  SandboxStopEffectUnknownError,
} from './errors.ts';
import { protectedCommand, requireProtectedRuntime } from './protected-runtime.ts';
import { requireWorkerExecutionBoundary } from './execution-boundary.ts';
import {
  assertRecordedOperationId,
  buildNetworkPolicy,
  ownerTags,
  resolveWorkspacePath,
  sandboxName,
  validateProfile,
} from './policy.ts';
import {
  WORKSPACE_ROOT,
  MAX_OWNED_SANDBOX_DISCOVERY,
  type ArtifactExportPlan,
  type CommandHandle,
  type CommandObservation,
  type ProviderSandboxStatus,
  type ProvisionSandboxRequest,
  type OwnedSandboxObservation,
  type OwnedSandboxDiscovery,
  type SandboxExecutionProfile,
  type SandboxHandle,
  type SandboxObservation,
  type SandboxAdapterOptions,
  type SandboxSdkFactory,
  type SandboxState,
  type SdkCreateRequest,
  type SdkSandbox,
  type StartCommandRequest,
  type StopObservation,
} from './types.ts';

function mapState(status: ProviderSandboxStatus): SandboxState {
  switch (status) {
    case 'pending': return 'PROVISIONING';
    case 'running': return 'RUNNING';
    case 'stopping':
    case 'snapshotting': return 'STOPPING';
    case 'stopped': return 'STOPPED';
    case 'failed':
    case 'aborted': return 'FAILED';
  }
}

function isTerminal(status: ProviderSandboxStatus): boolean {
  return status === 'stopped' || status === 'failed' || status === 'aborted';
}

export class VercelSandboxAdapter {
  private readonly profile: SandboxExecutionProfile;
  private readonly effects: 'suspended' | 'durable-controller';
  private readonly now: () => Date;

  constructor(
    profile: SandboxExecutionProfile,
    private readonly sdk: SandboxSdkFactory,
    options: SandboxAdapterOptions = {},
  ) {
    validateProfile(profile);
    this.effects = options.effects ?? 'suspended';
    this.now = options.now ?? (() => new Date());
    // Keep execution policy stable even if the caller later mutates its input.
    this.profile = {
      ...profile,
      ...(profile.protectedRuntime ? { protectedRuntime: { ...profile.protectedRuntime } } : {}),
      ...(profile.providerUntrustedDataRuntime ? { providerUntrustedDataRuntime: { ...profile.providerUntrustedDataRuntime } } : {}),
      trustedSource: { ...profile.trustedSource },
      allowedExecutables: [...profile.allowedExecutables],
      egress: {
        gateway: profile.egress.gateway.map(rule => ({ ...rule, methods: [...rule.methods] })),
        artifacts: profile.egress.artifacts.map(rule => ({ ...rule, methods: [...rule.methods] })),
        ...(profile.egress.mcp ? { mcp: profile.egress.mcp.map(rule => ({ ...rule, methods: [...rule.methods] })) } : {}),
        ...(profile.egress.gatewayProxy ? { gatewayProxy: { ...profile.egress.gatewayProxy } } : {}),
      },
      artifacts: { ...profile.artifacts },
    };
  }

  planCreate(request: ProvisionSandboxRequest): SdkCreateRequest {
    requireWorkerExecutionBoundary(this.profile);
    assertRecordedOperationId(request.intent.operationId);
    if (!/^[A-Za-z0-9_-]{32,512}$/.test(request.runCapability)) {
      throw new SandboxAdapterError('SANDBOX_POLICY_INVALID', 'runCapability must be a bounded scoped capability.');
    }
    const common = {
      name: sandboxName(request.attemptId, request.leaseEpoch),
      persistent: false as const,
      timeout: this.profile.timeoutMs,
      resources: { vcpus: this.profile.vcpus },
      ports: [] as const,
      networkPolicy: buildNetworkPolicy(this.profile),
      // These are the only values copied into the worker. Provider, donor,
      // controller, storage-admin, and repository credentials stay outside.
      env: {
        MOTIVE_RUN_CAPABILITY: request.runCapability,
      },
      tags: ownerTags(request.attemptId, request.leaseEpoch, this.profile.profileDigest),
    };
    return this.profile.trustedSource.kind === 'snapshot'
      ? { ...common, source: { type: 'snapshot', snapshotId: this.profile.trustedSource.snapshotId } }
      : { ...common, image: this.profile.trustedSource.image };
  }

  async create(request: ProvisionSandboxRequest): Promise<SandboxHandle> {
    this.assertEffectsEnabled();
    requireWorkerExecutionBoundary(this.profile);
    const plan = this.planCreate(request);
    let sandbox: SdkSandbox;
    try {
      // Exactly one adapter call. The native factory separately disables the
      // SDK's internal retries for effectful HTTP requests.
      sandbox = await this.sdk.create(plan);
      if (sandbox.name !== plan.name || sandbox.persistent !== false) {
        throw new SandboxAdapterError(
          'SANDBOX_PROVIDER_CONTRACT',
          'Created sandbox metadata did not preserve its deterministic name and non-persistent policy.',
        );
      }
      this.assertTrustedSource(sandbox);
    } catch (error) {
      throw new SandboxCreateEffectUnknownError(plan.name, error);
    }
    return {
      provider: 'vercel',
      attemptId: request.attemptId,
      leaseEpoch: request.leaseEpoch,
      sandboxId: sandbox.name,
      sessionId: sandbox.sessionId,
      profileDigest: this.profile.profileDigest,
    };
  }

  async observe(handle: SandboxHandle): Promise<SandboxObservation> {
    this.assertHandle(handle);
    let sandbox: SdkSandbox;
    try {
      sandbox = await this.sdk.get({ name: handle.sandboxId, resume: false });
    } catch (error) {
      throw new SandboxAdapterError(
        'SANDBOX_OBSERVATION_FAILED',
        `Could not observe sandbox ${handle.sandboxId}; its state remains unknown.`,
        { cause: error },
      );
    }
    this.assertObservedSandbox(handle, sandbox);
    return {
      handle,
      state: mapState(sandbox.status),
      providerStatus: sandbox.status,
      persistent: false,
      expiresAt: sandbox.expiresAt ?? null,
      observedAt: this.now(),
    };
  }

  async discoverOwned(): Promise<OwnedSandboxDiscovery> {
    let discovery;
    try {
      discovery = await this.sdk.listOwned({
        namePrefix: 'motive-w-',
        tags: { 'motive-owner': 'control' },
        maximumResults: MAX_OWNED_SANDBOX_DISCOVERY,
      });
    } catch (error) {
      throw new SandboxAdapterError(
        'SANDBOX_OBSERVATION_FAILED',
        'Could not enumerate Motive-owned sandboxes.',
        { cause: error },
      );
    }
    const sandboxes: OwnedSandboxObservation[] = discovery.sandboxes
      .filter(sandbox =>
        sandbox.name.startsWith('motive-w-') &&
        sandbox.tags?.['motive-owner'] === 'control' &&
        sandbox.tags?.['motive-kind'] === 'worker')
      .map(sandbox => ({
        sandboxId: sandbox.name,
        sessionId: sandbox.sessionId,
        state: mapState(sandbox.status),
        providerStatus: sandbox.status,
        persistent: sandbox.persistent,
        expiresAt: sandbox.expiresAt ?? null,
        tags: { ...sandbox.tags },
        observedAt: this.now(),
      }));
    return {
      sandboxes,
      complete: discovery.complete,
      maximumResults: MAX_OWNED_SANDBOX_DISCOVERY,
    };
  }

  async startCommand(handle: SandboxHandle, request: StartCommandRequest): Promise<CommandHandle> {
    this.assertEffectsEnabled();
    const boundary = requireWorkerExecutionBoundary(this.profile);
    this.assertHandle(handle);
    assertRecordedOperationId(request.intent.operationId);
    if (!this.profile.allowedExecutables.includes(request.executable)) {
      throw new SandboxAdapterError('SANDBOX_POLICY_INVALID', `Executable ${request.executable} is not in the frozen profile.`);
    }
    if (request.args.length > 512 || request.args.some(arg => arg.length > 16_384 || arg.includes('\0'))) {
      throw new SandboxAdapterError('SANDBOX_POLICY_INVALID', 'Command arguments exceed the frozen bounds.');
    }
    if (request.cwd !== undefined) resolveWorkspacePath(request.cwd, 'cwd');
    const commandRequest = boundary.kind === 'protected-runtime' ? protectedCommand(this.profile, request) : {
      cmd: request.executable, args: [...request.args], cwd: request.cwd === undefined ? WORKSPACE_ROOT : resolveWorkspacePath(request.cwd, 'cwd'),
      detached: true as const, sudo: false as const, timeoutMs: this.profile.commandTimeoutMs,
    };
    let sandbox: SdkSandbox;
    try {
      sandbox = await this.sdk.get({ name: handle.sandboxId, resume: false });
    } catch (error) {
      throw new SandboxAdapterError('SANDBOX_OBSERVATION_FAILED', 'Command launch requires a confirmed running sandbox.', { cause: error });
    }
    this.assertObservedSandbox(handle, sandbox);
    if (sandbox.status !== 'running' || sandbox.sessionId !== handle.sessionId) {
      throw new SandboxAdapterError(
        'SANDBOX_NOT_RUNNING',
        `Sandbox ${handle.sandboxId} is not the recorded running session; the adapter will not resume it.`,
      );
    }
    try {
      const command = await sandbox.startCommand(commandRequest);
      if (command.cmdId.length === 0) throw new Error('Provider returned an empty command ID.');
      return {
        ...handle,
        commandId: command.cmdId,
        commandOperationId: request.intent.operationId,
      };
    } catch (error) {
      throw new SandboxCommandEffectUnknownError(handle.sandboxId, request.intent.operationId, error);
    }
  }

  async observeCommand(handle: CommandHandle): Promise<CommandObservation> {
    this.assertHandle(handle);
    let sandbox: SdkSandbox;
    try {
      sandbox = await this.sdk.get({ name: handle.sandboxId, resume: false });
      this.assertObservedSandbox(handle, sandbox);
      if (sandbox.sessionId !== handle.sessionId) {
        throw new Error('The recorded session is no longer current.');
      }
      const command = await sandbox.getCommand(handle.commandId);
      if (command.cmdId !== handle.commandId) throw new Error('Provider returned a different command ID.');
      return {
        commandId: command.cmdId,
        state: command.exitCode === null ? 'RUNNING' : 'EXITED',
        exitCode: command.exitCode,
        ...(command.durationMs === undefined ? {} : { durationMs: command.durationMs }),
      };
    } catch (error) {
      throw new SandboxAdapterError(
        'SANDBOX_OBSERVATION_FAILED',
        `Could not observe command ${handle.commandId}; its state remains unknown.`,
        { cause: error },
      );
    }
  }

  async stop(handle: SandboxHandle): Promise<StopObservation> {
    this.assertEffectsEnabled();
    this.assertHandle(handle);
    let sandbox: SdkSandbox;
    try {
      sandbox = await this.sdk.get({ name: handle.sandboxId, resume: false });
    } catch (error) {
      throw new SandboxAdapterError('SANDBOX_OBSERVATION_FAILED', 'Stop requires observation of the exact sandbox handle.', { cause: error });
    }
    this.assertObservedSandbox(handle, sandbox);
    if (isTerminal(sandbox.status)) {
      return {
        sandboxId: sandbox.name,
        state: mapState(sandbox.status),
        providerStatus: sandbox.status,
        alreadyTerminal: true,
      };
    }
    try {
      const stopped = await sandbox.stop();
      return {
        sandboxId: sandbox.name,
        state: mapState(stopped.status),
        providerStatus: stopped.status,
        alreadyTerminal: false,
      };
    } catch (error) {
      throw new SandboxStopEffectUnknownError(handle.sandboxId, error);
    }
  }

  prepareArtifactExport(handle: SandboxHandle, relativePaths: readonly string[]): ArtifactExportPlan {
    this.assertHandle(handle);
    // This API asserts trusted no-follow native capture. Provider-untrusted circle data uses its separate bounded collector.
    requireProtectedRuntime(this.profile);
    if (relativePaths.length === 0 || relativePaths.length > this.profile.artifacts.maxFiles) {
      throw new SandboxAdapterError(
        'SANDBOX_ARTIFACT_PATH_INVALID',
        `Artifact manifest must contain between 1 and ${this.profile.artifacts.maxFiles} files.`,
      );
    }
    const unique = new Set<string>();
    const files = relativePaths.map(relativePath => {
      const sourcePath = resolveWorkspacePath(relativePath, 'artifact path');
      if (unique.has(relativePath)) {
        throw new SandboxAdapterError('SANDBOX_ARTIFACT_PATH_INVALID', `Duplicate artifact path: ${relativePath}.`);
      }
      unique.add(relativePath);
      return { relativePath, sourcePath };
    });
    return {
      sandboxId: handle.sandboxId,
      workspaceRoot: WORKSPACE_ROOT,
      files,
      maxFileBytes: this.profile.artifacts.maxFileBytes,
      maxTotalBytes: this.profile.artifacts.maxTotalBytes,
      requiresLstatNoFollow: true,
      sealedStorageRequired: true,
    };
  }

  private assertHandle(handle: SandboxHandle): void {
    if (
      handle.provider !== 'vercel' ||
      handle.profileDigest !== this.profile.profileDigest ||
      handle.sandboxId !== sandboxName(handle.attemptId, handle.leaseEpoch) ||
      handle.sessionId.length === 0
    ) {
      throw new SandboxAdapterError('SANDBOX_HANDLE_INVALID', 'Sandbox handle does not match the frozen attempt identity and profile.');
    }
  }

  private assertEffectsEnabled(): void {
    if (this.effects !== 'durable-controller') {
      throw new SandboxAdapterError(
        'SANDBOX_EFFECTS_SUSPENDED',
        'Remote sandbox effects are suspended until the durable controller persists and reconciles lifecycle intents.',
      );
    }
  }

  private assertObservedSandbox(handle: SandboxHandle, sandbox: SdkSandbox): void {
    if (
      sandbox.name !== handle.sandboxId ||
      sandbox.sessionId !== handle.sessionId ||
      sandbox.persistent !== false
    ) {
      throw new SandboxAdapterError('SANDBOX_PROVIDER_CONTRACT', 'Observed sandbox violates its recorded identity, session, or disposal policy.');
    }
    this.assertTrustedSource(sandbox);
  }

  private assertTrustedSource(sandbox: Pick<SdkSandbox, 'sourceSnapshotId' | 'image'>): void {
    const source = this.profile.trustedSource;
    if (source.kind === 'snapshot' && sandbox.sourceSnapshotId !== source.snapshotId) {
      throw new SandboxAdapterError('SANDBOX_PROVIDER_CONTRACT', 'Sandbox did not report the frozen trusted snapshot ID.');
    }
    if (source.kind === 'image' && sandbox.image !== source.image) {
      throw new SandboxAdapterError('SANDBOX_PROVIDER_CONTRACT', 'Sandbox did not report the frozen digest-pinned image.');
    }
  }
}
