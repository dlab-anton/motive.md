import { describe, expect, it } from 'vitest';
import { CSQV_MAX_BYTES, CSQV_WITNESS_FORMAT } from './circle-packing';
import { compareCirclePackingWitnesses } from './circle-packing-equivalence';

type Circle = { x: string; y: string; r: string };

function decimal(hundredths: number) {
  return `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, '0')}`;
}

function units(value: string) {
  const [whole, fraction] = value.split('.');
  return Number(whole) * 100 + Number(fraction);
}

function circles(): Circle[] {
  return Array.from({ length: 101 }, (_, index) => {
    const column = index % 11;
    const row = Math.floor(index / 11);
    return {
      x: decimal(5 + column * 9 + row % 3),
      y: decimal(5 + row * 10 + column % 2),
      r: '0.01',
    };
  });
}

function witness(value: Circle[]) {
  return JSON.stringify({ format: CSQV_WITNESS_FORMAT, n: 101, circles: value });
}

const symmetries: Array<(circle: Circle) => Circle> = [
  ({ x, y, r }) => ({ x: decimal(100 - units(x)), y, r }),
  ({ x, y, r }) => ({ x, y: decimal(100 - units(y)), r }),
  ({ x, y, r }) => ({ x: y, y: x, r }),
  ({ x, y, r }) => ({ x: decimal(100 - units(y)), y: x, r }),
  ({ x, y, r }) => ({ x: decimal(100 - units(x)), y: decimal(100 - units(y)), r }),
  ({ x, y, r }) => ({ x: y, y: decimal(100 - units(x)), r }),
  ({ x, y, r }) => ({ x: decimal(100 - units(y)), y: decimal(100 - units(x)), r }),
];

describe('exact circle-packing geometry equivalence', () => {
  it('matches unordered circles after exact decimal normalization', () => {
    const left = circles();
    const right = [...left].reverse().map(circle => ({
      x: `${circle.x}${'0'.repeat(16)}`,
      y: `${circle.y}${'0'.repeat(16)}`,
      r: `${circle.r}${'0'.repeat(16)}`,
    }));
    expect(compareCirclePackingWitnesses(witness(left), witness(right)))
      .toEqual({ ok: true, relation: 'SAME_GEOMETRY' });
  });

  it('recognizes every non-identity unit-square isometry exactly', () => {
    const left = circles();
    for (const symmetry of symmetries) {
      expect(compareCirclePackingWitnesses(witness(left), witness(left.map(symmetry).reverse())))
        .toEqual({ ok: true, relation: 'SQUARE_SYMMETRY' });
    }
  });

  it('detects a one-unit change at the fixed 10^-18 scale', () => {
    const left = circles();
    const right = left.map(circle => ({ ...circle }));
    right[0]!.x = '0.050000000000000001';
    expect(compareCirclePackingWitnesses(witness(left), witness(right)))
      .toEqual({ ok: true, relation: 'DIFFERENT_GEOMETRY' });
  });

  it('keeps each exact radius attached to its center', () => {
    const left = circles();
    left[0]!.r = '0.009';
    left[1]!.r = '0.008';
    const right = left.map(circle => ({ ...circle }));
    [right[0]!.r, right[1]!.r] = [right[1]!.r, right[0]!.r];
    expect(compareCirclePackingWitnesses(witness(left), witness(right)))
      .toEqual({ ok: true, relation: 'DIFFERENT_GEOMETRY' });
  });

  it('returns the checker failure for the first invalid or oversized input', () => {
    const valid = witness(circles());
    expect(compareCirclePackingWitnesses('{', valid)).toMatchObject({
      ok: false,
      invalidInput: 'left',
      error: { code: 'MALFORMED_JSON' },
    });
    expect(compareCirclePackingWitnesses(valid, ' '.repeat(CSQV_MAX_BYTES + 1))).toMatchObject({
      ok: false,
      invalidInput: 'right',
      error: { code: 'SIZE_LIMIT' },
    });
  });
});
