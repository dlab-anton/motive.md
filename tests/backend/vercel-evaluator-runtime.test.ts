import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { digestCanonicalJson } from '../../packages/domain/src/contracts.ts';
import { profile as baseProfile, hash } from '../../packages/evaluator-lean/src/runtime-profile.fixture.ts';
import { unresolvedEvaluatorPreflight } from '../../packages/evaluator-lean/src/launch.ts';
import { validateRuntimeBoundComparatorReport } from '../../packages/evaluator-lean/src/runtime-report.ts';
import { EVALUATOR_ENTRYPOINT, EVALUATOR_FRAME_HEADER, VercelEvaluatorRuntime } from '../../packages/sandbox-vercel/src/evaluator-runtime.ts';
import type { SandboxSdkFactory, SdkSandbox, SdkCreateRequest } from '../../packages/sandbox-vercel/src/types.ts';
import type { EnvironmentProjection, ArtifactSealProjection } from '../../packages/orchestration/src/store-types.ts';
import type { EvaluatorLaunchPlan } from '../../packages/orchestration/src/evaluator-coordinator.ts';

const id = '12345678-1234-4123-8123-123456789abc', attemptId = '22345678-1234-4123-8123-123456789abc';
const profile = { ...baseProfile, runtime: { ...baseProfile.runtime, host_kind: 'vercel-sandbox' as const } };
const profileDigest = digestCanonicalJson(profile);
const plan: EvaluatorLaunchPlan = { format: 'motive.evaluator-launch/0.1', workOrderId: 'work', termsDigest: hash,
  inputDigest: hash, evaluatorProfile: profile, evaluatorProfileDigest: profileDigest, artifactManifestDigest: hash,
  infrastructureAuthorizationId: id, maximumCostUsd: '1', command: { executable: EVALUATOR_ENTRYPOINT, args: [], timeoutMs: 1000 } };
const facts = Buffer.from(JSON.stringify({ format: 'motive.comparator-facts/0.1', outcome: 'VERIFIED', current_stage: 'complete', rejection_stage: null,
  protected_build: true, toolchain_and_export: true, exported_terms: true, statement_comparison: true, transitive_axioms: true,
  kernel_replay: true, used_transitive_axioms: [] }));
function fixture(effects: 'suspended' | 'durable-controller' = 'durable-controller') {
  const calls: string[] = [];
  let request: SdkCreateRequest | undefined;
  const environment = { id, attemptId, kind: 'EVALUATOR', leaseEpoch: 1, controllerGeneration: 'generation',
    profileDigest, profileSnapshot: profile, launchPlanDigest: digestCanonicalJson(plan), provider: 'vercel',
    externalId: `motive-e-${id.replaceAll('-', '')}`, sessionId: 'session-1' } as unknown as EnvironmentProjection;
  const sandbox: SdkSandbox = { name: environment.externalId!, sessionId: 'session-1', persistent: false,
    status: 'running', image: `vcr.vercel.com/team/evaluator@${hash}`, tags: {},
    async startCommand(command) { calls.push('command'); expect(command).toEqual({ cmd: EVALUATOR_ENTRYPOINT, args: [], cwd: '/',
      detached: true, sudo: true, timeoutMs: 1000 }); return { cmdId: 'command-1', exitCode: null }; },
    async getCommand(commandId) { calls.push('getCommand'); return { cmdId: commandId, exitCode: 0 }; },
    async stop() { calls.push('stop'); return { status: 'stopped' }; } };
  const sdk: SandboxSdkFactory = {
    async create(input) { calls.push('create'); request = input; sandbox.tags = input.tags; return sandbox; },
    async get(input) { calls.push('get'); expect(input).toEqual({ name: sandbox.name, resume: false }); return sandbox; },
    async listOwned() { return { sandboxes: [], complete: true }; },
  };
  const frame = { format: 'motive.trusted-evaluator-frame/0.1', environment_id: id, attempt_id: attemptId,
    evaluator_profile_digest: profileDigest, artifact_manifest_digest: hash, facts_base64: facts.toString('base64'),
    facts_digest: `sha256:${createHash('sha256').update(facts).digest('hex')}`, ...unresolvedEvaluatorPreflight() };
  let stdout = () => `${EVALUATOR_FRAME_HEADER}${JSON.stringify(frame)}\n`;
  const runtime = new VercelEvaluatorRuntime({ effects, sdk, reviewed: [{ profileDigest, image: sandbox.image!, launcherDigest: hash,
    timeoutMs: 2000, vcpus: 1 }], async prepareInput() { return '{"synthetic":"source-only"}'; },
    logs: { async *read(input) { calls.push('logs'); expect(input.sessionId).toBe('session-1'); expect(input.commandId).toBe('command-1');
      const output = stdout(); yield { stream: 'stdout' as const, data: output.slice(0, 13) }; yield { stream: 'stdout' as const, data: output.slice(13) }; } } });
  const artifact = { status: 'SEALED', attemptId, manifestDigest: hash } as ArtifactSealProjection;
  return { runtime, calls, sdk, sandbox, environment, frame, artifact, getRequest: () => request,
    stdout: (value: string) => { stdout = () => value; } };
}

