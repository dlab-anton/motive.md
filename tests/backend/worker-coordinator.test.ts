import { describe, expect, it, vi } from 'vitest';
import { DurableWorkerCoordinator, launchDigest, type CoordinatorDependencies, type WorkerLaunchPlan } from '../../packages/orchestration/src/coordinator.ts';
import type { AttemptProjection } from '../../packages/accounting/src/kernel.ts';
import type { ControllerLease, EffectIntent, EnvironmentProjection, ExecutionProjection, OrchestrationStore } from '../../packages/orchestration/src/store-types.ts';
import { ownerTags, sandboxName } from '../../packages/sandbox-vercel/src/policy.ts';
import type { SandboxHandle } from '../../packages/sandbox-vercel/src/types.ts';
import { defineProtectedRuntime } from '../../packages/sandbox-vercel/src/protected-runtime.ts';
import { defineProviderUntrustedDataRuntime } from '../../packages/sandbox-vercel/src/execution-boundary.ts';
import { CIRCLE_LEARNING_COLLECTOR } from '../../packages/orchestration/src/circle-data-boundary.ts';

const digest = `sha256:${'a'.repeat(64)}` as const;
const attemptId = '11111111-1111-4111-8111-111111111111';
function fixture() {
  const events: string[] = [];
  const attempt: AttemptProjection = { id: attemptId, projectId: 'project', workOrderId: 'work', grantId: 'grant', sourceId: 'source',
    termsDigest: digest, inputDigest: digest, profileDigest: digest, ceilingAmount: '2', consumedAmount: '0', requestHeldAmount: '0',
    availableAmount: '2', deficitAmount: '0', executionStatus: 'RESERVED', leaseEpoch: 1, controllerGeneration: 'generation',
    admissionClosedAt: null, cancellationRequestedAt: null, createdAt: new Date().toISOString() };
  const plan: WorkerLaunchPlan = { format: 'motive.worker-launch/0.1', workOrderId: 'work', termsDigest: digest,
    inputDigest: digest, inferenceProfileDigest: digest, actorId: 'operator', infrastructureAuthorizationId: 'infra', maximumCostUsd: '1',
    capabilityTtlSeconds: 120, command: { executable: '/usr/local/bin/codex', args: ['exec', 'approved fixture'] },
    sandbox: { format: 'motive.sandbox-profile/0.1', profileDigest: digest, protectedRuntime: defineProtectedRuntime(digest),
      trustedSource: { kind: 'snapshot', snapshotId: 'snap_MotiveTrusted01', materialDigest: digest, buildRecipeDigest: digest, sourceCommit: 'a'.repeat(40) },
      timeoutMs: 120000, commandTimeoutMs: 60000, vcpus: 2, allowedExecutables: ['/usr/local/bin/codex'],
      egress: { gateway: [{ url: 'https://gateway.motive.example/v1/responses', methods: ['POST'], pathMatch: 'exact' }],
        artifacts: [{ url: 'https://artifacts.motive.example/upload/attempt/', methods: ['PUT'], pathMatch: 'prefix' }] },
      artifacts: { maxFiles: 8, maxFileBytes: 1024, maxTotalBytes: 8192 } } };
  const lease: ControllerLease = { attemptId, ownerId: 'owner', epoch: 1, controllerGeneration: 'generation', expiresAt: new Date(Date.now() + 60000).toISOString() };
  const environment: EnvironmentProjection = { id: 'environment', attemptId, sourceId: 'source', grantId: 'grant', kind: 'WORKER', state: 'ACTIVE',
    leaseEpoch: 1, controllerGeneration: 'generation', profileDigest: digest, profileSnapshot: {}, launchPlanDigest: launchDigest(plan),
    infrastructureAuthorizationId: 'infra', maximumCostUsd: '1', heldCostUsd: '1', consumedCostUsd: '0', provider: 'vercel',
    externalId: sandboxName(attemptId, 1), sessionId: 'session', providerStatus: 'running', providerExpiresAt: null,
    lastObservedAt: null, terminatedAt: null, orphanReason: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const create: EffectIntent = { effectId: 'create-effect', environmentId: environment.id, attemptId, kind: 'CREATE', state: 'RESULT_RECORDED', claimed: false,
    commandDigest: null, providerCommandId: null, claimedAt: null };
  const execution: ExecutionProjection = { attemptId, lease, environments: [environment], effects: [create], artifactSeal: null };
  const store = {
    acquireLease: vi.fn(async () => lease), heartbeat: vi.fn(async () => lease), getExecution: vi.fn(async () => execution),
    closeAttemptAdmission: vi.fn(async () => {}),
    abandonReservedEnvironment: vi.fn(async () => { environment.state = 'ABANDONED'; return environment; }),
    reserveEnvironment: vi.fn(async () => { events.push('reserve'); return { environment, effect: create }; }),
    freezeNativeCollectionPlan: vi.fn(async () => { events.push('freeze-collection'); return {} as never; }),
    claimEffect: vi.fn(async (_lease, effectId) => { events.push(`claim:${effectId}`); return { effectId, claimed: true }; }),
    recordCreateResult: vi.fn(async () => { events.push('record-create'); return environment; }),
    recordRecoveredCreate: vi.fn(async (_lease, _effect, handle) => { events.push('recover'); Object.assign(environment, { provider: handle.provider, externalId: handle.externalId, sessionId: handle.sessionId }); return environment; }),
    markEffectUnknown: vi.fn(async () => { events.push('unknown'); }),
    recordObservation: vi.fn(async (_lease, _id, observation) => { events.push('observe-record'); environment.state = observation.state; return environment; }),
    planCommand: vi.fn(async (_lease, _id, input) => { events.push('command-intent'); return { effect: { ...create, kind: 'COMMAND', state: 'INTENT_RECORDED', effectId: 'command-effect', commandDigest: input.commandDigest } as EffectIntent }; }),
    recordCommandResult: vi.fn(async () => { events.push('command-result'); }),
    requestStop: vi.fn(async () => { events.push('stop-intent'); return { effect: { ...create, kind: 'STOP', state: 'INTENT_RECORDED', effectId: 'stop-effect' } as EffectIntent }; }),
    recordStopResult: vi.fn(async (_lease, _id, observed) => { events.push('stop-result'); environment.state = observed.state; return environment; }),
    recordArtifactSeal: vi.fn(async () => { events.push('seal-record'); return { environmentId: environment.id, attemptId, manifestDigest: digest, receiptId: 'receipt', status: 'SEALED' as const, failureCode: null, createdAt: new Date().toISOString() }; }),
    recordArtifactFailure: vi.fn(async () => { events.push('seal-failure'); return { environmentId: environment.id, attemptId, manifestDigest: digest, receiptId: 'receipt', status: 'FAILED' as const, failureCode: 'ARTIFACT_SEAL_FAILED', createdAt: new Date().toISOString() }; }),
    listReconciliationCandidates: vi.fn(async () => []), findEnvironment: vi.fn(async () => null),
    recordOrphan: vi.fn(async () => ({ environment, effect: { ...create, effectId: 'orphan-stop' } })),
    claimOrphanStop: vi.fn(async () => ({ effectId: 'orphan-stop', claimed: true })),
    recordOrphanStopResult: vi.fn(async () => environment), markOrphanStopUnknown: vi.fn(async () => {}),
    recordOrphanObservation: vi.fn(async () => environment),
  } satisfies Partial<OrchestrationStore>;
  const handle = { provider: 'vercel' as const, attemptId, leaseEpoch: 1, sandboxId: environment.externalId!, sessionId: 'session', profileDigest: digest };
  const adapter = {
    create: vi.fn(async () => { events.push('create'); return handle; }),
    observe: vi.fn(async () => ({ handle, state: 'RUNNING' as const, providerStatus: 'running' as const, persistent: false as const, expiresAt: null, observedAt: new Date() })),
    discoverOwned: vi.fn(async () => ({ sandboxes: [{ ...handle, state: 'RUNNING' as const, providerStatus: 'running' as const, persistent: false,
      expiresAt: null, observedAt: new Date(), tags: ownerTags(attemptId, 1, digest) }], complete: true, maximumResults: 1000 as const })),
    startCommand: vi.fn(async () => { events.push('command'); return { ...handle, commandId: 'command', commandOperationId: 'command-effect' }; }),
    observeCommand: vi.fn(async () => ({ commandId: 'command', state: 'EXITED' as const, exitCode: 0 })),
    stop: vi.fn(async (_handle: SandboxHandle) => { events.push('stop'); return { sandboxId: handle.sandboxId, state: 'STOPPED' as const, providerStatus: 'stopped' as const, alreadyTerminal: false }; }),
  };
  const ledger = {
    getAttempt: vi.fn(async () => attempt),
    issueRunCapability: vi.fn(async () => { events.push('capability'); return { capability: 'synthetic-capability', context: {} } as never; }),
    revokeRunCapability: vi.fn(async () => { events.push('revoke'); return []; }),
  };
  const artifacts = { assertReady: vi.fn(async () => {}), seal: vi.fn(async () => { events.push('seal-bytes'); return { manifestDigest: digest, receiptId: 'receipt' }; }) };
  const orphanProvider = { discover: vi.fn(async () => ({ sandboxes: [] as Awaited<ReturnType<typeof adapter.discoverOwned>>['sandboxes'], complete: true })),
    stopOwned: vi.fn(async () => ({ providerStatus: 'stopped', providerTerminal: true, state: 'TERMINATED' as const })) };
  const deps: CoordinatorDependencies = { store: store as unknown as OrchestrationStore, ledger, artifacts, orphanProvider, resolvePlan: async () => plan, adapter: () => adapter, ownerId: 'owner' };
  return { events, attempt, plan, lease, environment, create, execution, store, adapter, ledger, artifacts, orphanProvider, deps,
    run: () => new DurableWorkerCoordinator(deps).reconcileAttempt(attemptId) };
}

describe('durable worker coordinator', () => {
  it('rejects unbound plans before lease acquisition or effects', async () => {
    const f = fixture(); f.plan.inputDigest = `sha256:${'b'.repeat(64)}`;
    f.execution.environments = [];
    await expect(f.run()).rejects.toThrow('LAUNCH_PLAN_MISMATCH');
    expect(f.store.acquireLease).not.toHaveBeenCalled(); expect(f.adapter.create).not.toHaveBeenCalled();
  });
  it('rejects an invalid command working directory before provisioning', async () => {
    const f = fixture(); f.plan.command.cwd = '../outside';
    f.execution.environments = [];
    await expect(f.run()).rejects.toThrow();
    expect(f.store.acquireLease).not.toHaveBeenCalled(); expect(f.adapter.create).not.toHaveBeenCalled();
  });
  it('refuses launch when durable artifact storage is unavailable', async () => {
    const f = fixture(); f.execution.environments = []; f.artifacts.assertReady.mockRejectedValue(new Error('storage offline'));
    await expect(f.run()).rejects.toThrow('storage offline');
    expect(f.store.reserveEnvironment).not.toHaveBeenCalled(); expect(f.ledger.issueRunCapability).not.toHaveBeenCalled();
  });
  it('does not allocate or issue a capability for a legacy unprotected launch plan', async () => {
    const f = fixture(); f.execution.environments = []; delete f.plan.sandbox.protectedRuntime;
    expect((await f.run()).status).toBe('UNCONFIGURED');
    expect(f.store.reserveEnvironment).not.toHaveBeenCalled();
    expect(f.ledger.issueRunCapability).not.toHaveBeenCalled();
    expect(f.adapter.create).not.toHaveBeenCalled();
  });
  it('rejects a provider-untrusted worker without the exact circle data plan before any provider effect', async () => {
    const f = fixture(); f.execution.environments = []; delete f.plan.sandbox.protectedRuntime;
    f.plan.sandbox.providerUntrustedDataRuntime = defineProviderUntrustedDataRuntime();
    f.plan.sandbox.egress.artifacts = [];
    f.plan.sandbox.egress.gatewayProxy = { format: 'motive.vercel-gateway-proxy/0.1',
      url: new URL('/api/sandbox-egress', f.plan.sandbox.egress.gateway[0]!.url).href };
    f.plan.sandbox.artifacts = { maxFiles: 2, maxFileBytes: 32_768, maxTotalBytes: 49_152 };
    await expect(f.run()).rejects.toThrow('PROVIDER_UNTRUSTED_COLLECTION_MISMATCH');
    expect(f.store.acquireLease).not.toHaveBeenCalled(); expect(f.adapter.create).not.toHaveBeenCalled();
  });
  it('freezes the exact provider-untrusted circle plan before claiming CREATE', async () => {
    const f = fixture(); f.environment.externalId = null; f.create.state = 'INTENT_RECORDED';
    delete f.plan.sandbox.protectedRuntime;
    f.plan.sandbox.providerUntrustedDataRuntime = defineProviderUntrustedDataRuntime();
    f.plan.sandbox.egress.artifacts = [];
    f.plan.sandbox.egress.gatewayProxy = { format: 'motive.vercel-gateway-proxy/0.1',
      url: new URL('/api/sandbox-egress', f.plan.sandbox.egress.gateway[0]!.url).href };
    f.plan.sandbox.artifacts = { maxFiles: 2, maxFileBytes: 32_768, maxTotalBytes: 49_152 };
    f.plan.nativeCollection = { collectorRuntimeDigest: CIRCLE_LEARNING_COLLECTOR as typeof digest,
      maximumFileBytes: 32_768, maximumTotalBytes: 49_152, approvedPaths: [
        { relativePath: 'candidate.json', mediaType: 'application/json', availability: 'REQUIRED', maximumBytes: 32_768 },
        { relativePath: 'investigation.json', mediaType: 'application/json', availability: 'OPTIONAL_ON_FAILURE', maximumBytes: 16_384 },
      ] };
    f.environment.launchPlanDigest = launchDigest(f.plan);
    expect((await f.run()).status).toBe('WAITING');
    expect(f.events).toEqual(['freeze-collection', 'claim:create-effect', 'capability', 'create', 'record-create']);
  });
  it.each(['removed', 'invalid'])('tears down existing work when the replacement protected runtime is %s', async mode => {
    const f = fixture(); f.environment.profileSnapshot = structuredClone(f.plan.sandbox);
    if (mode === 'removed') delete f.plan.sandbox.protectedRuntime;
    else f.plan.sandbox.protectedRuntime!.runtimeDigest = `sha256:${'0'.repeat(64)}`;
    await f.run();
    expect(f.store.closeAttemptAdmission).toHaveBeenCalled();
    expect(f.adapter.stop).toHaveBeenCalledOnce();
    expect(f.adapter.create).not.toHaveBeenCalled(); expect(f.adapter.startCommand).not.toHaveBeenCalled();
  });
  it('claims the persisted create before secret issuance and remote creation', async () => {
    const f = fixture(); f.environment.externalId = null; f.create.state = 'INTENT_RECORDED';
    expect((await f.run()).status).toBe('WAITING');
    expect(f.events).toEqual(['claim:create-effect', 'capability', 'create', 'record-create']);
  });
  it('records ambiguity without retry when create may have succeeded', async () => {
    const f = fixture(); f.environment.externalId = null; f.create.state = 'INTENT_RECORDED'; f.adapter.create.mockRejectedValue(new Error('response lost'));
    expect((await f.run()).status).toBe('QUARANTINED');
    expect(f.adapter.create).toHaveBeenCalledTimes(1); expect(f.store.markEffectUnknown).toHaveBeenCalledOnce();
  });
  it('recovers ambiguous create by owned identity and source observation without creating again', async () => {
    const f = fixture(); f.environment.externalId = null; f.create.state = 'UNKNOWN';
    await f.run();
    expect(f.adapter.create).not.toHaveBeenCalled(); expect(f.store.recordRecoveredCreate).toHaveBeenCalledOnce();
    expect(f.events.indexOf('recover')).toBeLessThan(f.events.indexOf('command-intent'));
  });
  it('does not recreate or release an unknown create absent from complete inventory', async () => {
    const f = fixture(); f.environment.externalId = null; f.create.state = 'UNKNOWN'; f.adapter.discoverOwned.mockResolvedValue({ sandboxes: [], complete: true, maximumResults: 1000 });
    expect((await f.run()).status).toBe('QUARANTINED');
    expect(f.adapter.create).not.toHaveBeenCalled(); expect(f.store.recordObservation).not.toHaveBeenCalled();
  });
  it('persists and claims command intent before executing it', async () => {
    const f = fixture(); expect((await f.run()).status).toBe('RUNNING');
    expect(f.events).toEqual(['observe-record', 'command-intent', 'claim:command-effect', 'command', 'command-result']);
  });
  it('never starts another command after an ambiguous command result', async () => {
    const f = fixture(); f.execution.effects = [f.create, { ...f.create, effectId: 'command-effect', kind: 'COMMAND', state: 'UNKNOWN', commandDigest: launchDigest(f.plan.command) }];
    await f.run(); expect(f.adapter.startCommand).not.toHaveBeenCalled(); expect(f.adapter.stop).toHaveBeenCalledOnce();
  });
  it('stops the old launch after a controller takeover', async () => {
    const f = fixture(); f.lease.epoch = 2; await f.run();
    expect(f.adapter.startCommand).not.toHaveBeenCalled(); expect(f.adapter.stop.mock.calls[0]?.[0]).toMatchObject({ leaseEpoch: 1 });
  });
  it('seals real-byte receipt before stop, without treating exit zero as acceptance', async () => {
    const f = fixture(); f.execution.effects = [f.create, { ...f.create, effectId: 'command-effect', kind: 'COMMAND', state: 'RESULT_RECORDED', commandDigest: launchDigest(f.plan.command), providerCommandId: 'command' }];
    await f.run();
    expect(f.events).toEqual(['observe-record', 'seal-bytes', 'seal-record', 'stop-intent', 'revoke', 'claim:stop-effect', 'stop', 'stop-result']);
  });
  it('records collection failure and tears down instead of leaving the worker running', async () => {
    const f = fixture(); f.execution.effects = [f.create, { ...f.create, kind: 'COMMAND', commandDigest: launchDigest(f.plan.command), providerCommandId: 'command' }];
    f.artifacts.seal.mockRejectedValue(new Error('storage rejected bytes'));
    await f.run(); expect(f.store.recordArtifactSeal).not.toHaveBeenCalled(); expect(f.events.indexOf('seal-failure')).toBeLessThan(f.events.indexOf('stop'));
  });
  it('still stops when capability issuer authorization has been removed', async () => {
    const f = fixture(); f.attempt.cancellationRequestedAt = new Date().toISOString(); f.ledger.revokeRunCapability.mockRejectedValue(new Error('membership revoked'));
    expect((await f.run()).status).toBe('QUARANTINED'); expect(f.adapter.stop).toHaveBeenCalledOnce();
  });
  it('uses authoritative handle lookup, not absence from the candidate page, for orphan identity', async () => {
    const f = fixture(); f.orphanProvider.discover.mockResolvedValue(await f.adapter.discoverOwned());
    f.store.findEnvironment.mockResolvedValue(f.environment as never);
    await new DurableWorkerCoordinator(f.deps).reconcileOrphans();
    expect(f.store.recordOrphan).not.toHaveBeenCalled(); expect(f.adapter.startCommand).toHaveBeenCalledOnce();
  });
  it('reports incomplete provider inventory without asserting all orphans are resolved', async () => {
    const f = fixture(); f.orphanProvider.discover.mockResolvedValue({ sandboxes: [], complete: false });
    expect(await new DurableWorkerCoordinator(f.deps).reconcileOrphans()).toMatchObject({ status: 'INCOMPLETE' });
  });
  it('preserves successful remote create for recovery when result persistence fails', async () => {
    const f = fixture(); f.environment.externalId = null; f.create.state = 'INTENT_RECORDED';
    f.store.recordCreateResult.mockRejectedValue(new Error('database connection lost'));
    await expect(f.run()).rejects.toThrow('database connection lost');
    expect(f.adapter.create).toHaveBeenCalledOnce();
    expect(f.store.markEffectUnknown).not.toHaveBeenCalled();
  });
  it('does not turn a sealed-byte receipt into collection failure when the database write fails', async () => {
    const f = fixture(); f.execution.effects = [f.create, { ...f.create, kind: 'COMMAND', commandDigest: launchDigest(f.plan.command), providerCommandId: 'command' }];
    f.store.recordArtifactSeal.mockRejectedValue(new Error('lease fenced while storing receipt'));
    await expect(f.run()).rejects.toThrow('lease fenced while storing receipt');
    expect(f.artifacts.seal).toHaveBeenCalledOnce(); expect(f.store.recordArtifactFailure).not.toHaveBeenCalled();
    expect(f.adapter.stop).not.toHaveBeenCalled();
  });
  it('binds controller-observed command exit to the artifact collector', async () => {
    const f = fixture(); f.execution.effects = [f.create, { ...f.create, kind: 'COMMAND', commandDigest: launchDigest(f.plan.command), providerCommandId: 'command' }];
    await f.run();
    expect(f.artifacts.seal).toHaveBeenCalledWith(expect.objectContaining({ outcome: { kind: 'COMMAND_EXITED', commandId: 'command', exitCode: 0 } }));
  });
  it('rechecks cancellation after resolving the approved plan', async () => {
    const f = fixture(); f.deps.resolvePlan = async () => { f.attempt.cancellationRequestedAt = new Date().toISOString(); return f.plan; };
    await f.run(); expect(f.adapter.startCommand).not.toHaveBeenCalled(); expect(f.adapter.stop).toHaveBeenCalledOnce();
  });
  it('does not report a sealed terminal outcome while capability revocation is failing', async () => {
    const f = fixture(); f.environment.state = 'TERMINATED';
    f.execution.artifactSeal = { environmentId: f.environment.id, attemptId, manifestDigest: digest, receiptId: 'receipt', status: 'SEALED', failureCode: null, createdAt: new Date().toISOString() };
    f.ledger.revokeRunCapability.mockRejectedValue(new Error('membership removed'));
    expect((await f.run()).status).toBe('QUARANTINED');
  });
  it('abandons a cancelled create that was never claimed instead of inventing a provider stop', async () => {
    const f = fixture(); f.environment.externalId = null; f.create.state = 'INTENT_RECORDED'; f.attempt.cancellationRequestedAt = new Date().toISOString();
    expect((await f.run()).status).toBe('TERMINATED');
    expect(f.store.abandonReservedEnvironment).toHaveBeenCalledOnce();
    expect(f.adapter.create).not.toHaveBeenCalled(); expect(f.adapter.stop).not.toHaveBeenCalled();
  });
  it('closes admission again when resuming an already-terminal environment', async () => {
    const f = fixture(); f.environment.state = 'TERMINATED';
    await f.run();
    expect(f.store.closeAttemptAdmission).toHaveBeenCalled();
    expect(f.ledger.revokeRunCapability).toHaveBeenCalled();
    expect(f.adapter.create).not.toHaveBeenCalled(); expect(f.adapter.startCommand).not.toHaveBeenCalled();
  });
  it('cleans a known evaluator with the owned-session stop port instead of the worker adapter', async () => {
    const f = fixture(); f.environment.kind = 'EVALUATOR'; f.environment.externalId = `motive-e-${'1'.repeat(32)}`;
    const item = (await f.adapter.discoverOwned()).sandboxes[0];
    item.sandboxId = f.environment.externalId; item.tags['motive-kind'] = 'evaluator';
    f.orphanProvider.discover.mockResolvedValue({ sandboxes: [item], complete: true });
    f.store.findEnvironment.mockResolvedValue(f.environment as never);
    expect(await new DurableWorkerCoordinator(f.deps).reconcileOrphans()).toMatchObject({ stopped: 1 });
    expect(f.orphanProvider.stopOwned).toHaveBeenCalledOnce();
    expect(f.adapter.startCommand).not.toHaveBeenCalled(); expect(f.adapter.stop).not.toHaveBeenCalled();
  });
  it('routes a known evaluator to the configured evaluator phase during orphan scans', async () => {
    const f = fixture(); f.environment.kind = 'EVALUATOR'; f.environment.externalId = `motive-e-${'1'.repeat(32)}`;
    const item = (await f.adapter.discoverOwned()).sandboxes[0];
    item.sandboxId = f.environment.externalId; item.tags['motive-kind'] = 'evaluator';
    f.orphanProvider.discover.mockResolvedValue({ sandboxes: [item], complete: true });
    f.store.findEnvironment.mockResolvedValue(f.environment as never);
    const reconcileAttempt = vi.fn(async (id: string) => ({ attemptId: id, status: 'RUNNING' }));
    f.deps.evaluator = { reconcileAttempt };
    await new DurableWorkerCoordinator(f.deps).reconcileOrphans();
    expect(reconcileAttempt).toHaveBeenCalledWith(attemptId);
    expect(f.orphanProvider.stopOwned).not.toHaveBeenCalled();
    expect(f.adapter.startCommand).not.toHaveBeenCalled(); expect(f.adapter.stop).not.toHaveBeenCalled();
  });
});
