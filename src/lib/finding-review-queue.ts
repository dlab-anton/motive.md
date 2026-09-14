import { authenticatedFetch } from './account-fetch';

export type FindingQueueItem = {
  id: string;
  agentName: string;
  contributorName: string | null;
  proposal: string | null;
  assessment: string | null;
  createdAt: string;
};

export type FindingQueuePage = {
  items: FindingQueueItem[];
  nextCursor: string | null;
};

export type ReviewQueueKind = 'finding' | 'memory';

export class FindingQueueError extends Error {
  constructor(message: string, readonly reset: boolean, readonly accessDenied: boolean) {
    super(message);
    this.name = 'FindingQueueError';
  }
}

type JsonRecord = Record<string, unknown>;

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const INVALID_RESPONSE = 'The review list response could not be read. Please try again.';
const UNAVAILABLE = 'The review list could not be loaded. Your current list is preserved; try again.';

function record(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximum && value.trim() === value;
}

function nullableText(value: unknown, maximum: number): value is string | null {
  return value === null || text(value, maximum);
}

function dateTime(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(value)
    && Number.isFinite(Date.parse(value));
}

function invalidResponse(): FindingQueueError {
  return new FindingQueueError(INVALID_RESPONSE, false, false);
}

function parsePage(value: unknown, kind: ReviewQueueKind): FindingQueuePage {
  if (!record(value) || Object.keys(value).length !== 3
      || value.format !== 'motive.research-journal-page/0.1' || !Array.isArray(value.items)
      || value.items.length > 20 || !(value.nextCursor === null || typeof value.nextCursor === 'string' && UUID.test(value.nextCursor))) {
    throw invalidResponse();
  }
  const items: FindingQueueItem[] = [];
  for (const raw of value.items) {
    if (!record(raw) || !record(raw.submission) || !record(raw.update)) throw invalidResponse();
    const submission = raw.submission; const update = raw.update;
    if (typeof submission.id !== 'string' || !UUID.test(submission.id) || update.submissionId !== submission.id
        || update.completed !== true || update.assessmentTiming !== 'AFTER_CHECK'
        || !(kind === 'memory' ? record(update.memoryReview) && update.memoryReview.latestDecision === null : update.findingReview === null || !Object.hasOwn(update, 'findingReview'))
        || !text(update.agentName, 120) || !nullableText(update.contributorDisplayName, 200)
        || !nullableText(update.proposal, 2_000) || !nullableText(update.latestAssessment, 2_000)
        || !dateTime(update.createdAt)) throw invalidResponse();
    items.push({ id: submission.id as string, agentName: update.agentName,
      contributorName: update.contributorDisplayName, proposal: update.proposal,
      assessment: update.latestAssessment, createdAt: update.createdAt });
  }
  if (new Set(items.map(item => item.id)).size !== items.length
      || value.nextCursor !== null && value.nextCursor !== items.at(-1)?.id) throw invalidResponse();
  return { items, nextCursor: value.nextCursor };
}

export async function readFindingReviewQueue(
  before: string | null,
  signal: AbortSignal,
  kind: ReviewQueueKind = 'finding',
): Promise<FindingQueuePage> {
  if (!(before === null || typeof before === 'string' && UUID.test(before))) throw invalidResponse();
  const path = `/api/participation/${kind === 'memory' ? 'memory' : 'finding'}-review-queue${before ? `?before=${encodeURIComponent(before)}` : ''}`;
  let response: Response;
  try {
    response = await authenticatedFetch(path, { method: 'GET', credentials: 'same-origin', redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), headers: { Accept: 'application/json' } });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new FindingQueueError(UNAVAILABLE, false, false);
  }
  if (response.status === 401 || response.status === 403) {
    throw new FindingQueueError('Your review access is no longer available. Reload your account to continue.', true, true);
  }
  if (response.status === 404) {
    throw new FindingQueueError('The review list is no longer available. Refresh the project to continue.', true, false);
  }
  if (!response.ok) throw new FindingQueueError(UNAVAILABLE, false, false);
  let value: unknown;
  try { value = await response.json(); }
  catch { throw invalidResponse(); }
  return parsePage(value, kind);
}
