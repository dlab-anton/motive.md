export const CSQV_WITNESS_FORMAT = 'motive.csqv.witness.v1';
export const CSQV_N = 101;
export const CSQV_MAX_BYTES = 32 * 1024;
export const CSQV_MAX_DECIMAL_PLACES = 18;
export const PAPER_PRINTED_SCORE = '5.289154';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Circle = { x: string; y: string; r: string };
const MAX_JSON_DEPTH = 16;

export type CirclePackingReport = {
  format: 'motive.csqv.local-check.v1';
  valid: true;
  official: false;
  n: 101;
  decimal_places: number;
  scale: string;
  objective: {
    units: string; exact_decimal: string;
    versus_frozen_reference_5_29109518547430697: 'greater' | 'equal' | 'less';
    versus_paper_printed_5_289154: 'greater' | 'equal' | 'less';
  };
  minimum_boundary_slack: { units: string; exact_decimal: string; circle: number };
  minimum_squared_pair_slack: { squared_units: string; exact_decimal: string; circles: [number, number] };
};

export type CirclePackingCheck = { ok: true; report: CirclePackingReport } | {
  ok: false;
  error: { code: string; message: string };
};

class WitnessError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

const fail = (code: string, message: string): never => { throw new WitnessError(code, message); };
const isObject = (value: Json): value is { [key: string]: Json } => value !== null && typeof value === 'object' && !Array.isArray(value);

class StrictJsonParser {
  private cursor = 0;
  constructor(private readonly source: string) {}

  parse(): Json {
    if (this.source.charCodeAt(0) === 0xfeff) fail('MALFORMED_JSON', 'A UTF-8 BOM is not allowed.');
    const value = this.value(0);
    this.space();
    if (this.cursor !== this.source.length) fail('MALFORMED_JSON', 'Unexpected data after the JSON value.');
    return value;
  }

  private space() {
    while ([' ', '\t', '\r', '\n'].includes(this.source[this.cursor] ?? '')) this.cursor += 1;
  }
  private value(depth: number): Json {
    if (depth > MAX_JSON_DEPTH) fail('DEPTH_LIMIT', `JSON nesting may not exceed ${MAX_JSON_DEPTH}.`);
    this.space();
    const token = this.source[this.cursor];
    if (token === '{') return this.object(depth + 1);
    if (token === '[') return this.array(depth + 1);
    if (token === '"') return this.string();
    for (const [word, value] of [['true', true], ['false', false], ['null', null]] as const) {
      if (this.source.startsWith(word, this.cursor)) { this.cursor += word.length; return value; }
    }
    if (token === '-' || (token >= '0' && token <= '9')) return this.number();
    return fail('MALFORMED_JSON', `Unexpected token at byte ${this.cursor}.`);
  }

  private object(depth: number): { [key: string]: Json } {
    this.cursor += 1; this.space();
    const result = Object.create(null) as { [key: string]: Json };
    const keys = new Set<string>();
    if (this.source[this.cursor] === '}') { this.cursor += 1; return result; }
    for (;;) {
      if (this.source[this.cursor] !== '"') fail('MALFORMED_JSON', 'Object keys must be JSON strings.');
      const key = this.string();
      if (keys.has(key)) fail('DUPLICATE_KEY', `Duplicate object key ${JSON.stringify(key)}.`);
      keys.add(key); this.space();
      if (this.source[this.cursor] !== ':') fail('MALFORMED_JSON', 'Expected a colon after an object key.');
      this.cursor += 1; result[key] = this.value(depth); this.space();
      if (this.source[this.cursor] === '}') { this.cursor += 1; return result; }
      if (this.source[this.cursor] !== ',') fail('MALFORMED_JSON', 'Expected a comma between object fields.');
      this.cursor += 1; this.space();
    }
  }

  private array(depth: number): Json[] {
    this.cursor += 1; this.space();
    const result: Json[] = [];
    if (this.source[this.cursor] === ']') { this.cursor += 1; return result; }
    for (;;) {
      result.push(this.value(depth)); this.space();
      if (this.source[this.cursor] === ']') { this.cursor += 1; return result; }
      if (this.source[this.cursor] !== ',') fail('MALFORMED_JSON', 'Expected a comma between array items.');
      this.cursor += 1;
    }
  }

