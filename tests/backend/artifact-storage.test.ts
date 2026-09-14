import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import type { AttemptProjection } from '../../packages/accounting/src/kernel.ts';
import {
  ArtifactSealer,
  SupabaseImmutableObjectStore,
  type ApprovedArtifactPath,
  type ArtifactApprovalPolicy,
  type ArtifactFileKind,
  type ImmutableObjectStore,
  type SafeArtifactReader,
  type SafeArtifactSnapshot,
} from '../../packages/artifact-storage/src/index.ts';
import { digestCanonicalJson, type Digest } from '../../packages/domain/src/contracts.ts';
import type { WorkerLaunchPlan } from '../../packages/orchestration/src/coordinator.ts';
import type { EnvironmentProjection } from '../../packages/orchestration/src/store-types.ts';
import type { SandboxHandle } from '../../packages/sandbox-vercel/src/types.ts';

const attemptId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const workOrderId = '33333333-3333-4333-8333-333333333333';
const environmentId = '44444444-4444-4444-8444-444444444444';
const digestA = `sha256:${'a'.repeat(64)}` as Digest;
const digestB = `sha256:${'b'.repeat(64)}` as Digest;
const digestC = `sha256:${'c'.repeat(64)}` as Digest;
const digestD = `sha256:${'d'.repeat(64)}` as Digest;
const encoder = new TextEncoder();

function byteDigest(value: Uint8Array): Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

async function collect(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of body) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

class MemoryStore implements ImmutableObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly puts: string[] = [];
  corruptReadKey: string | null = null;

  async putIfAbsent(input: Parameters<ImmutableObjectStore['putIfAbsent']>[0]) {
    this.puts.push(input.objectKey);
    if (this.objects.has(input.objectKey)) return { status: 'EXISTS' as const, objectId: input.objectKey };
    const bytes = await collect(input.body);
    this.objects.set(input.objectKey, bytes);
    return { status: 'CREATED' as const, objectId: input.objectKey };
  }

  async readObject(
    input: Parameters<ImmutableObjectStore['readObject']>[0],
  ): Promise<Awaited<ReturnType<ImmutableObjectStore['readObject']>>> {
    const found = this.objects.get(input.objectKey);
    if (!found) return null;
    const value = this.corruptReadKey === input.objectKey ? Uint8Array.of(...found, 0) : found;
    const maximumChunkBytes = input.maximumChunkBytes;
    return { body: (async function* () {
      for (let offset = 0; offset < value.byteLength; offset += maximumChunkBytes) {
        yield value.subarray(offset, Math.min(offset + maximumChunkBytes, value.byteLength));
      }
    })(), declaredBytes: value.byteLength };
  }
}

type SnapshotOptions = {
  kind?: ArtifactFileKind;
  linkCount?: number;
  declaredBytes?: number;
  chunks?: readonly Uint8Array[];
  resolution?: SafeArtifactSnapshot['resolution'];
  immutableSnapshot?: true;
};

function snapshot(relativePath: string, bytes: Uint8Array, options: SnapshotOptions = {}): SafeArtifactSnapshot {
  // Several negative cases deliberately construct impossible collector
  // metadata to verify the runtime boundary, so keep that invalidity explicit.
  return {
    relativePath,
    kind: options.kind ?? 'regular',
    linkCount: options.linkCount ?? 1,
    declaredBytes: options.declaredBytes ?? bytes.byteLength,
    identityToken: `snapshot:${relativePath}`,
    resolution: options.resolution ?? 'beneath-workspace-no-follow',
    immutableSnapshot: options.immutableSnapshot ?? true,
    read: () => (async function* () {
      for (const chunk of options.chunks ?? [bytes]) yield chunk;
    })(),
  } as unknown as SafeArtifactSnapshot;
}

