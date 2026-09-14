import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LiveRouteProbeError,
  OPENROUTER_LIVE_ROUTE_MODEL,
  parseOpenRouterLiveRouteArguments,
  probeOpenRouterLiveRoute,
} from './probe-openrouter-live-route.ts';

const SECRET = 'sk-or-v1-test-secret-that-must-never-appear';
const roots: string[] = [];
const NOW = () => new Date('2026-09-08T09:00:00.000Z');

async function root(): Promise<{ projectRoot: string; intentFile: string }> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'motive-live-route-'));
  roots.push(projectRoot); await mkdir(join(projectRoot, '.local'));
  return { projectRoot, intentFile: '.local/intent.json' };
}

function metadata(overrides: Record<string, unknown> = {}): Response {
  return Response.json({ data: { id: OPENROUTER_LIVE_ROUTE_MODEL, endpoints: [{
    name: 'OpenAI | openai/gpt-6-astra', provider_name: 'OpenAI', tag: 'openai',
    supported_parameters: ['reasoning', 'max_tokens'],
    pricing: { prompt: '0.00001', completion: '0.00005', request: '0',
      input_cache_read: '0.000001', input_cache_write: '0.0000125', internal_reasoning: '0.00005',
      overrides: [{ min_prompt_tokens: 272000, prompt: '0.00002', completion: '0.000075',
        input_cache_read: '0.000002', input_cache_write: '0.000025' }] },
    ...overrides,
  }] } });
}

