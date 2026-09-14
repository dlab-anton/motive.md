import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { authenticatedFetch } = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));
vi.mock('./account-fetch', () => ({ authenticatedFetch }));

import { HandoffReadError, readHandoff, readHandoffPage } from './research-handoffs';

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const fetchMock = vi.fn();

function handoff(value = 1, createdAt = `2026-09-09T03:00:${(30 - value).toString().padStart(2, '0')}.000Z`) {
  return { id: id(value), claimId: id(100 + value), assignmentId: id(200 + value), agentName: 'Research agent',
    contributorDisplayName: 'Public contributor', createdAt,
    stopReason: '<img src=x onerror="window.privateCanary=true"> The local solver could not initialize; no result was produced.',
    intent: { proposal: 'Try the bounded candidate.', expectation: 'The protected score may improve.',
      conditions: ['Use the frozen checker.'], workOrderRevision: 3, declaredAt: '2026-09-09T02:00:00.000Z' },
    interpretationStatus: 'AGENT_DECLARED_UNVERIFIED' };
}

function page(items: ReturnType<typeof handoff>[], nextCursor: string | null = null) {
  return { format: 'motive.research-handoff-page/0.1', items, nextCursor };
}

function response(body: unknown, status = 200): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), { status,
    headers: { 'Content-Type': 'application/json' } });
}

function expectReadError(error: unknown, reset: boolean, accessDenied: boolean) {
  expect(error).toBeInstanceOf(HandoffReadError); expect(error).toMatchObject({ reset, accessDenied });
}

