import { createHash } from 'node:crypto';
import { Sandbox } from '@vercel/sandbox';
import { assertDigest, canonicalJson, digestCanonicalJson, type Digest } from '../../domain/src/contracts.ts';
import { captureRuntimeBoundComparatorReport } from '../../evaluator-lean/src/capture.ts';
import { prepareTrustedEvaluatorReportBindings } from '../../evaluator-lean/src/launch.ts';
import { requireFrozenRuntimeBoundProfile } from '../../evaluator-lean/src/runtime-profile.ts';
import { MAX_SEALED_EVALUATOR_INPUT_PACK_BYTES } from '../../evaluator-lean/src/sealed-input.ts';
import type { EvaluatorLaunchPlan, EvaluatorRuntime } from '../../orchestration/src/evaluator-coordinator.ts';
import type { EnvironmentProjection, ProviderObservation } from '../../orchestration/src/store-types.ts';
import { assertRecordedOperationId } from './policy.ts';
import { createNativeVercelSdkFactory, createSingleAttemptFetch, type NativeVercelCredentials } from './vercel-sdk.ts';
import type { SandboxSdkFactory, SdkSandbox, ProviderSandboxStatus } from './types.ts';

export const EVALUATOR_ENTRYPOINT = '/opt/motive/bin/evaluator-launcher' as const;
export const EVALUATOR_FRAME_HEADER = 'MOTIVE_TRUSTED_EVALUATOR_FRAME_V1\n';
const MAX_FRAME_BYTES = 192 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const terminal = (status: ProviderSandboxStatus) => ['stopped', 'failed', 'aborted'].includes(status);
function fail(code: string): never { throw new Error(`VERCEL_EVALUATOR_${code}`); }
function sha(bytes: Uint8Array): Digest { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }

/** Private, reviewed deployment entries. Defining one does not review or publish an image. */
export type ReviewedVercelEvaluator = {
  profileDigest: Digest;
  image: string;
  launcherDigest: Digest;
  timeoutMs: number;
  vcpus: number;
};
export type EvaluatorCommandLogs = {
  read(input: { name: string; sessionId: string; commandId: string; signal: AbortSignal }):
    AsyncIterable<{ stream: 'stdout' | 'stderr'; data: string }>;
};
export type VercelEvaluatorDependencies = {
  sdk: SandboxSdkFactory;
  logs: EvaluatorCommandLogs;
  reviewed: readonly ReviewedVercelEvaluator[];
  /** Exact bounded source-only pack prepared from sealed storage; no URLs or credentials. */
  prepareInput(environment: EnvironmentProjection, plan: EvaluatorLaunchPlan): Promise<string>;
  effects?: 'suspended' | 'durable-controller';
};

/** Repeatable log READ against the recorded session, without SDK auto-resume or a helper command. */
export function createNativeEvaluatorCommandLogs(credentials: NativeVercelCredentials,
  rawFetch: typeof globalThis.fetch = globalThis.fetch): EvaluatorCommandLogs {
  const auth = { ...credentials }, fetch = createSingleAttemptFetch(rawFetch);
  return {
    async *read(input) {
      input.signal.throwIfAborted();
      const sandbox = await Sandbox.get({ name: input.name, resume: false, ...auth, fetch });
      const session = sandbox.currentSession();
      if (sandbox.name !== input.name || sandbox.persistent || session.sessionId !== input.sessionId) fail('SESSION_CHANGED');
      const command = await session.getCommand(input.commandId, { signal: input.signal });
      if (command.cmdId !== input.commandId || command.exitCode === null) fail('COMMAND_NOT_COMPLETE');
      const logs = command.logs({ signal: input.signal });
      try { for await (const line of logs) yield line; } finally { logs.close(); }
    },
  };
}

export function evaluatorCreateBinding(environment: EnvironmentProjection, plan: EvaluatorLaunchPlan): string {
  if (!UUID.test(environment.id) || !environment.attemptId || !UUID.test(environment.attemptId)) fail('IDENTITY_INVALID');
  return Buffer.from(`motive.trusted-evaluator-create/0.1\nenvironment_id=${environment.id}\nattempt_id=${environment.attemptId}\nevaluator_profile_digest=${assertDigest(plan.evaluatorProfileDigest, 'evaluator profile')}\nartifact_manifest_digest=${assertDigest(plan.artifactManifestDigest, 'artifact manifest')}\n`).toString('base64');
}

