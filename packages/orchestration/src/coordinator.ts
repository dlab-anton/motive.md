import type { AttemptProjection, LedgerKernel } from '../../accounting/src/kernel.ts';
import { digestCanonicalJson, type DecimalAmount, type Digest } from '../../domain/src/contracts.ts';
import type { VercelSandboxAdapter } from '../../sandbox-vercel/src/adapter.ts';
import { ownerTags, resolveWorkspacePath, sandboxName, validateProfile } from '../../sandbox-vercel/src/policy.ts';
import { requireWorkerExecutionBoundary } from '../../sandbox-vercel/src/execution-boundary.ts';
import type { CommandObservation, OwnedSandboxObservation, SandboxExecutionProfile, SandboxHandle } from '../../sandbox-vercel/src/types.ts';
import type { ArtifactSealProjection, ControllerLease, EffectIntent, EnvironmentProjection, ExecutionProjection, FreezeNativeCollectionPlanInput, OrchestrationStore, ProviderObservation } from './store-types.ts';
import { isExactProviderCircleCollection } from './circle-data-boundary.ts';

/** Server-reviewed material only. Queue messages carry only an attempt ID. */
export type WorkerLaunchPlan = {
  format: 'motive.worker-launch/0.1'; workOrderId: string; termsDigest: Digest; inputDigest: Digest;
  inferenceProfileDigest: Digest; actorId: string; sandbox: SandboxExecutionProfile;
  infrastructureAuthorizationId: string; maximumCostUsd: DecimalAmount;
  command: { executable: string; args: string[]; cwd?: string }; capabilityTtlSeconds: number;
  /** Optional and inactive by default. When supplied it is frozen before CREATE is claimed. */
  nativeCollection?: FreezeNativeCollectionPlanInput;
};

/** The terminal fact the byte collector must bind into its immutable receipt. */
export type WorkerArtifactOutcome =
  | { kind: 'COMMAND_EXITED'; commandId: string; exitCode: number | null; durationMs?: number }
  | { kind: 'CANCELLED' }
  | { kind: 'COMMAND_RESULT_UNKNOWN'; commandOperationId: string }
  | { kind: 'PROVIDER_TERMINATED'; providerStatus: string }
  | { kind: 'STOP_REQUESTED' }
  | { kind: 'CONTROLLER_SUPERSEDED' }
  | { kind: 'AUTHORITY_CLOSED'; code: string };

type Adapter = Pick<VercelSandboxAdapter, 'create' | 'observe' | 'discoverOwned' | 'startCommand' | 'observeCommand' | 'stop'>;
export type CoordinatorDependencies = {
  store: OrchestrationStore;
  ledger: Pick<LedgerKernel, 'getAttempt' | 'issueRunCapability' | 'revokeRunCapability'>;
  resolvePlan(attempt: AttemptProjection): Promise<WorkerLaunchPlan | null>;
  adapter(profile: SandboxExecutionProfile): Adapter;
  artifacts: {
    assertReady(plan: WorkerLaunchPlan): Promise<void>;
    seal(input: { lease: ControllerLease; attempt: AttemptProjection; environment: EnvironmentProjection; handle: SandboxHandle;
      plan: WorkerLaunchPlan; outcome: WorkerArtifactOutcome }): Promise<{ manifestDigest: Digest; receiptId: string }>;
  };
  orphanProvider: {
    discover(): Promise<{ sandboxes: OwnedSandboxObservation[]; complete: boolean }>;
    stopOwned(observation: OwnedSandboxObservation, operationId: string): Promise<ProviderObservation>;
  };
  ownerId: string; leaseSeconds?: number;
  /** Optional composition with the existing evaluator phase; absent stays cleanup-only. */
  evaluator?: { reconcileAttempt(attemptId: string): Promise<{ attemptId: string; status: string }> };
};

export type ReconcileResult = { attemptId: string; status: 'WAITING' | 'RUNNING' | 'STOPPING' | 'TERMINATED' | 'SEALED' | 'UNCONFIGURED' | 'QUARANTINED' };