function completedSse(overrides: Record<string, unknown> = {}): Response {
  const response = {
    id: 'resp_route_1', status: 'completed', model: OPENROUTER_LIVE_ROUTE_MODEL,
    provider_name: 'OpenAI', usage: { input_tokens: 9, output_tokens: 2, total_tokens: 11,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 }, cost: 0.0002 },
    ...overrides,
  };
  const body = `data: ${JSON.stringify({ type: 'response.completed', response })}\n\ndata: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function provider(sequence: Array<Response | Error>) {
  return vi.fn(async () => {
    const next = sequence.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error('unexpected fetch');
    return next;
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });

describe('OpenRouter bounded live-route probe', () => {
  it('keeps the default dry run public and makes zero POST requests', async () => {
    const calls: Array<{ method: string; authorization: string | null }> = [];
    const fetchProvider = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', authorization: new Headers(init?.headers).get('authorization') });
      return metadata();
    }) as unknown as typeof fetch;
    const report = await probeOpenRouterLiveRoute({ execute: false, fetch: fetchProvider, now: NOW });
    expect(report.status).toBe('DRY_RUN');
    expect(report.authorization.execute).toBe(false);
    expect(report.pricing.ratesUsdPerToken.inputCacheWrite).toBe('0.0000125');
    expect(report.pricing.tierRates).toEqual([expect.objectContaining({ minimumPromptTokens: 272000,
      inputCacheWriteUsdPerToken: '0.000025' })]);
    expect(report.authorization.maximumExposureUsd).toBe('0.121600000000');
    expect(calls).toEqual([{ method: 'GET', authorization: null }]);
  });

  it('rejects missing execute approval, ceiling, or key before network access', async () => {
    expect(() => parseOpenRouterLiveRouteArguments(['--ceiling-usd', '0.1']))
      .toThrowError(expect.objectContaining({ code: 'EXECUTE_REQUIRES_CEILING' }));
    const fetchProvider = vi.fn() as unknown as typeof fetch;
    await expect(probeOpenRouterLiveRoute({ execute: true, env: {}, fetch: fetchProvider }))
      .rejects.toMatchObject({ code: 'EXECUTE_REQUIRES_CEILING' });
    await expect(probeOpenRouterLiveRoute({ execute: true, ceilingUsd: '0.1', env: {}, fetch: fetchProvider }))
      .rejects.toMatchObject({ code: 'KEY_REQUIRED' });
    await expect(probeOpenRouterLiveRoute({ execute: true, ceilingUsd: '0.0000000000001',
      env: { OPENROUTER_API_KEY: SECRET }, fetch: fetchProvider })).rejects.toMatchObject({ code: 'CEILING_INVALID' });
    expect(fetchProvider).not.toHaveBeenCalled();
  });

  it('persists intent before one fixed provider POST and records sanitized terminal evidence', async () => {
    const paths = await root(); const fetchProvider = provider([metadata(), completedSse()]);
    const report = await probeOpenRouterLiveRoute({ ...paths, execute: true, ceilingUsd: '0.2',
      env: { OPENROUTER_API_KEY: SECRET }, fetch: fetchProvider, now: NOW });
    expect(report.status).toBe('COMPLETED');
    expect(report.result).toMatchObject({ code: 'STREAMING_ROUTE_VERIFIED', returnedModel: OPENROUTER_LIVE_ROUTE_MODEL,
      returnedProvider: 'OpenAI', identityVerified: true, costVerified: true, networkCallsAttempted: 1 });
    expect(fetchProvider).toHaveBeenCalledTimes(2);
    const post = (fetchProvider as ReturnType<typeof vi.fn>).mock.calls[1]!;
    const init = post[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({ model: OPENROUTER_LIVE_ROUTE_MODEL, service_tier: 'default',
      stream: true, store: false, tools: [], provider: { only: ['openai'], order: ['openai'],
        allow_fallbacks: false, require_parameters: true } });
    expect(JSON.stringify(report)).not.toContain(SECRET);
    const intent = await readFile(join(paths.projectRoot, paths.intentFile), 'utf8');
    const result = await readFile(join(paths.projectRoot, '.local/intent.result.json'), 'utf8');
    expect(intent).not.toContain(SECRET); expect(result).not.toContain(SECRET);
    expect(JSON.parse(intent)).toMatchObject({ status: 'UNKNOWN', result: null,
      authorization: { maximumExposureUsd: '0.121600000000' } });
    expect(JSON.parse(result)).toMatchObject({ status: 'COMPLETED' });
  });

  it('refuses same-intent replay and reports changed authorization as a conflict without network', async () => {
    const paths = await root();
    await probeOpenRouterLiveRoute({ ...paths, execute: true, ceilingUsd: '0.2', env: { OPENROUTER_API_KEY: SECRET },
      fetch: provider([metadata(), completedSse()]), now: NOW });
    const noNetwork = vi.fn() as unknown as typeof fetch;
    await expect(probeOpenRouterLiveRoute({ ...paths, execute: true, ceilingUsd: '0.2',
      env: { OPENROUTER_API_KEY: SECRET }, fetch: noNetwork })).rejects.toMatchObject({ code: 'INTENT_ALREADY_EXISTS' });
    await expect(probeOpenRouterLiveRoute({ ...paths, execute: true, ceilingUsd: '0.3',
      env: { OPENROUTER_API_KEY: SECRET }, fetch: noNetwork })).rejects.toMatchObject({ code: 'INTENT_CONFLICT' });
    expect(noNetwork).not.toHaveBeenCalled();
  });

  it('rejects exposure above the explicit ceiling before creating an intent or POSTing', async () => {
    const paths = await root(); const fetchProvider = provider([metadata()]);
    await expect(probeOpenRouterLiveRoute({ ...paths, execute: true, ceilingUsd: '0.01',
      env: { OPENROUTER_API_KEY: SECRET }, fetch: fetchProvider, now: NOW }))
      .rejects.toMatchObject({ code: 'EXPOSURE_EXCEEDS_CEILING' });
    expect(fetchProvider).toHaveBeenCalledTimes(1);
    await expect(readFile(join(paths.projectRoot, paths.intentFile), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains ambiguous network and truncated outcomes without retry or secret disclosure', async () => {
    const networkPaths = await root(); const network = provider([metadata(), new Error(`upstream ${SECRET}`)]);
    const unknown = await probeOpenRouterLiveRoute({ ...networkPaths, execute: true, ceilingUsd: '0.2',
      env: { OPENROUTER_API_KEY: SECRET }, fetch: network, now: NOW });
    expect(unknown.status).toBe('UNKNOWN'); expect(network).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(unknown)).not.toContain(SECRET);
    expect(await readFile(join(networkPaths.projectRoot, networkPaths.intentFile), 'utf8')).not.toContain(SECRET);

    const truncatedPaths = await root();
    const truncated = provider([metadata(), new Response('data: {"type":"response.completed"',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } })]);
    const result = await probeOpenRouterLiveRoute({ ...truncatedPaths, execute: true, ceilingUsd: '0.2',
      env: { OPENROUTER_API_KEY: SECRET }, fetch: truncated, now: NOW });
    expect(result.status).toBe('UNKNOWN'); expect(truncated).toHaveBeenCalledTimes(2);
  });

  it('keeps the synced intent immutable when result persistence fails after the POST', async () => {
    const paths = await root(); let calls = 0;
    const fetchProvider = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if ((init?.method ?? 'GET') === 'GET') return metadata();
      await mkdir(join(paths.projectRoot, '.local/intent.result.json'));
      return completedSse();
    }) as unknown as typeof fetch;
    await expect(probeOpenRouterLiveRoute({ ...paths, execute: true, ceilingUsd: '0.2',
      env: { OPENROUTER_API_KEY: SECRET }, fetch: fetchProvider, now: NOW }))
      .rejects.toMatchObject({ code: 'RESULT_PERSISTENCE_FAILED' });
    expect(calls).toBe(2);
    const intent = JSON.parse(await readFile(join(paths.projectRoot, paths.intentFile), 'utf8'));
    expect(intent).toMatchObject({ status: 'UNKNOWN', result: null,
      authorization: { maximumExposureUsd: '0.121600000000' } });
  });

  it('bounds metadata, response bytes, and incomplete identity without inventing verification', async () => {
    const oversizedMetadata = new Response('x'.repeat(2 * 1024 * 1024 + 1));
    await expect(probeOpenRouterLiveRoute({ execute: false, fetch: provider([oversizedMetadata]), now: NOW }))
      .rejects.toBeInstanceOf(LiveRouteProbeError);

    const responsePaths = await root(); const oversized = new Response('x'.repeat(1024 * 1024 + 1),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    const bounded = await probeOpenRouterLiveRoute({ ...responsePaths, execute: true, ceilingUsd: '0.2',
      env: { OPENROUTER_API_KEY: SECRET }, fetch: provider([metadata(), oversized]), now: NOW });
    expect(bounded.status).toBe('UNKNOWN');

    const identityPaths = await root();
    const incomplete = await probeOpenRouterLiveRoute({ ...identityPaths, execute: true, ceilingUsd: '0.2',
      env: { OPENROUTER_API_KEY: SECRET }, fetch: provider([metadata(), completedSse({ provider_name: undefined })]), now: NOW });
    expect(incomplete.status).toBe('COMPLETED_UNVERIFIED');
    expect(incomplete.result).toMatchObject({ identityVerified: false, returnedProvider: null });
  });

  it('treats a pre-existing different request digest as a conflict', async () => {
    const paths = await root();
    await writeFile(join(paths.projectRoot, paths.intentFile), JSON.stringify({ request: { normalizedBodyDigest: `sha256:${'0'.repeat(64)}` },
      authorization: { operatorCeilingUsd: '0.1' } }));
    const noNetwork = vi.fn() as unknown as typeof fetch;
    await expect(probeOpenRouterLiveRoute({ ...paths, execute: true, ceilingUsd: '0.1',
      env: { OPENROUTER_API_KEY: SECRET }, fetch: noNetwork })).rejects.toMatchObject({ code: 'INTENT_CONFLICT' });
    expect(noNetwork).not.toHaveBeenCalled();
  });
});
