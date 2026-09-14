import { open, readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import Decimal from 'decimal.js';
import { canonicalJson, digestCanonicalJson } from '../packages/domain/src/contracts.ts';
import { GatewayStreamError, ResponsesSseAccountingParser } from '../packages/inference-gateway/src/stream.ts';

/**
 * One operator-authorized route probe, separate from application profile loading.
 * Protocol sources:
 * - https://openrouter.ai/docs/api/api-reference/responses/create-responses
 * - https://openrouter.ai/docs/guides/routing/provider-selection
 * - https://openrouter.ai/docs/api/api-reference/endpoints/list-all-endpoints-for-a-model
 * - https://openrouter.ai/docs/cookbook/administration/usage-accounting
 */

export const OPENROUTER_LIVE_ROUTE_MODEL = 'openai/gpt-6-astra';
export const OPENROUTER_LIVE_ROUTE_PROVIDER = 'openai';
export const OPENROUTER_LIVE_ROUTE_INTENT = '.local/openrouter-live-route-intent.json';
const RESPONSES_URL = 'https://openrouter.ai/api/v1/responses';
const ENDPOINTS_URL = 'https://openrouter.ai/api/v1/models/openai/gpt-6-astra/endpoints';
const INPUT_TOKEN_CEILING = 4_096;
const OUTPUT_TOKEN_CEILING = 256;
const REQUEST_BYTE_LIMIT = 16 * 1024;
const RESPONSE_BYTE_LIMIT = 1024 * 1024;
const EVENT_BYTE_LIMIT = 256 * 1024;
const METADATA_BYTE_LIMIT = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const INTENT_BYTE_LIMIT = 512 * 1024;
const FIXED_INPUT = 'Reply with exactly ROUTE_OK and no other text.';
const DECIMAL_RATE = /^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/;
const DECIMAL_USD = /^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/;

type JsonRecord = Record<string, unknown>;
type EnvironmentSource = Readonly<Record<string, string | undefined>>;

export class LiveRouteProbeError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

type PricingSnapshot = Readonly<{
  source: typeof ENDPOINTS_URL;
  model: typeof OPENROUTER_LIVE_ROUTE_MODEL;
  provider: typeof OPENROUTER_LIVE_ROUTE_PROVIDER;
  providerName: 'OpenAI';
  endpointName: string | null;
  retrievedAt: string;
  ratesUsdPerToken: Readonly<{
    prompt: string;
    completion: string;
    inputCacheRead: string | null;
    inputCacheWrite: string | null;
    internalReasoning: string | null;
  }>;
  fixedRequestUsd: string;
  tierRates: readonly Readonly<{
    minimumPromptTokens: number;
    promptUsdPerToken: string;
    completionUsdPerToken: string;
    inputCacheReadUsdPerToken: string | null;
    inputCacheWriteUsdPerToken: string;
    internalReasoningUsdPerToken: string | null;
    fixedRequestUsd: string;
  }>[];
  supportedParameters: readonly string[];
  digest: `sha256:${string}`;
}>;

export type LiveRouteProbeReport = Readonly<{
  format: 'motive.openrouter-live-route-probe/0.1';
  status: 'DRY_RUN' | 'COMPLETED' | 'COMPLETED_UNVERIFIED' | 'UNKNOWN';
  checkedAt: string;
  request: Readonly<{
    model: typeof OPENROUTER_LIVE_ROUTE_MODEL;
    provider: typeof OPENROUTER_LIVE_ROUTE_PROVIDER;
    serviceTier: 'default';
    inputKind: 'fixed-small-text';
    inputTokenCeiling: typeof INPUT_TOKEN_CEILING;
    outputTokenCeiling: typeof OUTPUT_TOKEN_CEILING;
    tools: false;
    stream: true;
    store: false;
    fallbacks: false;
    retries: 0;
    normalizedBodyDigest: `sha256:${string}`;
    requestBytes: number;
  }>;
  pricing: PricingSnapshot;
  authorization: Readonly<{
    execute: boolean;
    operatorCeilingUsd: string | null;
    maximumExposureUsd: string;
    intentFile: string | null;
    resultFile: string | null;
  }>;
  result: null | Readonly<{
    code: string;
    providerResponseId: string | null;
    returnedModel: string | null;
    returnedProvider: string | null;
    identityVerified: boolean;
    costVerified: boolean;
    actualCostUsd: string | null;
    usage: null | Readonly<{
      inputTokens: number | null;
      outputTokens: number | null;
      totalTokens: number | null;
      cachedInputTokens: number | null;
      cacheWriteInputTokens: number | null;
      reasoningOutputTokens: number | null;
    }>;
    responseBytes: number;
    networkCallsAttempted: 1;
  }>;
  interpretation: 'BOUNDED_STREAMING_ROUTE_PROBE_ONLY';
  limitations: readonly string[];
}>;

type ProbeOptions = Readonly<{
  execute: boolean;
  ceilingUsd?: string;
  intentFile?: string;
  env?: EnvironmentSource;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  projectRoot?: string;
}>;

function fail(code: string, message: string): never { throw new LiveRouteProbeError(code, message); }
function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}
function safeMessage(code: string): string {
  const messages: Record<string, string> = {
    EXECUTE_REQUIRES_CEILING: 'Execution requires an explicit --ceiling-usd value.',
    CEILING_INVALID: 'The operator ceiling must be a positive USD decimal no greater than 1.00.',
    KEY_REQUIRED: 'Execution requires OPENROUTER_API_KEY in the process environment.',
    KEY_INVALID: 'OPENROUTER_API_KEY is malformed.',
    METADATA_UNAVAILABLE: 'Bounded OpenRouter endpoint metadata was unavailable.',
    METADATA_INVALID: 'OpenRouter metadata did not contain one exact standard OpenAI endpoint and complete rates.',
    EXPOSURE_EXCEEDS_CEILING: 'The conservative maximum exposure exceeds the operator ceiling.',
    INTENT_ALREADY_EXISTS: 'The existing intent prevents a replay network call.',
    INTENT_CONFLICT: 'The existing intent was created for different request or ceiling data.',
    INTENT_INVALID: 'The local intent path or file is invalid.',
    RESULT_PERSISTENCE_FAILED: 'The probe result could not be retained; the immutable intent remains UNKNOWN and prevents replay.',
  };
  return messages[code] ?? 'The bounded route probe could not proceed.';
}

