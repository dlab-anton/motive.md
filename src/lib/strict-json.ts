/**
 * Strict JSON parsing for data-only witnesses.
 *
 * This is the same parser the circle-packing checker uses, exported for other
 * checker families. It is a separate copy on purpose: `src/lib/circle-packing.ts`
 * is digest-pinned by the frozen circle-packing evaluator profile and must not
 * change. Rules: no BOM, no exponent notation, no non-integer numbers, no
 * duplicate keys, bounded nesting, and no data after the root value.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export const MAX_JSON_DEPTH = 16;

export class WitnessError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export const fail = (code: string, message: string): never => { throw new WitnessError(code, message); };
export const isJsonObject = (value: Json): value is { [key: string]: Json } => value !== null && typeof value === 'object' && !Array.isArray(value);

export class StrictJsonParser {
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
    if (match[0].includes('.')) fail('NONINTEGER_NUMBER', 'JSON numbers must be integers.');
    this.cursor += match[0].length;
    const value = Number(match[0]);
    if (!Number.isSafeInteger(value)) fail('INVALID_INTEGER', 'JSON integers must be exactly representable.');
    return value;
  }
}

export function exactKeys(value: { [key: string]: Json }, expected: readonly string[], context: string) {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) {
    fail('MALFORMED_STRUCTURE', `${context} must contain exactly: ${expected.join(', ')}.`);
  }
}
