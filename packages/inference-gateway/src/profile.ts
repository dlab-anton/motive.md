import Decimal from 'decimal.js';
import { canonicalJson, digestCanonicalJson, type DecimalAmount, type Digest } from '../../domain/src/contracts.ts';
import { compareAmounts, exactAmount, reservationAmount } from '../../accounting/src/money.ts';
import {
  GatewayProtocolError,
  assertExactKeys,
  deepFreeze,
  isPlainRecord,
  type ValidatedGatewayRequest,
} from './protocol.ts';

export type LocalToolType = 'function' | 'custom' | 'local_shell';

export type GatewayProfile = Readonly<{
  format: 'motive.gateway-profile/0.1';
  profileId: string;
  status: 'test-only-local-mock' | 'reviewed-live';
  upstream: Readonly<{
    responsesUrl: string;
    credentialRef: string;
  }>;
  route: Readonly<{
    model: string;
    provider: Readonly<{
      order: readonly string[];
      allowFallbacks: false;
      requireParameters: true;
    }> | null;
  }>;
  limits: Readonly<{
    maxRequestBytes: number;
    maxResponseBytes: number;
    maxEventBytes: number;
    requestTimeoutMs: number;
    maxInputItems: number;
    maxTools: number;
    contextWindowTokens: number;
    maxOutputTokens: number;
  }>;
  requestPolicy: Readonly<{
    allowedLocalTools: readonly Readonly<{ type: LocalToolType; name: string }>[];
    allowedReasoningEfforts: readonly string[];
    allowParallelToolCalls: boolean;
    allowTemperature: boolean;
    allowTopP: boolean;
    /** Reject by default; the opt-in is pinned to one reviewed stock Codex wire extension. */
    codexClientMetadata: 'reject' | 'drop-pinned-0.153.4';
  }>;
  pricing: Readonly<{
    currency: 'USD';
    highestInputUsdPerMillionTokens: DecimalAmount;
    highestOutputUsdPerMillionTokens: DecimalAmount;
    fixedRequestUsd: DecimalAmount;
    worstCaseAdditionalUsd: DecimalAmount;
    approvedMaximumExposureUsd: DecimalAmount;
  }>;
  evidence: Readonly<{
    kind: 'local-mock' | 'gate-a-reviewed';
    reviewedAt: string;
    reviewedBy: string;
    pricingSource: string;
    responsesCompatibilitySource: string;
  }>;
}>;

const ProfileDecimal = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_CEIL, toExpNeg: -100, toExpPos: 100 });
const JSON_ENCODER = new TextEncoder();
const OPENROUTER_RESPONSES_URL = 'https://openrouter.ai/api/v1/responses';
const PROCESS_LIMITS = Object.freeze({
  maxRequestBytes: 4 * 1024 * 1024,
  maxResponseBytes: 64 * 1024 * 1024,
  maxEventBytes: 8 * 1024 * 1024,
  requestTimeoutMs: 15 * 60 * 1_000,
});

export const SUPPORTED_REQUEST_BODY_FIELDS = Object.freeze([
  'model', 'input', 'instructions', 'stream', 'store', 'previous_response_id', 'max_output_tokens',
  'tools', 'tool_choice', 'parallel_tool_calls', 'reasoning', 'include', 'prompt_cache_key', 'text',
  'temperature', 'top_p', 'truncation',
] as const);

