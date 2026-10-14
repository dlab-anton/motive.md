/** A bounded, data-only format for agent-submitted exoplanet work. */
export const EXOPLANET_EVIDENCE_FORMAT = 'motive.exoplanet.evidence.v1';
export const EXOPLANET_MAX_BYTES = 32_768;

export type ExoplanetDataKind = 'observational' | 'synthetic';
export type ExoplanetTaskKind = 'data-audit' | 'control-recovery' | 'transit-search' | 'false-positive-review' | 'replication';
export type ExoplanetClassification = 'candidate' | 'no-signal' | 'false-positive' | 'inconclusive';
export type ExoplanetFinding = { name: string; status: 'pass' | 'fail' | 'inconclusive' | 'not-run'; notes: string };
export type ExoplanetEvidence = {
  format: typeof EXOPLANET_EVIDENCE_FORMAT;
  protocolVersion: 'motive.exoplanet-hunting.pilot.v1';
  dataKind: ExoplanetDataKind;
  target: { ticId: string };
  taskKind: ExoplanetTaskKind;
  inputs: { uri: string; sha256: string; sector: number; timeSystem: 'BJD_TDB'; fluxProvenance: string }[];
  method: { code: { name: string; version: string; sha256?: string }; commands: string[]; detrending: string; search: string };
  observations: {
    classification: ExoplanetClassification;
    events: { epochBjdTdb: number; depthPpm: number; durationHours: number; uncertaintyPpm?: number }[];
  };
  orbitalFit?: {
    periodDays: number; periodUncertaintyDays: number; epochBjdTdb: number;
    epochUncertaintyDays: number; depthPpm: number; depthUncertaintyPpm: number;
  };
  diagnostics: ExoplanetFinding[];
  controlResults: ExoplanetFinding[];
  limitations: string[];
  summary: string;
  nextSteps: string[];
};
export type ExoplanetCheck = {
  ok: true;
  report: {
    format: 'motive.exoplanet.structure-check.v1';
    scope: 'STRUCTURE_ONLY';
    scientificStatus: 'NOT_VALIDATED';
    dataKind: ExoplanetDataKind;
    taskKind: ExoplanetTaskKind;
    classification: ExoplanetClassification;
    inputCount: number;
    eventCount: number;
    diagnosticCount: number;
    controlResultCount: number;
    limitationCount: number;
    nextStepCount: number;
  };
} | { ok: false; error: { code: string; message: string } };

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ObjectValue = { [key: string]: Json };

class EvidenceError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
const fail = (code: string, message: string): never => { throw new EvidenceError(code, message); };

/** JSON.parse silently overwrites duplicate keys, so parse the small bundle explicitly. */
class JsonParser {
  private cursor = 0;
  constructor(private readonly source: string) {}

  parse(): Json {
    if (this.source.charCodeAt(0) === 0xfeff) fail('MALFORMED_JSON', 'A UTF-8 BOM is not allowed.');
    const value = this.value(0);
    this.space();
    if (this.cursor !== this.source.length) fail('MALFORMED_JSON', 'Unexpected content after JSON.');
    return value;
  }

  private space() {
    while ([' ', '\t', '\r', '\n'].includes(this.source[this.cursor] ?? '')) this.cursor += 1;
  }

  private value(depth: number): Json {
    if (depth > 16) fail('DEPTH_LIMIT', 'JSON nesting may not exceed 16 levels.');
    this.space();
    const token = this.source[this.cursor];
    if (token === '{') return this.object(depth + 1);
    if (token === '[') return this.array(depth + 1);
    if (token === '"') return this.string();
    for (const [word, value] of [['true', true], ['false', false], ['null', null]] as const) {
      if (this.source.startsWith(word, this.cursor)) { this.cursor += word.length; return value; }
    }
    if (token === '-' || (token >= '0' && token <= '9')) return this.number();
    return fail('MALFORMED_JSON', 'Invalid JSON value.');
  }

  private object(depth: number): ObjectValue {
    this.cursor += 1; this.space();
    const result = Object.create(null) as ObjectValue;
    const keys = new Set<string>();
    if (this.source[this.cursor] === '}') { this.cursor += 1; return result; }
    for (;;) {
      if (this.source[this.cursor] !== '"') fail('MALFORMED_JSON', 'Object keys must be strings.');
      const key = this.string();
      if (keys.has(key)) fail('DUPLICATE_KEY', `Duplicate object key ${JSON.stringify(key)}.`);
      keys.add(key); this.space();
      if (this.source[this.cursor] !== ':') fail('MALFORMED_JSON', 'Expected a colon after an object key.');
      this.cursor += 1; result[key] = this.value(depth); this.space();
      if (this.source[this.cursor] === '}') { this.cursor += 1; return result; }
      if (this.source[this.cursor] !== ',') fail('MALFORMED_JSON', 'Expected a comma between fields.');
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
      if (this.source[this.cursor] !== ',') fail('MALFORMED_JSON', 'Expected a comma between items.');
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
      escaped = !escaped && code === 0x5c;
      this.cursor += 1;
    }
    return fail('MALFORMED_JSON', 'Unterminated JSON string.');
  }

