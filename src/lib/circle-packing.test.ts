import { describe, expect, it } from 'vitest';
import { checkCirclePackingWitness, CSQV_MAX_BYTES, CSQV_WITNESS_FORMAT } from './circle-packing';

function decimal(hundredths: number) { return `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, '0')}`; }
function circles() {
  return Array.from({ length: 101 }, (_, index) => ({
    x: decimal(5 + (index % 11) * 9),
    y: decimal(5 + Math.floor(index / 11) * 10),
    r: '0.01',
  }));
}
function witness(value = circles(), n = 101) { return JSON.stringify({ format: CSQV_WITNESS_FORMAT, n, circles: value }); }

describe('exact CSQV witness checker', () => {
  it('reports exact objective and distinct boundary and squared-pair slack units', () => {
    const result = checkCirclePackingWitness(witness());
    expect(result).toEqual({ ok: true, report: {
      format: 'motive.csqv.local-check.v1', valid: true, official: false, n: 101, decimal_places: 2, scale: '100',
      objective: { units: '101', exact_decimal: '1.01', versus_frozen_reference_5_29109518547430697: 'less', versus_paper_printed_5_289154: 'less' },
      minimum_boundary_slack: { units: '4', exact_decimal: '0.04', circle: 1 },
      minimum_squared_pair_slack: { squared_units: '77', exact_decimal: '0.0077', circles: [1, 2] },
    } });
  });

  it('accepts exact tangency and rejects an overlap of one 10^-18 unit without repair', () => {
    const tangent = circles();
    tangent[1] = { x: '0.07', y: '0.05', r: '0.01' };
    expect(checkCirclePackingWitness(witness(tangent)).ok).toBe(true);
    tangent[1].x = '0.069999999999999999';
    expect(checkCirclePackingWitness(witness(tangent))).toMatchObject({ ok: false, error: { code: 'OVERLAP' } });
  });

  it('rejects wrong N, exponent strings, nonfinite tokens and unknown structure', () => {
    expect(checkCirclePackingWitness(witness(circles(), 102))).toMatchObject({ ok: false, error: { code: 'WRONG_N' } });
    expect(checkCirclePackingWitness(witness().replace('"n":101', '"n":101.000000000000000001'))).toMatchObject({ ok: false, error: { code: 'NONINTEGER_NUMBER' } });
    const exponent = circles(); exponent[0].x = '5e-2';
    expect(checkCirclePackingWitness(witness(exponent))).toMatchObject({ ok: false, error: { code: 'INVALID_DECIMAL' } });
    expect(checkCirclePackingWitness('{"format":"motive.csqv.witness.v1","n":NaN,"circles":[]}')).toMatchObject({ ok: false, error: { code: 'MALFORMED_JSON' } });
    expect(checkCirclePackingWitness(JSON.stringify({ format: CSQV_WITNESS_FORMAT, n: 101, circles: circles(), note: 'unknown' }))).toMatchObject({ ok: false, error: { code: 'MALFORMED_STRUCTURE' } });
    expect(checkCirclePackingWitness(witness().replace('{', '{"__proto__":{},'))).toMatchObject({ ok: false, error: { code: 'MALFORMED_STRUCTURE' } });
    expect(checkCirclePackingWitness(`\u00a0${witness()}`)).toMatchObject({ ok: false, error: { code: 'MALFORMED_JSON' } });
  });

  it('detects duplicate decoded keys, including escaped spellings', () => {
    const body = witness();
    expect(checkCirclePackingWitness(body.replace('"n":101', '"n":101,"\\u006e":101'))).toMatchObject({ ok: false, error: { code: 'DUPLICATE_KEY' } });
    expect(checkCirclePackingWitness(body.replace('"x":"0.05"', '"x":"0.05","\\u0078":"0.05"'))).toMatchObject({ ok: false, error: { code: 'DUPLICATE_KEY' } });
  });

  it('enforces positive radii, exact boundary, precision, byte and depth bounds', () => {
    const zero = circles(); zero[0].r = '0';
    expect(checkCirclePackingWitness(witness(zero))).toMatchObject({ ok: false, error: { code: 'NONPOSITIVE_RADIUS' } });
    const boundary = circles(); boundary[0].x = '0.009999999999999999';
    expect(checkCirclePackingWitness(witness(boundary))).toMatchObject({ ok: false, error: { code: 'OUT_OF_BOUNDS' } });
    const precision = circles(); precision[0].x = '0.0500000000000000000';
    expect(checkCirclePackingWitness(witness(precision))).toMatchObject({ ok: false, error: { code: 'INVALID_DECIMAL' } });
    expect(checkCirclePackingWitness(' '.repeat(CSQV_MAX_BYTES + 1))).toMatchObject({ ok: false, error: { code: 'SIZE_LIMIT' } });
    expect(checkCirclePackingWitness(`${'['.repeat(18)}null${']'.repeat(18)}`)).toMatchObject({ ok: false, error: { code: 'DEPTH_LIMIT' } });
  });
});
