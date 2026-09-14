import { describe, expect, it } from 'vitest';
import {
  estimateMaximumExposure,
  profileDigest,
  validateAndFreezeProfile,
  validateRequest,
} from '../../packages/inference-gateway/src/profile.ts';
import { ResponsesSseAccountingParser } from '../../packages/inference-gateway/src/stream.ts';

function localProfile(responsesUrl = 'http://127.0.0.1:4545/v1/responses') {
  return {
    format: 'motive.gateway-profile/0.1',
    profileId: 'gateway-local-test',
    status: 'test-only-local-mock',
    upstream: { responsesUrl, credentialRef: 'fixture:gateway-test' },
    route: { model: 'motive-local-mock-v1', provider: null },
    limits: {
      maxRequestBytes: 262_144,
      maxResponseBytes: 1_048_576,
      maxEventBytes: 262_144,
      requestTimeoutMs: 5_000,
      maxInputItems: 128,
      maxTools: 4,
      contextWindowTokens: 4_096,
      maxOutputTokens: 256,
    },
    requestPolicy: {
      allowedLocalTools: [
        { type: 'function', name: 'exec_command' },
        { type: 'function', name: 'write_stdin' },
        { type: 'function', name: 'request_user_input' },
        { type: 'function', name: 'view_image' },
      ],
      allowedReasoningEfforts: ['low'],
      allowParallelToolCalls: false,
      allowTemperature: false,
      allowTopP: false,
    },
    pricing: {
      currency: 'USD',
      highestInputUsdPerMillionTokens: '1.000000000000',
      highestOutputUsdPerMillionTokens: '2.000000000000',
      fixedRequestUsd: '0.010000000000',
      worstCaseAdditionalUsd: '0.020000000000',
      approvedMaximumExposureUsd: '0.034608000000',
    },
    evidence: {
      kind: 'local-mock',
      reviewedAt: '2026-09-06',
      reviewedBy: 'gateway-protocol-test',
      pricingSource: 'fixture:synthetic-pricing',
      responsesCompatibilitySource: 'fixture:deterministic-sse',
    },
  } as const;
}

function parser(overrides: Partial<ConstructorParameters<typeof ResponsesSseAccountingParser>[0]> = {}) {
  return new ResponsesSseAccountingParser({
    maxTotalBytes: 64 * 1024,
    maxEventBytes: 16 * 1024,
    expectedModel: 'motive-local-mock-v1',
    maximumExposure: '0.034608000000',
    ...overrides,
  });
}

const encoder = new TextEncoder();
const event = (type: string, payload: Record<string, unknown>, named = true) =>
  encoder.encode(`${named ? `event: ${type}\n` : ''}data: ${JSON.stringify({ type, ...payload })}\n\n`);

function terminal(cost: string | number = '0.012345678901') {
  return event('response.done', {
    response: {
      id: 'resp_test_1',
      status: 'completed',
      model: 'motive-local-mock-v1',
      provider: 'fixture-provider',
      usage: {
        input_tokens: 10,
        prompt_tokens: 10,
        output_tokens: 4,
        completion_tokens: 4,
        total_tokens: 14,
        input_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 },
        output_tokens_details: { reasoning_tokens: 3 },
        cost,
        cost_details: { upstream_inference_cost: '999.000000000000' },
      },
    },
  });
}