  private number(): number {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(this.source.slice(this.cursor));
    if (!match) return fail('MALFORMED_JSON', 'Invalid JSON number.');
    this.cursor += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) fail('NONFINITE_NUMBER', 'Numeric values must be finite.');
    return value;
  }
}

function object(value: Json, path: string): ObjectValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('MALFORMED_STRUCTURE', `${path} must be an object.`);
  return value as ObjectValue;
}
function keys(value: ObjectValue, required: readonly string[], optional: readonly string[], path: string) {
  for (const key of required) if (!Object.hasOwn(value, key)) fail('MALFORMED_STRUCTURE', `${path}.${key} is required.`);
  for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key)) fail('MALFORMED_STRUCTURE', `${path}.${key} is not allowed.`);
}
function string(value: Json, path: string, max = 2048): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail('INVALID_FIELD', `${path} must be nonempty text of at most ${max} characters without control characters.`);
  }
  return value as string;
}
function oneOf<T extends string>(value: Json, choices: readonly T[], path: string): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) fail('INVALID_FIELD', `${path} must be one of ${choices.join(', ')}.`);
  return value as T;
}
function number(value: Json, path: string, lower?: number, strict = false, upper?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) ||
      (lower !== undefined && (strict ? value <= lower : value < lower)) ||
      (upper !== undefined && value > upper)) {
    fail('INVALID_FIELD', `${path} must be a finite number${lower === undefined ? '' : ` ${strict ? 'greater than' : 'at least'} ${lower}`}${upper === undefined ? '' : ` and at most ${upper}`}.`);
  }
  return value as number;
}
function array(value: Json, path: string, min: number, max: number): Json[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail('MALFORMED_STRUCTURE', `${path} must contain ${min}–${max} entries.`);
  return value as Json[];
}
function textArray(value: Json, path: string, min: number, max: number) {
  return array(value, path, min, max).map((item, i) => string(item, `${path}[${i}]`));
}
const shaPattern = /^[0-9a-f]{64}$/;
function sha256(value: Json, path: string): string {
  if (typeof value !== 'string' || !shaPattern.test(value)) fail('INVALID_FIELD', `${path} must be a lowercase SHA-256 hex digest.`);
  return value as string;
}
function uri(value: Json, path: string, kind: ExoplanetDataKind, digest: string) {
  const text = string(value, path, 2048);
  if (kind === 'synthetic' && text === `urn:sha256:${digest}`) return;
  if (kind === 'observational' && /^mast:[A-Za-z0-9][A-Za-z0-9._:/?=&%+-]*$/.test(text)) return;
  if (kind === 'observational') {
    try {
      const parsed = new URL(text);
      if (parsed.protocol === 'https:' && parsed.hostname && !parsed.username && !parsed.password && !parsed.hash) return;
    } catch { /* invalid URL */ }
  }
  fail('INVALID_URI', `${path} must be an HTTPS or mast: reference for observations, or a matching urn:sha256: digest for synthetic data.`);
}

