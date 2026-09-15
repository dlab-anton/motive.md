import { DEFAULT_PROJECT_SLUG, publicProjectPath } from './project-slug';

export const reviewedArtifactDigestPattern = /^[a-f0-9]{64}$/;
const canonicalUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export type ReviewedArtifactItem = {
  witnessDigest: string;
  submissionId: string;
  agentName: string;
  submittedAt: string;
  review: {
    id: string;
    decision: 'ADMIT';
    reviewedAt: string;
    rationale: string;
  };
};

export type ContributorReviewedArtifactsPage = {
  format: 'motive.contributor-reviewed-artifacts/0.1';
  projectSlug: string;
  contributorId: string;
  items: ReviewedArtifactItem[];
  nextCursor: string | null;
};

function exact(value: object, keys: string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

export async function readContributorReviewedArtifacts(
  contributorId: string,
  after: string | null,
  signal: AbortSignal,
  slug = DEFAULT_PROJECT_SLUG,
): Promise<ContributorReviewedArtifactsPage> {
  const cursor = after ? `?after=${encodeURIComponent(after)}` : '';
  const path = `${publicProjectPath(slug)}/contributors/${encodeURIComponent(contributorId)}/reviewed-artifacts${cursor}`;
  const response = await fetch(path, { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    credentials: 'same-origin', redirect: 'error' });
  if (!response.ok) throw new Error(response.status === 404
    ? 'This contributor’s reviewed artifacts are no longer available. Refresh to check the latest work.'
    : 'Reviewed artifacts could not be loaded. Please try again.');
  const decoded = await response.json().catch(() => null) as unknown;
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)
    || !exact(decoded, ['format', 'projectSlug', 'contributorId', 'items', 'nextCursor'])) {
    throw new Error('The reviewed artifact history could not be read. Please try again.');
  }
  const page = decoded as Record<string, unknown>; const values = page.items;
  const validItems = Array.isArray(values) && values.length <= 20 && values.every((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || !exact(value, ['witnessDigest', 'submissionId', 'agentName', 'submittedAt', 'review'])) return false;
    const item = value as Record<string, unknown>; const review = item.review;
    return typeof item.witnessDigest === 'string' && reviewedArtifactDigestPattern.test(item.witnessDigest)
      && (!after || item.witnessDigest > after)
      && typeof item.submissionId === 'string' && canonicalUuid.test(item.submissionId)
      && typeof item.agentName === 'string' && item.agentName.length > 0
      && typeof item.submittedAt === 'string' && Number.isFinite(Date.parse(item.submittedAt))
      && Boolean(review) && typeof review === 'object' && !Array.isArray(review)
      && exact(review as object, ['id', 'decision', 'reviewedAt', 'rationale'])
      && typeof (review as Record<string, unknown>).id === 'string'
      && canonicalUuid.test((review as Record<string, unknown>).id as string)
      && (review as Record<string, unknown>).decision === 'ADMIT'
      && typeof (review as Record<string, unknown>).reviewedAt === 'string'
      && Number.isFinite(Date.parse((review as Record<string, unknown>).reviewedAt as string))
      && typeof (review as Record<string, unknown>).rationale === 'string'
      && (index === 0 || ((values[index - 1] as Record<string, unknown>).witnessDigest as string)
        < (item.witnessDigest as string));
  });
  const nextCursor = page.nextCursor;
  if (page.format !== 'motive.contributor-reviewed-artifacts/0.1'
    || page.projectSlug !== slug || page.contributorId !== contributorId
    || typeof page.contributorId !== 'string' || !canonicalUuid.test(page.contributorId)
    || !validItems || !(nextCursor === null
      || typeof nextCursor === 'string' && reviewedArtifactDigestPattern.test(nextCursor))
    || (nextCursor !== null
      && nextCursor !== (values as Array<Record<string, unknown>>).at(-1)?.witnessDigest)) {
    throw new Error('The reviewed artifact history could not be read. Please try again.');
  }
  return decoded as ContributorReviewedArtifactsPage;
}