  private string(): string {
    const start = this.cursor;
    this.cursor += 1;
    let escaped = false;
    while (this.cursor < this.source.length) {
      const code = this.source.charCodeAt(this.cursor);
      if (!escaped && code === 0x22) {
        this.cursor += 1;
        try { return JSON.parse(this.source.slice(start, this.cursor)) as string; }
        catch { return fail('MALFORMED_JSON', 'Invalid JSON string.'); }
      }
      if (!escaped && code < 0x20) fail('MALFORMED_JSON', 'Unescaped control character in JSON string.');
      if (!escaped && code === 0x5c) escaped = true;
      else escaped = false;
      this.cursor += 1;
    }
    return fail('MALFORMED_JSON', 'Unterminated JSON string.');
  }

  private number(): number {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(this.source.slice(this.cursor));
    if (!match) return fail('MALFORMED_JSON', 'Invalid JSON number.');
    if (/[eE]/.test(match[0])) fail('EXPONENT_NOT_ALLOWED', 'Exponent notation is not allowed.');
    if (match[0].includes('.')) fail('NONINTEGER_NUMBER', 'JSON numbers must be integers; coordinates and radii must be decimal strings.');
    this.cursor += match[0].length;
    const value = Number(match[0]);
    if (!Number.isSafeInteger(value)) fail('INVALID_INTEGER', 'JSON integers must be exactly representable.');
    return value;
  }
}

function exactKeys(value: { [key: string]: Json }, expected: string[], context: string) {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) {
    fail('MALFORMED_STRUCTURE', `${context} must contain exactly: ${expected.join(', ')}.`);
  }
}

const decimalPattern = /^(?:0|1|0\.[0-9]{1,18}|1\.0{1,18})$/;
function decimalParts(value: Json, field: string): { text: string; places: number; digits: bigint } {
  if (typeof value !== 'string' || !decimalPattern.test(value)) {
    fail('INVALID_DECIMAL', `${field} must be a finite decimal string from 0 to 1 with at most 18 decimal places and no exponent.`);
  }
  const text = value as string;
  const [whole, fraction = ''] = text.split('.');
  return { text, places: fraction.length, digits: BigInt(whole + fraction) };
}

function atScale(value: { places: number; digits: bigint }, places: number) {
  return value.digits * 10n ** BigInt(places - value.places);
}

