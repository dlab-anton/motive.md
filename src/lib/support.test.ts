import { describe, expect, it } from 'vitest';
import { emptyState, restoreState, supportReducer } from './support';

describe('public project following', () => {
  it('follows and unfollows the one real public project idempotently', () => {
    const followed = supportReducer(emptyState, { type: 'follow', goal: 'circle-packing', following: true });
    expect(followed).toEqual({ following: ['circle-packing'] });
    expect(supportReducer(followed, { type: 'follow', goal: 'circle-packing', following: true })).toBe(followed);
    expect(supportReducer(followed, { type: 'follow', goal: 'circle-packing', following: false })).toEqual(emptyState);
  });

  it('restores only current project follows and drops legacy synthetic money data', () => {
    expect(restoreState({ following: ['circle-packing', 'math', 'circle-packing'], allocations: { math: { tokens: 10000 } }, credits: [{ amount: 50000 }] }))
      .toEqual({ following: ['circle-packing'] });
    expect(restoreState({ allocations: { 'circle-packing': { tokens: 10000 } } })).toEqual(emptyState);
  });

  it('rejects unknown project ids without changing state', () => {
    expect(supportReducer(emptyState, { type: 'follow', goal: 'placeholder', following: true })).toBe(emptyState);
  });
});
