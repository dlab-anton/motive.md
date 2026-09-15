/**
 * Exact checker for bilinear matrix multiplication schemes over the integers.
 *
 * A witness lists r products. Product p multiplies a linear form in the entries
 * of A (row p of `u`) by a linear form in the entries of B (row p of `v`) and
 * contributes to the entries of C with the coefficients in row p of `w`. The
 * scheme is valid when the sum over all products reconstructs the ⟨a,b,c⟩
 * matrix multiplication tensor exactly. Every coefficient must be an integer,
 * so a valid scheme works over every commutative ring; rational and complex
 * schemes are rejected here by design.
 *
 * Index conventions, verified against seven published schemes on 15 Sep 2026:
 *   u[p][i*b + j]  is the coefficient of A[i][j]   (A is a×b, row-major)
 *   v[p][j*c + k]  is the coefficient of B[j][k]   (B is b×c, row-major)
 *   w[p][k*a + i]  is the coefficient of C[i][k]   (C is a×c, column-major)
 *
 * This file is digest-pinned by the matmul evaluator profile. Do not change it
 * without revising that profile.
 */
import { exactKeys, fail, isJsonObject, StrictJsonParser, WitnessError, type Json } from './strict-json.ts';

export const MATMUL_WITNESS_FORMAT = 'motive.matmul.witness.v1';
export const MATMUL_CHECK_FORMAT = 'motive.matmul.local-check.v1';
export const MATMUL_MAX_BYTES = 256 * 1024;
export const MATMUL_MAX_ABS_COEFFICIENT = 1_000_000;
export const MATMUL_MAX_RANK = 4096;
export const MATMUL_MAX_DIMENSION = 32;

export type MatmulShape = readonly [number, number, number];

export type MatmulProfile = {
  /** ⟨a,b,c⟩: A is a×b, B is b×c. */
  shape: MatmulShape;
  /** Only integer coefficients are checked; the profile records the ring explicitly. */
  ring: 'Z';
  /** The frozen reference rank a valid scheme must beat. */
  referenceRank: number;
  maximumBytes: number;
  maximumAbsCoefficient: number;
};

export const MATMUL_4X4X4_SHAPE: MatmulShape = [4, 4, 4];
export const MATMUL_4X4X4_REFERENCE_RANK = 49;

export const MATMUL_4X4X4_PROFILE: MatmulProfile = Object.freeze({
  shape: MATMUL_4X4X4_SHAPE,
  ring: 'Z',
  referenceRank: MATMUL_4X4X4_REFERENCE_RANK,
  maximumBytes: MATMUL_MAX_BYTES,
  maximumAbsCoefficient: MATMUL_MAX_ABS_COEFFICIENT,
});

export type MatmulWitness = {
  format: typeof MATMUL_WITNESS_FORMAT;
  shape: [number, number, number];
  rank: number;
  u: number[][];
  v: number[][];
  w: number[][];
};

export type MatmulReport = {
  format: typeof MATMUL_CHECK_FORMAT;
  valid: true;
  official: false;
  shape: [number, number, number];
  ring: 'Z';
  rank: number;
  reference_rank: number;
  versus_frozen_reference: 'less' | 'equal' | 'greater';
  coefficient_class: 'ternary' | 'integer';
  max_abs_coefficient: number;
  nonzero_entries: { u: number; v: number; w: number };
  tensor_entries_checked: number;
};

export type MatmulCheck = { ok: true; report: MatmulReport } | {
  ok: false;
  error: { code: string; message: string };
};

function requireShape(value: Json, profile: MatmulProfile): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3 || value.some(item => typeof item !== 'number')) {
    fail('WRONG_SHAPE', 'shape must be an array of three positive integers.');
  }
  const shape = value as number[];
  if (shape.some(item => item < 1 || item > MATMUL_MAX_DIMENSION)) fail('WRONG_SHAPE', `Each dimension must be between 1 and ${MATMUL_MAX_DIMENSION}.`);
  if (shape[0] !== profile.shape[0] || shape[1] !== profile.shape[1] || shape[2] !== profile.shape[2]) {
    fail('WRONG_SHAPE', `shape must be the trusted value [${profile.shape.join(', ')}].`);
  }
  return [shape[0], shape[1], shape[2]];
}

function requireFactor(value: Json, name: 'u' | 'v' | 'w', rank: number, width: number, profile: MatmulProfile): number[][] {
  const rows = Array.isArray(value) ? value : fail('MALFORMED_STRUCTURE', `${name} must be an array with one row per product.`);
  if (rows.length !== rank) fail('RANK_MISMATCH', `${name} must have exactly rank (${rank}) rows; it has ${rows.length}.`);
  return rows.map((row, index) => {
    const entries = Array.isArray(row) ? row : fail('MALFORMED_STRUCTURE', `${name}[${index}] must be an array of ${width} integers.`);
    if (entries.length !== width) fail('MALFORMED_STRUCTURE', `${name}[${index}] must have exactly ${width} entries; it has ${entries.length}.`);
    return entries.map((entry, column) => {
      if (typeof entry !== 'number') fail('NON_INTEGER_ENTRY', `${name}[${index}][${column}] must be a JSON integer.`);
      const coefficient = entry as number;
      if (Math.abs(coefficient) > profile.maximumAbsCoefficient) {
        fail('COEFFICIENT_TOO_LARGE', `${name}[${index}][${column}] exceeds the coefficient limit ${profile.maximumAbsCoefficient}.`);
      }
      return coefficient;
    });
  });
}

