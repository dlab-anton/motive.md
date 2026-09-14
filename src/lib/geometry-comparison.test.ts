import { afterEach, describe, expect, it, vi } from 'vitest';
import { geometryComparisonFormat, parseGeometryComparison, readGeometryComparison } from './geometry-comparison';

const left = { submissionId: 'aaaaaaaa-1111-4111-8111-111111111111', artifactSha256: `sha256:${'a'.repeat(64)}` };
const right = { submissionId: 'bbbbbbbb-2222-4222-8222-222222222222', artifactSha256: `sha256:${'b'.repeat(64)}` };
const response = () => ({ format: geometryComparisonFormat, left, right, relation: 'SQUARE_SYMMETRY' });
function respond(value: unknown) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(value), { status: 200 }));
  vi.stubGlobal('fetch', fetch); return fetch;
}
afterEach(() => vi.unstubAllGlobals());

describe('public geometry comparison client', () => {
  it('performs one credential-free same-origin GET and validates the exact response', async () => {
    const fetch = respond(response());
    await expect(readGeometryComparison(left, right, new AbortController().signal)).resolves.toEqual(response());
    expect(fetch).toHaveBeenCalledWith(
      `/api/public/projects/circle-packing/submissions/${left.submissionId}/geometry-comparison?against=${right.submissionId}`,
      expect.objectContaining({ method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error' }),
    );
    expect(fetch.mock.calls[0]?.[1]).not.toHaveProperty('body');
  });

  it('rejects mismatched identities, digests, relations, and response shapes', async () => {
    const changes = [
      { left: { ...left, submissionId: right.submissionId } },
      { right: { ...right, artifactSha256: `sha256:${'c'.repeat(64)}` } },
      { relation: 'NOVEL' },
      { reviewer: 'invented' },
    ];
    for (const change of changes) {
      respond({ ...response(), ...change });
      await expect(readGeometryComparison(left, right, new AbortController().signal)).rejects.toThrow('No geometry comparison');
    }
    expect(() => parseGeometryComparison({ ...response(), relation: 'DIFFERENT_GEOMETRY' }, left, right)).not.toThrow();
  });

  it('rejects noncanonical request bindings before fetch and preserves caller aborts', async () => {
    const fetch = respond(response());
    await expect(readGeometryComparison({ ...left, submissionId: left.submissionId.toUpperCase() }, right,
      new AbortController().signal)).rejects.toThrow('No geometry comparison');
    await expect(readGeometryComparison({ ...left, artifactSha256: left.artifactSha256.slice(7) }, right,
      new AbortController().signal)).rejects.toThrow('No geometry comparison');
    expect(fetch).not.toHaveBeenCalled();

    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    })));
    const pending = readGeometryComparison(left, right, controller.signal);
    controller.abort(new DOMException('caller stopped', 'AbortError'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError', message: 'caller stopped' });
  });
});
