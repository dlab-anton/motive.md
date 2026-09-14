import { describe, expect, it, vi } from 'vitest';
import { agentMcpEgress } from '../../packages/sandbox-vercel/src/agent-mcp.ts';
import {
  SandboxAdapterError,
  SandboxCommandEffectUnknownError,
  SandboxCreateEffectUnknownError,
  SandboxStopEffectUnknownError,
  VERCEL_SANDBOX_SDK_VERSION,
  VercelSandboxAdapter,
  buildNetworkPolicy,
  createNativeVercelSdkFactory,
  defineProviderUntrustedDataRuntime,
  defineProtectedRuntime,
  requireProtectedRuntime,
  requireWorkerExecutionBoundary,
  retainedUpstreamStatus,
  sandboxName,
  type ProviderSandboxStatus,
  type SandboxExecutionProfile,
  type SandboxHandle,
  type SandboxSdkFactory,
  type SdkCreateRequest,
  type SdkSandbox,
} from '../../packages/sandbox-vercel/src/index.ts';

const hex = (character: string) => character.repeat(64);

it('admits only selected remote MCP paths and freezes their rules in the adapter', () => {
  const settings = { servers: { research: { transport: 'http' as const, url: 'https://mcp.example.com/mcp' } },
    agents: { worker: { mcpServers: ['research'] }, plain: { mcpServers: [] } } };
  expect(agentMcpEgress(settings, 'plain')).toEqual([]);
  const input = profile();
  input.egress.mcp = agentMcpEgress(settings, 'worker');
  const adapter = new VercelSandboxAdapter(input, fakeFactory());
  input.egress.mcp[0].url = 'https://changed.example.com/';
  const plan = adapter.planCreate({ attemptId: 'attempt-1', leaseEpoch: 1, runCapability: 'a'.repeat(32), intent: { status: 'RECORDED', operationId: 'create-1' } });
  expect(plan.networkPolicy).toMatchObject({ allow: { 'mcp.example.com': [{ match: { method: ['GET', 'POST', 'DELETE'], path: { exact: '/mcp' } } }] } });
  expect(JSON.stringify(plan.networkPolicy)).not.toContain('changed.example.com');
  input.egress.mcp = [{ url: 'https://127.0.0.1/mcp', methods: ['POST'], pathMatch: 'exact' }];
  expect(() => new VercelSandboxAdapter(input, fakeFactory())).toThrow(/public DNS/);
});

function profile(overrides: Partial<SandboxExecutionProfile> = {}): SandboxExecutionProfile {
  return {
    format: 'motive.sandbox-profile/0.1',
    profileDigest: `sha256:${hex('1')}`,
    protectedRuntime: defineProtectedRuntime(`sha256:${hex('9')}`),
    trustedSource: {
      kind: 'snapshot',
      snapshotId: 'snap_MotiveTrusted01',
      materialDigest: `sha256:${hex('2')}`,
      buildRecipeDigest: `sha256:${hex('3')}`,
      sourceCommit: '4'.repeat(40),
    },
    timeoutMs: 15 * 60 * 1_000,
    commandTimeoutMs: 10 * 60 * 1_000,
    vcpus: 2,
    allowedExecutables: ['/usr/local/bin/codex', '/usr/bin/lean'],
    egress: {
      gateway: [{ url: 'https://gateway.motive.example/v1/responses', methods: ['POST'], pathMatch: 'exact' }],
      artifacts: [{ url: 'https://artifacts.motive.example/upload/attempt/', methods: ['PUT'], pathMatch: 'prefix' }],
    },
    artifacts: { maxFiles: 8, maxFileBytes: 500_000, maxTotalBytes: 1_000_000 },
    ...overrides,
  };
}

function providerProfile(overrides: Partial<SandboxExecutionProfile> = {}): SandboxExecutionProfile {
  return profile({ protectedRuntime: undefined, providerUntrustedDataRuntime: defineProviderUntrustedDataRuntime(),
    egress: { gateway: [{ url: 'https://gateway.motive.example/v1/responses', methods: ['POST'], pathMatch: 'exact' }], artifacts: [],
      gatewayProxy: { format: 'motive.vercel-gateway-proxy/0.1', url: 'https://gateway.motive.example/api/sandbox-egress' } },
    artifacts: { maxFiles: 2, maxFileBytes: 32_768, maxTotalBytes: 48_000 }, ...overrides });
}

