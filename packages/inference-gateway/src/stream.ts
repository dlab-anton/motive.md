import Decimal from 'decimal.js';
import type { DecimalAmount } from '../../domain/src/contracts.ts';
import { chargedAmount, compareAmounts } from '../../accounting/src/money.ts';
import { GatewayProtocolError, deepFreeze, isPlainRecord } from './protocol.ts';

export type SanitizedProviderUsage = Readonly<{
  cost: DecimalAmount;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  reasoningOutputTokens: number | null;
}>;

export type TerminalUsage = Readonly<{
  providerResponseId: string;
  rawCost: string;
  actualCost: DecimalAmount;
  returnedModel: string;
  returnedProvider: string | null;
  usage: SanitizedProviderUsage;
  overrun: boolean;
}>;

export type ResponsesSseParserOptions = Readonly<{
  maxTotalBytes: number;
  maxEventBytes: number;
  expectedModel: string;
  maximumExposure?: DecimalAmount;
}>;

export class GatewayStreamError extends GatewayProtocolError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'GatewayStreamError';
  }
}

const CostDecimal = Decimal.clone({ precision: 80, rounding: Decimal.ROUND_CEIL, toExpNeg: -200, toExpPos: 200 });
const TERMINAL_TYPES = new Set(['response.done', 'response.completed']);
const FAILURE_TYPES = new Set(['response.failed', 'response.incomplete', 'error']);

function streamFail(code: string, message: string): never {
  throw new GatewayStreamError(code, message);
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) streamFail('INVALID_STREAM_LIMIT', `${name} must be a positive safe integer.`);
  return value;
}

function nonnegativeInteger(value: unknown, name: string): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) streamFail('AMBIGUOUS_USAGE', `${name} is invalid.`);
  return value as number;
}

function oneTokenCount(usage: Record<string, unknown>, primary: string, alias: string): number | null {
  const left = nonnegativeInteger(usage[primary], `usage.${primary}`);
  const right = nonnegativeInteger(usage[alias], `usage.${alias}`);
  if (left !== null && right !== null && left !== right) streamFail('AMBIGUOUS_USAGE', `Terminal usage has conflicting ${primary} counts.`);
  return left ?? right;
}

function detailCount(usage: Record<string, unknown>, field: string, detail: string): number | null {
  const value = usage[field];
  if (value === undefined || value === null) return null;
  if (!isPlainRecord(value)) streamFail('AMBIGUOUS_USAGE', `usage.${field} is invalid.`);
  return nonnegativeInteger(value[detail], `usage.${field}.${detail}`);
}

function uniqueString(values: unknown[], name: string): string | null {
  const present = values.filter(value => value !== undefined && value !== null);
  if (present.some(value => typeof value !== 'string' || value.length === 0)) streamFail('AMBIGUOUS_TERMINAL', `${name} is invalid.`);
  const unique = [...new Set(present as string[])];
  if (unique.length > 1) streamFail('AMBIGUOUS_TERMINAL', `${name} conflicts within the terminal response.`);
  return unique[0] ?? null;
}

/**
 * Finds primitive JSON lexemes without converting a numeric token through a
 * JavaScript Number. JSON.parse still validates the complete event separately.
 */
class JsonLexemeLocator {
  private position = 0;
  private readonly matches: string[] = [];

  constructor(private readonly source: string, private readonly target: readonly string[]) {}

  find(): readonly string[] {
    this.value([]);
    this.space();
    if (this.position !== this.source.length) streamFail('MALFORMED_SSE', 'Terminal event JSON is malformed.');
    return this.matches;
  }

  private space(): void {
    while (/\s/.test(this.source[this.position] ?? '')) this.position += 1;
  }

  private string(): string {
    const start = this.position;
    if (this.source[this.position] !== '"') streamFail('MALFORMED_SSE', 'Terminal event JSON is malformed.');
    this.position += 1;
    while (this.position < this.source.length) {
      const character = this.source[this.position++];
      if (character === '"') {
        try { return JSON.parse(this.source.slice(start, this.position)) as string; }
        catch { streamFail('MALFORMED_SSE', 'Terminal event JSON is malformed.'); }
      }
      if (character === '\\') {
        if (this.source[this.position] === 'u') this.position += 5;
        else this.position += 1;
      }
    }
    streamFail('MALFORMED_SSE', 'Terminal event JSON is malformed.');
  }

