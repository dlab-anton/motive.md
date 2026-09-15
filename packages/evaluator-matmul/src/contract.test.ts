import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Digest } from '../../domain/src/contracts.ts';
import { checkMatmulWitness } from '../../../src/lib/matmul.ts';
import {
  MATMUL_4X4X4_EVALUATOR_PROFILE,
  MATMUL_4X4X4_EVALUATOR_PROFILE_DIGEST,
  MATMUL_4X4X4_REFERENCE_WITNESS_DIGEST,
  MATMUL_CHECKER_SOURCE_DIGEST,
  MatmulEvaluatorError,
  matmulByteDigest,
  requireMatmulEvaluatorProfile,
} from './contract.ts';

const digestOf = (path: string): Digest => `sha256:${createHash('sha256').update(readFileSync(new URL(path, import.meta.url))).digest('hex')}`;

describe('matmul evaluator profile', () => {
  it('pins the checker source that is on disk', () => {
    expect(digestOf('../../../src/lib/matmul.ts')).toBe(MATMUL_CHECKER_SOURCE_DIGEST);
  });

  it('pins the published frozen reference and that reference passes the pinned checker at rank 49', () => {
    const bytes = readFileSync(new URL('../../../public/projects/matmul-4x4x4/reference-witness.json', import.meta.url));
    expect(matmulByteDigest(bytes)).toBe(MATMUL_4X4X4_REFERENCE_WITNESS_DIGEST);
    expect(checkMatmulWitness(bytes.toString('utf8'))).toMatchObject({ ok: true, report: { rank: 49, versus_frozen_reference: 'equal', coefficient_class: 'ternary' } });
    const provenance = JSON.parse(readFileSync(new URL('../../../public/projects/matmul-4x4x4/reference-provenance.json', import.meta.url), 'utf8')) as { witness: { sha256: string }; validator: { sha256: string } };
    expect(`sha256:${provenance.witness.sha256}`).toBe(MATMUL_4X4X4_REFERENCE_WITNESS_DIGEST);
    expect(`sha256:${provenance.validator.sha256}`).toBe(MATMUL_CHECKER_SOURCE_DIGEST);
  });

  it('accepts only the exact reviewed profile', () => {
    expect(requireMatmulEvaluatorProfile(JSON.parse(JSON.stringify(MATMUL_4X4X4_EVALUATOR_PROFILE)), MATMUL_4X4X4_EVALUATOR_PROFILE_DIGEST)).toBe(MATMUL_4X4X4_EVALUATOR_PROFILE);
    const altered = { ...MATMUL_4X4X4_EVALUATOR_PROFILE, reference: { ...MATMUL_4X4X4_EVALUATOR_PROFILE.reference, exact_objective: '48' } };
    expect(() => requireMatmulEvaluatorProfile(altered, MATMUL_4X4X4_EVALUATOR_PROFILE_DIGEST)).toThrow(MatmulEvaluatorError);
    expect(() => requireMatmulEvaluatorProfile(MATMUL_4X4X4_EVALUATOR_PROFILE, 'sha256:0000000000000000000000000000000000000000000000000000000000000000')).toThrow(/does not match/);
  });
});
