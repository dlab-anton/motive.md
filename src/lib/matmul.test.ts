import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  checkMatmulWitness, MATMUL_4X4X4_PROFILE, MATMUL_MAX_ABS_COEFFICIENT, MATMUL_WITNESS_FORMAT,
  type MatmulProfile, type MatmulWitness,
} from './matmul';
import { canonicalWitnessJson, fromPerminovScheme, kroneckerScheme, strassenScheme } from './matmul-schemes';

const upstream = (name: string) => JSON.parse(readFileSync(new URL(`../../fixtures/matmul/upstream/${name}`, import.meta.url), 'utf8')) as unknown;
const profile = (shape: [number, number, number], referenceRank: number): MatmulProfile => ({ ...MATMUL_4X4X4_PROFILE, shape, referenceRank });
const witness = (value: MatmulWitness) => canonicalWitnessJson(value);
const clone = (value: MatmulWitness): MatmulWitness => JSON.parse(JSON.stringify(value)) as MatmulWitness;

describe('exact integer matrix multiplication scheme checker', () => {
  it('accepts Strassen and reports the ternary class against a 2×2×2 profile', () => {
    const result = checkMatmulWitness(witness(strassenScheme()), profile([2, 2, 2], 8));
    expect(result).toEqual({ ok: true, report: {
      format: 'motive.matmul.local-check.v1', valid: true, official: false, shape: [2, 2, 2], ring: 'Z', rank: 7,
      reference_rank: 8, versus_frozen_reference: 'less', coefficient_class: 'ternary', max_abs_coefficient: 1,
      nonzero_entries: { u: 12, v: 12, w: 12 }, tensor_entries_checked: 64,
    } });
  });

  it('accepts Strassen ⊗ Strassen as a 49-product 4×4×4 scheme equal to the frozen reference', () => {
    const result = checkMatmulWitness(witness(kroneckerScheme(strassenScheme(), strassenScheme())));
    expect(result).toMatchObject({ ok: true, report: { shape: [4, 4, 4], rank: 49, reference_rank: 49, versus_frozen_reference: 'equal', coefficient_class: 'ternary', tensor_entries_checked: 4096 } });
  });

  it.each([
    ['alpha_tensor-2x2x2_m7_ZT.json', [2, 2, 2], 7, 'ternary', 1],
    ['a_60_addition-3x3x3_m23_additions60_ZT.json', [3, 3, 3], 23, 'ternary', 1],
    ['results_ZT-4x4x4_m49_ZT.json', [4, 4, 4], 49, 'ternary', 1],
    ['results_ZT-3x3x6_m42_ZT.json', [3, 3, 6], 42, 'ternary', 1],
    ['results_ZT-2x4x5_m33_ZT.json', [2, 4, 5], 33, 'ternary', 1],
    ['alpha_tensor-2x4x5_m33_Z.json', [2, 4, 5], 33, 'integer', 3],
    ['results_ZT-3x6x6_m82_ZT.json', [3, 6, 6], 82, 'ternary', 1],
  ] as const)('verifies the published scheme %s exactly', (name, shape, rank, coefficientClass, maxAbs) => {
    const converted = fromPerminovScheme(upstream(name));
    const result = checkMatmulWitness(witness(converted), profile([...shape], rank));
    expect(result).toMatchObject({ ok: true, report: { shape: [...shape], rank, versus_frozen_reference: 'equal', coefficient_class: coefficientClass, max_abs_coefficient: maxAbs } });
  });

  it('rejects a scheme with one altered coefficient and names the failing tensor entry', () => {
    const altered = clone(kroneckerScheme(strassenScheme(), strassenScheme()));
    altered.w[0][0] = 0;
    const result = checkMatmulWitness(witness(altered));
    expect(result).toMatchObject({ ok: false, error: { code: 'TENSOR_MISMATCH' } });
    expect(result.ok ? '' : result.error.message).toMatch(/A\[1\]\[1\]·B\[1\]\[1\] in C\[1\]\[1\] is 0; expected 1/);
  });

  it('rejects a duplicated row and a deleted row because the tensor no longer matches', () => {
    const reference = kroneckerScheme(strassenScheme(), strassenScheme());
    const duplicated = clone(reference);
    duplicated.u.push([...duplicated.u[0]]); duplicated.v.push([...duplicated.v[0]]); duplicated.w.push([...duplicated.w[0]]); duplicated.rank = 50;
    expect(checkMatmulWitness(witness(duplicated))).toMatchObject({ ok: false, error: { code: 'TENSOR_MISMATCH' } });
    const deleted = clone(reference);
    deleted.u.pop(); deleted.v.pop(); deleted.w.pop(); deleted.rank = 48;
    expect(checkMatmulWitness(witness(deleted))).toMatchObject({ ok: false, error: { code: 'TENSOR_MISMATCH' } });
  });

  it('rejects rational coefficients even when the scheme would be valid over the rationals', () => {
    const reference = kroneckerScheme(strassenScheme(), strassenScheme());
    const scaled = witness(reference).replace('"u":[[1,', '"u":[[2,').replace('"v":[[1,', '"v":[[0.5,');
    expect(checkMatmulWitness(scaled)).toMatchObject({ ok: false, error: { code: 'NONINTEGER_NUMBER' } });
    const text = witness(reference).replace('"u":[[1,', '"u":[["1",');
    expect(checkMatmulWitness(text)).toMatchObject({ ok: false, error: { code: 'NON_INTEGER_ENTRY' } });
  });

  it('rejects a scheme that is only valid in characteristic 2', () => {
    const reference = clone(kroneckerScheme(strassenScheme(), strassenScheme()));
    reference.u[0][0] += 2; // unchanged modulo 2, wrong over the integers
    expect(checkMatmulWitness(witness(reference))).toMatchObject({ ok: false, error: { code: 'TENSOR_MISMATCH' } });
  });

  it('rejects rank and shape inconsistencies, oversized coefficients, empty products and unknown keys', () => {
    const reference = kroneckerScheme(strassenScheme(), strassenScheme());
    expect(checkMatmulWitness(witness({ ...reference, rank: 48 }))).toMatchObject({ ok: false, error: { code: 'RANK_MISMATCH' } });
    expect(checkMatmulWitness(witness({ ...reference, shape: [4, 4, 5] }))).toMatchObject({ ok: false, error: { code: 'WRONG_SHAPE' } });
    expect(checkMatmulWitness(witness(strassenScheme()))).toMatchObject({ ok: false, error: { code: 'WRONG_SHAPE' } });
    const wide = clone(reference); wide.u[0].push(0);
    expect(checkMatmulWitness(witness(wide))).toMatchObject({ ok: false, error: { code: 'MALFORMED_STRUCTURE' } });
    const huge = clone(reference); huge.u[0][0] = MATMUL_MAX_ABS_COEFFICIENT + 1;
    expect(checkMatmulWitness(witness(huge))).toMatchObject({ ok: false, error: { code: 'COEFFICIENT_TOO_LARGE' } });
    const empty = clone(reference); empty.w[3] = empty.w[3].map(() => 0);
    expect(checkMatmulWitness(witness(empty))).toMatchObject({ ok: false, error: { code: 'ZERO_PRODUCT' } });
    expect(checkMatmulWitness(JSON.stringify({ ...reference, multiplications: [] }))).toMatchObject({ ok: false, error: { code: 'MALFORMED_STRUCTURE' } });
    expect(checkMatmulWitness(witness({ ...reference, format: 'motive.csqv.witness.v1' as typeof MATMUL_WITNESS_FORMAT }))).toMatchObject({ ok: false, error: { code: 'WRONG_FORMAT' } });
  });

  it('rejects malformed JSON, exponents, duplicate keys and oversized input', () => {
    const reference = witness(kroneckerScheme(strassenScheme(), strassenScheme()));
    expect(checkMatmulWitness(reference.replace('"rank":49', '"rank":4.9e1'))).toMatchObject({ ok: false, error: { code: 'EXPONENT_NOT_ALLOWED' } });
    expect(checkMatmulWitness(reference.replace('{', '{"rank":49,'))).toMatchObject({ ok: false, error: { code: 'DUPLICATE_KEY' } });
    expect(checkMatmulWitness(reference.replace('{', '{"__proto__":{},'))).toMatchObject({ ok: false, error: { code: 'MALFORMED_STRUCTURE' } });
    expect(checkMatmulWitness('{"format":"motive.matmul.witness.v1",')).toMatchObject({ ok: false, error: { code: 'MALFORMED_JSON' } });
    expect(checkMatmulWitness('')).toMatchObject({ ok: false, error: { code: 'SIZE_LIMIT' } });
    expect(checkMatmulWitness(`${reference}${' '.repeat(MATMUL_4X4X4_PROFILE.maximumBytes)}`)).toMatchObject({ ok: false, error: { code: 'SIZE_LIMIT' } });
  });

  it('reports an improvement only when the rank is strictly below the frozen reference', () => {
    const better = checkMatmulWitness(witness(strassenScheme()), profile([2, 2, 2], 8));
    const equal = checkMatmulWitness(witness(strassenScheme()), profile([2, 2, 2], 7));
    const worse = checkMatmulWitness(witness(strassenScheme()), profile([2, 2, 2], 6));
    expect([better, equal, worse].map(item => item.ok ? item.report.versus_frozen_reference : item.error.code)).toEqual(['less', 'equal', 'greater']);
  });
});
