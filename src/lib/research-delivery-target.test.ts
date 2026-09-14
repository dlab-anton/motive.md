import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { researchDeliveryTargetSelectionsEqual, validateResearchDeliveryTargetBinding,
  validateResearchDeliveryTargetSelection } from './research-delivery-target';

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;
const selection = () => ({ mode: 'APPEND_EXISTING' as const, scopeId: randomUUID(), snapshotId: randomUUID(),
  snapshotDigest: digest('a'), hypothesisId: randomUUID(), observedUpdatedAt: '2026-09-13T00:00:00.000Z' });

describe('research delivery target', () => {
  it('accepts only the exact six-field canonical retained selection', () => {
    const value = selection();
    expect(validateResearchDeliveryTargetSelection(value)).toEqual(value);
    for (const invalid of [
      { ...value, mode: 'NEW_DRAFT' },
      { ...value, scopeId: value.scopeId.toUpperCase() },
      { ...value, snapshotDigest: digest('A') },
      { ...value, observedUpdatedAt: 'not-a-time' },
      { ...value, extra: true },
    ]) expect(() => validateResearchDeliveryTargetSelection(invalid)).toThrow(TypeError);
  });

  it('validates server bindings and compares selections by all immutable fields', () => {
    const value = selection();
    const binding = { format: 'motive.research-delivery-target/0.1' as const, selection: value,
      channelId: randomUUID(), scopeConfigurationDigest: digest('b'), hypothesisContentDigest: digest('c'),
      statementDigest: digest('d') };
    expect(validateResearchDeliveryTargetBinding(binding)).toEqual(binding);
    expect(researchDeliveryTargetSelectionsEqual(value, { ...value })).toBe(true);
    expect(researchDeliveryTargetSelectionsEqual(value, { ...value, observedUpdatedAt: '2026-09-13T00:00:01.000Z' })).toBe(false);
    expect(() => validateResearchDeliveryTargetBinding({ ...binding, statementDigest: digest('D') })).toThrow(TypeError);
  });
});