const PROFILE_KEYS = ['format', 'profileId', 'status', 'upstream', 'route', 'limits', 'requestPolicy', 'pricing', 'evidence'] as const;
const UNSAFE_MARKER = /(?:replace(?:[_ -]?with)?|placeholder|unresolved|not[-_ ]?runnable|todo|tbd)/i;
const INPUT_ITEM_TYPES = new Set([
  'message', 'reasoning', 'function_call', 'function_call_output', 'custom_tool_call',
  'custom_tool_call_output', 'local_shell_call', 'local_shell_call_output',
]);
const REMOTE_OR_MEDIA_TYPES = new Set([
  'input_image', 'input_file', 'computer_call', 'computer_call_output', 'file_search_call',
  'image_generation_call', 'mcp_call', 'mcp_approval_request', 'mcp_approval_response',
  'web_search_call', 'web_search_preview', 'web_search', 'code_interpreter_call',
]);
const PINNED_CODEX_METADATA_KEYS = Object.freeze([
  'root_turn_id', 'session_id', 'thread_id', 'turn_id', 'x-codex-installation-id',
  'x-codex-turn-metadata', 'x-codex-window-id',
] as const);
const PINNED_CODEX_TURN_METADATA_KEY = 'x-codex-turn-metadata';
const PINNED_CODEX_METADATA_MAX_VALUE_BYTES = 2_048;
const PINNED_CODEX_METADATA_MAX_TOTAL_BYTES = 8_192;
const PINNED_CODEX_ID_MAX_BYTES = 128;

function fail(code: string, message: string): never {
  throw new GatewayProtocolError(code, message);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainRecord(value)) fail('INVALID_PROFILE', `${path} must be an object.`);
  return value;
}

function nonemptyString(value: unknown, path: string, maximum = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || UNSAFE_MARKER.test(value)) {
    fail('INVALID_PROFILE', `${path} must be a resolved non-empty string.`);
  }
  return value;
}

function positiveSafeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) fail('INVALID_PROFILE', `${path} must be a positive safe integer.`);
  return value as number;
}

function decimal(value: unknown, path: string): DecimalAmount {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    fail('INVALID_PROFILE', `${path} must be a non-negative decimal string.`);
  }
  try {
    return exactAmount(value, path);
  } catch {
    fail('INVALID_PROFILE', `${path} is outside the supported USD amount range or precision.`);
  }
}

function cloneJson<T>(value: T): T {
  try {
    return JSON.parse(canonicalJson(value)) as T;
  } catch {
    fail('INVALID_JSON', 'Value must contain only finite, acyclic JSON data.');
  }
}

function assertNoUnsafeMarkers(value: unknown, path: string): void {
  if (value === null) fail('INCOMPLETE_PROFILE', `${path} cannot be null.`);
  if (typeof value === 'string' && UNSAFE_MARKER.test(value)) fail('INCOMPLETE_PROFILE', `${path} is unresolved.`);
  if (Array.isArray(value)) value.forEach((child, index) => assertNoUnsafeMarkers(child, `${path}[${index}]`));
  else if (isPlainRecord(value)) {
    for (const [key, child] of Object.entries(value)) assertNoUnsafeMarkers(child, `${path}.${key}`);
  }
}

export function estimateMaximumExposure(profile: Readonly<GatewayProfile>): DecimalAmount {
  const input = new ProfileDecimal(profile.pricing.highestInputUsdPerMillionTokens)
    .times(profile.limits.contextWindowTokens)
    .dividedBy(1_000_000);
  const output = new ProfileDecimal(profile.pricing.highestOutputUsdPerMillionTokens)
    .times(profile.limits.maxOutputTokens)
    .dividedBy(1_000_000);
  const total = input
    .plus(output)
    .plus(profile.pricing.fixedRequestUsd)
    .plus(profile.pricing.worstCaseAdditionalUsd);
  return reservationAmount(total.toFixed(50), 'computed maximum exposure');
}

