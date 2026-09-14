import { describe, expect, it } from 'vitest';
import { COMPARATOR_FACTS_FORMAT, decodeComparatorFacts, MAX_COMPARATOR_FACTS_BYTES } from './facts.ts';

const verified = {
  format: COMPARATOR_FACTS_FORMAT, outcome: 'VERIFIED', current_stage: 'complete', rejection_stage: null,
  protected_build: true, toolchain_and_export: true, exported_terms: true, statement_comparison: true,
  transitive_axioms: true, kernel_replay: true, used_transitive_axioms: ['Classical.choice'],
};
const rejected = { ...verified, outcome: 'REJECTED', current_stage: 'transitive_axioms', rejection_stage: 'transitive_axioms',
  transitive_axioms: false, kernel_replay: false, used_transitive_axioms: null };
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
describe('protected Comparator facts decoding', () => {
  it('preserves actual used axioms and distinguishes an established empty set', () => {
    expect(decodeComparatorFacts(encode(verified)).used_transitive_axioms).toEqual(['Classical.choice']);
    expect(decodeComparatorFacts(encode({ ...verified, used_transitive_axioms: [] })).used_transitive_axioms).toEqual([]);
    expect(decodeComparatorFacts(encode(rejected)).used_transitive_axioms).toBeNull();
  });
  it('refuses candidate logs, acceptance fields, and incompatible formats', () => {
    for (const value of [{ outcome: 'VERIFIED', human_acceptance: 'ACCEPTED' }, { ...verified, human_acceptance: 'PENDING' }, { ...verified, format: 'stock' }]) {
      expect(() => decodeComparatorFacts(encode(value))).toThrow();
    }
    expect(() => decodeComparatorFacts(new TextEncoder().encode('Your solution is okay!'))).toThrow();
  });
  it('refuses verification with unfinished stages, unknown axioms, or invented empty axioms after rejection', () => {
    for (const value of [{ ...verified, kernel_replay: false }, { ...verified, current_stage: 'kernel_replay' },
      { ...verified, used_transitive_axioms: null }, { ...rejected, used_transitive_axioms: [] },
      { ...rejected, rejection_stage: 'kernel_replay' }, { ...verified, used_transitive_axioms: ['a', 'a'] }]) {
      expect(() => decodeComparatorFacts(encode(value))).toThrow();
    }
  });
  it('retains inconclusive kernel interruptions without upgrading them to verified', () => {
    const interrupted = { ...verified, outcome: 'INCONCLUSIVE', current_stage: 'kernel_replay', kernel_replay: false };
    expect(decodeComparatorFacts(encode(interrupted)).outcome).toBe('INCONCLUSIVE');
    expect(() => decodeComparatorFacts(encode({ ...interrupted, kernel_replay: true }))).toThrow();
    expect(() => decodeComparatorFacts(encode({ ...verified, outcome: 'INCONCLUSIVE' }))).toThrow();
  });
  it('bounds the capture and fails on invalid UTF-8 or truncated JSON', () => {
    for (const bytes of [new Uint8Array(), new Uint8Array(MAX_COMPARATOR_FACTS_BYTES + 1), Uint8Array.of(0xff), encode(verified).slice(0, -2)]) {
      expect(() => decodeComparatorFacts(bytes)).toThrow();
    }
  });
});