export function parseOpenRouterLiveRouteArguments(argv: readonly string[]): { execute: boolean; ceilingUsd?: string } {
  let execute = false; let ceilingUsd: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--execute') { if (execute) fail('ARGUMENT_INVALID', 'Duplicate --execute.'); execute = true; continue; }
    if (item === '--ceiling-usd') {
      const value = argv[++index];
      if (!value || value.startsWith('--') || ceilingUsd !== undefined) fail('ARGUMENT_INVALID', 'Invalid --ceiling-usd.');
      ceilingUsd = value; continue;
    }
    fail('ARGUMENT_INVALID', 'Unknown route-probe argument.');
  }
  if (!execute && ceilingUsd !== undefined) fail('EXECUTE_REQUIRES_CEILING', safeMessage('EXECUTE_REQUIRES_CEILING'));
  if (execute && ceilingUsd === undefined) fail('EXECUTE_REQUIRES_CEILING', safeMessage('EXECUTE_REQUIRES_CEILING'));
  return { execute, ...(ceilingUsd === undefined ? {} : { ceilingUsd }) };
}

function exactCeiling(value: string | undefined): string {
  if (!value || !DECIMAL_USD.test(value)) fail('CEILING_INVALID', safeMessage('CEILING_INVALID'));
  const amount = new Decimal(value);
  if (!amount.isPositive() || amount.greaterThan(1)) fail('CEILING_INVALID', safeMessage('CEILING_INVALID'));
  return amount.toFixed();
}