export function validateAndFreezeProfile(value: unknown): Readonly<GatewayProfile> {
  const root = record(value, 'profile');
  assertExactKeys(root, PROFILE_KEYS, 'profile');
  if (root.format !== 'motive.gateway-profile/0.1') fail('INVALID_PROFILE', 'profile.format is unsupported.');
  if (root.status !== 'test-only-local-mock' && root.status !== 'reviewed-live') {
    fail('INCOMPLETE_PROFILE', 'profile.status is not runnable.');
  }

  const upstream = record(root.upstream, 'profile.upstream');
  assertExactKeys(upstream, ['responsesUrl', 'credentialRef'], 'profile.upstream');
  const responsesUrl = nonemptyString(upstream.responsesUrl, 'profile.upstream.responsesUrl', 2048);
  let parsedUrl: URL;
  try { parsedUrl = new URL(responsesUrl); } catch { fail('INVALID_PROFILE', 'profile.upstream.responsesUrl must be an absolute URL.'); }
  if (!parsedUrl.pathname.endsWith('/responses') || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    fail('INVALID_PROFILE', 'profile.upstream.responsesUrl must be a credential-free Responses endpoint URL.');
  }
  const credentialRef = nonemptyString(upstream.credentialRef, 'profile.upstream.credentialRef');

  const route = record(root.route, 'profile.route');
  assertExactKeys(route, ['model', 'provider'], 'profile.route');
  const model = nonemptyString(route.model, 'profile.route.model');
  let provider: GatewayProfile['route']['provider'] = null;
  if (route.provider !== null) {
    const candidate = record(route.provider, 'profile.route.provider');
    assertExactKeys(candidate, ['order', 'allowFallbacks', 'requireParameters'], 'profile.route.provider');
    if (!Array.isArray(candidate.order) || candidate.order.length !== 1) fail('INVALID_PROFILE', 'profile.route.provider.order must pin exactly one provider.');
    const order = [nonemptyString(candidate.order[0], 'profile.route.provider.order[0]')];
    if (candidate.allowFallbacks !== false || candidate.requireParameters !== true) {
      fail('INVALID_PROFILE', 'profile route must disable fallbacks and require parameter support.');
    }
    provider = { order, allowFallbacks: false, requireParameters: true };
  }

  const limits = record(root.limits, 'profile.limits');
  assertExactKeys(limits, ['maxRequestBytes', 'maxResponseBytes', 'maxEventBytes', 'requestTimeoutMs', 'maxInputItems', 'maxTools', 'contextWindowTokens', 'maxOutputTokens'], 'profile.limits');
  const validatedLimits = {
    maxRequestBytes: positiveSafeInteger(limits.maxRequestBytes, 'profile.limits.maxRequestBytes'),
    maxResponseBytes: positiveSafeInteger(limits.maxResponseBytes, 'profile.limits.maxResponseBytes'),
    maxEventBytes: positiveSafeInteger(limits.maxEventBytes, 'profile.limits.maxEventBytes'),
    requestTimeoutMs: positiveSafeInteger(limits.requestTimeoutMs, 'profile.limits.requestTimeoutMs'),
    maxInputItems: positiveSafeInteger(limits.maxInputItems, 'profile.limits.maxInputItems'),
    maxTools: positiveSafeInteger(limits.maxTools, 'profile.limits.maxTools'),
    contextWindowTokens: positiveSafeInteger(limits.contextWindowTokens, 'profile.limits.contextWindowTokens'),
    maxOutputTokens: positiveSafeInteger(limits.maxOutputTokens, 'profile.limits.maxOutputTokens'),
  };
  for (const field of ['maxRequestBytes', 'maxResponseBytes', 'maxEventBytes', 'requestTimeoutMs'] as const) {
    if (validatedLimits[field] > PROCESS_LIMITS[field]) {
      fail('INVALID_PROFILE', `profile.limits.${field} exceeds the gateway process limit.`);
    }
  }
  if (validatedLimits.maxEventBytes > validatedLimits.maxResponseBytes) fail('INVALID_PROFILE', 'maxEventBytes cannot exceed maxResponseBytes.');
  if (validatedLimits.maxOutputTokens > validatedLimits.contextWindowTokens) fail('INVALID_PROFILE', 'maxOutputTokens cannot exceed contextWindowTokens.');

  const requestPolicy = record(root.requestPolicy, 'profile.requestPolicy');
  assertExactKeys(requestPolicy, ['allowedLocalTools', 'allowedReasoningEfforts', 'allowParallelToolCalls', 'allowTemperature', 'allowTopP', 'codexClientMetadata'], 'profile.requestPolicy');
  if (!Array.isArray(requestPolicy.allowedLocalTools) || requestPolicy.allowedLocalTools.length > validatedLimits.maxTools) {
    fail('INVALID_PROFILE', 'profile.requestPolicy.allowedLocalTools exceeds the tool limit.');
  }
  const toolKeys = new Set<string>();
  const allowedLocalTools = requestPolicy.allowedLocalTools.map((tool, index) => {
    const candidate = record(tool, `profile.requestPolicy.allowedLocalTools[${index}]`);
    assertExactKeys(candidate, ['type', 'name'], `profile.requestPolicy.allowedLocalTools[${index}]`);
    if (!['function', 'custom', 'local_shell'].includes(String(candidate.type))) fail('INVALID_PROFILE', 'Only local tool types may be approved.');
    const name = nonemptyString(candidate.name, `profile.requestPolicy.allowedLocalTools[${index}].name`, 128);
    const key = `${candidate.type}:${name}`;
    if (toolKeys.has(key)) fail('INVALID_PROFILE', 'Approved local tools must be unique.');
    toolKeys.add(key);
    return { type: candidate.type as LocalToolType, name };
  });
  if (!Array.isArray(requestPolicy.allowedReasoningEfforts) || requestPolicy.allowedReasoningEfforts.some(item => typeof item !== 'string' || !['minimal', 'low', 'medium', 'high'].includes(item))) {
    fail('INVALID_PROFILE', 'profile.requestPolicy.allowedReasoningEfforts is invalid.');
  }
  const allowedReasoningEfforts = [...new Set(requestPolicy.allowedReasoningEfforts as string[])];
  for (const key of ['allowParallelToolCalls', 'allowTemperature', 'allowTopP'] as const) {
    if (typeof requestPolicy[key] !== 'boolean') fail('INVALID_PROFILE', `profile.requestPolicy.${key} must be boolean.`);
  }
  const codexClientMetadata = requestPolicy.codexClientMetadata ?? 'reject';
  if (!['reject', 'drop-pinned-0.153.4'].includes(String(codexClientMetadata))) {
    fail('INVALID_PROFILE', 'profile.requestPolicy.codexClientMetadata is unsupported.');
  }

  const pricing = record(root.pricing, 'profile.pricing');
  assertExactKeys(pricing, ['currency', 'highestInputUsdPerMillionTokens', 'highestOutputUsdPerMillionTokens', 'fixedRequestUsd', 'worstCaseAdditionalUsd', 'approvedMaximumExposureUsd'], 'profile.pricing');
  if (pricing.currency !== 'USD') fail('INVALID_PROFILE', 'Only the initial USD accounting profile is supported.');
  const validatedPricing = {
    currency: 'USD' as const,
    highestInputUsdPerMillionTokens: decimal(pricing.highestInputUsdPerMillionTokens, 'profile.pricing.highestInputUsdPerMillionTokens'),
    highestOutputUsdPerMillionTokens: decimal(pricing.highestOutputUsdPerMillionTokens, 'profile.pricing.highestOutputUsdPerMillionTokens'),
    fixedRequestUsd: decimal(pricing.fixedRequestUsd, 'profile.pricing.fixedRequestUsd'),
    worstCaseAdditionalUsd: decimal(pricing.worstCaseAdditionalUsd, 'profile.pricing.worstCaseAdditionalUsd'),
    approvedMaximumExposureUsd: decimal(pricing.approvedMaximumExposureUsd, 'profile.pricing.approvedMaximumExposureUsd'),
  };

  const evidence = record(root.evidence, 'profile.evidence');
  assertExactKeys(evidence, ['kind', 'reviewedAt', 'reviewedBy', 'pricingSource', 'responsesCompatibilitySource'], 'profile.evidence');
  if (evidence.kind !== 'local-mock' && evidence.kind !== 'gate-a-reviewed') fail('INCOMPLETE_PROFILE', 'profile.evidence.kind is not accepted.');
  const validatedEvidence = {
    kind: evidence.kind,
    reviewedAt: nonemptyString(evidence.reviewedAt, 'profile.evidence.reviewedAt'),
    reviewedBy: nonemptyString(evidence.reviewedBy, 'profile.evidence.reviewedBy'),
    pricingSource: nonemptyString(evidence.pricingSource, 'profile.evidence.pricingSource', 2048),
    responsesCompatibilitySource: nonemptyString(evidence.responsesCompatibilitySource, 'profile.evidence.responsesCompatibilitySource', 2048),
  } as GatewayProfile['evidence'];
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*Z)?$/.test(validatedEvidence.reviewedAt)) fail('INVALID_PROFILE', 'profile.evidence.reviewedAt must be an ISO date or UTC timestamp.');

  const normalized: GatewayProfile = {
    format: 'motive.gateway-profile/0.1',
    profileId: nonemptyString(root.profileId, 'profile.profileId'),
    status: root.status,
    upstream: { responsesUrl, credentialRef },
    route: { model, provider },
    limits: validatedLimits,
    requestPolicy: {
      allowedLocalTools,
      allowedReasoningEfforts,
      allowParallelToolCalls: requestPolicy.allowParallelToolCalls as boolean,
      allowTemperature: requestPolicy.allowTemperature as boolean,
      allowTopP: requestPolicy.allowTopP as boolean,
      codexClientMetadata: codexClientMetadata as GatewayProfile['requestPolicy']['codexClientMetadata'],
    },
    pricing: validatedPricing,
    evidence: validatedEvidence,
  };

  if (normalized.status === 'test-only-local-mock') {
    const literalLoopback = /^https?:\/\/(?:127\.0\.0\.1|\[::1\])(?::\d+)?\//.test(normalized.upstream.responsesUrl);
    if (normalized.evidence.kind !== 'local-mock' || !literalLoopback || !['127.0.0.1', '[::1]'].includes(parsedUrl.hostname) || !normalized.upstream.credentialRef.startsWith('fixture:')) {
      fail('INVALID_PROFILE', 'A test-only profile must use explicit local-mock evidence, an HTTP(S) literal loopback endpoint, and a fixture credential reference.');
    }
  } else {
    if (normalized.evidence.kind !== 'gate-a-reviewed' || normalized.upstream.responsesUrl !== OPENROUTER_RESPONSES_URL || normalized.route.provider === null || normalized.upstream.credentialRef.startsWith('fixture:')) {
      fail('INCOMPLETE_PROFILE', 'A reviewed live profile requires the pinned OpenRouter Responses endpoint, one pinned provider, a non-fixture credential reference, and Gate A evidence.');
    }
    assertNoUnsafeMarkers(normalized, 'profile');
  }

  const computed = estimateMaximumExposure(normalized);
  if (compareAmounts(normalized.pricing.approvedMaximumExposureUsd, computed) < 0) {
    fail('UNSAFE_PRICING', 'Approved maximum exposure is below the frozen full-context tariff calculation.');
  }
  return deepFreeze(cloneJson(normalized)) as Readonly<GatewayProfile>;
}

