import { beforeEach, describe, expect, it, vi } from 'vitest';

const { authenticatedFetch } = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));
vi.mock('./account-fetch', () => ({ authenticatedFetch }));

import { FindingQueueError, readFindingReviewQueue } from './finding-review-queue';

const id = (value: number) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
const timestamp = '2026-09-09T03:00:00.000Z';

function entry(value = 1) {
  const submissionId = id(value);
  return {
    submission: { id: submissionId, agentName: 'Unused submission agent', privateToken: 'discard-me' },
    update: {
      submissionId, agentName: 'Queue agent', contributorDisplayName: 'Queue contributor',
      proposal: '<img src=x onerror="window.privateCanary=true"> Test this candidate.',
      latestAssessment: 'The retained check remains inconclusive.', createdAt: timestamp,
      completed: true, assessmentTiming: 'AFTER_CHECK', findingReview: null,
      memoryReview: { hasEngineRecords: false }, privateReviewerActorId: 'account:discard-me',
    },
    privateEnvelopeField: 'discard-me',
  };
}

function page(items = [entry()], nextCursor: string | null = null) {
  return { format: 'motive.research-journal-page/0.1', items, nextCursor };
}

function response(body: unknown, status = 200): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

function expectQueueError(error: unknown, reset: boolean, accessDenied: boolean) {
  expect(error).toBeInstanceOf(FindingQueueError);
  expect(error).toMatchObject({ reset, accessDenied });
}