export function launchDigest(value: unknown): Digest { return digestCanonicalJson(value); }
function terminal(status: string): boolean { return ['stopped', 'failed', 'aborted'].includes(status); }
function observation(status: string, observedAt?: Date, expiresAt?: Date | null): ProviderObservation {
  return { providerStatus: status, providerTerminal: terminal(status),
    state: terminal(status) ? 'TERMINATED' : status === 'running' ? 'ACTIVE' : status === 'pending' ? 'PROVISIONING' : 'STOP_REQUESTED',
    ...(observedAt ? { observedAt: observedAt.toISOString() } : {}),
    ...(expiresAt !== undefined ? { providerExpiresAt: expiresAt?.toISOString() ?? null } : {}) };
}
function handleFor(environment: EnvironmentProjection): SandboxHandle {
  if (environment.provider !== 'vercel' || !environment.attemptId || !environment.externalId || !environment.sessionId
      || !environment.profileDigest || environment.leaseEpoch === null) throw new Error('ENVIRONMENT_HANDLE_UNAVAILABLE');
  return { provider: 'vercel', attemptId: environment.attemptId, sandboxId: environment.externalId,
    sessionId: environment.sessionId, profileDigest: environment.profileDigest, leaseEpoch: environment.leaseEpoch };
}
function cancelled(attempt: AttemptProjection): boolean { return attempt.admissionClosedAt !== null || attempt.cancellationRequestedAt !== null; }
const AUTHORITY_CLOSED_CODES = new Set([
  'CONTROLLER_FROZEN', 'SOURCE_UNAVAILABLE', 'GRANT_UNAVAILABLE', 'ATTEMPT_UNAVAILABLE',
  'INFRA_AUTHORIZATION_UNAVAILABLE',
]);
function authorityClosed(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error) || typeof error.code !== 'string') return null;
  return AUTHORITY_CLOSED_CODES.has(error.code) ? error.code : null;
}
function commandOutcome(command: CommandObservation): WorkerArtifactOutcome {
  return { kind: 'COMMAND_EXITED', commandId: command.commandId, exitCode: command.exitCode,
    ...(command.durationMs === undefined ? {} : { durationMs: command.durationMs }) };
}
function profileFor(environment: EnvironmentProjection): SandboxExecutionProfile {
  if (environment.profileSnapshot === null || environment.profileDigest === null) throw new Error('FROZEN_PROFILE_UNAVAILABLE');
  const profile = structuredClone(environment.profileSnapshot) as SandboxExecutionProfile;
  validateProfile(profile);
  if (profile.profileDigest !== environment.profileDigest) throw new Error('FROZEN_PROFILE_MISMATCH');
  return profile;
}
function effectFor(execution: ExecutionProjection | null, environmentId: string, kind: EffectIntent['kind']): EffectIntent | undefined {
  return execution?.effects.find(effect => effect.environmentId === environmentId && effect.kind === kind);
}
function workerFor(execution: ExecutionProjection | null, lease?: ControllerLease): EnvironmentProjection | undefined {
  const workers = execution?.environments.filter(item => item.kind === 'WORKER') ?? [];
  const live = workers.filter(item => !['ABANDONED', 'TERMINATED'].includes(item.state));
  return (lease ? live.find(item => item.leaseEpoch === lease.epoch) : undefined)
    ?? live[0]
    ?? workers.find(item => item.state === 'TERMINATED');
}
function result(attemptId: string, status: ReconcileResult['status']): ReconcileResult { return { attemptId, status }; }

/** One bounded reconciliation step. No sleeps and no remote-effect retries. */
export class DurableWorkerCoordinator {
  private readonly ttl: number;
  constructor(private readonly deps: CoordinatorDependencies) {
    this.ttl = deps.leaseSeconds ?? 60;
    if (!deps.ownerId || !Number.isInteger(this.ttl) || this.ttl < 10 || this.ttl > 300) throw new Error('CONTROLLER_CONFIGURATION_INVALID');
  }