export function profileDigest(profile: Readonly<GatewayProfile>): Digest {
  return digestCanonicalJson(profile);
}

function validatePinnedCodexClientMetadata(value: unknown): Digest {
  if (!isPlainRecord(value)) fail('INVALID_REQUEST', 'request.client_metadata must be an object.');
  assertExactKeys(value, PINNED_CODEX_METADATA_KEYS, 'request.client_metadata');
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string' || item.length === 0) {
      fail('INVALID_REQUEST', `request.client_metadata.${key} must be a non-empty string.`);
    }
    const bytes = JSON_ENCODER.encode(item).byteLength;
    const maximum = key === PINNED_CODEX_TURN_METADATA_KEY
      ? PINNED_CODEX_METADATA_MAX_VALUE_BYTES
      : PINNED_CODEX_ID_MAX_BYTES;
    if (bytes > maximum) fail('INVALID_REQUEST', `request.client_metadata.${key} exceeds the pinned Codex bound.`);
  }
  const canonical = canonicalJson(value);
  if (JSON_ENCODER.encode(canonical).byteLength > PINNED_CODEX_METADATA_MAX_TOTAL_BYTES) {
    fail('INVALID_REQUEST', 'request.client_metadata exceeds the pinned Codex total bound.');
  }
  return digestCanonicalJson(value);
}