function fixedRequest(): JsonRecord {
  return {
    input: FIXED_INPUT,
    max_output_tokens: OUTPUT_TOKEN_CEILING,
    model: OPENROUTER_LIVE_ROUTE_MODEL,
    previous_response_id: null,
    provider: { allow_fallbacks: false, only: [OPENROUTER_LIVE_ROUTE_PROVIDER],
      order: [OPENROUTER_LIVE_ROUTE_PROVIDER], require_parameters: true },
    service_tier: 'default',
    store: false,
    stream: true,
    text: { format: { type: 'text' }, verbosity: 'low' },
    tool_choice: 'none',
    tools: [],
    truncation: 'disabled',
  };
}

function requestSummary(body: JsonRecord) {
  const json = canonicalJson(body); const requestBytes = Buffer.byteLength(json);
  if (requestBytes > REQUEST_BYTE_LIMIT) fail('REQUEST_TOO_LARGE', 'The fixed request exceeded its local byte limit.');
  return Object.freeze({
    model: OPENROUTER_LIVE_ROUTE_MODEL, provider: OPENROUTER_LIVE_ROUTE_PROVIDER, serviceTier: 'default' as const,
    inputKind: 'fixed-small-text' as const, inputTokenCeiling: INPUT_TOKEN_CEILING, outputTokenCeiling: OUTPUT_TOKEN_CEILING,
    tools: false as const, stream: true as const, store: false as const, fallbacks: false as const, retries: 0 as const,
    normalizedBodyDigest: digestCanonicalJson(body), requestBytes,
  });
}

async function boundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  if (!response.ok || !response.body) fail('METADATA_UNAVAILABLE', safeMessage('METADATA_UNAVAILABLE'));
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maximumBytes) { await reader.cancel(); fail('METADATA_INVALID', safeMessage('METADATA_INVALID')); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('METADATA_INVALID', safeMessage('METADATA_INVALID')); }
}

function rate(value: unknown, required = false): string | null {
  if (value === undefined || value === null) {
    if (required) fail('METADATA_INVALID', safeMessage('METADATA_INVALID'));
    return null;
  }
  const text = String(value);
  if (!DECIMAL_RATE.test(text) || new Decimal(text).isNegative()) fail('METADATA_INVALID', safeMessage('METADATA_INVALID'));
  return new Decimal(text).toFixed();
}

function tierRates(pricing: JsonRecord): PricingSnapshot['tierRates'] {
  if (pricing.overrides === undefined) return Object.freeze([]);
  if (!Array.isArray(pricing.overrides) || pricing.overrides.length > 20) {
    fail('METADATA_INVALID', safeMessage('METADATA_INVALID'));
  }
  return Object.freeze(pricing.overrides.map(value => {
    const override = record(value);
    if (!override || !Number.isSafeInteger(override.min_prompt_tokens) || Number(override.min_prompt_tokens) < 1) {
      fail('METADATA_INVALID', safeMessage('METADATA_INVALID'));
    }
    const promptUsdPerToken = rate(override.prompt, true)!;
    const completionUsdPerToken = rate(override.completion, true)!;
    const inputCacheWriteUsdPerToken = rate(override.input_cache_write);
    if (inputCacheWriteUsdPerToken === null) fail('METADATA_INVALID', safeMessage('METADATA_INVALID'));
    return Object.freeze({
      minimumPromptTokens: Number(override.min_prompt_tokens), promptUsdPerToken, completionUsdPerToken,
      inputCacheReadUsdPerToken: rate(override.input_cache_read), inputCacheWriteUsdPerToken,
      internalReasoningUsdPerToken: rate(override.internal_reasoning), fixedRequestUsd: rate(override.request) ?? '0',
    });
  }).sort((left, right) => left.minimumPromptTokens - right.minimumPromptTokens));
}