  async reconcileAttempt(attemptId: string): Promise<ReconcileResult> {
    const firstAttempt = await this.requireAttempt(attemptId);
    const resolved = await this.deps.resolvePlan(firstAttempt);
    if (!resolved) return this.cleanupWithoutPlan(firstAttempt);
    const plan = structuredClone(resolved);
    // A removed/legacy runtime must not leave an existing environment running.
    // Cleanup uses its frozen profile or independent exact-session inventory.
    try { requireWorkerExecutionBoundary(plan.sandbox); }
    catch { return this.cleanupWithoutPlan(firstAttempt); }
    try { this.validatePlan(firstAttempt, plan); }
    catch (error) {
      // A bad replacement configuration must never suppress teardown of work
      // started under the previous valid, frozen configuration.
      const prior = await this.deps.store.getExecution(attemptId);
      if (prior?.environments.some(environment => !['ABANDONED', 'TERMINATED'].includes(environment.state))) {
        return this.cleanupWithoutPlan(firstAttempt);
      }
      throw error;
    }
    const planDigest = launchDigest(plan);
    let lease = await this.deps.store.acquireLease(attemptId, this.deps.ownerId, this.ttl);
    const attempt = await this.requireAttempt(attemptId);
    this.validatePlan(attempt, plan);
    const adapter = this.deps.adapter(plan.sandbox);
    let execution = await this.deps.store.getExecution(attemptId);
    let environment = workerFor(execution, lease);

    if (!environment) {
      if (cancelled(attempt)) return result(attemptId, 'TERMINATED');
      await this.deps.artifacts.assertReady(plan);
      try {
        environment = (await this.deps.store.reserveEnvironment(lease, { kind: 'WORKER', profileDigest: plan.sandbox.profileDigest,
          profileSnapshot: plan.sandbox as unknown as Record<string, unknown>, launchPlanDigest: planDigest,
          infrastructureAuthorizationId: plan.infrastructureAuthorizationId, maximumCostUsd: plan.maximumCostUsd })).environment;
      } catch (error) {
        const fresh = await this.deps.ledger.getAttempt(attemptId);
        if (fresh && cancelled(fresh)) return result(attemptId, 'TERMINATED');
        throw error;
      }
      execution = await this.deps.store.getExecution(attemptId);
    }
    if (environment.launchPlanDigest !== planDigest || environment.profileDigest !== plan.sandbox.profileDigest) throw new Error('FROZEN_LAUNCH_PLAN_MISMATCH');
    if (environment.state === 'ABANDONED') return result(attemptId, 'TERMINATED');
    if (environment.state === 'TERMINATED') {
      await this.deps.store.closeAttemptAdmission(lease, environment.id, { preserveEvaluation: true });
      const seal = execution?.artifactSeal ?? await this.deps.store.recordArtifactFailure(lease, environment.id, {
        receiptId: `artifact-failure:${environment.id}`,
        failureCode: 'PROVIDER_TERMINATED_BEFORE_ARTIFACT_SEAL',
      });
      return this.finishTerminal(lease, environment, seal, plan.actorId);
    }

    const create = effectFor(execution, environment.id, 'CREATE');
    if (!create) throw new Error('CREATE_INTENT_MISSING');
    const stale = environment.leaseEpoch !== lease.epoch || environment.controllerGeneration !== lease.controllerGeneration;
    if (!environment.externalId) {
      if (create.state === 'INTENT_RECORDED' && stale) {
        // No caller claimed this old-generation intent, so no provider effect
        // is possible and its capacity/cost holds can be released safely.
        await this.deps.store.abandonReservedEnvironment(lease, environment.id);
        return result(attemptId, 'TERMINATED');
      }
      if (create.state === 'INTENT_RECORDED' && !stale) {
        if (cancelled(attempt)) {
          await this.deps.store.abandonReservedEnvironment(lease, environment.id);
          return result(attemptId, 'TERMINATED');
        }
        await this.deps.artifacts.assertReady(plan);
        // The plan is independent of the run capability and provider call. A
        // restart may repeat this immutable write, but no CREATE claim can
        // pass until it has committed for a native-enabled worker.
        if (plan.nativeCollection !== undefined) {
          try {
            await this.deps.store.freezeNativeCollectionPlan(lease, environment.id, plan.nativeCollection);
          } catch (error) {
            // A cancellation or authority boundary can land after readiness
            // succeeds but before the immutable plan is written. CREATE is
            // still unclaimed here, so release its finite hold immediately.
            const fresh = await this.deps.ledger.getAttempt(attemptId);
            if ((fresh && cancelled(fresh)) || authorityClosed(error) !== null) {
              await this.deps.store.abandonReservedEnvironment(lease, environment.id);
              return result(attemptId, 'TERMINATED');
            }
            throw error;
          }
        }
        lease = await this.deps.store.heartbeat(lease, this.ttl);
        let claimed: boolean;
        try { claimed = (await this.deps.store.claimEffect(lease, create.effectId)).claimed; }
        catch (error) {
          const fresh = await this.deps.ledger.getAttempt(attemptId);
          if ((fresh && cancelled(fresh)) || authorityClosed(error) !== null) {
            await this.deps.store.abandonReservedEnvironment(lease, environment.id);
            return result(attemptId, 'TERMINATED');
          }
          throw error;
        }
        if (!claimed) return result(attemptId, 'WAITING');
        // Issuance is outside the provider catch: persistence failure keeps the claim discoverable and cannot trigger replacement.
        const issued = await this.deps.ledger.issueRunCapability({ actorId: plan.actorId, attemptId,
          idempotencyKey: `worker-capability:${create.effectId}`, ttlSeconds: plan.capabilityTtlSeconds });
        let created: SandboxHandle;
        try {
          created = await adapter.create({ attemptId, leaseEpoch: lease.epoch, runCapability: issued.capability,
            intent: { status: 'RECORDED', operationId: create.effectId } });
        } catch {
          await this.deps.store.markEffectUnknown(lease, create.effectId, 'CREATE_RESULT_UNCERTAIN');
          return result(attemptId, 'QUARANTINED');
        }
        await this.deps.store.recordCreateResult(lease, create.effectId,
          { provider: created.provider, externalId: created.sandboxId, sessionId: created.sessionId });
        return result(attemptId, 'WAITING');
      }
      if (create.state === 'ABANDONED') return result(attemptId, 'TERMINATED');
      const recovered = await this.recoverCreate(attemptId, lease, environment, create, plan.sandbox, adapter);
      if (!recovered) return result(attemptId, 'QUARANTINED');
      environment = recovered;
      execution = await this.deps.store.getExecution(attemptId);
    }

    const handle = handleFor(environment);
    const observed = await adapter.observe(handle);
    environment = await this.deps.store.recordObservation(lease, environment.id,
      observation(observed.providerStatus, observed.observedAt, observed.expiresAt));
    execution = await this.deps.store.getExecution(attemptId);
    const currentAttempt = await this.requireAttempt(attemptId);
    if (environment.state === 'TERMINATED') {
      // A terminal provider observation means the worker filesystem is no
      // longer a trusted source of bytes. Persist the real missing-artifact
      // outcome instead of asking the collector to invent a receipt.
      await this.deps.store.closeAttemptAdmission(lease, environment.id, { preserveEvaluation: true });
      const seal = execution?.artifactSeal ?? await this.deps.store.recordArtifactFailure(lease, environment.id, {
        receiptId: `artifact-failure:${environment.id}`,
        failureCode: 'PROVIDER_TERMINATED_BEFORE_ARTIFACT_SEAL',
      });
      return this.finishTerminal(lease, environment, seal, plan.actorId);
    }
    const stopEffect = effectFor(execution, environment.id, 'STOP');
    const existingCommand = effectFor(execution, environment.id, 'COMMAND');
    if (cancelled(currentAttempt) || stale || stopEffect || execution?.artifactSeal) {
      const outcome: WorkerArtifactOutcome = existingCommand
          && ['CLAIMED', 'UNKNOWN'].includes(existingCommand.state)
        ? { kind: 'COMMAND_RESULT_UNKNOWN', commandOperationId: existingCommand.effectId }
        : cancelled(currentAttempt) ? { kind: 'CANCELLED' }
          : stale ? { kind: 'CONTROLLER_SUPERSEDED' } : { kind: 'STOP_REQUESTED' };
      return this.sealAndStop(lease, currentAttempt, environment, handle, plan, adapter, outcome, execution?.artifactSeal ?? null);
    }
    if (observed.state !== 'RUNNING') return result(attemptId, 'WAITING');

    let command = effectFor(execution, environment.id, 'COMMAND');
    const commandDigest = launchDigest(plan.command);
    if (!command) {
      try { command = (await this.deps.store.planCommand(lease, environment.id, { commandDigest })).effect; }
      catch (error) {
        const fresh = await this.requireAttempt(attemptId);
        if (cancelled(fresh)) return this.sealAndStop(lease, fresh, environment, handle, plan, adapter, { kind: 'CANCELLED' }, null);
        const code = authorityClosed(error);
        if (code) return this.sealAndStop(lease, fresh, environment, handle, plan, adapter, { kind: 'AUTHORITY_CLOSED', code }, null);
        throw error;
      }
    }
    if (command.commandDigest !== commandDigest) throw new Error('FROZEN_COMMAND_MISMATCH');
    if (command.state === 'INTENT_RECORDED') {
      lease = await this.deps.store.heartbeat(lease, this.ttl);
      let claimed: boolean;
      try { claimed = (await this.deps.store.claimEffect(lease, command.effectId)).claimed; }
      catch (error) {
        const fresh = await this.requireAttempt(attemptId);
        if (cancelled(fresh)) return this.sealAndStop(lease, fresh, environment, handle, plan, adapter, { kind: 'CANCELLED' }, null);
        const code = authorityClosed(error);
        if (code) return this.sealAndStop(lease, fresh, environment, handle, plan, adapter, { kind: 'AUTHORITY_CLOSED', code }, null);
        throw error;
      }
      if (!claimed) return result(attemptId, 'WAITING');
      let started: Awaited<ReturnType<Adapter['startCommand']>>;
      try { started = await adapter.startCommand(handle, { ...plan.command, intent: { status: 'RECORDED', operationId: command.effectId } }); }
      catch {
        await this.deps.store.markEffectUnknown(lease, command.effectId, 'COMMAND_RESULT_UNCERTAIN');
        return result(attemptId, 'QUARANTINED');
      }
      await this.deps.store.recordCommandResult(lease, command.effectId, { providerCommandId: started.commandId });
      return result(attemptId, 'RUNNING');
    }
    if (command.state !== 'RESULT_RECORDED' || !command.providerCommandId) {
      return this.sealAndStop(lease, currentAttempt, environment, handle, plan, adapter,
        { kind: 'COMMAND_RESULT_UNKNOWN', commandOperationId: command.effectId }, execution?.artifactSeal ?? null);
    }
    const commandState = await adapter.observeCommand({ ...handle, commandId: command.providerCommandId, commandOperationId: command.effectId });
    if (commandState.state === 'RUNNING') return result(attemptId, 'RUNNING');
    return this.sealAndStop(lease, currentAttempt, environment, handle, plan, adapter,
      commandOutcome(commandState), execution?.artifactSeal ?? null);
  }