  private value(path: readonly string[]): void {
    this.space();
    const start = this.position;
    const character = this.source[this.position];
    if (character === '{') {
      this.position += 1;
      this.space();
      if (this.source[this.position] === '}') { this.position += 1; return; }
      while (true) {
        this.space();
        const key = this.string();
        this.space();
        if (this.source[this.position++] !== ':') streamFail('MALFORMED_SSE', 'Terminal event JSON is malformed.');
        this.value([...path, key]);
        this.space();
        const separator = this.source[this.position++];
        if (separator === '}') return;
        if (separator !== ',') streamFail('MALFORMED_SSE', 'Terminal event JSON is malformed.');
      }
    }
    if (character === '[') {
      this.position += 1;
      this.space();
      if (this.source[this.position] === ']') { this.position += 1; return; }
      while (true) {
        this.value([...path, '*']);
        this.space();
        const separator = this.source[this.position++];
        if (separator === ']') return;
        if (separator !== ',') streamFail('MALFORMED_SSE', 'Terminal event JSON is malformed.');
      }
    }
    if (character === '"') this.string();
    else {
      const remainder = this.source.slice(this.position);
      const match = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(remainder);
      if (!match) streamFail('MALFORMED_SSE', 'Terminal event JSON is malformed.');
      this.position += match[0].length;
    }
    if (path.length === this.target.length && path.every((part, index) => part === this.target[index])) {
      this.matches.push(this.source.slice(start, this.position));
    }
  }
}

function costFromLexeme(rawLexeme: string): { rawCost: string; actualCost: DecimalAmount } {
  let rawCost: string;
  if (rawLexeme.startsWith('"')) {
    const parsed = JSON.parse(rawLexeme) as unknown;
    if (typeof parsed !== 'string') streamFail('AMBIGUOUS_USAGE', 'usage.cost is invalid.');
    rawCost = parsed;
  } else {
    rawCost = rawLexeme;
  }
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(rawCost)) streamFail('AMBIGUOUS_USAGE', 'usage.cost must be a non-negative decimal value.');
  let parsed: Decimal;
  try { parsed = new CostDecimal(rawCost); }
  catch { streamFail('AMBIGUOUS_USAGE', 'usage.cost is invalid.'); }
  if (!parsed.isFinite() || parsed.isNegative()) streamFail('AMBIGUOUS_USAGE', 'usage.cost is invalid.');
  try {
    return { rawCost, actualCost: chargedAmount(parsed.toFixed(), 'provider usage.cost') };
  } catch {
    streamFail('AMBIGUOUS_USAGE', 'usage.cost is outside the supported accounting range.');
  }
}

function frameBoundary(bytes: Uint8Array): { eventEnd: number; consumed: number } | null {
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 10 && bytes[index] !== 13) continue;
    const firstLength = bytes[index] === 13 && bytes[index + 1] === 10 ? 2 : 1;
    const second = index + firstLength;
    if (bytes[second] !== 10 && bytes[second] !== 13) continue;
    const secondLength = bytes[second] === 13 && bytes[second + 1] === 10 ? 2 : 1;
    return { eventEnd: index, consumed: second + secondLength };
  }
  return null;
}

function concatenate(left: Uint8Array<ArrayBufferLike>, right: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> {
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left);
  combined.set(right, left.byteLength);
  return combined;
}

export class ResponsesSseAccountingParser {
  private readonly maxTotalBytes: number;
  private readonly maxEventBytes: number;
  private readonly expectedModel: string;
  private readonly maximumExposure?: DecimalAmount;
  private pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private totalBytes = 0;
  private responseIdValue: string | null = null;
  private terminalSeenValue = false;
  private doneSeen = false;
  private terminalUsage: TerminalUsage | null = null;
  private failure: GatewayStreamError | null = null;
  private finished = false;