async function pricingSnapshot(fetchProvider: typeof globalThis.fetch, now: () => Date): Promise<PricingSnapshot> {
  let response: Response;
  try { response = await fetchProvider(ENDPOINTS_URL, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000) }); }
  catch { fail('METADATA_UNAVAILABLE', safeMessage('METADATA_UNAVAILABLE')); }
  const root = record(await boundedJson(response, METADATA_BYTE_LIMIT)); const data = record(root?.data);
  if (data?.id !== OPENROUTER_LIVE_ROUTE_MODEL || !Array.isArray(data.endpoints) || data.endpoints.length > 200) {
    fail('METADATA_INVALID', safeMessage('METADATA_INVALID'));
  }
  const matches = data.endpoints.map(record).filter((endpoint): endpoint is JsonRecord => endpoint !== null
    && endpoint.tag === OPENROUTER_LIVE_ROUTE_PROVIDER && endpoint.provider_name === 'OpenAI');
  if (matches.length !== 1) fail('METADATA_INVALID', safeMessage('METADATA_INVALID'));
  const endpoint = matches[0]!; const pricing = record(endpoint.pricing);
  if (!pricing) fail('METADATA_INVALID', safeMessage('METADATA_INVALID'));
  const prompt = rate(pricing.prompt, true)!; const completion = rate(pricing.completion, true)!;
  const inputCacheWrite = rate(pricing.input_cache_write);
  if (inputCacheWrite === null) fail('METADATA_INVALID', safeMessage('METADATA_INVALID'));
  const base = {
    source: ENDPOINTS_URL as typeof ENDPOINTS_URL,
    model: OPENROUTER_LIVE_ROUTE_MODEL as typeof OPENROUTER_LIVE_ROUTE_MODEL,
    provider: OPENROUTER_LIVE_ROUTE_PROVIDER as typeof OPENROUTER_LIVE_ROUTE_PROVIDER,
    providerName: 'OpenAI' as const,
    endpointName: typeof endpoint.name === 'string' && endpoint.name.length <= 256 ? endpoint.name : null,
    retrievedAt: now().toISOString(),
    ratesUsdPerToken: {
      prompt, completion, inputCacheRead: rate(pricing.input_cache_read), inputCacheWrite,
      internalReasoning: rate(pricing.internal_reasoning),
    },
    fixedRequestUsd: rate(pricing.request) ?? '0',
    tierRates: tierRates(pricing),
    supportedParameters: Object.freeze(Array.isArray(endpoint.supported_parameters)
      ? endpoint.supported_parameters.filter((item): item is string => typeof item === 'string' && item.length <= 128).slice(0, 128).sort()
      : []),
  };
  return Object.freeze({ ...base, digest: digestCanonicalJson(base) });
}

function maximumExposure(snapshot: PricingSnapshot): string {
  const inputRates = [snapshot.ratesUsdPerToken.prompt, snapshot.ratesUsdPerToken.inputCacheRead,
    snapshot.ratesUsdPerToken.inputCacheWrite].filter((item): item is string => item !== null).map(item => new Decimal(item));
  const outputRates = [snapshot.ratesUsdPerToken.completion, snapshot.ratesUsdPerToken.internalReasoning]
    .filter((item): item is string => item !== null).map(item => new Decimal(item));
  const fixedRates = [new Decimal(snapshot.fixedRequestUsd)];
  for (const tier of snapshot.tierRates) {
    inputRates.push(new Decimal(tier.promptUsdPerToken), new Decimal(tier.inputCacheWriteUsdPerToken));
    if (tier.inputCacheReadUsdPerToken !== null) inputRates.push(new Decimal(tier.inputCacheReadUsdPerToken));
    outputRates.push(new Decimal(tier.completionUsdPerToken));
    if (tier.internalReasoningUsdPerToken !== null) outputRates.push(new Decimal(tier.internalReasoningUsdPerToken));
    fixedRates.push(new Decimal(tier.fixedRequestUsd));
  }
  const total = Decimal.max(...inputRates).times(INPUT_TOKEN_CEILING)
    .plus(Decimal.max(...outputRates).times(OUTPUT_TOKEN_CEILING)).plus(Decimal.max(...fixedRates));
  return total.toDecimalPlaces(12, Decimal.ROUND_CEIL).toFixed(12);
}

function resolveIntentPath(projectRoot: string, configured: string): string {
  if (isAbsolute(configured) || configured.includes('\0')) fail('INTENT_INVALID', safeMessage('INTENT_INVALID'));
  const root = resolve(projectRoot); const candidate = resolve(root, configured); const inside = relative(root, candidate);
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)
      || !inside.replaceAll('\\', '/').startsWith('.local/') || !inside.endsWith('.json')) {
    fail('INTENT_INVALID', safeMessage('INTENT_INVALID'));
  }
  return candidate;
}

