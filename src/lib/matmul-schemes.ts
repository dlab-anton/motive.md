/**
 * Constructions and conversions for matrix multiplication schemes. Kept apart
 * from the digest-pinned checker in `matmul.ts`; nothing here is trusted by an
 * evaluator, everything here is re-checked by `checkMatmulWitness`.
 */
import { MATMUL_WITNESS_FORMAT, type MatmulWitness } from './matmul.ts';

/**
 * Strassen (1969): 2×2 by 2×2 in 7 products. Rows follow the checker's index
 * conventions: u by A[i][j] as i*2+j, v by B[j][k] as j*2+k, w by C[i][k] as k*2+i.
 */
export function strassenScheme(): MatmulWitness {
  return {
    format: MATMUL_WITNESS_FORMAT, shape: [2, 2, 2], rank: 7,
    u: [[1, 0, 0, 1], [0, 0, 1, 1], [1, 0, 0, 0], [0, 0, 0, 1], [1, 1, 0, 0], [-1, 0, 1, 0], [0, 1, 0, -1]],
    v: [[1, 0, 0, 1], [1, 0, 0, 0], [0, 1, 0, -1], [-1, 0, 1, 0], [0, 0, 0, 1], [1, 1, 0, 0], [0, 0, 1, 1]],
    w: [[1, 0, 0, 1], [0, 1, 0, -1], [0, 0, 1, 1], [1, 1, 0, 0], [-1, 0, 1, 0], [0, 0, 0, 1], [1, 0, 0, 0]],
  };
}

/**
 * Tensor (Kronecker) product of two schemes: ⟨a1,b1,c1⟩ ⊗ ⟨a2,b2,c2⟩ gives
 * ⟨a1·a2, b1·b2, c1·c2⟩ with rank r1·r2, by treating the large matrices as
 * a1×b1 blocks of a2×b2 entries and applying the outer scheme to blocks.
 */
export function kroneckerScheme(outer: MatmulWitness, inner: MatmulWitness): MatmulWitness {
  const [a1, b1, c1] = outer.shape, [a2, b2, c2] = inner.shape;
  const a = a1 * a2, b = b1 * b2, c = c1 * c2;
  const u: number[][] = [], v: number[][] = [], w: number[][] = [];
  for (let p1 = 0; p1 < outer.rank; p1 += 1) for (let p2 = 0; p2 < inner.rank; p2 += 1) {
    const uRow = new Array<number>(a * b).fill(0), vRow = new Array<number>(b * c).fill(0), wRow = new Array<number>(c * a).fill(0);
    for (let i1 = 0; i1 < a1; i1 += 1) for (let j1 = 0; j1 < b1; j1 += 1) for (let i2 = 0; i2 < a2; i2 += 1) for (let j2 = 0; j2 < b2; j2 += 1) {
      uRow[(i1 * a2 + i2) * b + (j1 * b2 + j2)] = outer.u[p1][i1 * b1 + j1] * inner.u[p2][i2 * b2 + j2];
    }
    for (let j1 = 0; j1 < b1; j1 += 1) for (let k1 = 0; k1 < c1; k1 += 1) for (let j2 = 0; j2 < b2; j2 += 1) for (let k2 = 0; k2 < c2; k2 += 1) {
      vRow[(j1 * b2 + j2) * c + (k1 * c2 + k2)] = outer.v[p1][j1 * c1 + k1] * inner.v[p2][j2 * c2 + k2];
    }
    for (let k1 = 0; k1 < c1; k1 += 1) for (let i1 = 0; i1 < a1; i1 += 1) for (let k2 = 0; k2 < c2; k2 += 1) for (let i2 = 0; i2 < a2; i2 += 1) {
      wRow[(k1 * c2 + k2) * a + (i1 * a2 + i2)] = outer.w[p1][k1 * a1 + i1] * inner.w[p2][k2 * a2 + i2];
    }
    u.push(uRow); v.push(vRow); w.push(wRow);
  }
  return { format: MATMUL_WITNESS_FORMAT, shape: [a, b, c], rank: outer.rank * inner.rank, u, v, w };
}

/**
 * Convert a scheme in the JSON layout used by dronperminov/FastMatrixMultiplication
 * (`n`, `m`, `u`, `v`, `w`, plus derived fields) into a Motive witness. Only the
 * five structural fields are read; the result must still pass the checker.
 */
export function fromPerminovScheme(value: unknown): MatmulWitness {
  const record = value as { n?: unknown; m?: unknown; u?: unknown; v?: unknown; w?: unknown };
  const n = record.n;
  if (!Array.isArray(n) || n.length !== 3 || n.some(item => typeof item !== 'number')) throw new Error('Upstream scheme must have n = [a, b, c].');
  if (typeof record.m !== 'number') throw new Error('Upstream scheme must have an integer m.');
  const factor = (name: 'u' | 'v' | 'w') => {
    const rows = record[name];
    if (!Array.isArray(rows) || rows.some(row => !Array.isArray(row) || row.some(entry => typeof entry !== 'number'))) throw new Error(`Upstream scheme ${name} must be a matrix of numbers.`);
    return (rows as number[][]).map(row => [...row]);
  };
  return { format: MATMUL_WITNESS_FORMAT, shape: [n[0] as number, n[1] as number, n[2] as number], rank: record.m, u: factor('u'), v: factor('v'), w: factor('w') };
}

/** Compact canonical serialization: fixed key order, no whitespace. */
export function canonicalWitnessJson(witness: MatmulWitness): string {
  return JSON.stringify({ format: witness.format, shape: witness.shape, rank: witness.rank, u: witness.u, v: witness.v, w: witness.w });
}

function term(coefficient: number, name: string, first: boolean): string {
  const sign = coefficient < 0 ? '-' : first ? '' : '+';
  const magnitude = Math.abs(coefficient);
  const scaled = magnitude === 1 ? name : `${magnitude}·${name}`;
  return first ? `${sign}${scaled}` : ` ${sign} ${scaled}`;
}

function linearForm(row: number[], name: (index: number) => string): string {
  let text = '';
  let first = true;
  for (let index = 0; index < row.length; index += 1) {
    if (row[index] === 0) continue;
    text += term(row[index], name(index), first);
    first = false;
  }
  return text;
}

/**
 * Readable rendering of a scheme: each product as `m1 = (a11 + a22) * (b11 + b22)`
 * and each output entry as `c11 = m1 + m4 - m5 + m7`. Indices are 1-based.
 */
export function describeScheme(witness: MatmulWitness): { products: string[]; outputs: string[] } {
  const [a, b, c] = witness.shape;
  const products = witness.u.map((uRow, p) => {
    const left = linearForm(uRow, index => `a${Math.floor(index / b) + 1}${index % b + 1}`);
    const right = linearForm(witness.v[p], index => `b${Math.floor(index / c) + 1}${index % c + 1}`);
    return `m${p + 1} = (${left}) * (${right})`;
  });
  const outputs: string[] = [];
  for (let i = 0; i < a; i += 1) for (let k = 0; k < c; k += 1) {
    const column = k * a + i;
    const combination = linearForm(witness.w.map(row => row[column]), index => `m${index + 1}`);
    outputs.push(`c${i + 1}${k + 1} = ${combination || '0'}`);
  }
  return { products, outputs };
}