  constructor(options: ResponsesSseParserOptions) {
    this.maxTotalBytes = positiveLimit(options.maxTotalBytes, 'maxTotalBytes');
    this.maxEventBytes = positiveLimit(options.maxEventBytes, 'maxEventBytes');
    if (this.maxEventBytes > this.maxTotalBytes) streamFail('INVALID_STREAM_LIMIT', 'maxEventBytes cannot exceed maxTotalBytes.');
    if (typeof options.expectedModel !== 'string' || options.expectedModel.length === 0) streamFail('INVALID_STREAM_LIMIT', 'expectedModel is required.');
    this.expectedModel = options.expectedModel;
    this.maximumExposure = options.maximumExposure;
  }

  get responseId(): string | null { return this.responseIdValue; }
  get terminalSeen(): boolean { return this.terminalSeenValue; }

  push(chunk: Uint8Array): void {
    if (this.failure) throw this.failure;
    if (this.finished) this.fail('STREAM_CLOSED', 'Cannot push data after stream finish.');
    if (!(chunk instanceof Uint8Array)) this.fail('MALFORMED_SSE', 'Stream chunks must be Uint8Array values.');
    this.totalBytes += chunk.byteLength;
    if (!Number.isSafeInteger(this.totalBytes) || this.totalBytes > this.maxTotalBytes) this.fail('RESPONSE_TOO_LARGE', 'Provider response exceeds the profile byte limit.');
    this.pending = concatenate(this.pending, chunk);
    while (true) {
      const boundary = frameBoundary(this.pending);
      if (boundary === null) break;
      if (boundary.eventEnd > this.maxEventBytes) this.fail('EVENT_TOO_LARGE', 'Provider SSE event exceeds the profile byte limit.');
      const frame = this.pending.slice(0, boundary.eventEnd);
      this.pending = this.pending.slice(boundary.consumed);
      if (frame.byteLength > 0) this.consumeFrame(frame);
    }
    if (this.pending.byteLength > this.maxEventBytes + 3) this.fail('EVENT_TOO_LARGE', 'Provider SSE event exceeds the profile byte limit.');
  }

  finish(): TerminalUsage {
    if (this.failure) throw this.failure;
    if (this.finished) this.fail('STREAM_CLOSED', 'Stream finish may be called only once.');
    this.finished = true;
    if (this.pending.some(byte => ![9, 10, 13, 32].includes(byte))) this.fail('TRUNCATED_STREAM', 'Provider stream ended with an incomplete SSE event.');
    if (!this.terminalSeenValue || this.terminalUsage === null) this.fail('UNKNOWN_USAGE', 'Provider stream ended without one authoritative successful terminal usage record.');
    return this.terminalUsage;
  }

  private fail(code: string, message: string): never {
    const error = new GatewayStreamError(code, message);
    this.failure = error;
    throw error;
  }