function fixture() {
  const attempt: AttemptProjection = {
    id: attemptId,
    projectId,
    workOrderId,
    grantId: 'grant',
    sourceId: 'source',
    termsDigest: digestA,
    profileDigest: digestB,
    inputDigest: digestC,
    ceilingAmount: '2',
    consumedAmount: '0',
    requestHeldAmount: '0',
    availableAmount: '2',
    deficitAmount: '0',
    executionStatus: 'RUNNING',
    leaseEpoch: 1,
    controllerGeneration: 'generation',
    admissionClosedAt: null,
    cancellationRequestedAt: null,
    createdAt: new Date(0).toISOString(),
  };
  const plan: WorkerLaunchPlan = {
    format: 'motive.worker-launch/0.1',
    workOrderId,
    termsDigest: digestA,
    inputDigest: digestC,
    inferenceProfileDigest: digestB,
    actorId: 'operator',
    infrastructureAuthorizationId: 'infra',
    maximumCostUsd: '1',
    command: { executable: '/usr/local/bin/codex', args: ['exec', 'reviewed prompt'], cwd: 'repo' },
    capabilityTtlSeconds: 120,
    sandbox: {
      format: 'motive.sandbox-profile/0.1',
      profileDigest: digestD,
      trustedSource: {
        kind: 'snapshot',
        snapshotId: 'snap_MotiveTrusted01',
        materialDigest: digestA,
        buildRecipeDigest: digestB,
        sourceCommit: 'a'.repeat(40),
      },
      timeoutMs: 120_000,
      commandTimeoutMs: 60_000,
      vcpus: 2,
      allowedExecutables: ['/usr/local/bin/codex'],
      egress: { gateway: [], artifacts: [] },
      artifacts: { maxFiles: 4, maxFileBytes: 32, maxTotalBytes: 48 },
    },
  };
  const environment: EnvironmentProjection = {
    id: environmentId,
    attemptId,
    sourceId: 'source',
    grantId: 'grant',
    kind: 'WORKER',
    state: 'ACTIVE',
    leaseEpoch: 1,
    controllerGeneration: 'generation',
    profileDigest: digestD,
    profileSnapshot: {},
    launchPlanDigest: digestCanonicalJson(plan),
    infrastructureAuthorizationId: 'infra',
    maximumCostUsd: '1',
    heldCostUsd: '1',
    consumedCostUsd: '0',
    provider: 'vercel',
    externalId: 'motive-w-11111111111141118111111111111111',
    sessionId: 'session',
    providerStatus: 'running',
    providerExpiresAt: null,
    lastObservedAt: null,
    terminatedAt: null,
    orphanReason: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  const handle: SandboxHandle = {
    provider: 'vercel',
    attemptId,
    leaseEpoch: 1,
    sandboxId: environment.externalId!,
    sessionId: environment.sessionId!,
    profileDigest: digestD,
  };
  const approved: ApprovedArtifactPath[] = [
    { relativePath: 'reports/result.json', mediaType: 'application/json', availability: 'REQUIRED' },
    { relativePath: 'source/answer.txt', mediaType: 'text/plain', availability: 'REQUIRED' },
  ];
  const snapshots = new Map<string, SafeArtifactSnapshot>([
    ['reports/result.json', snapshot('reports/result.json', encoder.encode('{"ok":true}'))],
    ['source/answer.txt', snapshot('source/answer.txt', encoder.encode('proof'))],
  ]);
  const reader: SafeArtifactReader = {
    assertReady: vi.fn(async () => ({ capability: 'native-beneath-workspace-no-follow-v1' as const })),
    capture: vi.fn(async ({ relativePath }) => snapshots.get(relativePath) ?? null),
  };
  const policy: ArtifactApprovalPolicy = {
    approvedPaths: vi.fn(async () => approved),
    assertReady: vi.fn(async () => ({ capability: 'trusted-operator-artifact-policy-v1' as const })),
  };
  const store = new MemoryStore();
  const sealer = new ArtifactSealer({ reader, policy, store, maximumChunkBytes: 16 });
  const input = {
    attempt,
    environment,
    handle,
    plan,
    outcome: { kind: 'COMMAND_EXITED' as const, commandId: 'command-1', exitCode: 0, durationMs: 42 },
  };
  return { attempt, plan, environment, handle, approved, snapshots, reader, policy, store, sealer, input };
}

describe('artifact sealing', () => {
  it('seals approved bytes and binds trusted execution evidence without accepting it', async () => {
    const f = fixture();
    const receipt = await f.sealer.seal(f.input);
    expect(receipt.receiptId).toBe(`artifact-receipt:${receipt.manifestDigest.slice(7)}`);
    expect(f.store.objects.size).toBe(3);
    const manifestEntry = [...f.store.objects.entries()].find(([key]) => key.endsWith('/manifest.json'))!;
    const manifest = JSON.parse(new TextDecoder().decode(manifestEntry[1]));
    expect(byteDigest(manifestEntry[1])).toBe(receipt.manifestDigest);
    expect(manifest).toMatchObject({
      format: 'motive.artifact-manifest/0.1',
      project_id: projectId,
      work_order_id: workOrderId,
      attempt_id: attemptId,
      environment_id: environmentId,
      terms_digest: digestA,
      input_digest: digestC,
      inference_profile_digest: digestB,
      sandbox_profile_digest: digestD,
      launch_plan_digest: digestCanonicalJson(f.plan),
      command_digest: digestCanonicalJson(f.plan.command),
      controller_observed_outcome: { kind: 'COMMAND_EXITED', commandId: 'command-1', exitCode: 0, durationMs: 42 },
      capture_status: 'COMPLETE',
      missing_files: [],
      human_acceptance: { status: 'PENDING', decision_id: null },
      total_bytes: 16,
    });
    expect(manifest.files.map((file: { relative_path: string }) => file.relative_path))
      .toEqual(['reports/result.json', 'source/answer.txt']);
    expect(manifest.files[0].digest).toBe(byteDigest(encoder.encode('{"ok":true}')));
  });

  it.each([
    '', '/root.txt', 'C:/root.txt', '../secret', 'a/../secret', './answer', 'a//b',
    'a\\b', `nul\0name`, 'manifest.json',
  ])('rejects unsafe or reserved approved path %j before collection', async relativePath => {
    const f = fixture();
    f.approved.splice(0, f.approved.length, { relativePath, mediaType: 'text/plain', availability: 'REQUIRED' });
    await expect(f.sealer.seal(f.input)).rejects.toMatchObject({
      code: relativePath === 'manifest.json' ? 'ARTIFACT_PATH_RESERVED' : 'ARTIFACT_PATH_INVALID',
    });
    expect(f.reader.capture).not.toHaveBeenCalled();
    expect(f.store.objects.size).toBe(0);
  });

  it.each<[{ kind: ArtifactFileKind; linkCount: number }]>([
    [{ kind: 'symlink', linkCount: 1 }],
    [{ kind: 'directory', linkCount: 1 }],
    [{ kind: 'hardlink', linkCount: 2 }],
    [{ kind: 'block-device', linkCount: 1 }],
    [{ kind: 'character-device', linkCount: 1 }],
    [{ kind: 'fifo', linkCount: 1 }],
    [{ kind: 'socket', linkCount: 1 }],
    [{ kind: 'regular', linkCount: 2 }],
  ])('rejects non-unique regular-file metadata %o', async metadata => {
    const f = fixture();
    f.approved.splice(0, f.approved.length, { relativePath: 'answer.txt', mediaType: 'text/plain', availability: 'REQUIRED' });
    f.snapshots.set('answer.txt', snapshot('answer.txt', encoder.encode('data'), metadata));
    await expect(f.sealer.seal(f.input)).rejects.toMatchObject({ code: 'ARTIFACT_FILE_TYPE_REJECTED' });
    expect(f.store.objects.size).toBe(0);
  });

  it('enforces actual stream bytes despite deceptive declared sizes and chunks', async () => {
    const f = fixture();
    f.approved.splice(0, f.approved.length, { relativePath: 'answer.txt', mediaType: 'text/plain', availability: 'REQUIRED' });
    f.snapshots.set('answer.txt', snapshot('answer.txt', encoder.encode('ignored'), {
      declaredBytes: 1,
      chunks: [new Uint8Array(33)],
    }));
    await expect(f.sealer.seal(f.input)).rejects.toMatchObject({ code: 'ARTIFACT_CHUNK_TOO_LARGE' });
    expect(f.store.objects.size).toBe(0);
  });

  it('rejects a declared-length mismatch even when actual bytes are under the cap', async () => {
    const f = fixture();
    f.approved.splice(0, f.approved.length, { relativePath: 'answer.txt', mediaType: 'text/plain', availability: 'REQUIRED' });
    f.snapshots.set('answer.txt', snapshot('answer.txt', encoder.encode('four'), { declaredBytes: 1 }));
    await expect(f.sealer.seal(f.input)).rejects.toMatchObject({ code: 'ARTIFACT_DECLARED_SIZE_MISMATCH' });
  });

  it('enforces the aggregate byte limit while leaving partial objects unreferenced', async () => {
    const f = fixture();
    f.plan.sandbox.artifacts.maxFileBytes = 32;
    f.plan.sandbox.artifacts.maxTotalBytes = 40;
    f.environment.launchPlanDigest = digestCanonicalJson(f.plan);
    f.snapshots.set('reports/result.json', snapshot('reports/result.json', new Uint8Array(24), {
      chunks: [new Uint8Array(16), new Uint8Array(8)],
    }));
    f.snapshots.set('source/answer.txt', snapshot('source/answer.txt', new Uint8Array(24), {
      chunks: [new Uint8Array(16), new Uint8Array(8)],
    }));
    await expect(f.sealer.seal(f.input)).rejects.toMatchObject({ code: 'ARTIFACT_TOTAL_BYTES_EXCEEDED' });
    expect(f.store.objects.size).toBe(1);
    expect([...f.store.objects.keys()].some(key => key.endsWith('/manifest.json'))).toBe(false);
  });

  it('preserves uploaded partial evidence but issues no manifest when an approved file is missing', async () => {
    const f = fixture();
    f.snapshots.delete('source/answer.txt');
    await expect(f.sealer.seal(f.input)).rejects.toMatchObject({ code: 'ARTIFACT_FILE_MISSING' });
    expect(f.store.objects.size).toBe(1);
    expect([...f.store.objects.keys()].some(key => key.endsWith('/manifest.json'))).toBe(false);
  });

  it('seals an explicitly optional missing file as partial evidence only after failure', async () => {
    const f = fixture();
    f.approved[1]!.availability = 'OPTIONAL_ON_FAILURE';
    f.snapshots.delete('source/answer.txt');
    const receipt = await f.sealer.seal({
      ...f.input,
      outcome: { kind: 'COMMAND_EXITED', commandId: 'command-1', exitCode: 1 },
    });
    const manifestBytes = [...f.store.objects.entries()].find(([key]) => key.endsWith('/manifest.json'))![1];
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    expect(receipt.manifestDigest).toBe(byteDigest(manifestBytes));
    expect(manifest).toMatchObject({
      capture_status: 'PARTIAL',
      controller_observed_outcome: { kind: 'COMMAND_EXITED', commandId: 'command-1', exitCode: 1 },
      missing_files: [{
        relative_path: 'source/answer.txt', media_type: 'text/plain', availability: 'OPTIONAL_ON_FAILURE',
      }],
      human_acceptance: { status: 'PENDING', decision_id: null },
    });
  });

  it('does not omit an optional-on-failure file from a successful command receipt', async () => {
    const f = fixture();
    f.approved[1]!.availability = 'OPTIONAL_ON_FAILURE';
    f.snapshots.delete('source/answer.txt');
    await expect(f.sealer.seal(f.input)).rejects.toMatchObject({ code: 'ARTIFACT_FILE_MISSING' });
    expect([...f.store.objects.keys()].some(key => key.endsWith('/manifest.json'))).toBe(false);
  });

  it('requires an explicit native collector capability before launch', async () => {
    const f = fixture();
    vi.mocked(f.reader.assertReady).mockResolvedValue({ capability: 'claimed-without-native-proof' } as never);
    await expect(f.sealer.assertReady(f.plan)).rejects.toMatchObject({ code: 'ARTIFACT_COLLECTOR_UNSAFE' });
  });

  it('verifies every object readback before returning a receipt', async () => {
    const f = fixture();
    const original = f.store.readObject.bind(f.store);
    let reads = 0;
    f.store.readObject = async input => {
      const result = await original(input);
      if (result === null) return null;
      reads += 1;
      if (reads === 1) return { ...result, body: (async function* () { yield encoder.encode('corrupt'); })() };
      return result;
    };
    await expect(f.sealer.seal(f.input)).rejects.toMatchObject({ code: 'ARTIFACT_READBACK_MISMATCH' });
    expect([...f.store.objects.keys()].some(key => key.endsWith('/manifest.json'))).toBe(false);
  });

  it('is idempotent without overwriting and detects a poisoned existing key', async () => {
    const f = fixture();
    const first = await f.sealer.seal(f.input);
    const firstObjects = new Map(f.store.objects);
    const second = await f.sealer.seal(f.input);
    expect(second).toEqual(first);
    expect(f.store.objects).toEqual(firstObjects);

    const fileKey = [...f.store.objects.keys()].find(key => key.includes('/files/'))!;
    f.store.objects.set(fileKey, encoder.encode('different'));
    await expect(f.sealer.seal(f.input)).rejects.toMatchObject({ code: 'ARTIFACT_READBACK_MISMATCH' });
    expect(new TextDecoder().decode(f.store.objects.get(fileKey))).toBe('different');
  });

  it('recovers a previously sealed receipt before policy lookup or recapture', async () => {
    const f = fixture();
    const first = await f.sealer.seal(f.input);
    vi.mocked(f.reader.capture).mockClear();
    vi.mocked(f.policy.approvedPaths).mockClear();
    vi.mocked(f.policy.assertReady!).mockClear();
    vi.mocked(f.reader.capture).mockRejectedValue(new Error('sandbox is already gone'));
    vi.mocked(f.policy.approvedPaths).mockRejectedValue(new Error('policy registry unavailable'));
    vi.mocked(f.policy.assertReady!).mockRejectedValue(new Error('policy registry unavailable'));

    const recovered = await f.sealer.seal({ ...f.input, outcome: { kind: 'CANCELLED' } });
    expect(recovered).toEqual(first);
    expect(f.reader.capture).not.toHaveBeenCalled();
    expect(f.policy.approvedPaths).not.toHaveBeenCalled();
    expect(f.policy.assertReady).not.toHaveBeenCalled();
    const manifestBytes = [...f.store.objects.entries()].find(([key]) => key.endsWith('/manifest.json'))![1];
    expect(JSON.parse(new TextDecoder().decode(manifestBytes)).controller_observed_outcome)
      .toEqual({ kind: 'COMMAND_EXITED', commandId: 'command-1', exitCode: 0, durationMs: 42 });
  });

  it('recovers the same sealed manifest when object-store reads reuse their byte buffer', async () => {
    const f = fixture();
    const first = await f.sealer.seal(f.input);
    const originalRead = f.store.readObject.bind(f.store);
    f.store.readObject = async input => {
      const bytes = f.store.objects.get(input.objectKey);
      if (!bytes || !input.objectKey.endsWith('/manifest.json')) return originalRead(input);
      return { declaredBytes: bytes.length, body: (async function* () {
        const shared = new Uint8Array(Math.min(31, input.maximumChunkBytes));
        for (let offset = 0; offset < bytes.length; offset += shared.length) {
          shared.fill(0);
          const size = Math.min(shared.length, bytes.length - offset);
          shared.set(bytes.subarray(offset, offset + size));
          yield shared.subarray(0, size);
        }
        shared.fill(0);
      })() };
    };
    expect(await f.sealer.seal(f.input)).toEqual(first);
  });

  it('fails with a distinct diagnostic when a prior partial object conflicts', async () => {
    const f = fixture();
    f.snapshots.delete('source/answer.txt');
    await expect(f.sealer.seal(f.input)).rejects.toMatchObject({ code: 'ARTIFACT_FILE_MISSING' });
    f.snapshots.set('reports/result.json', snapshot('reports/result.json', encoder.encode('changed')));
    f.snapshots.set('source/answer.txt', snapshot('source/answer.txt', encoder.encode('proof')));
    await expect(f.sealer.seal(f.input)).rejects.toMatchObject({ code: 'ARTIFACT_PARTIAL_CONFLICT' });
    expect([...f.store.objects.keys()].some(key => key.endsWith('/manifest.json'))).toBe(false);
  });

  it('bounds a stalled stream by a deadline and requests iterator cancellation', async () => {
    const f = fixture();
    const iteratorReturn = vi.fn(async () => ({ done: true as const, value: undefined }));
    f.store.readObject = vi.fn(async () => ({
      declaredBytes: null,
      body: {
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
          return: iteratorReturn,
        }),
      },
    }));
    const sealer = new ArtifactSealer({ reader: f.reader, policy: f.policy, store: f.store, operationTimeoutMs: 10 });
    await expect(sealer.seal(f.input)).rejects.toMatchObject({ code: 'ARTIFACT_OPERATION_TIMEOUT' });
    expect(iteratorReturn).toHaveBeenCalledOnce();
    expect(f.reader.capture).not.toHaveBeenCalled();
  });

  it('rejects any mismatch across attempt, environment, handle, and frozen launch plan', async () => {
    const f = fixture();
    f.handle.sessionId = 'replacement-session';
    await expect(f.sealer.seal(f.input)).rejects.toMatchObject({ code: 'ARTIFACT_BINDING_MISMATCH' });
    expect(f.reader.capture).not.toHaveBeenCalled();
  });
});