  private validatePlan(attempt: AttemptProjection, plan: WorkerLaunchPlan): void {
    validateProfile(plan.sandbox);
    const boundary = requireWorkerExecutionBoundary(plan.sandbox);
    if (boundary.kind === 'provider-untrusted-circle-data'
        && !isExactProviderCircleCollection(plan.sandbox, plan.nativeCollection)) {
      throw new Error('PROVIDER_UNTRUSTED_COLLECTION_MISMATCH');
    }
    if (plan.format !== 'motive.worker-launch/0.1' || plan.workOrderId !== attempt.workOrderId || plan.termsDigest !== attempt.termsDigest
        || plan.inputDigest !== attempt.inputDigest || plan.inferenceProfileDigest !== attempt.profileDigest || !plan.actorId
        || !Number.isInteger(plan.capabilityTtlSeconds) || plan.capabilityTtlSeconds <= 0
        || !plan.sandbox.allowedExecutables.includes(plan.command.executable)) throw new Error('LAUNCH_PLAN_MISMATCH');
    // Reject malformed commands before reserving or creating a paid environment.
    if (!Array.isArray(plan.command.args) || plan.command.args.length > 512 ||
        plan.command.args.some(arg => typeof arg !== 'string' || arg.length > 16_384 || arg.includes('\0'))) {
      throw new Error('LAUNCH_COMMAND_INVALID');
    }
    if (plan.command.cwd !== undefined) resolveWorkspacePath(plan.command.cwd, 'cwd');
    // Use the exact same strict canonical format as artifact manifest bindings.
    launchDigest(plan);
  }
  private async requireAttempt(attemptId: string): Promise<AttemptProjection> {
    const attempt = await this.deps.ledger.getAttempt(attemptId);
    if (!attempt) throw new Error('ATTEMPT_NOT_FOUND');
    return attempt;
  }
  private async recoverCreate(attemptId: string, lease: ControllerLease, environment: EnvironmentProjection,
    create: EffectIntent, profile: SandboxExecutionProfile, adapter: Adapter): Promise<EnvironmentProjection | null> {
    if (environment.leaseEpoch === null) throw new Error('ENVIRONMENT_LEASE_UNAVAILABLE');
    const inventory = await adapter.discoverOwned();
    const expectedTags = ownerTags(attemptId, environment.leaseEpoch, profile.profileDigest);
    const matches = inventory.sandboxes.filter(item => item.sandboxId === sandboxName(attemptId, environment.leaseEpoch!) && !item.persistent
      && Object.entries(expectedTags).every(([key, value]) => item.tags[key] === value));
    if (matches.length !== 1) return null;
    const found = matches[0];
    const recovered: SandboxHandle = { provider: 'vercel', attemptId, leaseEpoch: environment.leaseEpoch,
      profileDigest: profile.profileDigest, sandboxId: found.sandboxId, sessionId: found.sessionId };
    await adapter.observe(recovered);
    return this.deps.store.recordRecoveredCreate(lease, create.effectId,
      { provider: 'vercel', externalId: found.sandboxId, sessionId: found.sessionId });
  }