describe('research handoff client', () => {
  beforeEach(() => { authenticatedFetch.mockReset(); fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  it('parses exact public handoffs and preserves contributor text as inert data', async () => {
    const raw = handoff(); fetchMock.mockResolvedValue(response(raw));
    const result = await readHandoff(raw.id, new AbortController().signal);
    expect(result).toEqual(raw); expect(result.stopReason).toContain('<img src=x');
    expect(fetchMock).toHaveBeenCalledWith(`/api/public/projects/circle-packing/research-handoffs/${raw.id}`,
      expect.objectContaining({ method: 'GET', credentials: 'same-origin', redirect: 'error',
        headers: { Accept: 'application/json' }, signal: expect.any(AbortSignal) }));
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });

  it('uses public fetch for shared pages and authenticated fetch only for account pages', async () => {
    const publicItems = [handoff(1)]; fetchMock.mockResolvedValue(response(page(publicItems)));
    expect(await readHandoffPage(false, null, new AbortController().signal)).toEqual(page(publicItems));
    expect(fetchMock.mock.calls[0][0]).toBe('/api/public/projects/circle-packing/research-handoffs');

    const accountItems = [handoff(2)]; authenticatedFetch.mockResolvedValue(response(page(accountItems)));
    expect(await readHandoffPage(true, id(9), new AbortController().signal)).toEqual(page(accountItems));
    expect(authenticatedFetch.mock.calls[0][0]).toBe(`/api/participation/research-handoffs?before=${id(9)}`);
  });

  it('accepts private attribution and an absent original intent', async () => {
    const raw = handoff(); raw.contributorDisplayName = null as unknown as string;
    raw.intent = null as unknown as ReturnType<typeof handoff>['intent'];
    fetchMock.mockResolvedValue(response(page([raw])));
    const result = await readHandoffPage(false, null, new AbortController().signal);
    expect(result.items[0]).toMatchObject({ contributorDisplayName: null, intent: null });
  });

  it('accepts a full 20-item page only when its cursor is the last item', async () => {
    const items = Array.from({ length: 20 }, (_, index) => handoff(index + 1));
    fetchMock.mockResolvedValue(response(page(items, items.at(-1)!.id)));
    const result = await readHandoffPage(false, null, new AbortController().signal);
    expect(result.items).toHaveLength(20); expect(result.nextCursor).toBe(items.at(-1)!.id);
  });

  it.each([
    ['null body', null],
    ['wrong format', { ...page([]), format: 'motive.private/0.1' }],
    ['extra envelope key', { ...page([]), privateRows: [] }],
    ['too many rows', page(Array.from({ length: 21 }, (_, index) => handoff(index + 1)))],
    ['duplicate IDs', page([handoff(1), handoff(1)])],
    ['ascending timestamp order', page([handoff(1, '2026-09-09T03:00:00.000Z'), handoff(2, '2026-09-09T04:00:00.000Z')])],
    ['cursor on short page', page([handoff(1)], id(1))],
    ['wrong full-page cursor', page(Array.from({ length: 20 }, (_, index) => handoff(index + 1)), id(19))],
    ['extra handoff key', page([{ ...handoff(1), reviewerActorId: 'account:private' } as unknown as ReturnType<typeof handoff>])],
    ['noncanonical event ID', page([{ ...handoff(10), id: id(10).toUpperCase() }])],
    ['mismatched exact ID', handoff(2)],
    ['bad timestamp', page([{ ...handoff(1), createdAt: 'yesterday' }])],
    ['normalized invalid timestamp', page([{ ...handoff(1), createdAt: '2026-02-31T03:00:00.000Z' }])],
    ['empty stop reason', page([{ ...handoff(1), stopReason: '' }])],
    ['untrimmed agent name', page([{ ...handoff(1), agentName: ' padded ' }])],
    ['extra intent key', page([{ ...handoff(1), intent: { ...handoff(1).intent,
      researchContext: {} } as unknown as ReturnType<typeof handoff>['intent'] }])],
    ['empty conditions', page([{ ...handoff(1), intent: { ...handoff(1).intent, conditions: [] } }])],
    ['noninteger revision', page([{ ...handoff(1), intent: { ...handoff(1).intent, workOrderRevision: 1.5 } }])],
  ])('rejects malformed successful data: %s', async (name, body) => {
    fetchMock.mockResolvedValue(response(body));
    const operation = name === 'mismatched exact ID'
      ? readHandoff(id(1), new AbortController().signal)
      : readHandoffPage(false, null, new AbortController().signal);
    await expect(operation).rejects.toSatisfy((error: unknown) => { expectReadError(error, false, false); return true; });
  });

  it('accepts either UUID order when distinct PostgreSQL microseconds serialize to the same millisecond', async () => {
    const first = handoff(1, '2026-09-09T03:00:00.123Z'); const second = handoff(2, '2026-09-09T03:00:00.123Z');
    fetchMock.mockResolvedValue(response(page([first, second])));
    await expect(readHandoffPage(false, null, new AbortController().signal)).resolves.toMatchObject({ items: [first, second] });
  });

  it('rejects noncanonical caller identifiers before any request', async () => {
    await expect(readHandoffPage(false, 'NOT-A-UUID', new AbortController().signal)).rejects.toSatisfy((error: unknown) => {
      expectReadError(error, false, false); return true;
    });
    await expect(readHandoff(id(10).toUpperCase(), new AbortController().signal)).rejects.toBeInstanceOf(HandoffReadError);
    expect(fetchMock).not.toHaveBeenCalled(); expect(authenticatedFetch).not.toHaveBeenCalled();
  });

  it.each([401, 403])('clears handoff state when access returns %s', async status => {
    authenticatedFetch.mockResolvedValue(response({ private: 'do-not-echo' }, status));
    await expect(readHandoffPage(true, null, new AbortController().signal)).rejects.toSatisfy((error: unknown) => {
      expectReadError(error, true, true); expect((error as Error).message).not.toContain('do-not-echo'); return true;
    });
  });

  it('resets a missing page cursor while keeping an unavailable exact link local to that read', async () => {
    fetchMock.mockResolvedValueOnce(response({}, 404)).mockResolvedValueOnce(response({}, 404));
    await expect(readHandoffPage(false, id(1), new AbortController().signal)).rejects.toSatisfy((error: unknown) => {
      expectReadError(error, true, false); return true;
    });
    await expect(readHandoff(id(1), new AbortController().signal)).rejects.toSatisfy((error: unknown) => {
      expectReadError(error, false, false); return true;
    });
  });

  it.each([
    ['server failure', async () => response({ private: 'database-canary' }, 503)],
    ['network failure', async () => { throw new Error('credential-canary'); }],
  ])('preserves current handoffs on %s', async (_name, implementation) => {
    fetchMock.mockImplementation(implementation);
    await expect(readHandoffPage(false, null, new AbortController().signal)).rejects.toSatisfy((error: unknown) => {
      expectReadError(error, false, false); expect((error as Error).message).not.toMatch(/database-canary|credential-canary/); return true;
    });
  });

  it('propagates caller abort instead of converting it to a handoff read failure', async () => {
    fetchMock.mockImplementation((_path: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new DOMException('caller stopped', 'AbortError')), { once: true });
    }));
    const controller = new AbortController(); const pending = readHandoffPage(false, null, controller.signal); controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