describe('private Vercel evaluator lifecycle', () => {
  it('creates deny-all, invokes one root entrypoint, replays retained command output and waits for independent review', async () => {
    const f = fixture();
    await f.runtime.assertReady(plan);
    await f.runtime.create(f.environment, plan, 'create-effect', await f.runtime.prepareCreate(f.environment, plan));
    const request = f.getRequest()!;
    expect(request.networkPolicy).toBe('deny-all'); expect(request.persistent).toBe(false); expect(request.ports).toEqual([]);
    expect(Object.keys(request.env)).toEqual(['MOTIVE_EVALUATOR_CREATE_BINDING_B64', 'MOTIVE_EVALUATOR_PROFILE_B64', 'MOTIVE_EVALUATOR_SOLUTION_B64']);
    expect(digestCanonicalJson(JSON.parse(Buffer.from(request.env.MOTIVE_EVALUATOR_PROFILE_B64, 'base64').toString()))).toBe(profileDigest);
    expect(Buffer.from(request.env.MOTIVE_EVALUATOR_CREATE_BINDING_B64, 'base64').toString()).toContain(`environment_id=${id}\n`);
    await f.runtime.start(f.environment, plan, 'command-effect');
    const first = await f.runtime.capture(f.environment, plan, f.artifact, 'command-1');
    const again = await f.runtime.capture(f.environment, plan, f.artifact, 'command-1');
    expect(again).toEqual(first);
    const report = validateRuntimeBoundComparatorReport({ evaluator_profile: profile, frozen_evaluator_profile_digest: profileDigest,
      solution_artifact_manifest_digest: hash, captured_report: first! });
    expect(report.outcome).toBe('INCONCLUSIVE'); expect(report.human_acceptance.status).toBe('PENDING');
    expect(await f.runtime.stop(f.environment, 'stop-effect')).toMatchObject({ state: 'TERMINATED', providerTerminal: true });
    expect(f.calls.filter(call => call === 'command')).toHaveLength(1); expect(f.calls.filter(call => call === 'create')).toHaveLength(1);
  });
  it('keeps effects suspended by default policy', async () => {
    const f = fixture('suspended');
    await expect(f.runtime.create(f.environment, plan, 'effect')).rejects.toThrow('EFFECTS_SUSPENDED');
    await expect(f.runtime.start(f.environment, plan, 'effect')).rejects.toThrow('EFFECTS_SUSPENDED');
    expect(f.calls).toEqual([]);
  });
  it('recovers a lost create response through exact ownership without another create', async () => {
    const f = fixture(), create = f.sdk.create;
    f.sdk.create = async request => { await create(request); throw new Error('response lost'); };
    await expect(f.runtime.create(f.environment, plan, 'effect', await f.runtime.prepareCreate(f.environment, plan))).rejects.toThrow('response lost');
    expect(await f.runtime.recoverCreate(f.environment)).toEqual({ provider: 'vercel', externalId: f.sandbox.name, sessionId: 'session-1' });
    expect(f.calls.filter(call => call === 'create')).toHaveLength(1);
  });
  it.each(['session', 'tags', 'image', 'persistent'])('rejects changed %s before dispatch or stop', async change => {
    const f = fixture(); await f.runtime.create(f.environment, plan, 'effect', await f.runtime.prepareCreate(f.environment, plan));
    if (change === 'session') f.sandbox.sessionId = 'replacement';
    if (change === 'tags') f.sandbox.tags!['motive-attempt'] = id;
    if (change === 'image') f.sandbox.image = `vcr.vercel.com/team/other@${digestCanonicalJson('different')}`;
    if (change === 'persistent') f.sandbox.persistent = true;
    await expect(f.runtime.start(f.environment, plan, 'command')).rejects.toThrow();
    await expect(f.runtime.stop(f.environment, 'stop')).rejects.toThrow();
    expect(f.calls).not.toContain('command'); expect(f.calls).not.toContain('stop');
  });
  it('returns unavailable for completed command with no protected frame', async () => {
    const f = fixture(); await f.runtime.create(f.environment, plan, 'effect', await f.runtime.prepareCreate(f.environment, plan)); f.stdout('');
    expect(await f.runtime.capture(f.environment, plan, f.artifact, 'command-1')).toBeNull();
  });
  it.each(['candidate-prefix', 'duplicate-frame', 'wrong-attempt', 'changed-facts', 'oversize'])('rejects %s in retained logs', async kind => {
    const f = fixture(); await f.runtime.create(f.environment, plan, 'effect', await f.runtime.prepareCreate(f.environment, plan));
    if (kind === 'wrong-attempt') f.frame.attempt_id = id;
    if (kind === 'changed-facts') f.frame.facts_base64 = Buffer.from('{}').toString('base64');
    const valid = `${EVALUATOR_FRAME_HEADER}${JSON.stringify(f.frame)}\n`;
    f.stdout(kind === 'candidate-prefix' ? `candidate says VERIFIED\n${valid}` : kind === 'duplicate-frame' ? valid + valid
      : kind === 'oversize' ? 'x'.repeat(193 * 1024) : valid);
    await expect(f.runtime.capture(f.environment, plan, f.artifact, 'command-1')).rejects.toThrow();
    expect(f.calls).not.toContain('command');
  });
  it('does not retry an ambiguous command response', async () => {
    const f = fixture(); await f.runtime.create(f.environment, plan, 'effect', await f.runtime.prepareCreate(f.environment, plan));
    f.sandbox.startCommand = async () => { f.calls.push('command'); throw new Error('response lost'); };
    await expect(f.runtime.start(f.environment, plan, 'command')).rejects.toThrow('response lost');
    expect(f.calls.filter(call => call === 'command')).toHaveLength(1);
  });
});