function name(environment: EnvironmentProjection): string {
  if (!UUID.test(environment.id)) fail('IDENTITY_INVALID');
  return `motive-e-${environment.id.replaceAll('-', '')}`;
}
function tags(environment: EnvironmentProjection): Record<string, string> {
  if (environment.kind !== 'EVALUATOR' || !environment.attemptId || !UUID.test(environment.attemptId)
    || !Number.isSafeInteger(environment.leaseEpoch) || environment.leaseEpoch! < 1 || !environment.controllerGeneration
    || !environment.profileDigest || !environment.launchPlanDigest) fail('IDENTITY_INVALID');
  return { 'motive-owner': 'control', 'motive-kind': 'evaluator', 'motive-environment': environment.id,
    'motive-attempt': environment.attemptId, 'motive-epoch': String(environment.leaseEpoch),
    'motive-generation': environment.controllerGeneration, 'motive-profile': environment.profileDigest,
    'motive-launch-plan': environment.launchPlanDigest };
}
function observation(status: ProviderSandboxStatus): ProviderObservation {
  const known = ['pending', 'running', 'stopping', 'stopped', 'failed', 'aborted', 'snapshotting'];
  if (!known.includes(status)) fail('STATUS_UNKNOWN');
  return { providerStatus: status, providerTerminal: terminal(status), observedAt: new Date().toISOString(),
    state: terminal(status) ? 'TERMINATED' : status === 'running' ? 'ACTIVE' : status === 'pending' ? 'PROVISIONING' : 'STOP_REQUESTED' };
}