  private async ensureArtifacts(lease: ControllerLease, attempt: AttemptProjection, environment: EnvironmentProjection,
    handle: SandboxHandle, plan: WorkerLaunchPlan, outcome: WorkerArtifactOutcome,
    existing: ArtifactSealProjection | null): Promise<ArtifactSealProjection> {
    if (existing) return existing;
    let receipt: { manifestDigest: Digest; receiptId: string };
    try { receipt = await this.deps.artifacts.seal({ lease: structuredClone(lease), attempt, environment, handle, plan, outcome }); }
    catch {
      return this.deps.store.recordArtifactFailure(lease, environment.id,
        { receiptId: `artifact-failure:${environment.id}`, failureCode: 'ARTIFACT_SEAL_FAILED' });
    }
    // A store failure is not a collector failure; the real idempotent receipt remains recoverable.
    return this.deps.store.recordArtifactSeal(lease, environment.id, receipt);
  }
  private async sealAndStop(lease: ControllerLease, attempt: AttemptProjection, environment: EnvironmentProjection,
    handle: SandboxHandle, plan: WorkerLaunchPlan, adapter: Adapter, outcome: WorkerArtifactOutcome,
    existing: ArtifactSealProjection | null): Promise<ReconcileResult> {
    const seal = await this.ensureArtifacts(lease, attempt, environment, handle, plan, outcome, existing);
    return this.stop(lease, environment, plan.actorId, adapter, seal);
  }
  private async revoke(actorId: string | null, attemptId: string, idempotencyKey: string): Promise<boolean> {
    if (actorId === null) return false;
    try {
      await this.deps.ledger.revokeRunCapability({ actorId, attemptId, idempotencyKey, reason: 'Worker teardown requested' });
      return true;
    } catch { return false; }
  }
  private terminalResult(attemptId: string, seal: ArtifactSealProjection | null, capabilityRevoked: boolean): ReconcileResult {
    if (!capabilityRevoked) return result(attemptId, 'QUARANTINED');
    return result(attemptId, seal?.status === 'SEALED' ? 'SEALED' : 'TERMINATED');
  }
  private async finishTerminal(lease: ControllerLease, environment: EnvironmentProjection, seal: ArtifactSealProjection | null,
    actorId: string | null): Promise<ReconcileResult> {
    // A sealed worker phase blocks inference but can retain evaluator authority.
    // Missing plans/issuers and failed artifacts use the full closure boundary.
    await this.deps.store.closeAttemptAdmission(lease, environment.id,
      { preserveEvaluation: actorId !== null && seal?.status === 'SEALED' });
    const capabilityClosed = actorId === null
      ? true
      : await this.revoke(actorId, lease.attemptId, `worker-terminal:${environment.id}`);
    return this.terminalResult(lease.attemptId, seal, capabilityClosed);
  }
  private async stop(lease: ControllerLease, environment: EnvironmentProjection, actorId: string | null,
    adapter: Adapter, seal: ArtifactSealProjection | null): Promise<ReconcileResult> {
    const { effect } = await this.deps.store.requestStop(lease, environment.id,
      { preserveEvaluation: actorId !== null && seal?.status === 'SEALED' });
    // requestStop atomically fences model admission with the durable intent.
    const revoked = actorId === null
      ? true
      : await this.revoke(actorId, lease.attemptId, `worker-stop:${effect.effectId}`);
    if (!(await this.deps.store.claimEffect(lease, effect.effectId)).claimed) {
      const execution = await this.deps.store.getExecution(lease.attemptId);
      const current = execution?.environments.find(item => item.id === environment.id);
      if (current?.state === 'TERMINATED') return this.terminalResult(lease.attemptId, execution?.artifactSeal ?? seal, revoked);
      return result(lease.attemptId, revoked ? 'STOPPING' : 'QUARANTINED');
    }
    let stopped: Awaited<ReturnType<Adapter['stop']>>;
    try { stopped = await adapter.stop(handleFor(environment)); }
    catch {
      await this.deps.store.markEffectUnknown(lease, effect.effectId, 'STOP_RESULT_UNCERTAIN');
      return result(lease.attemptId, revoked ? 'STOPPING' : 'QUARANTINED');
    }
    // Persist outside the provider catch so a database failure never fabricates provider ambiguity.
    const saved = await this.deps.store.recordStopResult(lease, effect.effectId, observation(stopped.providerStatus));
    if (saved.state !== 'TERMINATED') return result(lease.attemptId, revoked ? 'STOPPING' : 'QUARANTINED');
    return this.terminalResult(lease.attemptId, seal, revoked);
  }