function formatScaled(units: bigint, places: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(places + 1, '0');
  if (places === 0) return `${negative ? '-' : ''}${digits}`;
  const whole = digits.slice(0, -places);
  const fraction = digits.slice(-places).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function parseWitness(source: string): Circle[] {
  const value = new StrictJsonParser(source).parse();
  const root = isObject(value) ? value : fail('MALFORMED_STRUCTURE', 'The witness must be a JSON object.');
  exactKeys(root, ['format', 'n', 'circles'], 'The witness');
  if (root.format !== CSQV_WITNESS_FORMAT) fail('WRONG_FORMAT', `format must be ${CSQV_WITNESS_FORMAT}.`);
  if (root.n !== CSQV_N) fail('WRONG_N', `n must be the trusted value ${CSQV_N}.`);
  const circles = Array.isArray(root.circles) ? root.circles : fail('WRONG_N', `circles must contain exactly ${CSQV_N} entries.`);
  if (circles.length !== CSQV_N) fail('WRONG_N', `circles must contain exactly ${CSQV_N} entries.`);
  return circles.map((circle, index) => {
    const item = isObject(circle) ? circle : fail('MALFORMED_STRUCTURE', `circles[${index}] must be an object.`);
    exactKeys(item, ['x', 'y', 'r'], `circles[${index}]`);
    if (typeof item.x !== 'string' || typeof item.y !== 'string' || typeof item.r !== 'string') {
      fail('INVALID_DECIMAL', `circles[${index}] coordinates and radius must be decimal strings.`);
    }
    return { x: item.x as string, y: item.y as string, r: item.r as string };
  });
}

export function checkCirclePackingWitness(source: string): CirclePackingCheck {
  try {
    const bytes = new TextEncoder().encode(source).byteLength;
    if (bytes === 0 || bytes > CSQV_MAX_BYTES) fail('SIZE_LIMIT', `Witness must be 1–${CSQV_MAX_BYTES} UTF-8 bytes.`);
    const circles = parseWitness(source);
    const parsed = circles.map((circle, index) => ({
      x: decimalParts(circle.x, `circles[${index}].x`),
      y: decimalParts(circle.y, `circles[${index}].y`),
      r: decimalParts(circle.r, `circles[${index}].r`),
    }));
    const places = Math.max(...parsed.flatMap(circle => [circle.x.places, circle.y.places, circle.r.places]));
    const scale = 10n ** BigInt(places);
    const scaled = parsed.map(circle => ({ x: atScale(circle.x, places), y: atScale(circle.y, places), r: atScale(circle.r, places) }));
    let objective = 0n;
    let minimumBoundary: { slack: bigint; circle: number } | undefined;
    for (let index = 0; index < scaled.length; index += 1) {
      const circle = scaled[index];
      if (circle.r <= 0n) fail('NONPOSITIVE_RADIUS', `circles[${index}].r must be positive.`);
      objective += circle.r;
      const slack = [circle.x - circle.r, scale - circle.x - circle.r, circle.y - circle.r, scale - circle.y - circle.r]
        .reduce((least, item) => item < least ? item : least);
      if (slack < 0n) fail('OUT_OF_BOUNDS', `Circle ${index + 1} crosses the unit-square boundary by ${formatScaled(-slack, places)}.`);
      if (!minimumBoundary || slack < minimumBoundary.slack) minimumBoundary = { slack, circle: index + 1 };
    }
    let minimumPair: { slack: bigint; circles: [number, number] } | undefined;
    for (let left = 0; left < scaled.length; left += 1) for (let right = left + 1; right < scaled.length; right += 1) {
      const dx = scaled[left].x - scaled[right].x;
      const dy = scaled[left].y - scaled[right].y;
      const radii = scaled[left].r + scaled[right].r;
      const slack = dx * dx + dy * dy - radii * radii;
      if (slack < 0n) fail('OVERLAP', `Circles ${left + 1} and ${right + 1} overlap; squared slack is ${slack} at scale² ${scale * scale}.`);
      if (!minimumPair || slack < minimumPair.slack) minimumPair = { slack, circles: [left + 1, right + 1] };
    }
    if (!minimumBoundary || !minimumPair) fail('WRONG_N', `Exactly ${CSQV_N} circles are required.`);
    const boundary = minimumBoundary as { slack: bigint; circle: number };
    const pair = minimumPair as { slack: bigint; circles: [number, number] };
    const compare = (referenceUnits: bigint, referenceScale: bigint) => objective * referenceScale > referenceUnits * scale ? 'greater'
      : objective * referenceScale < referenceUnits * scale ? 'less' : 'equal';
    return { ok: true, report: {
      format: 'motive.csqv.local-check.v1', valid: true, official: false, n: CSQV_N,
      decimal_places: places, scale: scale.toString(),
      objective: {
        units: objective.toString(), exact_decimal: formatScaled(objective, places),
        versus_frozen_reference_5_29109518547430697: compare(529109518547430697n, 100000000000000000n),
        versus_paper_printed_5_289154: compare(5289154n, 1000000n),
      },
      minimum_boundary_slack: { units: boundary.slack.toString(), exact_decimal: formatScaled(boundary.slack, places), circle: boundary.circle },
      minimum_squared_pair_slack: { squared_units: pair.slack.toString(), exact_decimal: formatScaled(pair.slack, places * 2), circles: pair.circles },
    } };
  } catch (error) {
    if (error instanceof WitnessError) return { ok: false, error: { code: error.code, message: error.message } };
    return { ok: false, error: { code: 'MALFORMED_JSON', message: 'Witness is not valid JSON.' } };
  }
}
