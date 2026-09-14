import { describe, expect, it } from 'vitest';
import { parseHostedInvestigation } from './learning.ts';

const valid = { format: 'motive.investigation.v1', proposal: 'Try a bounded change.', expectation: 'The score may improve.',
  conditions: ['Use the frozen checker.'], observations: ['Geometry remained feasible.'], assessment: 'Promising 🔎',
  nextAction: 'Test again.' };

describe('hosted investigation validation', () => {
  it('accepts bounded Unicode including a valid surrogate pair', () => {
    expect(parseHostedInvestigation(Buffer.from(JSON.stringify(valid)))).toMatchObject({ assessment: 'Promising 🔎' });
  });

  it.each([
    ['UTF-8 BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(valid))])],
    ['duplicate key', Buffer.from(JSON.stringify(valid).replace('"proposal":', '"proposal":"first","proposal":'))],
    ['escaped NUL', Buffer.from(JSON.stringify({ ...valid, proposal: '\u0000' }))],
    ['lone surrogate', Buffer.from(JSON.stringify(valid).replace('Try a bounded change.', '\\ud800'))],
    ['unknown field', Buffer.from(JSON.stringify({ ...valid, secret: 'private' }))],
  ])('rejects %s without exposing worker text', (_label, bytes) => {
    expect(parseHostedInvestigation(bytes)).toBeNull();
  });
});