/** One effect per invocation. Only the durable coordinator may enable effects and call this private port. */
export class VercelEvaluatorRuntime implements EvaluatorRuntime {
  private readonly entries: readonly ReviewedVercelEvaluator[];
  constructor(private readonly dependencies: VercelEvaluatorDependencies) {
    this.entries = structuredClone(dependencies.reviewed);
    const seen = new Set<string>();
    for (const entry of this.entries) {
      assertDigest(entry.profileDigest, 'reviewed profile'); assertDigest(entry.launcherDigest, 'reviewed launcher');
      if (seen.has(entry.profileDigest) || !/^vcr\.vercel\.com\/[A-Za-z0-9/._-]+@sha256:[a-f0-9]{64}$/.test(entry.image)
        || !Number.isSafeInteger(entry.timeoutMs) || entry.timeoutMs < 1000 || entry.timeoutMs > 86400000
        || !Number.isSafeInteger(entry.vcpus) || entry.vcpus < 1 || entry.vcpus > 8) fail('REGISTRY_INVALID');
      seen.add(entry.profileDigest);
    }
  }
  private enabled() { if (this.dependencies.effects !== 'durable-controller') fail('EFFECTS_SUSPENDED'); }
  private selected(plan: EvaluatorLaunchPlan): ReviewedVercelEvaluator {
    const profile = requireFrozenRuntimeBoundProfile(plan.evaluatorProfile, plan.evaluatorProfileDigest);
    if (Buffer.byteLength(canonicalJson(profile)) > 16 * 1024) fail('PROFILE_BOUNDS');
    const entry = this.entries.find(item => item.profileDigest === plan.evaluatorProfileDigest);
    if (!entry || profile.runtime.host_kind !== 'vercel-sandbox'
      || !entry.image.endsWith(`@${profile.runtime.image_digest}`)
      || entry.launcherDigest !== profile.runtime.launcher.entrypoint_digest
      || plan.command.executable !== EVALUATOR_ENTRYPOINT || plan.command.args.length !== 0
      || !Number.isSafeInteger(plan.command.timeoutMs) || plan.command.timeoutMs < 1000
      || plan.command.timeoutMs > 3600000 || plan.command.timeoutMs >= entry.timeoutMs) fail('PLAN_NOT_REVIEWED');
    return entry;
  }
  private bound(environment: EnvironmentProjection, plan: EvaluatorLaunchPlan) {
    tags(environment);
    if (environment.profileDigest !== plan.evaluatorProfileDigest || environment.launchPlanDigest !== digestCanonicalJson(plan)
      || digestCanonicalJson(environment.profileSnapshot) !== digestCanonicalJson(plan.evaluatorProfile)) fail('PLAN_CHANGED');
  }
  private check(environment: EnvironmentProjection, sandbox: SdkSandbox, recovery = false) {
    const expected = tags(environment);
    if (sandbox.name !== name(environment) || sandbox.persistent || !sandbox.sessionId
      || Object.entries(expected).some(([key, value]) => sandbox.tags?.[key] !== value)
      || (!recovery && (environment.provider !== 'vercel' || environment.externalId !== sandbox.name || environment.sessionId !== sandbox.sessionId))) fail('SESSION_CHANGED');
    const runtime = (environment.profileSnapshot as { runtime?: { image_digest?: string } } | null)?.runtime;
    if (!runtime?.image_digest || !sandbox.image?.endsWith(`@${runtime.image_digest}`)) fail('IMAGE_CHANGED');
    observation(sandbox.status);
  }
  private async current(environment: EnvironmentProjection) {
    const sandbox = await this.dependencies.sdk.get({ name: name(environment), resume: false });
    this.check(environment, sandbox);
    return sandbox;
  }
  async assertReady(plan: EvaluatorLaunchPlan) { this.enabled(); this.selected(plan); }
  async prepareCreate(environment: EnvironmentProjection, plan: EvaluatorLaunchPlan) {
    this.enabled(); this.bound(environment, plan); this.selected(plan);
    const solution = await this.dependencies.prepareInput(environment, plan);
    if (typeof solution !== 'string' || Buffer.byteLength(solution) < 1 || Buffer.byteLength(solution) > MAX_SEALED_EVALUATOR_INPUT_PACK_BYTES) fail('INPUT_BOUNDS');
    return { environmentId: environment.id, planDigest: digestCanonicalJson(plan), solution };
  }
  async create(environment: EnvironmentProjection, plan: EvaluatorLaunchPlan, operationId: string, prepared?: unknown) {
    this.enabled(); assertRecordedOperationId(operationId); this.bound(environment, plan);
    const entry = this.selected(plan);
    const input = prepared as Awaited<ReturnType<VercelEvaluatorRuntime['prepareCreate']>> | undefined;
    if (!input || input.environmentId !== environment.id || input.planDigest !== digestCanonicalJson(plan)
      || typeof input.solution !== 'string' || Buffer.byteLength(input.solution) < 1 || Buffer.byteLength(input.solution) > MAX_SEALED_EVALUATOR_INPUT_PACK_BYTES) fail('INPUT_NOT_PREPARED');
    const sandbox = await this.dependencies.sdk.create({ name: name(environment), persistent: false,
      image: entry.image, timeout: entry.timeoutMs, resources: { vcpus: entry.vcpus }, ports: [], networkPolicy: 'deny-all',
      env: { MOTIVE_EVALUATOR_CREATE_BINDING_B64: evaluatorCreateBinding(environment, plan),
        MOTIVE_EVALUATOR_PROFILE_B64: Buffer.from(canonicalJson(plan.evaluatorProfile)).toString('base64'),
        MOTIVE_EVALUATOR_SOLUTION_B64: Buffer.from(input.solution).toString('base64') }, tags: tags(environment) });
    this.check(environment, sandbox, true);
    if (sandbox.image !== entry.image) fail('IMAGE_CHANGED');
    return { provider: 'vercel', externalId: sandbox.name, sessionId: sandbox.sessionId };
  }
  async recoverCreate(environment: EnvironmentProjection) {
    let sandbox: SdkSandbox;
    try { sandbox = await this.dependencies.sdk.get({ name: name(environment), resume: false }); }
    catch (error) {
      if ((error as { response?: { status?: number } })?.response?.status === 404) return null;
      throw error;
    }
    this.check(environment, sandbox, true);
    if (environment.sessionId && environment.sessionId !== sandbox.sessionId) fail('SESSION_CHANGED');
    return { provider: 'vercel', externalId: sandbox.name, sessionId: sandbox.sessionId };
  }
  async observe(environment: EnvironmentProjection) { return observation((await this.current(environment)).status); }
  async start(environment: EnvironmentProjection, plan: EvaluatorLaunchPlan, operationId: string) {
    this.enabled(); assertRecordedOperationId(operationId); this.bound(environment, plan); this.selected(plan);
    const sandbox = await this.current(environment);
    if (sandbox.status !== 'running') fail('NOT_RUNNING');
    const command = await sandbox.startCommand({ cmd: EVALUATOR_ENTRYPOINT, args: [], cwd: '/', detached: true, sudo: true,
      timeoutMs: plan.command.timeoutMs });
    if (!command.cmdId || command.cmdId.length > 512) fail('COMMAND_ID_INVALID');
    return { providerCommandId: command.cmdId };
  }
  async observeCommand(environment: EnvironmentProjection, providerCommandId: string) {
    const command = await (await this.current(environment)).getCommand(providerCommandId);
    if (command.cmdId !== providerCommandId) fail('COMMAND_CHANGED');
    return { state: command.exitCode === null ? 'RUNNING' as const : 'EXITED' as const };
  }
  async capture(environment: EnvironmentProjection, plan: EvaluatorLaunchPlan,
    artifact: Parameters<EvaluatorRuntime['capture']>[2], providerCommandId: string) {
    this.bound(environment, plan);
    if (artifact.status !== 'SEALED' || artifact.attemptId !== environment.attemptId || artifact.manifestDigest !== plan.artifactManifestDigest) fail('ARTIFACT_CHANGED');
    const sandbox = await this.current(environment);
    const command = await sandbox.getCommand(providerCommandId);
    if (command.cmdId !== providerCommandId || command.exitCode === null) fail('COMMAND_NOT_COMPLETE');
    let output = '', bytes = 0, diagnostics = false;
    for await (const line of this.dependencies.logs.read({ name: sandbox.name, sessionId: sandbox.sessionId,
      commandId: providerCommandId, signal: AbortSignal.timeout(15000) })) {
      bytes += Buffer.byteLength(line.data);
      if (bytes > MAX_FRAME_BYTES || (line.stream !== 'stdout' && line.stream !== 'stderr')) fail('FRAME_INVALID');
      if (line.stream === 'stdout') output += line.data;
      else if (line.data.length) diagnostics = true;
    }
    // Authoritative completed command with no frame is unavailable, not evidence against the hypothesis.
    if (output === '') return null;
    if (!output.startsWith(EVALUATOR_FRAME_HEADER) || !output.endsWith('\n')) fail('FRAME_INVALID');
    const body = output.slice(EVALUATOR_FRAME_HEADER.length, -1);
    if (body.includes('\n') || command.exitCode !== 0 || diagnostics) fail('FRAME_INVALID');
    let frame: Record<string, unknown>;
    try { frame = JSON.parse(body); } catch { return fail('FRAME_INVALID'); }
    // The native emitter writes compact JSON. Re-encoding also rejects duplicate keys and ambiguous encodings.
    if (JSON.stringify(frame) !== body) fail('FRAME_INVALID');
    const keys = ['format', 'environment_id', 'attempt_id', 'evaluator_profile_digest', 'artifact_manifest_digest',
      'facts_base64', 'facts_digest', 'runtime_preflight', 'input_preflight'];
    if (!frame || Array.isArray(frame) || Object.keys(frame).length !== keys.length || keys.some(key => !Object.hasOwn(frame, key))
      || frame.format !== 'motive.trusted-evaluator-frame/0.1' || frame.environment_id !== environment.id
      || frame.attempt_id !== environment.attemptId || frame.evaluator_profile_digest !== plan.evaluatorProfileDigest
      || frame.artifact_manifest_digest !== artifact.manifestDigest || typeof frame.facts_base64 !== 'string') fail('FRAME_BINDING_INVALID');
    const facts = Buffer.from(frame.facts_base64, 'base64');
    if (facts.length < 1 || facts.length > 128 * 1024 || facts.toString('base64') !== frame.facts_base64
      || sha(facts) !== frame.facts_digest) fail('FACTS_DIGEST_INVALID');
    return captureRuntimeBoundComparatorReport({ protectedFactsBytes: facts,
      bindings: prepareTrustedEvaluatorReportBindings({ evaluator_profile: plan.evaluatorProfile,
        frozen_evaluator_profile_digest: plan.evaluatorProfileDigest, solution_artifact_manifest_digest: artifact.manifestDigest,
        declared_preflight: { runtime_preflight: frame.runtime_preflight, input_preflight: frame.input_preflight } }) });
  }
  async stop(environment: EnvironmentProjection, operationId: string) {
    this.enabled(); assertRecordedOperationId(operationId);
    const sandbox = await this.current(environment);
    return observation(terminal(sandbox.status) ? sandbox.status : (await sandbox.stop()).status);
  }
}

export function createNativeVercelEvaluatorRuntime(credentials: NativeVercelCredentials,
  input: Omit<VercelEvaluatorDependencies, 'sdk' | 'logs'>, rawFetch: typeof globalThis.fetch = globalThis.fetch) {
  return new VercelEvaluatorRuntime({ ...input, sdk: createNativeVercelSdkFactory(credentials, rawFetch),
    logs: createNativeEvaluatorCommandLogs(credentials, rawFetch) });
}