function fakeSandbox(status: ProviderSandboxStatus = 'running'): SdkSandbox & { stopCalls: number; commandCalls: number } {
  const value = {
    name: sandboxName('attempt-1', 1),
    sessionId: 'session-1',
    persistent: false,
    status,
    expiresAt: new Date('2026-09-06T12:00:00.000Z'),
    sourceSnapshotId: 'snap_MotiveTrusted01',
    tags: {
      'motive-owner': 'control',
      'motive-kind': 'worker',
      'motive-epoch': '1',
    },
    stopCalls: 0,
    commandCalls: 0,
    async startCommand() {
      value.commandCalls += 1;
      return { cmdId: 'cmd-1', exitCode: null };
    },
    async getCommand(commandId: string) {
      return { cmdId: commandId, exitCode: 0, durationMs: 42 };
    },
    async stop() {
      value.stopCalls += 1;
      value.status = 'stopped';
      return { status: value.status };
    },
  };
  return value;
}

function fakeFactory(sandbox = fakeSandbox()): SandboxSdkFactory & { createRequests: SdkCreateRequest[]; getResume: boolean[] } {
  const factory = {
    createRequests: [] as SdkCreateRequest[],
    getResume: [] as boolean[],
    async create(request: SdkCreateRequest) {
      factory.createRequests.push(request);
      sandbox.name = request.name;
      return sandbox;
    },
    async get(request: { name: string; resume: false }) {
      factory.getResume.push(request.resume);
      return sandbox;
    },
    async listOwned() {
      return { sandboxes: [sandbox], complete: true };
    },
  };
  return factory;
}

const provisionRequest = {
  attemptId: 'attempt-1',
  leaseEpoch: 1,
  runCapability: 'synthetic-scoped-run-capability-1234567890',
  intent: { status: 'RECORDED', operationId: 'provision:attempt-1:1' },
} as const;

it.each(['short', 'x'.repeat(513), 'x'.repeat(32) + '\n', 'x'.repeat(32) + '='])
  ('rejects a capability the protected launcher cannot accept before provisioning', async runCapability => {
    const factory = fakeFactory();
    const adapter = new VercelSandboxAdapter(profile(), factory, { effects: 'durable-controller' });
    await expect(adapter.create({ ...provisionRequest, runCapability })).rejects.toMatchObject({ code: 'SANDBOX_POLICY_INVALID' });
    expect(factory.createRequests).toHaveLength(0);
  });

function handle(): SandboxHandle {
  return {
    provider: 'vercel',
    attemptId: 'attempt-1',
    leaseEpoch: 1,
    sandboxId: sandboxName('attempt-1', 1),
    sessionId: 'session-1',
    profileDigest: `sha256:${hex('1')}`,
  };
}

