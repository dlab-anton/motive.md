import { describe, expect, it } from 'vitest';
import { isPublicResearchSummary, validatePublicResearchSummary } from './research-summary';

const valid = {
  question: 'Did the tested move improve the retained reference?',
  finding: 'The protected checker found no improvement for this candidate.',
};

describe('public research summary validation', () => {
  it('accepts the exact bounded summary and ordinary Unicode', () => {
    expect(isPublicResearchSummary(valid)).toBe(true);
    expect(validatePublicResearchSummary(valid)).toBe(valid);
    expect(isPublicResearchSummary({ question: '何が変わった？', finding: '検査で改善を確認した。 🧪' })).toBe(true);
  });

  it.each([
    null,
    {},
    { question: valid.question },
    { finding: valid.finding },
    { ...valid, editorial: true },
    { ...valid, question: '' },
    { ...valid, question: ` ${valid.question}` },
    { ...valid, finding: `${valid.finding} ` },
    { ...valid, question: 'q'.repeat(181) },
    { ...valid, finding: 'f'.repeat(321) },
    { ...valid, question: 'two\nparagraphs' },
    { ...valid, finding: 'tab\tseparated' },
    { ...valid, finding: 'line\u2028separator' },
    { ...valid, finding: 'paragraph\u2029separator' },
    { ...valid, finding: 'control\u0085character' },
    { ...valid, finding: 'lone high surrogate \ud800' },
    { ...valid, finding: 'lone low surrogate \udfff' },
  ])('rejects a malformed summary: %j', value => {
    expect(isPublicResearchSummary(value)).toBe(false);
    expect(() => validatePublicResearchSummary(value)).toThrow('Invalid public research summary.');
  });

  it('counts Unicode code points for the published character limits', () => {
    expect(isPublicResearchSummary({ question: '🧪'.repeat(180), finding: valid.finding })).toBe(true);
    expect(isPublicResearchSummary({ question: '🧪'.repeat(181), finding: valid.finding })).toBe(false);
  });

  it('rejects hostile accessors without leaking their error', () => {
    const value = { finding: valid.finding } as Record<string, unknown>;
    Object.defineProperty(value, 'question', { enumerable: true, get: () => { throw new Error('private'); } });
    expect(isPublicResearchSummary(value)).toBe(false);
    expect(() => validatePublicResearchSummary(value)).toThrow('Invalid public research summary.');
  });
});
