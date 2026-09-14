export type PublicResearchSummary = {
  question: string;
  finding: string;
};

const DISALLOWED_TEXT = /[\u0000-\u001f\u007f-\u009f\ud800-\udfff\u2028\u2029]/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSummaryText(value: unknown, maximum: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.trim() === value
    && [...value].length <= maximum
    && !DISALLOWED_TEXT.test(value);
}

export function isPublicResearchSummary(value: unknown): value is PublicResearchSummary {
  try {
    return isRecord(value)
      && Object.keys(value).length === 2
      && Object.hasOwn(value, 'question')
      && Object.hasOwn(value, 'finding')
      && isSummaryText(value.question, 180)
      && isSummaryText(value.finding, 320);
  } catch {
    return false;
  }
}

export function validatePublicResearchSummary(value: unknown): PublicResearchSummary {
  if (!isPublicResearchSummary(value)) throw new Error('Invalid public research summary.');
  return value;
}