describe('Vercel sandbox policy', () => {
  it('requires exactly one digest-bound execution boundary for new effects while allowing legacy cleanup', async () => {
    const provider = providerProfile();
    expect(requireWorkerExecutionBoundary(provider)).toEqual({ kind:'provider-untrusted-circle-data',
      runtimeDigest: provider.providerUntrustedDataRuntime!.runtimeDigest });
    expect(requireWorkerExecutionBoundary(profile())).toEqual({ kind:'protected-runtime',runtimeDigest:profile().protectedRuntime!.runtimeDigest });
    expect(() => requireProtectedRuntime(provider)).toThrow(SandboxAdapterError);
    const neither = profile({protectedRuntime:undefined});
    expect(() => requireWorkerExecutionBoundary(neither)).toThrow(SandboxAdapterError);
    const both = profile({providerUntrustedDataRuntime:defineProviderUntrustedDataRuntime()});
    expect(() => new VercelSandboxAdapter(both,fakeFactory())).toThrow(SandboxAdapterError);
    const altered = providerProfile(); altered.providerUntrustedDataRuntime = {...altered.providerUntrustedDataRuntime!,runtimeDigest:`sha256:${hex('0')}`};
    expect(() => new VercelSandboxAdapter(altered,fakeFactory())).toThrow(SandboxAdapterError);
    const cleanup = new VercelSandboxAdapter(neither,fakeFactory(fakeSandbox()),{effects:'durable-controller'});
    await expect(cleanup.stop(handle())).resolves.toMatchObject({state:'STOPPED'});
  });

  it.each([
    { artifacts:[{url:'https://artifacts.motive.example/upload',methods:['PUT'] as const,pathMatch:'exact' as const}] },
    { mcp:[{url:'https://mcp.example.com/mcp',methods:['POST'] as const,pathMatch:'exact' as const}] },
    { gateway:[{url:'https://gateway.motive.example/v1/responses',methods:['GET'] as const,pathMatch:'exact' as const}] },
    { gateway:[{url:'https://gateway.motive.example/v1/',methods:['POST'] as const,pathMatch:'prefix' as const}] },
  ])('rejects provider-untrusted egress beyond one exact gateway POST', egress => {
    const base=providerProfile();
    expect(() => new VercelSandboxAdapter(providerProfile({egress:{...base.egress,...egress}}),fakeFactory())).toThrow(SandboxAdapterError);
  });

  it.each([
    undefined,
    { format: 'motive.vercel-gateway-proxy/0.1', url: 'https://other.example/api/sandbox-egress' },
    { format: 'motive.vercel-gateway-proxy/0.1', url: 'https://gateway.motive.example/api/sandbox-egress?next=/v1/responses' },
    { format: 'motive.vercel-gateway-proxy/0.1', url: 'https://gateway.motive.example/api/sandbox-egress', extra: true },
  ])('rejects a missing, mismatched, or open provider gateway proxy: %j', gatewayProxy => {
    const value = providerProfile();
    value.egress = { ...value.egress, ...(gatewayProxy ? { gatewayProxy: gatewayProxy as never } : {}) };
    if (!gatewayProxy) delete value.egress.gatewayProxy;
    expect(() => new VercelSandboxAdapter(value, fakeFactory())).toThrow(SandboxAdapterError);
  });

  it('keeps protected network rules unchanged and rejects the provider proxy there', () => {
    const value = profile();
    const protectedPolicy = buildNetworkPolicy(value) as Exclude<ReturnType<typeof buildNetworkPolicy>, string>;
    expect(protectedPolicy.allow).toMatchObject({
      'gateway.motive.example': [{ match: { method: ['POST'], path: { exact: '/v1/responses' } }, transform: [] }],
    });
    expect(protectedPolicy.subnets?.deny).toEqual(expect.arrayContaining(['::1/128', 'fc00::/7', 'fe80::/10']));
    value.egress.gatewayProxy = { format: 'motive.vercel-gateway-proxy/0.1', url: 'https://gateway.motive.example/api/sandbox-egress' };
    expect(() => buildNetworkPolicy(value)).toThrow(SandboxAdapterError);
  });
  it('accepts one truthful source identity and rejects missing, both, or malformed identities', () => {
    const snapshotDigest = `sha256:${hex('a')}` as const;
    const bySnapshot = profile({ trustedSource: {
      kind: 'snapshot', snapshotId: 'snap_MotiveTrusted01', materialDigest: `sha256:${hex('2')}`,
      buildRecipeDigest: `sha256:${hex('3')}`, sourceSnapshotDigest: snapshotDigest,
    } });
    expect(new VercelSandboxAdapter(bySnapshot, fakeFactory()).planCreate(provisionRequest))
      .toMatchObject({ source: { type: 'snapshot', snapshotId: 'snap_MotiveTrusted01' } });
    expect(() => new VercelSandboxAdapter(profile(), fakeFactory())).not.toThrow();

    const base = { kind: 'snapshot', snapshotId: 'snap_MotiveTrusted01', materialDigest: `sha256:${hex('2')}`,
      buildRecipeDigest: `sha256:${hex('3')}` };
    for (const trustedSource of [
      base,
      { ...base, sourceCommit: '4'.repeat(40), sourceSnapshotDigest: snapshotDigest },
      { ...base, sourceSnapshotDigest: 'sha256:not-a-digest' },
      { ...base, sourceCommit: 'not-a-git-commit' },
    ]) {
      expect(() => new VercelSandboxAdapter(profile({ trustedSource: trustedSource as never }), fakeFactory()))
        .toThrowError(SandboxAdapterError);
    }
  });

  it('rejects altered protected-runtime fields and digest before any SDK effect', () => {
    const valid = defineProtectedRuntime(`sha256:${hex('9')}`);
    for (const change of [
      { workerUid: 0 }, { launcherPath: '/bin/bash' }, { codexHome: '/tmp/config' },
      { runtimeDigest: `sha256:${hex('0')}` }, { launcherDigest: `sha256:${hex('8')}` },
      { sudo: true },
    ]) {
      expect(() => new VercelSandboxAdapter(profile({ protectedRuntime: { ...valid, ...change } as never }), fakeFactory()))
        .toThrow(SandboxAdapterError);
    }
  });

  it('keeps legacy profiles cleanup-only even with durable-controller effects enabled', async () => {
    const sandbox = fakeSandbox();
    const factory = fakeFactory(sandbox);
    const adapter = new VercelSandboxAdapter(profile({ protectedRuntime: undefined }), factory, { effects: 'durable-controller' });
    await expect(adapter.create(provisionRequest)).rejects.toMatchObject({ code: 'SANDBOX_POLICY_INVALID' });
    await expect(adapter.startCommand(handle(), { intent: { status: 'RECORDED', operationId: 'legacy-command' }, executable: '/usr/local/bin/codex', args: [] }))
      .rejects.toMatchObject({ code: 'SANDBOX_POLICY_INVALID' });
    expect(factory.createRequests).toEqual([]);
    expect(sandbox.commandCalls).toBe(0);
    await expect(adapter.stop(handle())).resolves.toMatchObject({ state: 'STOPPED' });
    expect(sandbox.stopCalls).toBe(1);
  });

  it('pins SDK 3.2.1 and constructs a disposable, bounded, allowlisted sandbox', () => {
    const adapter = new VercelSandboxAdapter(profile(), fakeFactory());
    const request = adapter.planCreate(provisionRequest);

    expect(VERCEL_SANDBOX_SDK_VERSION).toBe('3.2.1');
    expect(request).toEqual(expect.objectContaining({
      name: sandboxName('attempt-1', 1),
      source: { type: 'snapshot', snapshotId: 'snap_MotiveTrusted01' },
      persistent: false,
      timeout: 900_000,
      resources: { vcpus: 2 },
      ports: [],
      env: { MOTIVE_RUN_CAPABILITY: 'synthetic-scoped-run-capability-1234567890' },
    }));
    expect(request).not.toHaveProperty('snapshotExpiration');
    expect(request).not.toHaveProperty('keepLastSnapshots');
    expect(request).not.toHaveProperty('token');
    expect(request).not.toHaveProperty('teamId');
    expect(request).not.toHaveProperty('projectId');

    const policy = request.networkPolicy as Exclude<typeof request.networkPolicy, string>;
    expect(Object.keys(policy.allow as object)).toEqual([
      'gateway.motive.example',
      'artifacts.motive.example',
    ]);
    expect(policy.allow).toEqual(expect.objectContaining({
      'gateway.motive.example': [{
        match: { method: ['POST'], path: { exact: '/v1/responses' } },
        transform: [],
      }],
      'artifacts.motive.example': [{
        match: { method: ['PUT'], path: { startsWith: '/upload/attempt/' } },
        transform: [],
      }],
    }));
    expect(policy.subnets?.deny).toContain('169.254.0.0/16');
  });

  it.each([
    ['infinite timeout', { timeoutMs: Number.POSITIVE_INFINITY }],
    ['overlong timeout', { timeoutMs: 86_400_001 }],
    ['overlong command', { commandTimeoutMs: 3_600_001 }],
    ['excess cpu', { vcpus: 9 }],
    ['mutable image tag', { trustedSource: {
      kind: 'image', image: 'private/motive-worker:latest', materialDigest: `sha256:${hex('2')}`,
      buildRecipeDigest: `sha256:${hex('3')}`, sourceCommit: '4'.repeat(40),
    } }],
  ])('rejects unsafe finite-ceiling input: %s', (_name, change) => {
    expect(() => new VercelSandboxAdapter(profile(change as Partial<SandboxExecutionProfile>), fakeFactory()))
      .toThrowError(SandboxAdapterError);
  });

  it('rejects an artifact per-file ceiling above the total ceiling', () => {
    const changed = profile();
    changed.artifacts = { maxFiles: 8, maxFileBytes: 1_000_001, maxTotalBytes: 1_000_000 };
    expect(() => new VercelSandboxAdapter(changed, fakeFactory())).toThrowError(SandboxAdapterError);
  });

  it.each([
    'http://gateway.motive.example/v1/responses',
    'https://user:secret@gateway.motive.example/v1/responses',
    'https://gateway.motive.example:8443/v1/responses',
    'https://localhost/v1/responses',
    'https://*.motive.example/v1/responses',
  ])('rejects an unsafe egress destination: %s', url => {
    const changed = profile();
    changed.egress = { ...changed.egress, gateway: [{ url, methods: ['POST'], pathMatch: 'exact' }] };
    expect(() => new VercelSandboxAdapter(changed, fakeFactory())).toThrowError(SandboxAdapterError);
  });
});

