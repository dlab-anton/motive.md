export const CIRCLE_PROJECT_SLUG = 'circle-packing';
export const CIRCLE_APPROVED_CONTENT_DIGEST = 'sha256:c1fceddadef50b71b873f04bf666e2f91c6ff598dceb5dd3dc081b2e3e710246';
export const CIRCLE_FUNDED_WORK_ORDER_KEY = 'circle-packing-funded-astra';
export const CIRCLE_FUNDED_WORK_ORDER_REVISION = 1;
export const CIRCLE_PROJECT_LEAD_ACTOR_ID = 'operator:seed';
export const CIRCLE_FUNDED_MODEL = 'openai/gpt-6-astra';
export const CIRCLE_REFERENCE_SCORE = '5.29109518547430697';
export const CIRCLE_FUNDED_WORK_OBJECTIVE =
  `Produce and submit an exactly checked N=101 circle-packing witness whose radius sum exceeds ${CIRCLE_REFERENCE_SCORE}.`;
export const CIRCLE_FUNDED_ALLOWED_EFFECTS = [
  'read-approved-inputs',
  'write-isolated-workspace',
  'submit-data-only-witness',
] as const;

export function positiveProjectRevision(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function isApprovedCircleRevisionBinding(input: {
  currentProjectRevision: unknown;
  workProjectRevision: unknown;
  termsProjectRevision: unknown;
  contentDigest: unknown;
}): boolean {
  const current = positiveProjectRevision(input.currentProjectRevision);
  const work = positiveProjectRevision(input.workProjectRevision);
  const terms = positiveProjectRevision(input.termsProjectRevision);
  return current !== null
    && current === work
    && current === terms
    && input.contentDigest === CIRCLE_APPROVED_CONTENT_DIGEST;
}

export function isApprovedCircleWorkPurpose(input: {
  objective: unknown;
  allowedEffects: readonly unknown[];
}): boolean {
  return input.objective === CIRCLE_FUNDED_WORK_OBJECTIVE
    && input.allowedEffects.length === CIRCLE_FUNDED_ALLOWED_EFFECTS.length
    && input.allowedEffects.every((effect, index) => effect === CIRCLE_FUNDED_ALLOWED_EFFECTS[index]);
}