describe('Supabase immutable object adapter', () => {
  it('uses the installed streaming SDK with create-only upload and cache-bypassed readback', async () => {
    const upload = vi.fn(async (_path: string, body: NodeJS.ReadableStream, options: Record<string, unknown>) => {
      expect(body).toBeInstanceOf(Readable);
      await collect(body as AsyncIterable<Uint8Array>);
      expect(options).toMatchObject({ upsert: false, duplex: 'half', contentType: 'text/plain' });
      return { data: { id: 'object-id', path: 'path', fullPath: 'bucket/path' }, error: null };
    });
    const asStream = vi.fn(async () => ({
      data: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode('ok')); controller.close(); } }),
      error: null,
    }));
    const download = vi.fn(() => ({ asStream }));
    const from = vi.fn(() => ({ upload, download }));
    const client = { storage: { from } } as unknown as Pick<SupabaseClient, 'storage'>;
    const store = new SupabaseImmutableObjectStore(client, 'private-artifacts');
    const bytes = encoder.encode('ok');
    const controller = new AbortController();
    await expect(store.putIfAbsent({
      objectKey: 'projects/p/object',
      body: (async function* () { yield bytes; })(),
      contentType: 'text/plain',
      expectedBytes: bytes.byteLength,
      expectedDigest: byteDigest(bytes),
      signal: controller.signal,
    })).resolves.toEqual({ status: 'CREATED', objectId: 'object-id' });
    const read = await store.readObject({ objectKey: 'projects/p/object', maximumBytes: 2, maximumChunkBytes: 2, signal: controller.signal });
    expect(read).not.toBeNull();
    expect(new TextDecoder().decode(await collect(read!.body))).toBe('ok');
    expect(download).toHaveBeenCalledWith('projects/p/object', {}, { cache: 'no-store', signal: controller.signal });
    expect(asStream).toHaveBeenCalledOnce();
  });

  it('classifies only explicit duplicate responses as existing objects', async () => {
    const upload = vi.fn(async () => ({ data: null, error: {
      name: 'StorageApiError', message: 'already exists', status: 409, statusCode: 'Duplicate', code: 'ResourceAlreadyExists',
    } }));
    const client = { storage: { from: () => ({ upload }) } } as unknown as Pick<SupabaseClient, 'storage'>;
    const store = new SupabaseImmutableObjectStore(client, 'private-artifacts');
    const bytes = encoder.encode('ok');
    const controller = new AbortController();
    await expect(store.putIfAbsent({
      objectKey: 'projects/p/object', body: (async function* () { yield bytes; })(), contentType: 'text/plain',
      expectedBytes: bytes.byteLength, expectedDigest: byteDigest(bytes), signal: controller.signal,
    })).resolves.toEqual({ status: 'EXISTS', objectId: 'private-artifacts/projects/p/object' });
  });

  it('cancels a pending SDK stream when the read deadline signal aborts', async () => {
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const asStream = vi.fn(async () => ({ data: stream, error: null }));
    const client = ({ storage: { from: () => ({ download: () => ({ asStream }) }) } }) as unknown as Pick<SupabaseClient, 'storage'>;
    const store = new SupabaseImmutableObjectStore(client, 'private-artifacts');
    const controller = new AbortController();
    const read = await store.readObject({
      objectKey: 'projects/p/object', maximumBytes: 2, maximumChunkBytes: 2, signal: controller.signal,
    });
    const next = read!.body[Symbol.asyncIterator]().next();
    controller.abort(new Error('deadline'));
    await next;
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('cancels the SDK response when a bounded consumer stops early', async () => {
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(32)); },
      cancel: cancelled,
    });
    const asStream = vi.fn(async () => ({ data: stream, error: null }));
    const client = ({ storage: { from: () => ({ download: () => ({ asStream }) }) } }) as unknown as Pick<SupabaseClient, 'storage'>;
    const store = new SupabaseImmutableObjectStore(client, 'private-artifacts');
    const controller = new AbortController();
    const read = await store.readObject({
      objectKey: 'projects/p/object', maximumBytes: 2, maximumChunkBytes: 2, signal: controller.signal,
    });
    const iterator = read!.body[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
    expect(cancelled).toHaveBeenCalledOnce();
  });
});
