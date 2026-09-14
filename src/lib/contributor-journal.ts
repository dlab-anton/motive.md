import type { PublicContributorJournalPage } from './participation';
import { journalIdPattern } from './research-journal';

export async function readContributorJournal(contributorId: string, before: string | null, signal: AbortSignal, acceptedOnly = false): Promise<PublicContributorJournalPage> {
  const path = `/api/public/projects/circle-packing/contributors/${encodeURIComponent(contributorId)}/${acceptedOnly ? 'accepted-findings' : 'research-updates'}${before ? `?before=${encodeURIComponent(before)}` : ''}`;
  const response = await fetch(path, { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), credentials: 'same-origin', redirect: 'error' });
  if (!response.ok) throw new Error(response.status === 404
    ? 'This public contribution history is no longer available. Refresh to check the latest work.'
    : 'Contributions could not be loaded. Please try again.');
  const page = await response.json().catch(() => null) as PublicContributorJournalPage | null;
  if (!page || typeof page !== 'object' || page.format !== 'motive.contributor-journal/0.1' || page.projectSlug !== 'circle-packing' || page.contributorId !== contributorId
    || !Array.isArray(page.items) || page.items.length > 20
    || !(page.nextCursor === null || typeof page.nextCursor === 'string' && journalIdPattern.test(page.nextCursor))
    || page.items.some(item => !item?.submission || !item.update || !journalIdPattern.test(item.submission.id)
      || item.update.submissionId !== item.submission.id || typeof item.submission.contributorDisplayName !== 'string'
      || !item.submission.contributorDisplayName.trim()
      || acceptedOnly && (!item.update.findingReview || item.update.findingReview.decision !== 'ACCEPT'
        || item.update.findingReview.novelty !== 'DISTINCT' || !journalIdPattern.test(item.update.findingReview.id)
        || !['SUPPORTED', 'CONTRADICTED', 'INCONCLUSIVE'].includes(item.update.findingReview.outcome ?? '')
        || typeof item.update.findingReview.finding !== 'string' || !item.update.findingReview.finding.trim()
        || typeof item.update.findingReview.limitations !== 'string' || !item.update.findingReview.limitations.trim()))
    || new Set(page.items.map(item => item.submission.id)).size !== page.items.length
    || page.nextCursor !== null && page.nextCursor !== page.items.at(-1)?.submission.id) {
    throw new Error('The contribution history could not be read. Please try again.');
  }
  return page;
}