function inspectInputValue(value: unknown, path: string, depth = 0): void {
  if (depth > 32) fail('INVALID_REQUEST', `${path} exceeds the maximum nesting depth.`);
  if (Array.isArray(value)) {
    value.forEach((child, index) => inspectInputValue(child, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!isPlainRecord(value)) return;
  if (typeof value.type === 'string') {
    if (REMOTE_OR_MEDIA_TYPES.has(value.type)) fail('UNSUPPORTED_INPUT', `${path} contains a remote or media item.`);
    if (path.startsWith('request.input') && depth === 0 && !INPUT_ITEM_TYPES.has(value.type)) {
      fail('UNSUPPORTED_INPUT', `${path}.type is unsupported.`);
    }
  }
  for (const [key, child] of Object.entries(value)) inspectInputValue(child, `${path}.${key}`, depth + 1);
}

function validateInput(value: unknown, profile: Readonly<GatewayProfile>): void {
  if (typeof value === 'string') {
    if (value.length === 0) fail('INVALID_REQUEST', 'request.input cannot be empty.');
    return;
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > profile.limits.maxInputItems) {
    fail('INVALID_REQUEST', 'request.input must be a non-empty bounded string or item array.');
  }
  value.forEach((item, index) => {
    if (!isPlainRecord(item) || typeof item.type !== 'string' || !INPUT_ITEM_TYPES.has(item.type)) {
      fail('UNSUPPORTED_INPUT', `request.input[${index}] has an unsupported item type.`);
    }
    if (item.type === 'message') {
      if (!['system', 'developer', 'user', 'assistant'].includes(String(item.role))) fail('UNSUPPORTED_INPUT', `request.input[${index}].role is unsupported.`);
      if (item.role === 'assistant' && (typeof item.id !== 'string' || item.id.length === 0 || typeof item.status !== 'string')) {
        fail('INVALID_REQUEST', `request.input[${index}] assistant history must retain id and status.`);
      }
    }
    inspectInputValue(item, `request.input[${index}]`);
  });
}

function validateTools(value: unknown, profile: Readonly<GatewayProfile>): void {
  if (!Array.isArray(value) || value.length > profile.limits.maxTools) fail('INVALID_REQUEST', 'request.tools must be a bounded array.');
  const allowed = new Set(profile.requestPolicy.allowedLocalTools.map(tool => `${tool.type}:${tool.name}`));
  const seen = new Set<string>();
  value.forEach((tool, index) => {
    if (!isPlainRecord(tool)) fail('INVALID_REQUEST', `request.tools[${index}] must be an object.`);
    if (!['function', 'custom', 'local_shell'].includes(String(tool.type)) || typeof tool.name !== 'string') {
      fail('UNSUPPORTED_TOOL', `request.tools[${index}] is not an approved local tool.`);
    }
    const key = `${tool.type}:${tool.name}`;
    if (!allowed.has(key) || seen.has(key)) fail('UNSUPPORTED_TOOL', `request.tools[${index}] is not uniquely approved by the profile.`);
    seen.add(key);
    if (tool.type === 'function') assertExactKeys(tool, ['type', 'name', 'description', 'parameters', 'strict'], `request.tools[${index}]`);
    else if (tool.type === 'custom') assertExactKeys(tool, ['type', 'name', 'description', 'format'], `request.tools[${index}]`);
    else assertExactKeys(tool, ['type', 'name'], `request.tools[${index}]`);
    inspectInputValue(tool, `request.tools[${index}]`);
  });
}

function validateReasoning(value: unknown, profile: Readonly<GatewayProfile>): void {
  if (!isPlainRecord(value)) fail('INVALID_REQUEST', 'request.reasoning must be an object.');
  assertExactKeys(value, ['effort', 'summary'], 'request.reasoning');
  if (value.effort !== undefined && !profile.requestPolicy.allowedReasoningEfforts.includes(String(value.effort))) {
    fail('UNSUPPORTED_PARAMETER', 'request.reasoning.effort is not approved by the profile.');
  }
  if (value.summary !== undefined && !['auto', 'concise', 'detailed', 'none'].includes(String(value.summary))) {
    fail('UNSUPPORTED_PARAMETER', 'request.reasoning.summary is unsupported.');
  }
}

function validateText(value: unknown): void {
  if (!isPlainRecord(value)) fail('INVALID_REQUEST', 'request.text must be an object.');
  assertExactKeys(value, ['format', 'verbosity'], 'request.text');
  if (value.verbosity !== undefined && !['low', 'medium', 'high'].includes(String(value.verbosity))) fail('UNSUPPORTED_PARAMETER', 'request.text.verbosity is unsupported.');
  if (value.format !== undefined) {
    if (!isPlainRecord(value.format)) fail('INVALID_REQUEST', 'request.text.format must be an object.');
    assertExactKeys(value.format, ['type'], 'request.text.format');
    if (value.format.type !== 'text') fail('UNSUPPORTED_PARAMETER', 'Only plain text output is supported by this profile.');
  }
}

function validateToolChoice(value: unknown, profile: Readonly<GatewayProfile>): void {
  if (typeof value === 'string') {
    if (!['auto', 'none', 'required'].includes(value)) fail('UNSUPPORTED_PARAMETER', 'request.tool_choice is unsupported.');
    return;
  }
  if (!isPlainRecord(value)) fail('INVALID_REQUEST', 'request.tool_choice must be a string or object.');
  assertExactKeys(value, ['type', 'name'], 'request.tool_choice');
  const type = String(value.type ?? '');
  const name = String(value.name ?? '');
  if (!profile.requestPolicy.allowedLocalTools.some(tool => tool.type === type && tool.name === name)) {
    fail('UNSUPPORTED_TOOL', 'request.tool_choice does not select an approved local tool.');
  }
}

export function validateRequest(body: unknown, profile: Readonly<GatewayProfile>, exactRawBodyDigest?: Digest): ValidatedGatewayRequest {
  const request = record(body, 'request');
  const acceptsPinnedMetadata = profile.requestPolicy.codexClientMetadata === 'drop-pinned-0.153.4';
  assertExactKeys(request, acceptsPinnedMetadata
    ? [...SUPPORTED_REQUEST_BODY_FIELDS, 'client_metadata']
    : SUPPORTED_REQUEST_BODY_FIELDS, 'request');
  let clientMetadataDigest: Digest | null = null;
  if (request.client_metadata !== undefined) {
    if (!acceptsPinnedMetadata) fail('UNSUPPORTED_FIELD', 'request contains unsupported field client_metadata.');
    clientMetadataDigest = validatePinnedCodexClientMetadata(request.client_metadata);
  }
  if (request.model !== profile.route.model) fail('MODEL_MISMATCH', 'request.model must match the frozen profile model.');
  validateInput(request.input, profile);
  if (request.instructions !== undefined && typeof request.instructions !== 'string') fail('INVALID_REQUEST', 'request.instructions must be a string.');
  if (request.stream !== true) fail('UNSUPPORTED_PARAMETER', 'request.stream must be true.');
  if (request.store !== false) fail('UNSUPPORTED_PARAMETER', 'request.store must be false.');
  if (request.previous_response_id !== null && request.previous_response_id !== undefined) {
    fail('UNSUPPORTED_PARAMETER', 'request.previous_response_id must be null or omitted.');
  }
  if (request.tools !== undefined) validateTools(request.tools, profile);
  if (request.reasoning !== undefined) validateReasoning(request.reasoning, profile);
  if (request.text !== undefined) validateText(request.text);
  if (request.tool_choice !== undefined) validateToolChoice(request.tool_choice, profile);
  if (request.parallel_tool_calls !== undefined && request.parallel_tool_calls !== profile.requestPolicy.allowParallelToolCalls) {
    fail('UNSUPPORTED_PARAMETER', 'request.parallel_tool_calls differs from the frozen profile.');
  }
  if (Array.isArray(request.tools) && request.tools.length > 0 && request.parallel_tool_calls === undefined) {
    fail('UNSUPPORTED_PARAMETER', 'request.parallel_tool_calls must explicitly match the frozen profile when tools are declared.');
  }
  if (request.include !== undefined && (!Array.isArray(request.include) || request.include.some(item => item !== 'reasoning.encrypted_content'))) {
    fail('UNSUPPORTED_PARAMETER', 'request.include only supports reasoning.encrypted_content.');
  }
  if (request.prompt_cache_key !== undefined && (typeof request.prompt_cache_key !== 'string' || request.prompt_cache_key.length === 0 || request.prompt_cache_key.length > 256)) {
    fail('INVALID_REQUEST', 'request.prompt_cache_key must be a bounded non-empty string.');
  }
  if (request.truncation !== undefined && request.truncation !== 'disabled') fail('UNSUPPORTED_PARAMETER', 'request.truncation must be disabled.');
  if (request.temperature !== undefined) {
    if (!profile.requestPolicy.allowTemperature || typeof request.temperature !== 'number' || !Number.isFinite(request.temperature) || request.temperature < 0 || request.temperature > 2) {
      fail('UNSUPPORTED_PARAMETER', 'request.temperature is not approved.');
    }
  }
  if (request.top_p !== undefined) {
    if (!profile.requestPolicy.allowTopP || typeof request.top_p !== 'number' || !Number.isFinite(request.top_p) || request.top_p < 0 || request.top_p > 1) {
      fail('UNSUPPORTED_PARAMETER', 'request.top_p is not approved.');
    }
  }

  const normalizations: ValidatedGatewayRequest['normalizations'][number][] = [];
  let maxOutputTokens = request.max_output_tokens;
  if (maxOutputTokens === undefined) {
    maxOutputTokens = profile.limits.maxOutputTokens;
    normalizations.push({ field: 'max_output_tokens', from: 'omitted', to: profile.limits.maxOutputTokens });
  } else if (!Number.isSafeInteger(maxOutputTokens) || (maxOutputTokens as number) <= 0 || (maxOutputTokens as number) > profile.limits.maxOutputTokens) {
    fail('OUTPUT_LIMIT', 'request.max_output_tokens exceeds the frozen profile limit or is invalid.');
  }

  const requestWithoutClientMetadata = cloneJson(request);
  delete requestWithoutClientMetadata.client_metadata;
  if (clientMetadataDigest) normalizations.push({ field: 'client_metadata', from: 'pinned-codex-0.153.4',
    to: 'omitted', valueDigest: clientMetadataDigest });
  const normalizedBody: Record<string, unknown> = {
    ...requestWithoutClientMetadata,
    model: profile.route.model,
    stream: true,
    store: false,
    previous_response_id: null,
    max_output_tokens: maxOutputTokens,
    ...(profile.route.provider === null ? {} : { provider: {
      order: [...profile.route.provider.order],
      allow_fallbacks: false,
      require_parameters: true,
    } }),
  };
  const bodyJson = canonicalJson(normalizedBody);
  if (JSON_ENCODER.encode(bodyJson).byteLength > profile.limits.maxRequestBytes) fail('REQUEST_TOO_LARGE', 'Normalized request exceeds the profile byte limit.');
  const frozenBody = deepFreeze(cloneJson(normalizedBody));
  const rawBodyDigest = exactRawBodyDigest ?? digestCanonicalJson(request);
  if (!/^sha256:[a-f0-9]{64}$/.test(rawBodyDigest)) fail('INVALID_REQUEST', 'raw request digest is invalid.');
  return deepFreeze({
    body: frozenBody,
    rawBodyDigest,
    normalizedBodyDigest: digestCanonicalJson(frozenBody),
    maximumExposure: profile.pricing.approvedMaximumExposureUsd,
    normalizations,
  });
}
