import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ImmutableObjectStore } from '../../packages/artifact-storage/src/types.ts';
import { canonicalJson, digestCanonicalJson, type Digest } from '../../packages/domain/src/contracts.ts';
import { MAX_SEALED_EVALUATOR_INPUT_BYTES, SealedEvaluatorInputLoader } from '../../packages/evaluator-lean/src/sealed-input.ts';
import { profile } from '../../packages/evaluator-lean/src/runtime-profile.fixture.ts';

const attemptId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const workOrderId = '33333333-3333-4333-8333-333333333333';
const workerEnvironmentId = '44444444-4444-4444-8444-444444444444';
const termsDigest = digestCanonicalJson('terms');
const inputDigest = digestCanonicalJson('input');
const profileDigest = digestCanonicalJson(profile);

const digest = (bytes: Uint8Array): Digest => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const token = (path: string) => createHash('sha256').update(path).digest('hex');
const stream = (bytes: Uint8Array): AsyncIterable<Uint8Array> => (async function* () {
  for (let offset = 0; offset < bytes.length; offset += 64 * 1024) yield bytes.slice(offset, offset + 64 * 1024);
})();

function fixture(source = Buffer.from('theorem target : True := by trivial\n')) {
  const prefix = `projects/${projectId}/attempts/${attemptId}/seals/${workerEnvironmentId}`;
  const sourceKey = `${prefix}/files/${token('Solution.lean')}`;
  const ignored = Buffer.from('diagnostic');
  const ignoredKey = `${prefix}/files/${token('worker.log')}`;
  const manifest = {
    format: 'motive.artifact-manifest/0.1', project_id: projectId, work_order_id: workOrderId,
    attempt_id: attemptId, environment_id: workerEnvironmentId, terms_digest: termsDigest, input_digest: inputDigest,
    inference_profile_digest: digestCanonicalJson('inference'), sandbox_profile_digest: digestCanonicalJson('sandbox'),
    launch_plan_digest: digestCanonicalJson('launch'), command_digest: digestCanonicalJson('command'),
    controller_observed_outcome: { kind: 'COMMAND_EXITED', commandId: 'worker-command', exitCode: 0 }, capture_status: 'COMPLETE',
    files: [
      { relative_path: 'Solution.lean', media_type: 'text/plain', availability: 'REQUIRED', bytes: source.byteLength,
        digest: digest(source), object_key: sourceKey },
      { relative_path: 'worker.log', media_type: 'text/plain', availability: 'REQUIRED', bytes: ignored.byteLength,
        digest: digest(ignored), object_key: ignoredKey },
    ], missing_files: [], total_bytes: source.byteLength + ignored.byteLength,
    human_acceptance: { status: 'PENDING', decision_id: null },
  };
  const manifestBytes = Buffer.from(canonicalJson(manifest));
  const objects = new Map([[`${prefix}/manifest.json`, manifestBytes], [sourceKey, source], [ignoredKey, ignored]]);
  const reads: string[] = [];
  const store: Pick<ImmutableObjectStore, 'readObject'> = {
    async readObject(input) {
      reads.push(input.objectKey);
      const bytes = objects.get(input.objectKey);
      return bytes ? { body: stream(bytes), declaredBytes: bytes.byteLength } : null;
    },
  };
  const contextResolver = { resolve: vi.fn(async () => ({ projectId, workerEnvironmentId })) };
  const loader = new SealedEvaluatorInputLoader({ store, contextResolver });
  const load = (overrides: Record<string, unknown> = {}) => loader.load({ attemptId, workOrderId, termsDigest, inputDigest,
    manifestDigest: digest(manifestBytes), evaluatorProfile: profile, evaluatorProfileDigest: profileDigest,
    signal: new AbortController().signal, ...overrides });
  return { load, manifest, manifestBytes, objects, reads, sourceKey, ignoredKey, contextResolver };
}