describe('sandbox effects and observation', () => {
  it('does not blindly retry an ambiguous create', async () => {
    let createCalls = 0;
    const factory = fakeFactory();
    factory.create = async () => {
      createCalls += 1;
      throw new Error('connection reset after send');
    };
    const adapter = new VercelSandboxAdapter(profile(), factory, { effects: 'durable-controller' });
    await expect(adapter.create(provisionRequest)).rejects.toBeInstanceOf(SandboxCreateEffectUnknownError);
    expect(createCalls).toBe(1);
  });

  it('does not launch or resume a stopped sandbox', async () => {
    const sandbox = fakeSandbox('stopped');
    const factory = fakeFactory(sandbox);
    const adapter = new VercelSandboxAdapter(profile(), factory, { effects: 'durable-controller' });
    await expect(adapter.startCommand(handle(), {
      intent: { status: 'RECORDED', operationId: 'command:attempt-1:1' },
      executable: '/usr/local/bin/codex',
      args: ['exec'],
    })).rejects.toMatchObject({ code: 'SANDBOX_NOT_RUNNING' });
    expect(factory.getResume).toEqual([false]);
    expect(sandbox.commandCalls).toBe(0);
  });

  it('starts the fixed privilege-dropping launcher once and records its provider handle', async () => {
    const sandbox = fakeSandbox();
    const start = vi.spyOn(sandbox, 'startCommand');
    const adapter = new VercelSandboxAdapter(profile(), fakeFactory(sandbox), { effects: 'durable-controller' });
    const result = await adapter.startCommand(handle(), {
      intent: { status: 'RECORDED', operationId: 'command:attempt-1:1' },
      executable: '/usr/local/bin/codex',
      args: ['exec', '--json'],
      cwd: 'solution',
    });
    expect(result.commandId).toBe('cmd-1');
    expect(start).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledWith({
      cmd: '/opt/motive/bin/worker-launcher',
      args: ['--cwd-relative', 'solution', '--', '/usr/local/bin/codex', 'exec', '--json'],
      cwd: '/',
      detached: true,
      sudo: true,
      timeoutMs: 600_000,
    });
  });

  it('starts provider-untrusted circle data directly without claiming a privilege boundary or trusted export', async () => {
    const sandbox=fakeSandbox(); const start=vi.spyOn(sandbox,'startCommand'); const factory=fakeFactory(sandbox);
    const adapter=new VercelSandboxAdapter(providerProfile(),factory,{effects:'durable-controller'});
    await expect(adapter.create(provisionRequest)).resolves.toMatchObject({sessionId:'session-1'});
    expect(factory.createRequests[0]!.networkPolicy).toEqual({
      allow: { 'gateway.motive.example': [{ forwardURL: 'https://gateway.motive.example/api/sandbox-egress' }] },
      subnets: { deny: expect.arrayContaining(['169.254.0.0/16']) },
    });
    const providerPolicy = factory.createRequests[0]!.networkPolicy as Exclude<ReturnType<typeof buildNetworkPolicy>, string>;
    expect(providerPolicy.subnets?.deny).not.toEqual(expect.arrayContaining(['::1/128', 'fc00::/7', 'fe80::/10']));
    await adapter.startCommand(handle(),{intent:{status:'RECORDED',operationId:'command:provider:1'},
      executable:'/usr/local/bin/codex',args:['exec'],cwd:'solution'});
    expect(start).toHaveBeenCalledWith({cmd:'/usr/local/bin/codex',args:['exec'],cwd:'/vercel/sandbox/workspace/solution',
      detached:true,sudo:false,timeoutMs:600_000});
    expect(() => adapter.prepareArtifactExport(handle(),['candidate.json'])).toThrow(SandboxAdapterError);
  });

  it('keeps a private copy of the frozen executable policy', async () => {
    const mutableProfile = profile();
    const adapter = new VercelSandboxAdapter(mutableProfile, fakeFactory(), { effects: 'durable-controller' });
    (mutableProfile.allowedExecutables as string[]).push('/tmp/late-added-tool');
    await expect(adapter.startCommand(handle(), {
      intent: { status: 'RECORDED', operationId: 'command:attempt-1:late' },
      executable: '/tmp/late-added-tool',
      args: [],
    })).rejects.toMatchObject({ code: 'SANDBOX_POLICY_INVALID' });
  });

  it('reports an ambiguous command without retrying it', async () => {
    const sandbox = fakeSandbox();
    let calls = 0;
    sandbox.startCommand = async () => {
      calls += 1;
      throw new Error('stream ended after dispatch');
    };
    const adapter = new VercelSandboxAdapter(profile(), fakeFactory(sandbox), { effects: 'durable-controller' });
    await expect(adapter.startCommand(handle(), {
      intent: { status: 'RECORDED', operationId: 'command:attempt-1:1' },
      executable: '/usr/local/bin/codex',
      args: [],
    })).rejects.toBeInstanceOf(SandboxCommandEffectUnknownError);
    expect(calls).toBe(1);
  });

  it.each([
    ['pending', 'PROVISIONING'], ['running', 'RUNNING'], ['stopping', 'STOPPING'],
    ['snapshotting', 'STOPPING'], ['stopped', 'STOPPED'], ['failed', 'FAILED'], ['aborted', 'FAILED'],
  ] as const)('maps provider state %s to %s without resuming', async (providerStatus, state) => {
    const factory = fakeFactory(fakeSandbox(providerStatus));
    const adapter = new VercelSandboxAdapter(profile(), factory, { now: () => new Date('2026-09-06T00:00:00Z') });
    await expect(adapter.observe(handle())).resolves.toEqual(expect.objectContaining({ state, providerStatus }));
    expect(factory.getResume).toEqual([false]);
  });

  it('makes a repeated stop safe when observation already proves a terminal state', async () => {
    const sandbox = fakeSandbox('stopped');
    const adapter = new VercelSandboxAdapter(profile(), fakeFactory(sandbox), { effects: 'durable-controller' });
    await expect(adapter.stop(handle())).resolves.toEqual(expect.objectContaining({ alreadyTerminal: true, state: 'STOPPED' }));
    expect(sandbox.stopCalls).toBe(0);
  });

  it('reports an ambiguous stop separately and issues it once', async () => {
    const sandbox = fakeSandbox('running');
    let calls = 0;
    sandbox.stop = async () => {
      calls += 1;
      throw new Error('stop response lost');
    };
    const adapter = new VercelSandboxAdapter(profile(), fakeFactory(sandbox), { effects: 'durable-controller' });
    await expect(adapter.stop(handle())).rejects.toBeInstanceOf(SandboxStopEffectUnknownError);
    expect(calls).toBe(1);
  });

  it('enumerates only owned worker labels with the SDK-supported single tag filter', async () => {
    const owned = fakeSandbox();
    const foreign = fakeSandbox();
    foreign.name = 'foreign';
    foreign.tags = { 'motive-owner': 'control', 'motive-kind': 'other' };
    const factory = fakeFactory(owned);
    factory.listOwned = vi.fn(async request => {
      expect(request).toEqual({
        namePrefix: 'motive-w-',
        tags: { 'motive-owner': 'control' },
        maximumResults: 1_000,
      });
      return { sandboxes: [owned, foreign], complete: true };
    });
    const adapter = new VercelSandboxAdapter(profile(), factory);
    await expect(adapter.discoverOwned()).resolves.toEqual(expect.objectContaining({
      complete: true,
      maximumResults: 1_000,
      sandboxes: [expect.objectContaining({ sandboxId: owned.name })],
    }));
  });

  it('propagates an explicit incomplete marker from bounded discovery', async () => {
    const factory = fakeFactory();
    factory.listOwned = async () => ({ sandboxes: [fakeSandbox()], complete: false });
    const adapter = new VercelSandboxAdapter(profile(), factory);
    await expect(adapter.discoverOwned()).resolves.toEqual(expect.objectContaining({ complete: false }));
  });

  it('keeps remote effects suspended unless a durable controller explicitly enables them', async () => {
    const factory = fakeFactory();
    const adapter = new VercelSandboxAdapter(profile(), factory);
    await expect(adapter.create(provisionRequest)).rejects.toMatchObject({ code: 'SANDBOX_EFFECTS_SUSPENDED' });
    expect(factory.createRequests).toHaveLength(0);
  });
});

