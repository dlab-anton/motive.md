import { describe, expect, it } from 'vitest';
import {
  CIRCLE_APPROVED_CONTENT_DIGEST,
  CIRCLE_FUNDED_ALLOWED_EFFECTS,
  CIRCLE_FUNDED_WORK_OBJECTIVE,
  isApprovedCircleRevisionBinding,
  isApprovedCircleWorkPurpose,
  positiveProjectRevision,
} from './circle-work-authority.ts';

describe('circle funded-work revision authority', () => {
  it.each([1, 2, '1', '2'])(
    'accepts reviewed content at positive current revision %s',
    revision => {
      expect(isApprovedCircleRevisionBinding({
        currentProjectRevision: revision,
        workProjectRevision: revision,
        termsProjectRevision: revision,
        contentDigest: CIRCLE_APPROVED_CONTENT_DIGEST,
      })).toBe(true);
    },
  );

  it.each([
    { currentProjectRevision: 2, workProjectRevision: 1, termsProjectRevision: 1, contentDigest: CIRCLE_APPROVED_CONTENT_DIGEST },
    { currentProjectRevision: 2, workProjectRevision: 2, termsProjectRevision: 1, contentDigest: CIRCLE_APPROVED_CONTENT_DIGEST },
    { currentProjectRevision: 1, workProjectRevision: 1, termsProjectRevision: 1, contentDigest: `sha256:${'0'.repeat(64)}` },
    { currentProjectRevision: 0, workProjectRevision: 0, termsProjectRevision: 0, contentDigest: CIRCLE_APPROVED_CONTENT_DIGEST },
  ])('rejects stale, mismatched, unapproved, and non-positive bindings', binding => {
    expect(isApprovedCircleRevisionBinding(binding)).toBe(false);
  });

  it.each([0, -1, 1.5, '0', '01', '1.0', '9007199254740992', null, undefined])(
    'rejects non-canonical project revision %s',
    value => expect(positiveProjectRevision(value)).toBeNull(),
  );

  it('binds the prepared objective and allowed effects exactly', () => {
    expect(isApprovedCircleWorkPurpose({
      objective: CIRCLE_FUNDED_WORK_OBJECTIVE,
      allowedEffects: CIRCLE_FUNDED_ALLOWED_EFFECTS,
    })).toBe(true);
    expect(isApprovedCircleWorkPurpose({
      objective: 'Use project funding for an unrelated purpose.',
      allowedEffects: CIRCLE_FUNDED_ALLOWED_EFFECTS,
    })).toBe(false);
    expect(isApprovedCircleWorkPurpose({
      objective: CIRCLE_FUNDED_WORK_OBJECTIVE,
      allowedEffects: [...CIRCLE_FUNDED_ALLOWED_EFFECTS, 'unapproved-effect'],
    })).toBe(false);
  });
});
