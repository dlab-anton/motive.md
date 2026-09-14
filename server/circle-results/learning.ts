import type { SubmissionInvestigationInput, SubmissionResearchReference } from '../../src/lib/participation.ts';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const MAX_DEPTH = 16;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

class Parser {
  private cursor = 0;
  constructor(private readonly source: string) {}
  parse(): Json {
    if (this.source.charCodeAt(0) === 0xfeff) throw new Error('invalid');
    const value = this.value(0); this.space();
    if (this.cursor !== this.source.length) throw new Error('invalid');
    return value;
  }
  private space() { while ([' ', '\t', '\r', '\n'].includes(this.source[this.cursor] ?? '')) this.cursor += 1; }
  private value(depth: number): Json {
    if (depth > MAX_DEPTH) throw new Error('invalid'); this.space(); const token = this.source[this.cursor];
    if (token === '{') return this.object(depth + 1); if (token === '[') return this.array(depth + 1);
    if (token === '"') return this.string();
    for (const [word, value] of [['true', true], ['false', false], ['null', null]] as const) {
      if (this.source.startsWith(word, this.cursor)) { this.cursor += word.length; return value; }
    }
    if (token === '-' || (token >= '0' && token <= '9')) return this.number();
    throw new Error('invalid');
  }
  private object(depth: number): { [key: string]: Json } {
    this.cursor += 1; this.space(); const result = Object.create(null) as { [key: string]: Json }; const keys = new Set<string>();
    if (this.source[this.cursor] === '}') { this.cursor += 1; return result; }
    for (;;) {
      if (this.source[this.cursor] !== '"') throw new Error('invalid'); const key = this.string();
      if (keys.has(key)) throw new Error('invalid'); keys.add(key); this.space();
      if (this.source[this.cursor] !== ':') throw new Error('invalid'); this.cursor += 1; result[key] = this.value(depth); this.space();
      if (this.source[this.cursor] === '}') { this.cursor += 1; return result; }
      if (this.source[this.cursor] !== ',') throw new Error('invalid'); this.cursor += 1; this.space();
    }
  }
  private array(depth: number): Json[] {
    this.cursor += 1; this.space(); const result: Json[] = [];
    if (this.source[this.cursor] === ']') { this.cursor += 1; return result; }
    for (;;) {
      result.push(this.value(depth)); this.space(); if (this.source[this.cursor] === ']') { this.cursor += 1; return result; }
      if (this.source[this.cursor] !== ',') throw new Error('invalid'); this.cursor += 1;
    }
  }
  private string(): string {
    const start = this.cursor++; let escaped = false;
    while (this.cursor < this.source.length) {
      const code = this.source.charCodeAt(this.cursor);
      if (!escaped && code === 0x22) {
        this.cursor += 1; const value = JSON.parse(this.source.slice(start, this.cursor)) as string;
        for (let index = 0; index < value.length; index += 1) {
          const unit = value.charCodeAt(index);
          if (unit === 0 || (unit >= 0xdc00 && unit <= 0xdfff)) throw new Error('invalid');
          if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('invalid');
            index += 1;
          }
        }
        return value;
      }
      if (!escaped && code < 0x20) throw new Error('invalid');
      if (!escaped && code === 0x5c) escaped = true; else escaped = false; this.cursor += 1;
    }
    throw new Error('invalid');
  }
  private number(): number {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(this.source.slice(this.cursor));
    if (!match) throw new Error('invalid'); this.cursor += match[0].length; const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new Error('invalid'); return value;
  }
}

function object(value: Json): value is { [key: string]: Json } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: { [key: string]: Json }, required: string[], optional: string[] = []): boolean {
  const keys = Object.keys(value).sort(); const allowed = [...required, ...optional].sort();
  return required.every(key => Object.hasOwn(value, key)) && keys.length >= required.length
    && keys.length <= allowed.length && keys.every(key => allowed.includes(key));
}
function bounded(value: Json, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && value === value.trim();
}
function reference(value: Json): value is SubmissionResearchReference {
  if (!object(value) || !exact(value, ['scopeId','snapshotId','snapshotDigest','hypothesisId','observedUpdatedAt','evidenceIds'])) return false;
  return [value.scopeId, value.snapshotId, value.hypothesisId].every(item => typeof item === 'string' && UUID.test(item))
    && typeof value.snapshotDigest === 'string' && DIGEST.test(value.snapshotDigest)
    && typeof value.observedUpdatedAt === 'string' && value.observedUpdatedAt.length <= 40 && Number.isFinite(Date.parse(value.observedUpdatedAt))
    && Array.isArray(value.evidenceIds) && value.evidenceIds.length <= 20 && new Set(value.evidenceIds).size === value.evidenceIds.length
    && value.evidenceIds.every(item => typeof item === 'string' && UUID.test(item));
}

export function parseHostedInvestigation(bytes: Uint8Array): SubmissionInvestigationInput | null {
  if (bytes.byteLength < 1 || bytes.byteLength > 16 * 1024) return null;
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return null;
  let value: Json;
  try { value = new Parser(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).parse(); } catch { return null; }
  if (!object(value) || !exact(value, ['format','proposal','expectation','conditions','observations','assessment','nextAction'], ['researchReferences'])
      || value.format !== 'motive.investigation.v1' || !bounded(value.proposal, 2000) || !bounded(value.expectation, 1000)
      || !bounded(value.assessment, 2000) || !bounded(value.nextAction, 1000)
      || !Array.isArray(value.conditions) || value.conditions.length < 1 || value.conditions.length > 12
      || !value.conditions.every(item => bounded(item, 500)) || !Array.isArray(value.observations)
      || value.observations.length < 1 || value.observations.length > 20 || !value.observations.every(item => bounded(item, 1000))
      || (value.researchReferences !== undefined && (!Array.isArray(value.researchReferences)
        || value.researchReferences.length < 1 || value.researchReferences.length > 10
        || !value.researchReferences.every(reference)))) return null;
  return value as unknown as SubmissionInvestigationInput;
}
