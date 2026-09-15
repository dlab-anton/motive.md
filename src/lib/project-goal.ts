import type { ParticipationPublicProjection, SubmissionSummary } from './participation';

function scoreUnits(score: string | null): bigint | null {
  if (!score || score.length > 32 || !/^\d+(?:\.\d{1,18})?$/.test(score)) return null;
  const [whole, fraction = ''] = score.split('.');
  return BigInt(whole!) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
}

/** Keep a new, stronger candidate visible without erasing an already reviewed goal. */
export function pendingImprovement(outcome: ParticipationPublicProjection['challengeOutcome'], bestChecked?: SubmissionSummary | null) {
  if (outcome?.status === 'AWAITING_REVIEW') return outcome.candidate;
  if (outcome?.status !== 'VERIFIED' || !outcome.candidate || bestChecked?.reportStatus !== 'VALID'
    || bestChecked.exceedsReference !== true) return null;
  const reviewedScore = scoreUnits(outcome.candidate.exactScore);
  const pendingScore = scoreUnits(bestChecked.exactScore);
  return reviewedScore !== null && pendingScore !== null && pendingScore > reviewedScore ? bestChecked : null;
}