function parseWitness(source: string, profile: MatmulProfile): MatmulWitness {
  const value = new StrictJsonParser(source).parse();
  const root = isJsonObject(value) ? value : fail('MALFORMED_STRUCTURE', 'The witness must be a JSON object.');
  exactKeys(root, ['format', 'shape', 'rank', 'u', 'v', 'w'], 'The witness');
  if (root.format !== MATMUL_WITNESS_FORMAT) fail('WRONG_FORMAT', `format must be ${MATMUL_WITNESS_FORMAT}.`);
  const shape = requireShape(root.shape, profile);
  if (typeof root.rank !== 'number' || root.rank < 1 || root.rank > MATMUL_MAX_RANK) fail('RANK_MISMATCH', `rank must be an integer from 1 to ${MATMUL_MAX_RANK}.`);
  const rank = root.rank as number;
  const [a, b, c] = shape;
  return {
    format: MATMUL_WITNESS_FORMAT, shape, rank,
    u: requireFactor(root.u, 'u', rank, a * b, profile),
    v: requireFactor(root.v, 'v', rank, b * c, profile),
    w: requireFactor(root.w, 'w', rank, c * a, profile),
  };
}

function nonzeroIndices(row: number[]): number[] {
  const indices: number[] = [];
  for (let index = 0; index < row.length; index += 1) if (row[index] !== 0) indices.push(index);
  return indices;
}

/**
 * Check a `motive.matmul.witness.v1` document against a profile. Every arithmetic
 * step uses BigInt, so no coefficient size within the limit can overflow.
 */
export function checkMatmulWitness(source: string, profile: MatmulProfile = MATMUL_4X4X4_PROFILE): MatmulCheck {
  try {
    const bytes = new TextEncoder().encode(source).byteLength;
    if (bytes === 0 || bytes > profile.maximumBytes) fail('SIZE_LIMIT', `Witness must be 1–${profile.maximumBytes} UTF-8 bytes.`);
    const witness = parseWitness(source, profile);
    const [a, b, c] = witness.shape;
    const ab = a * b, bc = b * c, ca = c * a;
    // Sparse accumulation: only entries some product touches are stored, so the
    // cost is the arithmetic the scheme itself implies, never the dense tensor.
    const sums = new Map<number, bigint>();
    let maxAbs = 0;
    const nonzero = { u: 0, v: 0, w: 0 };
    for (let product = 0; product < witness.rank; product += 1) {
      const uRow = witness.u[product], vRow = witness.v[product], wRow = witness.w[product];
      const uIdx = nonzeroIndices(uRow), vIdx = nonzeroIndices(vRow), wIdx = nonzeroIndices(wRow);
      if (!uIdx.length || !vIdx.length || !wIdx.length) fail('ZERO_PRODUCT', `Product ${product + 1} contributes nothing; every product must use A, B and C.`);
      nonzero.u += uIdx.length; nonzero.v += vIdx.length; nonzero.w += wIdx.length;
      for (const row of [uRow, vRow, wRow]) for (const entry of row) if (Math.abs(entry) > maxAbs) maxAbs = Math.abs(entry);
      for (const ui of uIdx) {
        const uCoefficient = BigInt(uRow[ui]);
        for (const vi of vIdx) {
          const uv = uCoefficient * BigInt(vRow[vi]);
          const base = (ui * bc + vi) * ca;
          for (const wi of wIdx) {
            const key = base + wi;
            sums.set(key, (sums.get(key) ?? 0n) + uv * BigInt(wRow[wi]));
          }
        }
      }
    }
    const describe = (key: number) => {
      const wi = key % ca, vi = Math.floor(key / ca) % bc, ui = Math.floor(key / (ca * bc));
      const i = Math.floor(ui / b) + 1, j = ui % b + 1, jj = Math.floor(vi / c) + 1, k = vi % c + 1, kk = Math.floor(wi / a) + 1, ii = wi % a + 1;
      return `A[${i}][${j}]·B[${jj}][${k}] in C[${ii}][${kk}]`;
    };
    // Every product A[i][j]·B[j][k] must reach C[i][k] with coefficient exactly 1 ...
    for (let i = 0; i < a; i += 1) for (let j = 0; j < b; j += 1) for (let k = 0; k < c; k += 1) {
      const key = ((i * b + j) * bc + (j * c + k)) * ca + (k * a + i);
      const actual = sums.get(key) ?? 0n;
      if (actual !== 1n) fail('TENSOR_MISMATCH', `Coefficient of ${describe(key)} is ${actual}; expected 1.`);
      sums.delete(key);
    }
    // ... and nothing else may survive the sum.
    for (const [key, actual] of sums) {
      if (actual !== 0n) fail('TENSOR_MISMATCH', `Coefficient of ${describe(key)} is ${actual}; expected 0.`);
    }
    const checked = ab * bc * ca;
    return { ok: true, report: {
      format: MATMUL_CHECK_FORMAT, valid: true, official: false,
      shape: witness.shape, ring: profile.ring, rank: witness.rank,
      reference_rank: profile.referenceRank,
      versus_frozen_reference: witness.rank < profile.referenceRank ? 'less' : witness.rank === profile.referenceRank ? 'equal' : 'greater',
      coefficient_class: maxAbs <= 1 ? 'ternary' : 'integer',
      max_abs_coefficient: maxAbs,
      nonzero_entries: nonzero,
      tensor_entries_checked: checked,
    } };
  } catch (error) {
    if (error instanceof WitnessError) return { ok: false, error: { code: error.code, message: error.message } };
    return { ok: false, error: { code: 'MALFORMED_JSON', message: 'Witness is not valid JSON.' } };
  }
}
