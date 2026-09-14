import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SubmissionInvestigationInput } from '../../src/lib/participation.ts';
import { validateInvestigation } from './service.ts';

function valid(): SubmissionInvestigationInput {
  return {
    format: 'motive.investigation.v1',
    proposal: 'Try one bounded move.',
    expectation: 'The exact score may change.',
    conditions: ['Keep N=101.'],
    observations: ['The protected checker ran.'],
    assessment: 'The result is evidence for this move only.',
    nextAction: 'Try the next bounded move.',
  };
}

describe('participation investigation validation', () => {
  it('identifies an oversized condition without reflecting submitted content', () => {
    const secret = `private-marker-${'x'.repeat(686)}`;
    expect(() => validateInvestigation({ ...valid(), conditions: [secret] }))
      .toThrow('investigation.conditions[0] must be nonblank, trimmed text of at most 500 characters.');
    try { validateInvestigation({ ...valid(), conditions: [secret] }); }
    catch (error) { expect(String(error)).not.toContain('private-marker'); }
  });

  it.each([
    ['proposal', { proposal: 'x'.repeat(2001) }, 'investigation.proposal must be nonblank, trimmed text of at most 2000 characters.'],
    ['expectation', { expectation: ' ' }, 'investigation.expectation must be nonblank, trimmed text of at most 1000 characters.'],
    ['conditions count', { conditions: [] }, 'investigation.conditions must contain 1–12 text items.'],
    ['observations item', { observations: ['x'.repeat(1001)] }, 'investigation.observations[0] must be nonblank, trimmed text of at most 1000 characters.'],
    ['observations count', { observations: Array.from({ length: 21 }, () => 'bounded') }, 'investigation.observations must contain 1–20 text items.'],
    ['assessment', { assessment: 'x'.repeat(2001) }, 'investigation.assessment must be nonblank, trimmed text of at most 2000 characters.'],
    ['nextAction', { nextAction: '\nnext' }, 'investigation.nextAction must be nonblank, trimmed text of at most 1000 characters.'],
  ])('reports the failing %s bound', (_name, change, message) => {
    expect(() => validateInvestigation({ ...valid(), ...change })).toThrow(message);
  });

  it('reports the whole-record UTF-8 byte bound after field bounds pass', () => {
    const oversized = { ...valid(), observations: Array.from({ length: 20 }, () => 'x'.repeat(900)) };
    expect(() => validateInvestigation(oversized))
      .toThrow('investigation must be at most 16384 UTF-8 bytes as JSON.');
  });

  it('identifies bounded research-reference fields', () => {
    const reference = { scopeId: randomUUID(), snapshotId: randomUUID(), snapshotDigest: `sha256:${'a'.repeat(64)}`,
      hypothesisId: randomUUID(), observedUpdatedAt: new Date().toISOString(), evidenceIds: Array.from({ length: 21 }, () => randomUUID()) };
    expect(() => validateInvestigation({ ...valid(), researchReferences: [reference] }))
      .toThrow('investigation.researchReferences[0].evidenceIds must contain at most 20 unique UUIDs.');
  });
});