describe('immutable gateway profiles and request admission', () => {
  it('freezes a strict local profile and computes a stable canonical digest', () => {
    const input = localProfile();
    const profile = validateAndFreezeProfile(input);
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.pricing)).toBe(true);
    expect(profileDigest(profile)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(profileDigest(profile)).toBe(profileDigest(validateAndFreezeProfile({
      ...input,
      // Insertion order does not affect the canonical profile identity.
      upstream: { credentialRef: input.upstream.credentialRef, responsesUrl: input.upstream.responsesUrl },
    })));
    expect(estimateMaximumExposure(profile)).toBe('0.034608000000');
  });

  it('fails closed for unresolved or structurally incomplete live profiles', () => {
    expect(() => validateAndFreezeProfile({ ...localProfile(), status: 'not-runnable' })).toThrow(/not runnable/);
    expect(() => validateAndFreezeProfile({
      ...localProfile('https://openrouter.ai/api/v1/responses'),
      status: 'reviewed-live',
      upstream: { responsesUrl: 'https://openrouter.ai/api/v1/responses', credentialRef: 'secret:openrouter-source-1' },
      route: { model: 'openai/example-pinned', provider: null },
      evidence: { ...localProfile().evidence, kind: 'gate-a-reviewed' },
    })).toThrow(/pinned OpenRouter Responses endpoint/);
    expect(() => validateAndFreezeProfile({ ...localProfile(), extra: true })).toThrow(/unsupported field/);
    expect(() => validateAndFreezeProfile({
      ...localProfile(),
      pricing: { ...localProfile().pricing, approvedMaximumExposureUsd: '0.034607999999' },
    })).toThrow(/below the frozen full-context/);
  });

  it('pins live OpenRouter and local literal-loopback endpoints', () => {
    const live = {
      ...localProfile('https://openrouter.ai/api/v1/responses'),
      status: 'reviewed-live',
      upstream: { responsesUrl: 'https://openrouter.ai/api/v1/responses', credentialRef: 'secret:openrouter-source-1' },
      route: {
        model: 'openai/example-pinned',
        provider: { order: ['openai'], allowFallbacks: false, requireParameters: true },
      },
      evidence: {
        ...localProfile().evidence,
        kind: 'gate-a-reviewed',
        pricingSource: 'evidence:reviewed-pricing-snapshot',
        responsesCompatibilitySource: 'evidence:reviewed-gate-a-run',
      },
    } as const;
    expect(validateAndFreezeProfile(live).upstream.responsesUrl).toBe('https://openrouter.ai/api/v1/responses');
    expect(() => validateAndFreezeProfile({
      ...live,
      upstream: { ...live.upstream, responsesUrl: 'https://gateway.example/v1/responses' },
    })).toThrow(/pinned OpenRouter Responses endpoint/);
    expect(() => validateAndFreezeProfile(localProfile('http://localhost:4545/v1/responses'))).toThrow(/literal loopback/);
    expect(validateAndFreezeProfile(localProfile('http://[::1]:4545/v1/responses')).upstream.responsesUrl).toContain('[::1]');
  });

  it.each([
    ['maxRequestBytes', 4 * 1024 * 1024 + 1],
    ['maxResponseBytes', 64 * 1024 * 1024 + 1],
    ['maxEventBytes', 8 * 1024 * 1024 + 1],
    ['requestTimeoutMs', 15 * 60 * 1_000 + 1],
  ] as const)('rejects process-unrunnable %s limits', (field, value) => {
    const profile = localProfile();
    expect(() => validateAndFreezeProfile({
      ...profile,
      limits: { ...profile.limits, [field]: value },
    })).toThrow(new RegExp(`${field} exceeds the gateway process limit`));
  });

  it('preserves opaque history identifiers and records the profile-cap normalization', () => {
    const profile = validateAndFreezeProfile(localProfile());
    const body = {
      model: profile.route.model,
      stream: true,
      store: false,
      previous_response_id: null,
      include: ['reasoning.encrypted_content'],
      reasoning: { effort: 'low', summary: 'none' },
      parallel_tool_calls: false,
      input: [
        { type: 'reasoning', id: 'rs_opaque', encrypted_content: 'opaque-provider-continuity', summary: [] },
        { type: 'function_call', id: 'fc_opaque', call_id: 'call_opaque', name: 'exec_command', arguments: '{"cmd":"pwd"}' },
        { type: 'function_call_output', call_id: 'call_opaque', output: 'opaque output' },
        { type: 'local_shell_call', id: 'shell_opaque', call_id: 'shell_call_opaque', action: { type: 'exec', command: 'pwd' } },
        { type: 'local_shell_call_output', call_id: 'shell_call_opaque', output: 'opaque shell output' },
        { type: 'message', role: 'assistant', id: 'msg_opaque', status: 'completed', content: [{ type: 'output_text', text: 'prior' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next' }] },
      ],
      tools: [{ type: 'function', name: 'exec_command', description: 'local shell', parameters: { type: 'object' }, strict: false }],
    };
    const validated = validateRequest(body, profile);
    expect(validated.maximumExposure).toBe('0.034608000000');
    expect(validated.body.max_output_tokens).toBe(256);
    expect(validated.normalizations).toEqual([{ field: 'max_output_tokens', from: 'omitted', to: 256 }]);
    expect(validated.body.input).toEqual(body.input);
    expect(Object.isFrozen(validated.body.input)).toBe(true);
    expect(validated.rawBodyDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(validated.normalizedBodyDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it.each([
    [{ model: 'motive-local-mock-v1', input: 'x', stream: true, store: true }, /store must be false/],
    [{ model: 'motive-local-mock-v1', input: 'x', stream: true, store: false, previous_response_id: 'resp_old' }, /previous_response_id/],
    [{ model: 'other', input: 'x', stream: true, store: false }, /frozen profile model/],
    [{ model: 'motive-local-mock-v1', input: 'x', stream: true, store: false, max_output_tokens: 257 }, /output_tokens exceeds/],
    [{ model: 'motive-local-mock-v1', input: 'x', stream: true, store: false, max_output_tokens: null }, /output_tokens exceeds/],
    [{ model: 'motive-local-mock-v1', input: 'x', stream: true, store: false, route: 'https://evil.test' }, /unsupported field route/],
    [{ model: 'motive-local-mock-v1', input: 'x', stream: true, store: false, provider: { order: ['other'] } }, /unsupported field provider/],
    [{ model: 'motive-local-mock-v1', input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'https://evil.test/x' }] }], stream: true, store: false }, /remote or media/],
    [{ model: 'motive-local-mock-v1', input: 'x', stream: true, store: false, tools: [{ type: 'web_search' }] }, /approved local tool/],
    [{ model: 'motive-local-mock-v1', input: 'x', stream: true, store: false, tools: [{ type: 'function', name: 'unapproved', parameters: {} }] }, /not uniquely approved/],
    [{ model: 'motive-local-mock-v1', input: 'x', stream: true, store: false, tools: [{ type: 'function', name: 'exec_command', parameters: {} }] }, /parallel_tool_calls must explicitly match/],
    [{ model: 'motive-local-mock-v1', input: 'x', stream: true, store: false, tool_choice: { type: 'function', name: 'exec_command', function: { name: 'exec_command' } } }, /unsupported field function/],
  ])('rejects unsafe request policy %#', (body, expected) => {
    expect(() => validateRequest(body, validateAndFreezeProfile(localProfile()))).toThrow(expected);
  });
});

describe('bounded Responses SSE accounting parser', () => {
  it('handles split UTF-8 and SSE frames while using only terminal usage.cost', () => {
    const subject = parser();
    const prefix = event('response.created', { response: { id: 'resp_test_1', status: 'in_progress' } });
    const delta = event('response.output_text.delta', { response_id: 'resp_test_1', delta: 'สวัสดี' });
    const bytes = new Uint8Array(prefix.byteLength + delta.byteLength + terminal().byteLength);
    bytes.set(prefix, 0);
    bytes.set(delta, prefix.byteLength);
    bytes.set(terminal(), prefix.byteLength + delta.byteLength);
    for (let offset = 0; offset < bytes.length; offset += 3) subject.push(bytes.slice(offset, offset + 3));
    expect(subject.responseId).toBe('resp_test_1');
    expect(subject.terminalSeen).toBe(true);
    expect(subject.finish()).toEqual({
      providerResponseId: 'resp_test_1',
      rawCost: '0.012345678901',
      actualCost: '0.012345678901',
      returnedModel: 'motive-local-mock-v1',
      returnedProvider: 'fixture-provider',
      usage: {
        cost: '0.012345678901', inputTokens: 10, outputTokens: 4, totalTokens: 14,
        cachedInputTokens: 2, cacheWriteInputTokens: 1, reasoningOutputTokens: 3,
      },
      overrun: false,
    });
  });

  it('accepts mixed valid SSE line endings split across chunks', () => {
    const subject = parser();
    const mixed = new TextDecoder().decode(terminal()).replace(/\n\n$/, '\n\r\n');
    const bytes = encoder.encode(mixed);
    subject.push(bytes.slice(0, bytes.length - 1));
    subject.push(bytes.slice(bytes.length - 1));
    expect(subject.finish().providerResponseId).toBe('resp_test_1');
  });

  it('preserves an exact numeric JSON cost lexeme, rounds the ledger charge upward, and flags overruns', () => {
    const subject = parser({ maximumExposure: '0.100000000000' });
    const raw = '{"type":"response.completed","response":{"id":"resp_test_1","status":"completed","model":"motive-local-mock-v1","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2,"cost":0.1234567890123456789,"cost_details":{"upstream_inference_cost":999}}}}';
    subject.push(encoder.encode(`data: ${raw}\n\n`));
    const result = subject.finish();
    expect(result.rawCost).toBe('0.1234567890123456789');
    expect(result.actualCost).toBe('0.123456789013');
    expect(result.overrun).toBe(true);
  });

  it('treats missing or duplicate terminal cost as unknown instead of summing details', () => {
    const missing = parser();
    expect(() => missing.push(event('response.done', { response: {
      id: 'resp_test_1', status: 'completed', model: 'motive-local-mock-v1',
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, cost_details: { upstream_inference_cost: 9 } },
    } }))).toThrow(/exactly one usage.cost/);

    const duplicate = parser();
    expect(() => duplicate.push(encoder.encode('data: {"type":"response.done","response":{"id":"resp_test_1","status":"completed","model":"motive-local-mock-v1","usage":{"cost":1},"usage":{"cost":2}}}\n\n'))).toThrow(/exactly one usage.cost/);
  });

  it('fails closed on malformed, truncated, provider-error, and non-success terminal streams', () => {
    expect(() => parser().push(encoder.encode('data: {bad}\n\n'))).toThrow(/valid JSON/);
    const truncated = parser();
    truncated.push(encoder.encode('data: {"type":"response.done"'));
    expect(() => truncated.finish()).toThrow(/incomplete SSE event/);
    expect(() => parser().push(event('error', { error: { message: 'private provider detail' } }))).toThrow(/non-success terminal/);
    expect(() => parser().push(event('response.done', { response: {
      id: 'resp_test_1', status: 'incomplete', model: 'motive-local-mock-v1', usage: { cost: 1 },
    } }))).toThrow(/not completed/);
  });

  it('rejects conflicting identifiers, models, duplicate terminals, and events after DONE', () => {
    const ids = parser();
    ids.push(event('response.created', { response: { id: 'resp_a' } }));
    expect(() => ids.push(event('response.output_text.delta', { response_id: 'resp_b', delta: 'x' }))).toThrow(/conflicting response identifiers/);

    const model = parser();
    const wrong = new TextDecoder().decode(terminal()).replace('motive-local-mock-v1', 'other-model');
    expect(() => model.push(encoder.encode(wrong))).toThrow(/differs from the frozen profile/);

    const duplicate = parser();
    duplicate.push(terminal());
    expect(() => duplicate.push(terminal())).toThrow(/after terminal completion/);

    const postTerminal = parser();
    postTerminal.push(terminal());
    expect(() => postTerminal.push(event('response.output_text.delta', { response_id: 'resp_test_1', delta: 'late' }))).toThrow(/after terminal completion/);

    const done = parser();
    done.push(terminal());
    done.push(encoder.encode('data: [DONE]\n\n'));
    expect(() => done.push(event('response.output_text.delta', { response_id: 'resp_test_1', delta: 'late' }))).toThrow(/after DONE/);
  });

  it('bounds both total response bytes and individual event bytes', () => {
    expect(() => parser({ maxTotalBytes: 4, maxEventBytes: 4 }).push(encoder.encode('12345'))).toThrow(/response exceeds/);
    expect(() => parser({ maxTotalBytes: 64, maxEventBytes: 4 }).push(encoder.encode('data: 12'))).toThrow(/event exceeds/);
  });
});