  private async cleanupWithoutPlan(attempt: AttemptProjection): Promise<ReconcileResult> {
    const execution = await this.deps.store.getExecution(attempt.id);
    const environment = workerFor(execution);
    if (!environment || environment.state === 'ABANDONED') return result(attempt.id, 'UNCONFIGURED');
    const lease = await this.deps.store.acquireLease(attempt.id, this.deps.ownerId, this.ttl);
    if (environment.state === 'TERMINATED') {
      await this.deps.store.closeAttemptAdmission(lease, environment.id);
      const seal = execution?.artifactSeal ?? await this.deps.store.recordArtifactFailure(lease, environment.id, {
        receiptId: `artifact-failure:${environment.id}`,
        failureCode: 'PROVIDER_TERMINATED_BEFORE_ARTIFACT_SEAL',
      });
      return this.finishTerminal(lease, environment, seal, null);
    }
    if (environment.state === 'RESERVED' && !environment.externalId) {
      await this.deps.store.abandonReservedEnvironment(lease, environment.id);
      return result(attempt.id, 'UNCONFIGURED');
    }
    // Without reviewed launch material there is no trusted issuer identity.
    // Close model admission before any slower discovery/artifact cleanup.
    await this.deps.store.closeAttemptAdmission(lease, environment.id);
    let current = environment;
    let profile: SandboxExecutionProfile;
    try { profile = profileFor(environment); }
    catch {
      return this.cleanupFromOwnedInventory(lease, current);
    }
    const adapter = this.deps.adapter(profile);
    if (!current.externalId) {
      const create = effectFor(execution, current.id, 'CREATE');
      if (!create) throw new Error('CREATE_INTENT_MISSING');
      const recovered = await this.recoverCreate(attempt.id, lease, current, create, profile, adapter);
      if (!recovered) return result(attempt.id, 'QUARANTINED');
      current = recovered;
    }
    const handle = handleFor(current);
    const observed = await adapter.observe(handle);
    current = await this.deps.store.recordObservation(lease, current.id,
      observation(observed.providerStatus, observed.observedAt, observed.expiresAt));
    if (current.state === 'TERMINATED') await this.deps.store.closeAttemptAdmission(lease, current.id);
    let seal = execution?.artifactSeal ?? null;
    if (!seal) seal = await this.deps.store.recordArtifactFailure(lease, current.id,
      { receiptId: `artifact-failure:${current.id}`, failureCode: 'LAUNCH_PLAN_UNAVAILABLE' });
    if (current.state === 'TERMINATED') {
      return this.finishTerminal(lease, current, seal, null);
    }
    return this.stop(lease, current, null, adapter, seal);
  }