  private rememberResponseId(candidate: unknown): void {
    if (candidate === undefined || candidate === null) return;
    if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 512) this.fail('AMBIGUOUS_RESPONSE_ID', 'Provider response identifier is invalid.');
    if (this.responseIdValue === null) this.responseIdValue = candidate;
    else if (this.responseIdValue !== candidate) this.fail('AMBIGUOUS_RESPONSE_ID', 'Provider stream contains conflicting response identifiers.');
  }

  private consumeFrame(bytes: Uint8Array): void {
    let frame: string;
    try { frame = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { this.fail('MALFORMED_SSE', 'Provider SSE event is not valid UTF-8.'); }
    const lines = frame.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    let eventName: string | null = null;
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.length === 0 || line.startsWith(':')) continue;
      const separator = line.indexOf(':');
      const field = separator < 0 ? line : line.slice(0, separator);
      let value = separator < 0 ? '' : line.slice(separator + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') {
        if (eventName !== null) this.fail('MALFORMED_SSE', 'Provider SSE event contains duplicate event fields.');
        eventName = value;
      } else if (field === 'data') dataLines.push(value);
      else this.fail('MALFORMED_SSE', 'Provider SSE event contains an unsupported field.');
    }
    if (dataLines.length === 0) return;
    const data = dataLines.join('\n');
    if (data === '[DONE]') {
      if (this.doneSeen) this.fail('AMBIGUOUS_TERMINAL', 'Provider stream contains duplicate DONE markers.');
      if (eventName !== null && eventName.length > 0) this.fail('MALFORMED_SSE', 'DONE marker cannot carry an event type.');
      this.doneSeen = true;
      return;
    }
    if (this.doneSeen) this.fail('AMBIGUOUS_TERMINAL', 'Provider stream contains events after DONE.');

    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(data) as unknown;
      if (!isPlainRecord(parsed)) this.fail('MALFORMED_SSE', 'Provider SSE data must be a JSON object.');
      event = parsed;
    } catch (error) {
      if (error instanceof GatewayStreamError) throw error;
      this.fail('MALFORMED_SSE', 'Provider SSE data is not valid JSON.');
    }
    if (typeof event.type !== 'string' || event.type.length === 0) this.fail('MALFORMED_SSE', 'Provider SSE event type is missing.');
    if (eventName !== null && eventName !== event.type) this.fail('MALFORMED_SSE', 'Provider SSE event and data types conflict.');

    const response = isPlainRecord(event.response) ? event.response : null;
    this.rememberResponseId(event.response_id);
    if (response) this.rememberResponseId(response.id);
    if (this.terminalSeenValue) this.fail('AMBIGUOUS_TERMINAL', 'Provider stream contains an event after terminal completion.');
    if (FAILURE_TYPES.has(event.type)) this.fail('PROVIDER_TERMINAL_FAILURE', 'Provider returned a non-success terminal event; usage requires reconciliation.');
    if (!TERMINAL_TYPES.has(event.type)) return;
    this.terminalSeenValue = true;
    if (!response || response.status !== 'completed') this.fail('PROVIDER_TERMINAL_FAILURE', 'Provider terminal response is not completed; usage requires reconciliation.');
    if (this.responseIdValue === null) this.fail('AMBIGUOUS_RESPONSE_ID', 'Provider terminal response has no response identifier.');
    if (response.model !== this.expectedModel) this.fail('MODEL_MISMATCH', 'Returned provider model differs from the frozen profile.');
    if (!isPlainRecord(response.usage)) this.fail('UNKNOWN_USAGE', 'Provider terminal response has no usage object.');

    let lexemes: readonly string[];
    try { lexemes = new JsonLexemeLocator(data, ['response', 'usage', 'cost']).find(); }
    catch (error) {
      if (error instanceof GatewayStreamError) this.failure = error;
      throw error;
    }
    if (lexemes.length !== 1) this.fail('UNKNOWN_USAGE', 'Provider terminal response must contain exactly one usage.cost value.');
    const { rawCost, actualCost } = costFromLexeme(lexemes[0]);
    const usage = response.usage;
    const inputTokens = oneTokenCount(usage, 'input_tokens', 'prompt_tokens');
    const outputTokens = oneTokenCount(usage, 'output_tokens', 'completion_tokens');
    const totalTokens = nonnegativeInteger(usage.total_tokens, 'usage.total_tokens');
    if (inputTokens !== null && outputTokens !== null && totalTokens !== null && inputTokens + outputTokens !== totalTokens) {
      this.fail('AMBIGUOUS_USAGE', 'Terminal usage token totals conflict.');
    }
    const metadata = isPlainRecord(response.openrouter_metadata) ? response.openrouter_metadata : {};
    const returnedProvider = uniqueString([
      response.provider,
      response.provider_name,
      metadata.provider,
      metadata.provider_name,
    ], 'Returned provider attribution');
    const sanitizedUsage: SanitizedProviderUsage = deepFreeze({
      cost: actualCost,
      inputTokens,
      outputTokens,
      totalTokens,
      cachedInputTokens: detailCount(usage, 'input_tokens_details', 'cached_tokens'),
      cacheWriteInputTokens: detailCount(usage, 'input_tokens_details', 'cache_write_tokens'),
      reasoningOutputTokens: detailCount(usage, 'output_tokens_details', 'reasoning_tokens'),
    });
    this.terminalUsage = deepFreeze({
      providerResponseId: this.responseIdValue,
      rawCost,
      actualCost,
      returnedModel: this.expectedModel,
      returnedProvider,
      usage: sanitizedUsage,
      overrun: this.maximumExposure === undefined ? false : compareAmounts(actualCost, this.maximumExposure) > 0,
    });
  }
}