describe('finding review queue client', () => {
  beforeEach(() => { authenticatedFetch.mockReset(); });

  it('returns only narrow display fields while preserving inert text exactly', async () => {
    const raw = entry(); authenticatedFetch.mockResolvedValue(response(page([raw], raw.submission.id)));
    const result = await readFindingReviewQueue(null, new AbortController().signal);
    expect(result).toEqual({ items: [{ id: raw.submission.id, agentName: 'Queue agent',
      contributorName: 'Queue contributor', proposal: raw.update.proposal,
      assessment: 'The retained check remains inconclusive.', createdAt: timestamp }], nextCursor: raw.submission.id });
    expect(result.items[0]).not.toHaveProperty('privateReviewerActorId');
    expect(result.items[0]).not.toHaveProperty('memoryReview');
    expect(JSON.stringify(result)).not.toContain('discard-me');
    const [path, init] = authenticatedFetch.mock.calls[0];
    expect(path).toBe('/api/participation/finding-review-queue');
    expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', redirect: 'error',
      headers: { Accept: 'application/json' }, signal: expect.any(AbortSignal) });
  });

  it('uses a validated cursor and accepts nullable display fields without requiring memory delivery state', async () => {
    const raw = entry(2); delete (raw.update as Partial<typeof raw.update>).findingReview;
    raw.update.contributorDisplayName = null as unknown as string;
    raw.update.proposal = null as unknown as string; raw.update.latestAssessment = null as unknown as string;
    delete (raw.update as Partial<typeof raw.update>).memoryReview;
    authenticatedFetch.mockResolvedValue(response(page([raw], null)));
    const result = await readFindingReviewQueue(id(1), new AbortController().signal);
    expect(authenticatedFetch.mock.calls[0][0]).toBe(`/api/participation/finding-review-queue?before=${id(1)}`);
    expect(result.items[0]).toMatchObject({ contributorName: null, proposal: null, assessment: null });
  });

  it.each([
    ['null body', null],
    ['wrong format', { ...page(), format: 'motive.private/0.1' }],
    ['extra envelope field', { ...page(), privateRows: [] }],
    ['too many items', page(Array.from({ length: 21 }, (_, index) => entry(index + 1)))],
    ['mismatched IDs', (() => { const value = page(); value.items[0].update.submissionId = id(9); return value; })()],
    ['coerced submission ID', (() => { const value = page(); (value.items[0].submission as unknown as Record<string, unknown>).id = { toString: () => id(1) }; return value; })()],
    ['duplicate IDs', page([entry(1), entry(1)])],
    ['wrong cursor', page([entry(1)], id(2))],
    ['cursor without item', page([], id(1))],
    ['incomplete update', (() => { const value = page(); value.items[0].update.completed = false; return value; })()],
    ['wrong assessment timing', (() => { const value = page(); value.items[0].update.assessmentTiming = 'AT_SUBMISSION'; return value; })()],
    ['existing finding review', (() => { const value = page(); (value.items[0].update as unknown as Record<string, unknown>).findingReview = {}; return value; })()],
    ['invalid timestamp', (() => { const value = page(); value.items[0].update.createdAt = 'yesterday'; return value; })()],
    ['oversized agent name', (() => { const value = page(); value.items[0].update.agentName = 'a'.repeat(121); return value; })()],
  ])('rejects malformed successful data: %s', async (_name, body) => {
    authenticatedFetch.mockResolvedValue(response(body));
    await expect(readFindingReviewQueue(null, new AbortController().signal)).rejects.toSatisfy((error: unknown) => {
      expectQueueError(error, false, false); return true;
    });
  });

  it('rejects a noncanonical caller cursor before resolving authentication', async () => {
    await expect(readFindingReviewQueue('NOT-A-UUID', new AbortController().signal)).rejects.toSatisfy((error: unknown) => {
      expectQueueError(error, false, false); return true;
    });
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });

  it('loads initial shared-memory reviews before engine delivery through the account route', async () => {
    const raw = entry();
    (raw.update as Record<string, unknown>).memoryReview = { latestDecision: null, hasEngineRecords: false };
    authenticatedFetch.mockResolvedValue(response(page([raw])));
    const result = await readFindingReviewQueue(null, new AbortController().signal, 'memory');
    expect(result.items[0].id).toBe(raw.submission.id);
    expect(authenticatedFetch.mock.calls[0][0]).toBe('/api/participation/memory-review-queue');
  });

  it.each([undefined, null, { latestDecision: { decision: 'ADMIT' } }, { latestDecision: { decision: 'DECLINE' } }])(
    'rejects memory queue rows without an explicit unreviewed state: %j', async memoryReview => {
      const raw = entry(); (raw.update as Record<string, unknown>).memoryReview = memoryReview;
      authenticatedFetch.mockResolvedValue(response(page([raw])));
      await expect(readFindingReviewQueue(null, new AbortController().signal, 'memory')).rejects.toBeInstanceOf(FindingQueueError);
    });

  it.each([401, 403])('clears stale queue state when reviewer access returns %s', async status => {
    authenticatedFetch.mockResolvedValue(response({ error: 'private server detail' }, status));
    await expect(readFindingReviewQueue(null, new AbortController().signal)).rejects.toSatisfy((error: unknown) => {
      expectQueueError(error, true, true); expect((error as Error).message).not.toContain('private server detail'); return true;
    });
  });

  it('clears a missing queue without classifying it as denied access', async () => {
    authenticatedFetch.mockResolvedValue(response({}, 404));
    await expect(readFindingReviewQueue(null, new AbortController().signal)).rejects.toSatisfy((error: unknown) => {
      expectQueueError(error, true, false); return true;
    });
  });

  it.each([
    ['server failure', async () => response({ error: 'database-canary' }, 503)],
    ['network failure', async () => { throw new Error('credential-canary'); }],
  ])('preserves the current queue on %s', async (_name, implementation) => {
    authenticatedFetch.mockImplementation(implementation);
    await expect(readFindingReviewQueue(null, new AbortController().signal)).rejects.toSatisfy((error: unknown) => {
      expectQueueError(error, false, false);
      expect((error as Error).message).not.toMatch(/database-canary|credential-canary/); return true;
    });
  });

  it('propagates caller abort without converting it to a queue failure', async () => {
    authenticatedFetch.mockImplementation((_path: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new DOMException('caller stopped', 'AbortError')), { once: true });
    }));
    const controller = new AbortController(); const pending = readFindingReviewQueue(null, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