  private async cleanupFromOwnedInventory(lease: ControllerLease, environment: EnvironmentProjection): Promise<ReconcileResult> {
    const inventory = await this.deps.orphanProvider.discover();
    let current = environment;
    let matches: OwnedSandboxObservation[];
    if (current.externalId && current.sessionId) {
      matches = inventory.sandboxes.filter(item => item.sandboxId === current.externalId && item.sessionId === current.sessionId);
    } else {
      if (!current.attemptId || current.leaseEpoch === null || !current.profileDigest) return result(lease.attemptId, 'QUARANTINED');
      const expectedTags = ownerTags(current.attemptId, current.leaseEpoch, current.profileDigest);
      matches = inventory.sandboxes.filter(item => item.sandboxId === sandboxName(current.attemptId!, current.leaseEpoch!) && !item.persistent
        && Object.entries(expectedTags).every(([key, value]) => item.tags[key] === value));
      if (matches.length === 1) {
        const create = (await this.deps.store.getExecution(lease.attemptId))?.effects
          .find(effect => effect.environmentId === current.id && effect.kind === 'CREATE');
        if (!create) throw new Error('CREATE_INTENT_MISSING');
        current = await this.deps.store.recordRecoveredCreate(lease, create.effectId, {
          provider: 'vercel', externalId: matches[0].sandboxId, sessionId: matches[0].sessionId,
        });
      }
    }
    if (matches.length !== 1) return result(lease.attemptId, 'QUARANTINED');
    const seal = (await this.deps.store.getExecution(lease.attemptId))?.artifactSeal
      ?? await this.deps.store.recordArtifactFailure(lease, current.id, {
        receiptId: `artifact-failure:${current.id}`, failureCode: 'LAUNCH_PLAN_UNAVAILABLE',
      });
    const terminal = await this.stopKnownEnvironment(current, matches[0]);
    return terminal ? this.terminalResult(lease.attemptId, seal, true) : result(lease.attemptId, 'QUARANTINED');
  }

  private async stopKnownEnvironment(environment: EnvironmentProjection, item: OwnedSandboxObservation): Promise<boolean> {
    if (!environment.attemptId || environment.state === 'TERMINATED') return false;
    const lease = await this.deps.store.acquireLease(environment.attemptId, this.deps.ownerId, this.ttl);
    const saved = await this.deps.store.recordObservation(lease, environment.id,
      observation(item.providerStatus, item.observedAt, item.expiresAt));
    if (saved.state === 'TERMINATED') {
      await this.deps.store.closeAttemptAdmission(lease, saved.id);
      return true;
    }
    const { effect } = await this.deps.store.requestStop(lease, saved.id);
    if (!(await this.deps.store.claimEffect(lease, effect.effectId)).claimed) {
      const execution = await this.deps.store.getExecution(lease.attemptId);
      return execution?.environments.find(candidate => candidate.id === saved.id)?.state === 'TERMINATED';
    }
    let stopped: ProviderObservation;
    try { stopped = await this.deps.orphanProvider.stopOwned(item, effect.effectId); }
    catch {
      await this.deps.store.markEffectUnknown(lease, effect.effectId, 'STOP_RESULT_UNCERTAIN');
      return false;
    }
    const recorded = await this.deps.store.recordStopResult(lease, effect.effectId, stopped);
    return recorded.state === 'TERMINATED';
  }

