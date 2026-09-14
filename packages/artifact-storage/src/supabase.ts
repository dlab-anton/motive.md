import { Readable } from 'node:stream';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Digest } from '../../domain/src/contracts.ts';
import { ArtifactStorageError } from './sealer.ts';
import type { ImmutableObjectStore } from './types.ts';

function isDuplicate(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const value = error as { status?: unknown; statusCode?: unknown; code?: unknown };
  return value.status === 409 || value.statusCode === '409' || value.statusCode === 'Duplicate'
    || value.code === 'ResourceAlreadyExists';
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const value = error as { status?: unknown; statusCode?: unknown; code?: unknown };
  return value.status === 404 || value.statusCode === '404' || value.statusCode === 'NoSuchKey'
    || value.code === 'NoSuchKey' || value.code === 'ObjectNotFound';
}

function asAsyncBytes(stream: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncIterable<Uint8Array> {
  return (async function* () {
    const reader = stream.getReader();
    const cancel = () => { void reader.cancel(signal.reason).catch(() => undefined); };
    let completed = false;
    signal.addEventListener('abort', cancel, { once: true });
    try {
      while (true) {
        if (signal.aborted) throw signal.reason;
        const next = await reader.read();
        if (next.done) { completed = true; return; }
        yield next.value;
      }
    } finally {
      if (!completed) await reader.cancel(signal.reason).catch(() => undefined);
      signal.removeEventListener('abort', cancel);
      reader.releaseLock();
    }
  })();
}

/** Supabase Storage implementation; callers provide an already-scoped private client. */
export class SupabaseImmutableObjectStore implements ImmutableObjectStore {
  constructor(private readonly client: Pick<SupabaseClient, 'storage'>, private readonly bucket: string) {
    if (!/^[a-z0-9][a-z0-9._-]{0,62}$/i.test(bucket)) {
      throw new ArtifactStorageError('ARTIFACT_STORAGE_CONFIG_INVALID', 'Supabase bucket name is invalid.');
    }
  }

  async putIfAbsent(input: {
    objectKey: string;
    body: AsyncIterable<Uint8Array>;
    contentType: string;
    expectedBytes: number;
    expectedDigest: Digest;
    signal: AbortSignal;
  }): Promise<{ status: 'CREATED' | 'EXISTS'; objectId: string }> {
    const result = await this.client.storage.from(this.bucket).upload(input.objectKey, Readable.from(input.body, { signal: input.signal }), {
      upsert: false,
      contentType: input.contentType,
      cacheControl: '31536000',
      duplex: 'half',
      metadata: { sha256: input.expectedDigest.slice('sha256:'.length), bytes: input.expectedBytes },
    });
    if (result.error) {
      if (isDuplicate(result.error)) return { status: 'EXISTS', objectId: `${this.bucket}/${input.objectKey}` };
      throw new ArtifactStorageError('ARTIFACT_STORAGE_WRITE_FAILED', `Supabase upload failed: ${result.error.message}`);
    }
    return { status: 'CREATED', objectId: result.data.id };
  }

  async readObject(input: {
    objectKey: string;
    maximumBytes: number;
    maximumChunkBytes: number;
    signal: AbortSignal;
  }): Promise<{ body: AsyncIterable<Uint8Array>; declaredBytes: number | null } | null> {
    const result = await this.client.storage.from(this.bucket)
      .download(input.objectKey, {}, { cache: 'no-store', signal: input.signal })
      .asStream();
    if (result.error && isNotFound(result.error)) return null;
    if (result.error || result.data === null) {
      throw new ArtifactStorageError('ARTIFACT_STORAGE_READ_FAILED', `Supabase readback failed: ${result.error?.message ?? 'empty response'}`);
    }
    return { body: asAsyncBytes(result.data, input.signal), declaredBytes: null };
  }
}