describe('SDK retry and artifact boundaries', () => {
  it('neutralizes the pinned SDK internal 5xx retry before an ambiguous create can repeat', async () => {
    let rawCalls = 0;
    const rawFetch = vi.fn(async () => {
      rawCalls += 1;
      return new Response(JSON.stringify({ error: { message: 'uncertain' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const factory = createNativeVercelSdkFactory({ token: 'control-token', teamId: 'team-id', projectId: 'project-id' }, rawFetch);
    const adapter = new VercelSandboxAdapter(profile(), factory, { effects: 'durable-controller' });
    let caught: unknown;
    try {
      await adapter.create(provisionRequest);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SandboxCreateEffectUnknownError);
    expect(rawCalls).toBe(1);
    expect(retainedUpstreamStatus((caught as SandboxCreateEffectUnknownError).cause)).toBe(503);
  });

  it('neutralizes the pinned SDK internal network-error retry', async () => {
    let rawCalls = 0;
    const rawFetch = vi.fn(async () => {
      rawCalls += 1;
      throw new TypeError('connection reset');
    }) as unknown as typeof fetch;
    const factory = createNativeVercelSdkFactory({ token: 'control-token', teamId: 'team-id', projectId: 'project-id' }, rawFetch);
    const adapter = new VercelSandboxAdapter(profile(), factory, { effects: 'durable-controller' });
    await expect(adapter.create(provisionRequest)).rejects.toBeInstanceOf(SandboxCreateEffectUnknownError);
    expect(rawCalls).toBe(1);
  });

  it('forces redirect:error on the actual SDK create request and never follows a 307', async () => {
    let rawCalls = 0;
    const rawFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      rawCalls += 1;
      expect(init?.redirect).toBe('error');
      return new Response(null, {
        status: 307,
        headers: { location: 'https://unexpected.example/second-effect' },
      });
    }) as unknown as typeof fetch;
    const factory = createNativeVercelSdkFactory({ token: 'control-token', teamId: 'team-id', projectId: 'project-id' }, rawFetch);
    const adapter = new VercelSandboxAdapter(profile(), factory, { effects: 'durable-controller' });
    await expect(adapter.create(provisionRequest)).rejects.toBeInstanceOf(SandboxCreateEffectUnknownError);
    expect(rawCalls).toBe(1);
  });

  it('builds a sealed-export plan only for bounded relative paths', () => {
    const adapter = new VercelSandboxAdapter(profile(), fakeFactory());
    expect(adapter.prepareArtifactExport(handle(), ['src/Main.lean', 'lake-manifest.json'])).toEqual(expect.objectContaining({
      requiresLstatNoFollow: true,
      sealedStorageRequired: true,
      maxFileBytes: 500_000,
      maxTotalBytes: 1_000_000,
      files: [
        { relativePath: 'src/Main.lean', sourcePath: '/vercel/sandbox/workspace/src/Main.lean' },
        { relativePath: 'lake-manifest.json', sourcePath: '/vercel/sandbox/workspace/lake-manifest.json' },
      ],
    }));
  });

  it.each(['../secret', '/etc/passwd', 'src\\Main.lean', 'src//Main.lean', 'src/./Main.lean'])
    ('rejects an unsafe artifact path: %s', path => {
      const adapter = new VercelSandboxAdapter(profile(), fakeFactory());
      expect(() => adapter.prepareArtifactExport(handle(), [path])).toThrowError(SandboxAdapterError);
    });
});