describe('sealed evaluator input loader', () => {
  it('authenticates the exact seal and loads only profile-approved Lean source bytes', async () => {
    const f = fixture();
    const result = await f.load();
    expect(result).toEqual({ format: 'motive.sealed-evaluator-input/0.1', artifact_manifest_digest: digest(f.manifestBytes), files: [{
      relative_path: 'Solution.lean', bytes_base64: Buffer.from('theorem target : True := by trivial\n').toString('base64'),
      digest: digest(Buffer.from('theorem target : True := by trivial\n')),
    }] });
    expect(f.contextResolver.resolve).toHaveBeenCalledWith({ attemptId, signal: expect.any(AbortSignal) });
    expect(f.reads).toEqual([expect.stringMatching(/\/manifest\.json$/), f.sourceKey]);
    expect(f.reads).not.toContain(f.ignoredKey);
  });

  it('rejects manifest identity, digest, object-key, and source-byte substitutions', async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => { f.manifest.work_order_id = workerEnvironmentId; },
      (f: ReturnType<typeof fixture>) => { f.manifest.files[0].object_key = f.ignoredKey; },
    ]) {
      const f = fixture(); mutate(f);
      const bytes = Buffer.from(canonicalJson(f.manifest));
      f.objects.set([...f.objects.keys()][0], bytes);
      await expect(f.load({ manifestDigest: digest(bytes) })).rejects.toBeInstanceOf(Error);
    }
    const badDigest = fixture();
    await expect(badDigest.load({ manifestDigest: digestCanonicalJson('other') })).rejects.toMatchObject({ code: 'SEALED_INPUT_MANIFEST_DIGEST_MISMATCH' });
    const badSource = fixture(); badSource.objects.set(badSource.sourceKey, Buffer.from('changed'));
    await expect(badSource.load()).rejects.toMatchObject({ code: 'SEALED_INPUT_SOURCE_MISMATCH' });
  });

  it('requires every approved source and enforces the aggregate 48 KiB boundary', async () => {
    const missing = fixture(); missing.objects.delete(missing.sourceKey);
    await expect(missing.load()).rejects.toMatchObject({ code: 'SEALED_INPUT_SOURCE_MISSING' });
    const oversized = fixture(Buffer.alloc(MAX_SEALED_EVALUATOR_INPUT_BYTES + 1, 65));
    await expect(oversized.load()).rejects.toMatchObject({ code: 'SEALED_INPUT_BYTES_EXCEEDED' });
  });

  it('fails before object reads when the trusted exact context is unavailable', async () => {
    const f = fixture(); f.contextResolver.resolve.mockResolvedValueOnce(null as never);
    await expect(f.load()).rejects.toMatchObject({ code: 'SEALED_INPUT_CONTEXT_UNAVAILABLE' });
    expect(f.reads).toEqual([]);
  });

  it('accepts a valid seal with many unrelated files while reading only the selected source', async () => {
    const f = fixture();
    const prefix = f.sourceKey.slice(0, f.sourceKey.lastIndexOf('/files/'));
    for (let i = 0; i < 1025; i++) {
      const relative_path = `logs/diagnostic-${String(i).padStart(4, '0')}.txt`;
      f.manifest.files.push({ relative_path, media_type: 'text/plain', availability: 'REQUIRED', bytes: 0,
        digest: digest(Buffer.alloc(0)), object_key: `${prefix}/files/${token(relative_path)}` });
    }
    f.manifest.files.sort((a, b) => a.relative_path.localeCompare(b.relative_path));
    const manifestBytes = Buffer.from(canonicalJson(f.manifest));
    f.objects.set(`${prefix}/manifest.json`, manifestBytes);
    expect((await f.load({ manifestDigest: digest(manifestBytes) })).files).toHaveLength(1);
    expect(f.reads).toEqual([`${prefix}/manifest.json`, f.sourceKey]);
  });
});