  async reconcileOrphans(): Promise<{ status: 'COMPLETE' | 'INCOMPLETE'; discovered: number; stopped: number;
    unresolved: number; unresolvedTruncated: boolean }> {
    const { store, orphanProvider } = this.deps;
    const inventory = await orphanProvider.discover();
    const candidateLimit = 500;
    const candidates = await store.listReconciliationCandidates(candidateLimit);
    const attempts = [...new Set(candidates.flatMap(candidate => (candidate.environment.kind === 'WORKER' || this.deps.evaluator)
      && candidate.environment.attemptId ? [candidate.environment.attemptId] : []))];
    let failed = false;
    for (const attemptId of attempts) {
      try {
        const evaluator = candidates.some(item => item.environment.attemptId === attemptId && item.environment.kind === 'EVALUATOR');
        if (evaluator && this.deps.evaluator) await this.deps.evaluator.reconcileAttempt(attemptId);
        else await this.reconcileAttempt(attemptId);
      } catch { failed = true; }
    }
    let stopped = 0;
    for (const item of inventory.sandboxes) {
      try { if (await this.reconcileOwnedItem(item)) stopped += 1; }
      catch { failed = true; }
    }
    const unresolved = await store.listReconciliationCandidates(candidateLimit);
    // COMPLETE describes this bounded inventory scan, not physical teardown.
    // Unknown/claimed effects remain explicit in the unresolved summary.
    return { status: !failed && inventory.complete && candidates.length < candidateLimit ? 'COMPLETE' : 'INCOMPLETE',
      discovered: inventory.sandboxes.length, stopped, unresolved: unresolved.length,
      unresolvedTruncated: unresolved.length === candidateLimit };
  }

  private async reconcileOwnedItem(item: OwnedSandboxObservation): Promise<boolean> {
    const { store } = this.deps;
    if (item.tags['motive-owner'] !== 'control' || !['worker', 'evaluator'].includes(item.tags['motive-kind'])) return false;
    const known = await store.findEnvironment({ provider: 'vercel', externalId: item.sandboxId, sessionId: item.sessionId });
    if (known?.state === 'TERMINATED' && !terminal(item.providerStatus)) return this.stopOrphan(item);
    if (known?.attemptId) {
      try {
        if (known.kind === 'WORKER') await this.reconcileAttempt(known.attemptId);
        else if (this.deps.evaluator) await this.deps.evaluator.reconcileAttempt(known.attemptId);
        else return this.stopKnownEnvironment(known, item);
      } catch {
        return this.stopKnownEnvironment(known, item);
      }
      return false;
    }
    if (known) {
      await store.recordOrphanObservation(known.id, observation(item.providerStatus, item.observedAt, item.expiresAt));
      if (terminal(item.providerStatus)) return false;
    } else if (terminal(item.providerStatus)) return false;
    return this.stopOrphan(item);
  }

  private async stopOrphan(item: OwnedSandboxObservation): Promise<boolean> {
    const { store, orphanProvider } = this.deps;
    const { effect } = await store.recordOrphan({ kind: item.tags['motive-kind'] === 'evaluator' ? 'EVALUATOR' : 'WORKER',
      handle: { provider: 'vercel', externalId: item.sandboxId, sessionId: item.sessionId }, providerStatus: item.providerStatus,
      identityDigest: launchDigest({ sandboxId: item.sandboxId, sessionId: item.sessionId, tags: item.tags }),
      observedAt: item.observedAt.toISOString() });
    if (!(await store.claimOrphanStop(this.deps.ownerId, effect.effectId)).claimed) return false;
    let stopped: ProviderObservation;
    try { stopped = await orphanProvider.stopOwned(item, effect.effectId); }
    catch {
      await store.markOrphanStopUnknown(this.deps.ownerId, effect.effectId, 'ORPHAN_STOP_RESULT_UNCERTAIN');
      return false;
    }
    await store.recordOrphanStopResult(this.deps.ownerId, effect.effectId, stopped);
    return stopped.providerTerminal;
  }
}