function resultPathForIntent(intentPath: string): string {
  return intentPath.slice(0, -'.json'.length) + '.result.json';
}

async function existingIntent(path: string): Promise<JsonRecord | null> {
  try {
    const info = await stat(path); if (!info.isFile() || info.size < 2 || info.size > INTENT_BYTE_LIMIT) fail('INTENT_INVALID', safeMessage('INTENT_INVALID'));
    return record(JSON.parse(await readFile(path, 'utf8'))) ?? fail('INTENT_INVALID', safeMessage('INTENT_INVALID'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof LiveRouteProbeError) throw error;
    fail('INTENT_INVALID', safeMessage('INTENT_INVALID'));
  }
}

function assertNoReplay(intent: JsonRecord, requestDigest: string, ceilingUsd: string): never {
  const authorization = record(intent.authorization);
  if (record(intent.request)?.normalizedBodyDigest !== requestDigest || authorization?.operatorCeilingUsd !== ceilingUsd) {
    fail('INTENT_CONFLICT', safeMessage('INTENT_CONFLICT'));
  }
  fail('INTENT_ALREADY_EXISTS', safeMessage('INTENT_ALREADY_EXISTS'));
}

async function persistExclusive(path: string, value: unknown, failureCode: 'INTENT_INVALID' | 'RESULT_PERSISTENCE_FAILED'): Promise<void> {
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
  if (bytes.byteLength > INTENT_BYTE_LIMIT) fail(failureCode, safeMessage(failureCode));
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, 'wx', 0o600);
    await handle.write(bytes, 0, bytes.byteLength, 0);
    await handle.sync();
  } catch (error) {
    if (error instanceof LiveRouteProbeError) throw error;
    fail(failureCode, safeMessage(failureCode));
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function terminalSummary(bytes: Uint8Array): { responseId: string | null; model: string | null; provider: string | null; cost: string | null } | null {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
  const terminals: JsonRecord[] = [];
  for (const frame of text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n\n')) {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') continue;
    try { const event = record(JSON.parse(data)); if (event && ['response.completed', 'response.done'].includes(String(event.type))) terminals.push(event); }
    catch { return null; }
  }
  if (terminals.length !== 1) return null;
  const response = record(terminals[0]!.response); if (!response || response.status !== 'completed') return null;
  const metadata = record(response.openrouter_metadata); const usage = record(response.usage);
  const providers = [response.provider, response.provider_name, metadata?.provider, metadata?.provider_name]
    .filter((item): item is string => typeof item === 'string');
  const provider = providers.length === 0 ? null : providers.every(item => item === providers[0]) ? providers[0]! : '__conflict__';
  const cost = usage && (typeof usage.cost === 'string' || typeof usage.cost === 'number') && DECIMAL_RATE.test(String(usage.cost))
    ? new Decimal(String(usage.cost)).toFixed(12) : null;
  return {
    responseId: typeof response.id === 'string' && response.id.length <= 512 ? response.id : null,
    model: typeof response.model === 'string' && response.model.length <= 512 ? response.model : null,
    provider,
    cost,
  };
}

function baseReport(input: { status: LiveRouteProbeReport['status']; now: string; request: ReturnType<typeof requestSummary>;
  pricing: PricingSnapshot; execute: boolean; ceiling: string | null; exposure: string; intentFile: string | null; resultFile: string | null;
  result: LiveRouteProbeReport['result'] }): LiveRouteProbeReport {
  return Object.freeze({
    format: 'motive.openrouter-live-route-probe/0.1', status: input.status, checkedAt: input.now,
    request: input.request, pricing: input.pricing,
    authorization: { execute: input.execute, operatorCeilingUsd: input.ceiling,
      maximumExposureUsd: input.exposure, intentFile: input.intentFile, resultFile: input.resultFile },
    result: input.result,
    interpretation: 'BOUNDED_STREAMING_ROUTE_PROBE_ONLY',
    limitations: Object.freeze([
      'This evidence covers one small text-only streaming Responses request.',
      'It does not validate Codex, tools, files, sandbox execution, retries, compaction, or evaluator compatibility.',
      'It does not create or approve a reviewed-live profile, work order, budget, controller state, or runtime.',
    ]),
  });
}

