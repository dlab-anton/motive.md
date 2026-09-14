import { describe, expect, it, vi } from 'vitest';
import { VercelOrphanProvider } from '../../packages/sandbox-vercel/src/orphans.ts';
import {
  MAX_OWNED_SANDBOX_DISCOVERY,
  type OwnedSandboxObservation,
  type SandboxSdkFactory,
  type SdkSandbox,
  type SdkSandboxSummary,
} from '../../packages/sandbox-vercel/src/types.ts';

const WORKER_NAME = 'motive-w-0123456789abcdef0123456789abcdef';

function tags(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    'motive-owner': 'control',
    'motive-kind': 'worker',
    'motive-attempt': '0123456789abcdef',
    'motive-epoch': '4',
    'motive-profile': 'fedcba9876543210',
    ...overrides,
  };
}

function sdkSandbox(overrides: Partial<SdkSandbox> = {}): SdkSandbox & { stopCalls: number } {
  const sandbox = {
    name: WORKER_NAME,
    sessionId: 'session-owned-1',
    persistent: false,
    status: 'running' as const,
    tags: tags(),
    stopCalls: 0,
    async startCommand() { return { cmdId: 'unused', exitCode: null }; },
    async getCommand(commandId: string) { return { cmdId: commandId, exitCode: null }; },
    async stop() {
      sandbox.stopCalls += 1;
      return { status: 'stopped' as const };
    },
    ...overrides,
  };
  return sandbox;
}

function observed(overrides: Partial<OwnedSandboxObservation> = {}): OwnedSandboxObservation {
  return {
    sandboxId: WORKER_NAME,
    sessionId: 'session-owned-1',
    state: 'RUNNING',
    providerStatus: 'running',
    persistent: false,
    expiresAt: new Date('2026-09-06T12:00:00.000Z'),
    tags: tags(),
    observedAt: new Date('2026-09-06T00:00:00.000Z'),
    ...overrides,
  };
}

function summary(overrides: Partial<SdkSandboxSummary> = {}): SdkSandboxSummary {
  return {
    name: WORKER_NAME,
    sessionId: 'session-owned-1',
    persistent: false,
    status: 'running',
    tags: tags(),
    ...overrides,
  };
}

function factory(current = sdkSandbox()): SandboxSdkFactory & {
  get: ReturnType<typeof vi.fn>;
  listOwned: ReturnType<typeof vi.fn>;
} {
  return {
    create: vi.fn(async () => current),
    get: vi.fn(async () => current),
    listOwned: vi.fn(async () => ({ sandboxes: [summary()], complete: true })),
  };
}

describe('Vercel orphan provider', () => {
  it('stops a persistent owned sandbox without running code inside it', async () => {
    const current = sdkSandbox({ persistent: true });
    const sdk = factory(current);
    const provider = new VercelOrphanProvider(sdk, 'durable-controller');

    await expect(provider.stopOwned(observed({ persistent: true }), 'orphan-stop:effect-1'))
      .resolves.toEqual(expect.objectContaining({
        providerStatus: 'stopped',
        providerTerminal: true,
        state: 'TERMINATED',
      }));
    expect(sdk.get).toHaveBeenCalledWith({ name: WORKER_NAME, resume: false });
    expect(current.stopCalls).toBe(1);
  });

  it('keeps effects suspended by default', async () => {
    const current = sdkSandbox();
    const sdk = factory(current);
    const provider = new VercelOrphanProvider(sdk);

    await expect(provider.stopOwned(observed(), 'orphan-stop:effect-1'))
      .rejects.toThrow('SANDBOX_EFFECTS_SUSPENDED');
    expect(sdk.get).not.toHaveBeenCalled();
    expect(current.stopCalls).toBe(0);
  });

  it.each([
    ['session', { sessionId: 'changed-session' }],
    ['identity tag', { tags: tags({ 'motive-epoch': '5' }) }],
    ['new identity tag', { tags: tags({ 'motive-tenant': 'late-added' }) }],
  ] satisfies [string, Partial<SdkSandbox>][])('rejects a changed %s before stop', async (_case, change) => {
    const current = sdkSandbox(change);
    const sdk = factory(current);
    const provider = new VercelOrphanProvider(sdk, 'durable-controller');

    await expect(provider.stopOwned(observed(), 'orphan-stop:effect-1'))
      .rejects.toThrow('ORPHAN_IDENTITY_CHANGED');
    expect(current.stopCalls).toBe(0);
  });

  it('rejects a lookalike owned name with a noncanonical suffix', async () => {
    const current = sdkSandbox();
    const sdk = factory(current);
    const provider = new VercelOrphanProvider(sdk, 'durable-controller');

    await expect(provider.stopOwned(
      observed({ sandboxId: 'motive-w-not-a-32-character-hex-identity' }),
      'orphan-stop:effect-1',
    )).rejects.toThrow('ORPHAN_IDENTITY_INVALID');
    expect(sdk.get).not.toHaveBeenCalled();
    expect(current.stopCalls).toBe(0);
  });

  it('issues one stop and propagates an ambiguous response without retrying', async () => {
    const current = sdkSandbox();
    current.stop = vi.fn(async () => { throw new Error('response lost after stop'); });
    const sdk = factory(current);
    const provider = new VercelOrphanProvider(sdk, 'durable-controller');

    await expect(provider.stopOwned(observed(), 'orphan-stop:effect-1'))
      .rejects.toThrow('response lost after stop');
    expect(current.stop).toHaveBeenCalledOnce();
    expect(sdk.get).toHaveBeenCalledOnce();
  });

  it('uses bounded discovery and preserves an incomplete inventory marker', async () => {
    const sdk = factory();
    sdk.listOwned.mockImplementation(async (request: unknown) => {
      expect(request).toEqual({
        namePrefix: 'motive-',
        tags: { 'motive-owner': 'control' },
        maximumResults: MAX_OWNED_SANDBOX_DISCOVERY,
      });
      return { sandboxes: [summary()], complete: false };
    });
    const provider = new VercelOrphanProvider(sdk);

    await expect(provider.discover()).resolves.toEqual({
      sandboxes: [expect.objectContaining({ sandboxId: WORKER_NAME })],
      complete: false,
    });
  });

  it('skips an otherwise well-formed sandbox owned by another tenant', async () => {
    const sdk = factory();
    sdk.listOwned.mockResolvedValue({
      sandboxes: [
        summary({ tags: tags({ 'motive-owner': 'tenant-b' }) }),
        summary({ name: 'motive-e-0123456789abcdef0123456789abcdef', tags: {
          'motive-owner': 'control',
          'motive-kind': 'evaluator',
        } }),
      ],
      complete: true,
    });
    const provider = new VercelOrphanProvider(sdk);

    const result = await provider.discover();
    expect(result.sandboxes).toHaveLength(1);
    expect(result.sandboxes[0].sandboxId).toMatch(/^motive-e-/);
    expect(result.sandboxes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ tags: expect.objectContaining({ 'motive-owner': 'tenant-b' }) }),
    ]));
  });
});
