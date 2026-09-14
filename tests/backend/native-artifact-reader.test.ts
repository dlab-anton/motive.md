import { describe, expect, it } from 'vitest';
import { decodeNativeArtifactFrame, LocalNativeArtifactReader } from '../../packages/artifact-storage/src/native-reader.ts';

const frame = (body: Buffer, header = `1:2:${body.length}`) => Buffer.concat([Buffer.from(`MOTIVE_ARTIFACT_V1\n${header}\n`), body]);
const contents = async (snapshot: ReturnType<typeof decodeNativeArtifactFrame>) => {
  const parts: Uint8Array[] = [];
  for await (const part of snapshot.read()) parts.push(part);
  return Buffer.concat(parts);
};

describe('trusted native collector output boundary', () => {
  it('owns captured bytes and every yielded chunk across repeated reads', async () => {
    const input = frame(Buffer.from('abcdef'));
    const snapshot = decodeNativeArtifactFrame(input, 'Solution.lean', 10, 2);
    input.fill(0);
    const chunks: number[] = [];
    for await (const chunk of snapshot.read()) { chunks.push(chunk.length); chunk.fill(0); }
    expect(chunks).toEqual([2, 2, 2]);
    expect((await contents(snapshot)).toString()).toBe('abcdef');
    expect(snapshot.declaredBytes).toBe(6);
    expect(snapshot.identityToken).toMatch(/^1:2:sha256:[0-9a-f]{64}$/);
  });

  it('accepts an empty regular file without fabricating bytes', async () => {
    const snapshot = decodeNativeArtifactFrame(frame(Buffer.alloc(0)), 'empty', 1, 1);
    expect((await contents(snapshot)).length).toBe(0);
  });

  it.each([
    ['short payload', frame(Buffer.from('a'), '1:2:2')],
    ['extra payload', frame(Buffer.from('ab'), '1:2:1')],
    ['negative length', frame(Buffer.from('a'), '1:2:-1')],
    ['leading zero', frame(Buffer.from('a'), '1:2:01')],
    ['missing identity', frame(Buffer.from('a'), ':2:1')],
    ['unbounded identity', frame(Buffer.from('a'), `${'1'.repeat(21)}:2:1`)],
    ['unknown header', Buffer.from('worker says success\n1:2:0\n')],
    ['truncated header', Buffer.from('MOTIVE_ARTIFACT_V1\n1:2:0')],
    ['non-ASCII header', Buffer.from([...frame(Buffer.from('a'))].map((byte, i) => i === 0 ? byte | 128 : byte))],
  ])('rejects %s', (_name, input) => {
    expect(() => decodeNativeArtifactFrame(input, 'Solution.lean', 10, 2)).toThrow();
  });

  it('enforces approved path and finite limits independently of framing', () => {
    expect(() => decodeNativeArtifactFrame(frame(Buffer.from('abc')), '../secret', 10, 2)).toThrow();
    expect(() => decodeNativeArtifactFrame(frame(Buffer.from('abc')), 'out', 2, 2)).toThrow();
    expect(() => decodeNativeArtifactFrame(frame(Buffer.alloc(0)), 'out', 2, 0)).toThrow();
    expect(() => decodeNativeArtifactFrame(frame(Buffer.alloc(0)), 'out', 65 * 1024 * 1024, 1)).toThrow();
  });

  it('has no default SDK, command, or workspace fallback for another session', async () => {
    const reader = new LocalNativeArtifactReader({ helperPath: '/opt/motive/collector', helperDigest: `sha256:${'a'.repeat(64)}`, bindings: [] });
    await expect(reader.capture({
      handle: { provider: 'vercel', sandboxId: 'unbound', sessionId: 'unbound', attemptId: 'unbound', leaseEpoch: 1, profileDigest: `sha256:${'a'.repeat(64)}` },
      relativePath: 'Solution.lean', maximumBytes: 100, maximumChunkBytes: 10, signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'NATIVE_SESSION_UNBOUND' });
  });
});