export async function probeOpenRouterLiveRoute(options: ProbeOptions): Promise<LiveRouteProbeReport> {
  const env = options.env ?? process.env; const fetchProvider = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date()); const body = fixedRequest(); const request = requestSummary(body);
  let ceiling: string | null = null; let key: string | null = null;
  if (options.execute) {
    if (options.ceilingUsd === undefined) fail('EXECUTE_REQUIRES_CEILING', safeMessage('EXECUTE_REQUIRES_CEILING'));
    ceiling = exactCeiling(options.ceilingUsd); key = env.OPENROUTER_API_KEY?.trim() ?? null;
    if (!key) fail('KEY_REQUIRED', safeMessage('KEY_REQUIRED'));
    if (key.length < 16 || key.length > 8_192 || !/^[\x21-\x7e]+$/.test(key)) fail('KEY_INVALID', safeMessage('KEY_INVALID'));
  }
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const intentPath = options.execute ? resolveIntentPath(projectRoot, options.intentFile ?? OPENROUTER_LIVE_ROUTE_INTENT) : null;
  const resultPath = intentPath === null ? null : resultPathForIntent(intentPath);
  if (intentPath) {
    const existing = await existingIntent(intentPath); if (existing) assertNoReplay(existing, request.normalizedBodyDigest, ceiling!);
    const existingResult = await existingIntent(resultPath!); if (existingResult) assertNoReplay(existingResult, request.normalizedBodyDigest, ceiling!);
  }

  const pricing = await pricingSnapshot(fetchProvider, now); const exposure = maximumExposure(pricing);
  if (!options.execute) return baseReport({ status: 'DRY_RUN', now: now().toISOString(), request, pricing,
    execute: false, ceiling: null, exposure, intentFile: null, resultFile: null, result: null });
  if (new Decimal(exposure).greaterThan(ceiling!)) fail('EXPOSURE_EXCEEDS_CEILING', safeMessage('EXPOSURE_EXCEEDS_CEILING'));

  const intent = baseReport({ status: 'UNKNOWN', now: now().toISOString(), request, pricing, execute: true,
    ceiling, exposure, intentFile: relative(projectRoot, intentPath!).replaceAll('\\', '/'),
    resultFile: relative(projectRoot, resultPath!).replaceAll('\\', '/'), result: null });
  try { await persistExclusive(intentPath!, intent, 'INTENT_INVALID'); }
  catch (error) {
    if ((error as LiveRouteProbeError).code === 'INTENT_INVALID') {
      const existing = await existingIntent(intentPath!); if (existing) assertNoReplay(existing, request.normalizedBodyDigest, ceiling!);
    }
    throw error;
  }

  let responseBytes = 0; const chunks: Uint8Array[] = [];
  const parser = new ResponsesSseAccountingParser({ maxTotalBytes: RESPONSE_BYTE_LIMIT,
    maxEventBytes: EVENT_BYTE_LIMIT, expectedModel: OPENROUTER_LIVE_ROUTE_MODEL, maximumExposure: exposure as `${number}` });
  let report: LiveRouteProbeReport;
  try {
    const response = await fetchProvider(RESPONSES_URL, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${key!}`, 'Content-Type': 'application/json', Accept: 'text/event-stream',
        'X-OpenRouter-Metadata': 'enabled' }, body: canonicalJson(body) });
    if (!response.ok || !response.body || !(response.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream')) {
      throw new LiveRouteProbeError('UPSTREAM_RESPONSE_UNVERIFIED', 'The upstream response could not be verified.');
    }
    const reader = response.body.getReader();
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        responseBytes += chunk.value.byteLength;
        if (responseBytes > RESPONSE_BYTE_LIMIT) { await reader.cancel(); throw new LiveRouteProbeError('RESPONSE_TOO_LARGE', 'The response exceeded its byte limit.'); }
        const copy = Uint8Array.from(chunk.value); chunks.push(copy); parser.push(copy);
      }
    } finally { reader.releaseLock(); }
    const allBytes = Buffer.concat(chunks.map(chunk => Buffer.from(chunk))); const shadow = terminalSummary(allBytes);
    try {
      const terminal = parser.finish();
      const providerValid = terminal.returnedProvider !== null && terminal.returnedProvider.toLowerCase() === 'openai';
      if (terminal.returnedProvider !== null && !providerValid) throw new LiveRouteProbeError('RETURNED_PROVIDER_MISMATCH', 'Provider identity did not match.');
      const status = providerValid ? 'COMPLETED' : 'COMPLETED_UNVERIFIED';
      report = baseReport({ status, now: now().toISOString(), request, pricing, execute: true, ceiling, exposure,
        intentFile: intent.authorization.intentFile, resultFile: intent.authorization.resultFile,
        result: { code: providerValid ? 'STREAMING_ROUTE_VERIFIED' : 'PROVIDER_IDENTITY_ABSENT',
          providerResponseId: terminal.providerResponseId, returnedModel: terminal.returnedModel,
          returnedProvider: terminal.returnedProvider, identityVerified: providerValid, costVerified: true,
          actualCostUsd: terminal.actualCost, usage: { inputTokens: terminal.usage.inputTokens,
            outputTokens: terminal.usage.outputTokens, totalTokens: terminal.usage.totalTokens,
            cachedInputTokens: terminal.usage.cachedInputTokens, cacheWriteInputTokens: terminal.usage.cacheWriteInputTokens,
            reasoningOutputTokens: terminal.usage.reasoningOutputTokens }, responseBytes, networkCallsAttempted: 1 } });
    } catch (error) {
      const expectedMissing = error instanceof GatewayStreamError && shadow !== null
        && (shadow.model === null || shadow.cost === null || shadow.responseId === null);
      if (!expectedMissing) throw error;
      const providerValid = shadow.provider === null || shadow.provider.toLowerCase() === 'openai';
      if (!providerValid || (shadow.model !== null && shadow.model !== OPENROUTER_LIVE_ROUTE_MODEL)) {
        throw new LiveRouteProbeError('RETURNED_IDENTITY_MISMATCH', 'Returned identity did not match.');
      }
      report = baseReport({ status: 'COMPLETED_UNVERIFIED', now: now().toISOString(), request, pricing, execute: true,
        ceiling, exposure, intentFile: intent.authorization.intentFile, resultFile: intent.authorization.resultFile,
        result: { code: 'TERMINAL_EVIDENCE_INCOMPLETE', providerResponseId: shadow.responseId,
          returnedModel: shadow.model, returnedProvider: shadow.provider, identityVerified: false,
          costVerified: shadow.cost !== null, actualCostUsd: shadow.cost, usage: null,
          responseBytes, networkCallsAttempted: 1 } });
    }
  } catch {
    report = baseReport({ status: 'UNKNOWN', now: now().toISOString(), request, pricing, execute: true, ceiling, exposure,
      intentFile: intent.authorization.intentFile, resultFile: intent.authorization.resultFile,
      result: { code: 'NETWORK_OR_STREAM_OUTCOME_UNKNOWN', providerResponseId: parser.responseId,
        returnedModel: null, returnedProvider: null, identityVerified: false, costVerified: false,
        actualCostUsd: null, usage: null, responseBytes, networkCallsAttempted: 1 } });
  }
  await persistExclusive(resultPath!, report, 'RESULT_PERSISTENCE_FAILED');
  return report;
}

async function main() {
  try {
    const args = parseOpenRouterLiveRouteArguments(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(await probeOpenRouterLiveRoute(args), null, 2)}\n`);
  } catch (error) {
    const code = error instanceof LiveRouteProbeError ? error.code : 'PROBE_FAILED';
    process.stderr.write(`${JSON.stringify({ status: 'ERROR', code, message: safeMessage(code) })}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
