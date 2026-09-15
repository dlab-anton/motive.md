import { describe, expect, it } from 'vitest';
import { checkMatmulWitness } from './matmul';
import { canonicalWitnessJson, describeScheme, fromPerminovScheme, kroneckerScheme, strassenScheme } from './matmul-schemes';

describe('matrix multiplication scheme constructions', () => {
  it('renders Strassen in the classical readable form', () => {
    const { products, outputs } = describeScheme(strassenScheme());
    expect(products).toEqual([
      'm1 = (a11 + a22) * (b11 + b22)',
      'm2 = (a21 + a22) * (b11)',
      'm3 = (a11) * (b12 - b22)',
      'm4 = (a22) * (-b11 + b21)',
      'm5 = (a11 + a12) * (b22)',
      'm6 = (-a11 + a21) * (b11 + b12)',
      'm7 = (a12 - a22) * (b21 + b22)',
    ]);
    expect(outputs).toEqual(['c11 = m1 + m4 - m5 + m7', 'c12 = m3 + m5', 'c21 = m2 + m4', 'c22 = m1 - m2 + m3 + m6']);
  });

  it('builds valid Kronecker products in both orders and for rectangular shapes', () => {
    const square = kroneckerScheme(strassenScheme(), strassenScheme());
    expect(square.shape).toEqual([4, 4, 4]);
    expect(checkMatmulWitness(canonicalWitnessJson(square))).toMatchObject({ ok: true, report: { rank: 49 } });
    const naive: ReturnType<typeof strassenScheme> = { format: 'motive.matmul.witness.v1', shape: [1, 2, 1], rank: 2, u: [[1, 0], [0, 1]], v: [[1, 0], [0, 1]], w: [[1], [1]] };
    const rectangular = kroneckerScheme(strassenScheme(), naive);
    expect(rectangular.shape).toEqual([2, 4, 2]);
    expect(checkMatmulWitness(canonicalWitnessJson(rectangular), { shape: [2, 4, 2], ring: 'Z', referenceRank: 16, maximumBytes: 262144, maximumAbsCoefficient: 1000000 })).toMatchObject({ ok: true, report: { rank: 14 } });
    const flipped = kroneckerScheme(naive, strassenScheme());
    expect(checkMatmulWitness(canonicalWitnessJson(flipped), { shape: [2, 4, 2], ring: 'Z', referenceRank: 16, maximumBytes: 262144, maximumAbsCoefficient: 1000000 })).toMatchObject({ ok: true, report: { rank: 14 } });
  });

  it('converts the upstream layout and rejects structurally wrong input', () => {
    const converted = fromPerminovScheme({ n: [2, 2, 2], m: 7, z2: false, ...strassenScheme() });
    expect(converted).toEqual(strassenScheme());
    expect(() => fromPerminovScheme({ n: [2, 2], m: 7 })).toThrow(/n = \[a, b, c\]/);
    expect(() => fromPerminovScheme({ n: [2, 2, 2], m: '7' })).toThrow(/integer m/);
    expect(() => fromPerminovScheme({ n: [2, 2, 2], m: 7, u: [[1, 'x']], v: [], w: [] })).toThrow(/u must be a matrix/);
  });

  it('serializes with a fixed key order and no whitespace', () => {
    expect(canonicalWitnessJson(strassenScheme()).startsWith('{"format":"motive.matmul.witness.v1","shape":[2,2,2],"rank":7,"u":[[1,0,0,1],')).toBe(true);
  });
});
