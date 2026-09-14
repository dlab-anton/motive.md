import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { LocalNativeArtifactReader } from '../src/native-reader.ts';
import type { Digest } from '../../domain/src/contracts.ts';

const helperPath = '/opt/motive/collector';
const helperDigest: Digest = `sha256:${createHash('sha256').update(await readFile(helperPath)).digest('hex')}`;
const handle = {
  provider: 'vercel' as const, attemptId: '00000000-0000-4000-8000-000000000001', leaseEpoch: 1,
  sandboxId: 'synthetic-local-session', sessionId: 'synthetic-local-session-1', profileDigest: `sha256:${'1'.repeat(64)}` as Digest,
};
// This fixture acts as trusted bootstrap. Production must freeze this binding
// when it provisions the session, never rediscover identity at capture time.
const workspaceIdentity = execFileSync(helperPath, ['--identity', '/srv/motive/workspace'], { env: {}, encoding: 'utf8' }).trim();
const binding = { handle, workspaceRoot: '/srv/motive/workspace', workspaceIdentity, workerUid: 2000 };
const reader = new LocalNativeArtifactReader({ helperPath, helperDigest, bindings: [binding] });
const signal = new AbortController().signal;
const capture = { handle, relativePath: 'Solution.lean', maximumBytes: 1024, maximumChunkBytes: 7, signal };
assert.equal((await reader.assertReady({ signal })).capability, 'native-beneath-workspace-no-follow-v1');
const snapshot = await reader.capture(capture);
assert.ok(snapshot);
const read = async () => {
  const parts: Uint8Array[] = [];
  for await (const bytes of snapshot.read()) { assert.ok(bytes.length <= 7); parts.push(bytes); }
  return Buffer.concat(parts).toString();
};
assert.equal(await read(), 'theorem demo : True := True.intro\n');
assert.equal(await read(), 'theorem demo : True := True.intro\n');
assert.equal(await reader.capture({ ...capture, relativePath: 'missing.lean' }), null);
await assert.rejects(reader.capture({ ...capture, relativePath: 'escape.lean' }), { code: 'NATIVE_CAPTURE_REJECTED' });
await assert.rejects(reader.capture({ ...capture, handle: { ...handle, sessionId: 'replacement' } }), { code: 'NATIVE_SESSION_UNBOUND' });
await assert.rejects(reader.capture({ ...capture, maximumBytes: 1 }), { code: 'NATIVE_CAPTURE_REJECTED' });
const wrongHash = new LocalNativeArtifactReader({ helperPath, helperDigest: `sha256:${'0'.repeat(64)}`, bindings: [binding] });
await assert.rejects(wrongHash.assertReady({ signal }), { code: 'NATIVE_HELPER_DIGEST' });
const sameUid = new LocalNativeArtifactReader({ helperPath, helperDigest, bindings: [{ ...binding, workerUid: process.getuid!() }] });
await assert.rejects(sameUid.capture(capture), { code: 'NATIVE_WORKER_IDENTITY_INVALID' });
const wrongRoot = new LocalNativeArtifactReader({ helperPath, helperDigest, bindings: [{ ...binding, workspaceIdentity: '0:0:0' }] });
await assert.rejects(wrongRoot.capture(capture), { code: 'NATIVE_CAPTURE_REJECTED' });
const unprotected = new LocalNativeArtifactReader({ helperPath, helperDigest, bindings: [{ ...binding, workspaceRoot: '/tmp/workspace' }] });
await assert.rejects(unprotected.capture(capture), { code: 'NATIVE_PATH_UNPROTECTED' });
const aborted = new AbortController(); aborted.abort();
await assert.rejects(reader.capture({ ...capture, signal: aborted.signal }), { code: 'NATIVE_ABORTED' });
process.stdout.write(JSON.stringify({ format: 'motive.native-reader-integration/0.1', passed: true, uid: process.getuid!(), workerUid: 2000, helperDigest, checks: ['probe', 'actual-bytes', 'repeat-read', 'missing', 'symlink-rejection', 'session-binding', 'size-limit', 'helper-digest', 'distinct-worker-uid', 'root-identity', 'protected-parent', 'abort'] }) + '\n');
