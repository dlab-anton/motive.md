import { afterEach, describe, expect, it, vi } from 'vitest';
import { readContributorJournal } from './contributor-journal';

const contributorId = '10000000-1111-4111-8111-111111111111';
const submissionId = '20000000-1111-4111-8111-111111111111';
const decisionId = '30000000-1111-4111-8111-111111111111';
const page = () => ({ format: 'motive.contributor-journal/0.1', projectSlug: 'circle-packing', contributorId,
  nextCursor: null, items: [{ submission: { id: submissionId, contributorDisplayName: 'Synthetic contributor' },
    update: { submissionId, findingReview: { id: decisionId, decision: 'ACCEPT', outcome: 'CONTRADICTED',
      novelty: 'DISTINCT', finding: 'The declared change did not improve this trial.', limitations: 'One bounded trial.', reviewedAt: '2026-09-09T00:00:00Z' } } }] });
function respond(body: unknown) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal('fetch', fetch); return fetch;
}
afterEach(() => vi.unstubAllGlobals());

describe('accepted finding history', () => {
  it('uses the filtered contributor route and keeps a useful negative finding', async () => {
    const fetch = respond(page());
    const result = await readContributorJournal(contributorId, submissionId, new AbortController().signal, true);
    expect(fetch.mock.calls[0]?.[0]).toBe(`/api/public/projects/circle-packing/contributors/${contributorId}/accepted-findings?before=${submissionId}`);
    expect(result.items[0]?.update.findingReview?.outcome).toBe('CONTRADICTED');
  });
  it('does not relabel a duplicate or declined review as accepted credit', async () => {
    for (const change of [{ decision: 'DECLINE' }, { novelty: 'DUPLICATE' }, { outcome: null }, { limitations: '' }]) {
      const value = page(); Object.assign(value.items[0]!.update.findingReview, change); respond(value);
      await expect(readContributorJournal(contributorId, null, new AbortController().signal, true)).rejects.toThrow('could not be read');
    }
  });
  it('rejects a different contributor and malformed repeated entries', async () => {
    const foreign = page(); foreign.contributorId = submissionId; respond(foreign);
    await expect(readContributorJournal(contributorId, null, new AbortController().signal, true)).rejects.toThrow('could not be read');
    const repeated = page(); repeated.items.push(repeated.items[0]!); respond(repeated);
    await expect(readContributorJournal(contributorId, null, new AbortController().signal, true)).rejects.toThrow('could not be read');
  });
  it('keeps ordinary contribution browsing independent of finding acceptance', async () => {
    const value = page(); value.items[0]!.update.findingReview.decision = 'DECLINE';
    const fetch = respond(value);
    expect((await readContributorJournal(contributorId, null, new AbortController().signal)).items).toHaveLength(1);
    expect(fetch.mock.calls[0]?.[0]).toMatch(/\/research-updates$/);
  });
  it('accepts an empty history without treating it as a rejection', async () => {
    respond({ ...page(), items: [] });
    expect((await readContributorJournal(contributorId, null, new AbortController().signal, true)).items).toEqual([]);
  });
});
