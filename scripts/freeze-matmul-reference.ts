/**
 * Freeze the matmul-4x4x4 reference: Strassen (1969) applied recursively, 49
 * products, integer coefficients. Writes the public witness and its provenance
 * record, cross-checking against an independently published 49-product scheme.
 *
 *   node --import tsx scripts/freeze-matmul-reference.ts
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkMatmulWitness, MATMUL_4X4X4_PROFILE, MATMUL_WITNESS_FORMAT } from '../src/lib/matmul.ts';
import { canonicalWitnessJson, fromPerminovScheme, kroneckerScheme, strassenScheme } from '../src/lib/matmul-schemes.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

const CROSS_CHECK = {
  repository: 'https://github.com/dronperminov/FastMatrixMultiplication',
  commit: 'db560ca5811bc38d5a6d5c0a3ec4315937ceabce',
  path: 'schemes/results/ZT/4x4x4_m49_ZT.json',
  fixture: 'fixtures/matmul/upstream/results_ZT-4x4x4_m49_ZT.json',
  license: 'MIT (LICENSES/FastMatrixMultiplication-MIT.txt)',
};

const reference = kroneckerScheme(strassenScheme(), strassenScheme());
const witness = canonicalWitnessJson(reference);
const checked = checkMatmulWitness(witness, MATMUL_4X4X4_PROFILE);
if (!checked.ok || checked.report.rank !== 49 || checked.report.versus_frozen_reference !== 'equal') {
  throw new Error(`Reference construction failed the exact check: ${JSON.stringify(checked)}`);
}

const crossCheckBytes = await readFile(resolve(root, CROSS_CHECK.fixture));
const crossCheck = checkMatmulWitness(canonicalWitnessJson(fromPerminovScheme(JSON.parse(crossCheckBytes.toString('utf8')))), MATMUL_4X4X4_PROFILE);
if (!crossCheck.ok || crossCheck.report.rank !== 49) throw new Error(`Cross-check scheme failed the exact check: ${JSON.stringify(crossCheck)}`);

const validatorPath = 'src/lib/matmul.ts';
const scriptPath = 'scripts/freeze-matmul-reference.ts';
const witnessSha256 = sha256(witness);
const provenance = {
  format: 'motive.matmul.reference-provenance.v1',
  project: 'matmul-4x4x4',
  shape: [4, 4, 4],
  ring: 'Z',
  frozen_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  attribution: 'Volker Strassen, "Gaussian elimination is not optimal", Numerische Mathematik 13 (1969), applied recursively to 2×2 blocks.',
  construction: {
    method: 'Kronecker product of the 7-product Strassen scheme with itself, built by scripts/freeze-matmul-reference.ts; no upstream bytes are copied into the witness.',
    rank: 49,
    coefficient_class: checked.report.coefficient_class,
  },
  witness: {
    format: MATMUL_WITNESS_FORMAT,
    path: 'public/projects/matmul-4x4x4/reference-witness.json',
    sha256: witnessSha256,
    index_convention: 'u[p][i*b+j] ↔ A[i][j]; v[p][j*c+k] ↔ B[j][k]; w[p][k*a+i] ↔ C[i][k]; verified against seven published schemes on 2026-09-15.',
  },
  cross_check: {
    ...CROSS_CHECK,
    raw_sha256: sha256(crossCheckBytes),
    rank: crossCheck.report.rank,
    coefficient_class: crossCheck.report.coefficient_class,
    result: 'An independently published 49-product integer scheme passes the same exact check; it is not the frozen reference.',
  },
  benchmark_context: {
    ring_note: 'Best known rank depends on the coefficient ring. This project pins integer coefficients.',
    perminov_table: { url: 'https://github.com/dronperminov/FastMatrixMultiplication', pushed_at: '2026-09-05', ternary: 49, integer: 49, rational: 48 },
    lille_digest: { url: 'https://github.com/sedoglavic/fmm_digest', created_at: '2026-09-07', rank: 48, ring: 'not stated' },
    complex_48: { url: 'https://arxiv.org/abs/2506.13131', note: 'AlphaEvolve, June 2025; complex-valued coefficients.' },
    rational_48: { url: 'https://arxiv.org/abs/2506.13242', note: 'Dumas, Pernet, Sedoglavic, June 2025; needs an inverse of 2, so not valid over the integers.' },
    characteristic_2_47: { url: 'https://github.com/google-deepmind/alphatensor', note: 'AlphaTensor, 2022; valid only in characteristic 2.' },
    integer_48: 'No integer-coefficient scheme with 48 products was found in the literature or the catalogues consulted on 2026-09-15.',
  },
  validator: { path: validatorPath, sha256: sha256(await readFile(resolve(root, validatorPath))) },
  freeze_script: { path: scriptPath, sha256: sha256(await readFile(resolve(root, scriptPath))) },
  exact_local_check: {
    rank: checked.report.rank,
    reference_rank: checked.report.reference_rank,
    coefficient_class: checked.report.coefficient_class,
    max_abs_coefficient: checked.report.max_abs_coefficient,
    nonzero_entries: checked.report.nonzero_entries,
    tensor_entries_checked: checked.report.tensor_entries_checked,
    official: false,
  },
};

const outputDirectory = resolve(root, 'public/projects/matmul-4x4x4');
await mkdir(outputDirectory, { recursive: true });
await writeFile(resolve(outputDirectory, 'reference-witness.json'), witness);
await writeFile(resolve(outputDirectory, 'reference-provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
console.log(JSON.stringify({ witness_sha256: witnessSha256, rank: checked.report.rank, cross_check_rank: crossCheck.report.rank, validator_sha256: provenance.validator.sha256 }, null, 2));
