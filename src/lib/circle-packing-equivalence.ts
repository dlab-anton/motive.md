import { checkCirclePackingWitness } from './circle-packing.ts';

const SCALE = 1_000_000_000_000_000_000n;

type Circle = { x: string; y: string; r: string };
type ParsedWitness = { circles: Circle[] };
type ScaledCircle = { x: bigint; y: bigint; r: bigint };
type Transform = (circle: ScaledCircle) => ScaledCircle;

export type CirclePackingEquivalenceResult =
  | { ok: true; relation: 'SAME_GEOMETRY' | 'SQUARE_SYMMETRY' | 'DIFFERENT_GEOMETRY' }
  | { ok: false; invalidInput: 'left' | 'right'; error: { code: string; message: string } };

function scaledDecimal(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(18, '0') || '0');
}

function parseCheckedWitness(source: string): ScaledCircle[] {
  const witness = JSON.parse(source) as ParsedWitness;
  return witness.circles.map(circle => ({
    x: scaledDecimal(circle.x),
    y: scaledDecimal(circle.y),
    r: scaledDecimal(circle.r),
  }));
}

const transforms: readonly Transform[] = [
  circle => circle,
  ({ x, y, r }) => ({ x: SCALE - y, y: x, r }),
  ({ x, y, r }) => ({ x: SCALE - x, y: SCALE - y, r }),
  ({ x, y, r }) => ({ x: y, y: SCALE - x, r }),
  ({ x, y, r }) => ({ x: SCALE - x, y, r }),
  ({ x, y, r }) => ({ x, y: SCALE - y, r }),
  ({ x, y, r }) => ({ x: y, y: x, r }),
  ({ x, y, r }) => ({ x: SCALE - y, y: SCALE - x, r }),
];

function canonical(circles: readonly ScaledCircle[], transform: Transform): string[] {
  return circles.map(circle => {
    const value = transform(circle);
    return `${value.x}:${value.y}:${value.r}`;
  }).sort();
}

function equal(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function compareCirclePackingWitnesses(left: string, right: string): CirclePackingEquivalenceResult {
  const leftCheck = checkCirclePackingWitness(left);
  if (!leftCheck.ok) return { ok: false, invalidInput: 'left', error: leftCheck.error };
  const rightCheck = checkCirclePackingWitness(right);
  if (!rightCheck.ok) return { ok: false, invalidInput: 'right', error: rightCheck.error };

  const leftCircles = parseCheckedWitness(left);
  const rightCanonical = canonical(parseCheckedWitness(right), transforms[0]);
  if (equal(canonical(leftCircles, transforms[0]), rightCanonical)) {
    return { ok: true, relation: 'SAME_GEOMETRY' };
  }
  for (const transform of transforms.slice(1)) {
    if (equal(canonical(leftCircles, transform), rightCanonical)) {
      return { ok: true, relation: 'SQUARE_SYMMETRY' };
    }
  }
  return { ok: true, relation: 'DIFFERENT_GEOMETRY' };
}
