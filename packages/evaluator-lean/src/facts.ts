/** Checker facts alone are not a bound assessment or a human decision. Callers
 * must authenticate their protected capture and bind the full reviewed runtime,
 * challenge, policy, and sealed manifest before constructing an assessment. */
export const COMPARATOR_FACTS_FORMAT = 'motive.comparator-facts/0.1' as const;
export const MAX_COMPARATOR_FACTS_BYTES = 128 * 1024;
export const FACT_CHECKS = ['protected_build', 'toolchain_and_export', 'exported_terms',
  'statement_comparison', 'transitive_axioms', 'kernel_replay'] as const;
type FactCheck = typeof FACT_CHECKS[number];
const completedBeforeStage = {
  startup: 0, challenge_build: 0, challenge_export: 0, solution_build: 0,
  solution_export: 1, exported_terms: 2, statement_comparison: 3,
  transitive_axioms: 4, kernel_replay: 5, complete: 6,
} as const;
type FactStage = keyof typeof completedBeforeStage;
type RejectionStage = 'statement_comparison' | 'transitive_axioms' | 'kernel_replay';
export type ComparatorFacts = Record<FactCheck, boolean> & {
  format: typeof COMPARATOR_FACTS_FORMAT;
  outcome: 'VERIFIED' | 'REJECTED' | 'INCONCLUSIVE';
  current_stage: FactStage;
  rejection_stage: RejectionStage | null;
  used_transitive_axioms: string[] | null;
};

function invalid(message: string): never { throw new Error(`Invalid Comparator facts: ${message}`); }

/** Decode bounded, strictly typed facts. No logs, exit codes, or acceptance
 * assertions are accepted as inputs. A malformed capture remains unavailable. */
export function decodeComparatorFacts(bytes: Uint8Array): ComparatorFacts {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_COMPARATOR_FACTS_BYTES) invalid('byte limit');
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { invalid('UTF-8 or JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('object required');
  const facts = value as Record<string, unknown>;
  const keys = ['format', 'outcome', 'current_stage', 'rejection_stage', 'used_transitive_axioms', ...FACT_CHECKS];
  if (Object.keys(facts).length !== keys.length || !keys.every(key => Object.hasOwn(facts, key))) invalid('fields');
  if (facts.format !== COMPARATOR_FACTS_FORMAT) invalid('format');
  if (!['VERIFIED', 'REJECTED', 'INCONCLUSIVE'].includes(facts.outcome as string)) invalid('outcome');
  if (typeof facts.current_stage !== 'string' || !Object.hasOwn(completedBeforeStage, facts.current_stage)) invalid('stage');
  const stage = facts.current_stage as FactStage;
  const completed = completedBeforeStage[stage];
  FACT_CHECKS.forEach((check, index) => {
    if (facts[check] !== (index < completed)) invalid(`stage/check mismatch: ${check}`);
  });
  if (facts.outcome === 'VERIFIED') {
    if (stage !== 'complete' || facts.rejection_stage !== null) invalid('verification incomplete');
  } else if (facts.outcome === 'REJECTED') {
    if (!['statement_comparison', 'transitive_axioms', 'kernel_replay'].includes(stage) || facts.rejection_stage !== stage) invalid('rejection stage');
  } else if (stage === 'complete' || facts.rejection_stage !== null) invalid('inconclusive stage');
  const axioms = facts.used_transitive_axioms;
  if (facts.transitive_axioms) {
    if (!Array.isArray(axioms) || axioms.length > 4096 || axioms.some(name => typeof name !== 'string' || name.length === 0 || name.length > 1024 || /[\u0000-\u001f\u007f]/u.test(name))) invalid('axiom set');
    if (new Set(axioms).size !== axioms.length) invalid('duplicate axiom');
    // Lean sorts Unicode scalar values; JavaScript's default UTF-16 comparison
    // differs for astral characters, so do not silently require that ordering.
  } else if (axioms !== null) invalid('unknown axiom set must be null');
  return facts as ComparatorFacts;
}