function validate(source: string): ExoplanetCheck & { ok: true } {
  const root = object(new JsonParser(source).parse(), 'evidence');
  keys(root, ['format', 'protocolVersion', 'dataKind', 'target', 'taskKind', 'inputs', 'method', 'observations', 'diagnostics', 'controlResults', 'limitations', 'summary', 'nextSteps'], ['orbitalFit'], 'evidence');
  if (root.format !== EXOPLANET_EVIDENCE_FORMAT) fail('WRONG_FORMAT', `format must be ${EXOPLANET_EVIDENCE_FORMAT}.`);
  if (root.protocolVersion !== 'motive.exoplanet-hunting.pilot.v1') fail('WRONG_PROTOCOL', 'protocolVersion must be motive.exoplanet-hunting.pilot.v1.');
  const dataKind = oneOf(root.dataKind, ['observational', 'synthetic'] as const, 'dataKind');
  const target = object(root.target, 'target');
  keys(target, ['ticId'], [], 'target');
  if (!/^[1-9][0-9]{0,11}$/.test(string(target.ticId, 'target.ticId', 12))) fail('INVALID_FIELD', 'target.ticId must be a positive TIC identifier of up to 12 digits.');
  const taskKind = oneOf(root.taskKind, ['data-audit', 'control-recovery', 'transit-search', 'false-positive-review', 'replication'] as const, 'taskKind');
  const inputs = array(root.inputs, 'inputs', 1, 32);
  inputs.forEach((value, i) => {
    const path = `inputs[${i}]`;
    const input = object(value, path);
    keys(input, ['uri', 'sha256', 'sector', 'timeSystem', 'fluxProvenance'], [], path);
    const digest = sha256(input.sha256, `${path}.sha256`);
    uri(input.uri, `${path}.uri`, dataKind, digest);
    if (!Number.isSafeInteger(input.sector) || (input.sector as number) <= 0) fail('INVALID_FIELD', `${path}.sector must be a positive integer.`);
    if (input.timeSystem !== 'BJD_TDB') fail('INVALID_FIELD', `${path}.timeSystem must be BJD_TDB.`);
    string(input.fluxProvenance, `${path}.fluxProvenance`);
  });
  const method = object(root.method, 'method');
  keys(method, ['code', 'commands', 'detrending', 'search'], [], 'method');
  const code = object(method.code, 'method.code');
  keys(code, ['name', 'version'], ['sha256'], 'method.code');
  string(code.name, 'method.code.name', 256);
  string(code.version, 'method.code.version', 256);
  if (Object.hasOwn(code, 'sha256')) sha256(code.sha256, 'method.code.sha256');
  textArray(method.commands, 'method.commands', 1, 32);
  string(method.detrending, 'method.detrending');
  string(method.search, 'method.search');
  const observations = object(root.observations, 'observations');
  keys(observations, ['classification', 'events'], [], 'observations');
  const classification = oneOf(observations.classification, ['candidate', 'no-signal', 'false-positive', 'inconclusive'] as const, 'observations.classification');
  if (dataKind === 'synthetic' && !['no-signal', 'inconclusive'].includes(classification)) fail('INVALID_CLASSIFICATION', 'Synthetic data may only be no-signal or inconclusive.');
  const events = array(observations.events, 'observations.events', classification === 'candidate' ? 1 : 0, 64);
  events.forEach((value, i) => {
    const path = `observations.events[${i}]`;
    const event = object(value, path);
    keys(event, ['epochBjdTdb', 'depthPpm', 'durationHours'], ['uncertaintyPpm'], path);
    number(event.epochBjdTdb, `${path}.epochBjdTdb`, 0, true);
    number(event.depthPpm, `${path}.depthPpm`, 0, false, 1_000_000);
    number(event.durationHours, `${path}.durationHours`, 0, true);
    if (Object.hasOwn(event, 'uncertaintyPpm')) number(event.uncertaintyPpm, `${path}.uncertaintyPpm`, 0);
  });
  if (Object.hasOwn(root, 'orbitalFit')) {
    const fit = object(root.orbitalFit, 'orbitalFit');
    keys(fit, ['periodDays', 'periodUncertaintyDays', 'epochBjdTdb', 'epochUncertaintyDays', 'depthPpm', 'depthUncertaintyPpm'], [], 'orbitalFit');
    number(fit.periodDays, 'orbitalFit.periodDays', 0, true);
    number(fit.periodUncertaintyDays, 'orbitalFit.periodUncertaintyDays', 0);
    number(fit.epochBjdTdb, 'orbitalFit.epochBjdTdb', 0, true);
    number(fit.epochUncertaintyDays, 'orbitalFit.epochUncertaintyDays', 0);
    number(fit.depthPpm, 'orbitalFit.depthPpm', 0, false, 1_000_000);
    number(fit.depthUncertaintyPpm, 'orbitalFit.depthUncertaintyPpm', 0);
  }
  function findings(value: Json, path: string) {
    return array(value, path, 0, 64).map((item, i) => {
      const itemPath = `${path}[${i}]`;
      const finding = object(item, itemPath);
      keys(finding, ['name', 'status', 'notes'], [], itemPath);
      string(finding.name, `${itemPath}.name`, 256);
      oneOf(finding.status, ['pass', 'fail', 'inconclusive', 'not-run'] as const, `${itemPath}.status`);
      string(finding.notes, `${itemPath}.notes`);
      return finding;
    });
  }
  const diagnostics = findings(root.diagnostics, 'diagnostics');
  const controlResults = findings(root.controlResults, 'controlResults');
  const limitations = textArray(root.limitations, 'limitations', 1, 32);
  string(root.summary, 'summary');
  const nextSteps = textArray(root.nextSteps, 'nextSteps', 1, 32);
  return { ok: true, report: {
    format: 'motive.exoplanet.structure-check.v1', scope: 'STRUCTURE_ONLY', scientificStatus: 'NOT_VALIDATED',
    dataKind, taskKind, classification, inputCount: inputs.length, eventCount: events.length,
    diagnosticCount: diagnostics.length, controlResultCount: controlResults.length,
    limitationCount: limitations.length, nextStepCount: nextSteps.length,
  } };
}

export function checkExoplanetEvidence(source: string): ExoplanetCheck {
  try {
    if (typeof source !== 'string') fail('MALFORMED_JSON', 'Evidence must be a JSON string.');
    const bytes = new TextEncoder().encode(source).byteLength;
    if (bytes < 1 || bytes > EXOPLANET_MAX_BYTES) fail('SIZE_LIMIT', `Evidence must be 1–${EXOPLANET_MAX_BYTES} UTF-8 bytes.`);
    return validate(source);
  } catch (error) {
    if (error instanceof EvidenceError) return { ok: false, error: { code: error.code, message: error.message } };
    return { ok: false, error: { code: 'MALFORMED_JSON', message: 'Evidence is not valid JSON.' } };
  }
}
