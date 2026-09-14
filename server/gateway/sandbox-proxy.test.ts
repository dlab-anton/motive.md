import express from 'express';
import { once } from 'node:events';
import { request as nodeRequest, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InvalidRequestProxyHandler, ProxyHandler } from '@vercel/sandbox/proxy';
import { createSandboxGatewayProxyRouter, SANDBOX_PROXY_HEADER, SANDBOX_PROXY_TRANSPORT_TIMEOUT_MS,
  type SandboxProxyDiagnostic } from './sandbox-proxy.ts';

const appOrigin = 'https://motive.example';
const gatewayUrl = `${appOrigin}/api/inference/v1/responses`;
const bearer = `Bearer ${'a'.repeat(32)}`;
const servers: Server[] = [];

const fakeDefinition = (handler: ProxyHandler, invalid?: InvalidRequestProxyHandler) => async (incoming: Request) => {
  if (incoming.headers.get('x-test-oidc') !== 'valid') {
    return invalid ? invalid(incoming, new Error('invalid fixture token')) : new Response(null, { status: 403 });
  }
  const method = incoming.headers.get('x-test-method') ?? 'POST';
  const headers = new Headers();
  for (const name of ['authorization', 'content-type', 'content-encoding']) {
    const value = incoming.headers.get(name); if (value) headers.set(name, value);
  }
  const body = ['GET', 'HEAD'].includes(method) ? undefined : incoming.body;
  const original = new Request(incoming.headers.get('x-test-url') ?? gatewayUrl, {
    method, headers, body, ...(body ? { duplex: 'half' as const } : {}),
  });
  return handler(original, {
    host: incoming.headers.get('x-test-host') ?? 'motive.example',
    teamId: incoming.headers.get('x-test-team') ?? 'team_motive',
    projectId: incoming.headers.get('x-test-project') ?? 'prj_motive',
    sandboxId: 'sbx_test', sandboxName: 'motive-worker-test',
  });
};

async function serve(fetchUpstream: typeof fetch, limits = { request: 64, response: 1024 }, transportTimeoutMs?: number,
  audit?: (diagnostic: SandboxProxyDiagnostic) => void, defineProxy = fakeDefinition) {
  const app = express();
  app.use('/api/sandbox-egress', createSandboxGatewayProxyRouter({ appOrigin,
    expectedTeamId: 'team_motive', expectedProjectId: 'prj_motive',
    maximumRequestBytes: limits.request, maximumResponseBytes: limits.response,
    fetch: fetchUpstream, defineProxy, ...(transportTimeoutMs ? { transportTimeoutMs } : {}), ...(audit ? { audit } : {}) }));
  const server = app.listen(0, '127.0.0.1'); servers.push(server); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('test server address unavailable');
  return `http://127.0.0.1:${address.port}`;
}

function headers(overrides: Record<string, string> = {}) {
  return { 'x-test-oidc': 'valid', 'x-test-url': gatewayUrl, 'content-type': 'application/json',
    authorization: bearer, ...overrides };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  })));
});

describe('Sandbox gateway forwarding proxy', () => {
  it('keeps its default transport ceiling above the gateway lifecycle and rejects a larger override', () => {
    expect(SANDBOX_PROXY_TRANSPORT_TIMEOUT_MS).toBe(250_000);
    expect(() => createSandboxGatewayProxyRouter({ appOrigin, expectedTeamId: 'team_motive', expectedProjectId: 'prj_motive',
      maximumRequestBytes: 64, maximumResponseBytes: 64, transportTimeoutMs: 250_001 }))
      .toThrow('SANDBOX_PROXY_TIMEOUT_INVALID');
  });
  it.each([
    ['OIDC', { 'x-test-oidc': 'invalid' }, '/api/sandbox-egress/api/inference/v1/responses', 'OIDC_VERIFICATION_FAILED'],
    ['team metadata', { 'x-test-team': 'team_other' }, '/api/sandbox-egress/api/inference/v1/responses', 'PREDICATE_TEAM_REJECTED'],
    ['project metadata', { 'x-test-project': 'project_other' }, '/api/sandbox-egress/api/inference/v1/responses', 'PREDICATE_PROJECT_REJECTED'],
    ['method', { 'x-test-method': 'GET' }, '/api/sandbox-egress/api/inference/v1/responses', 'PREDICATE_METHOD_REJECTED'],
    ['host', { 'x-test-host': 'other.example' }, '/api/sandbox-egress/api/inference/v1/responses', 'PREDICATE_HOST_REJECTED'],
    ['path', { 'x-test-url': `${appOrigin}/api/inference/v1/models` }, '/api/sandbox-egress/api/inference/v1/models', 'PREDICATE_DESTINATION_REJECTED'],
    ['bearer', { authorization: 'Bearer short' }, '/api/sandbox-egress/api/inference/v1/responses', 'PREDICATE_BEARER_REJECTED'],
    ['content type', { 'content-type': 'text/plain' }, '/api/sandbox-egress/api/inference/v1/responses', 'PREDICATE_CONTENT_TYPE_REJECTED'],
    ['query', {}, '/api/sandbox-egress/api/inference/v1/responses?redirect=other', 'INGRESS_PATH_REJECTED'],
  ])('denies invalid %s before forwarding', async (_label, changed, path, diagnosticCode) => {
    const upstream = vi.fn<typeof fetch>();
    const diagnostics: SandboxProxyDiagnostic[] = [];
    const auditedOrigin = await serve(upstream, undefined, undefined, event => diagnostics.push(event));
    const response = await fetch(`${auditedOrigin}${path}`, { method: 'POST', headers: headers(changed), body: '{}' });
    expect(response.status).toBe(403);
    expect(response.headers.get(SANDBOX_PROXY_HEADER)).toBe('denied');
    expect(upstream).not.toHaveBeenCalled();
    expect(diagnostics.map(event => event.code)).toEqual(diagnosticCode === 'INGRESS_PATH_REJECTED'
      ? [diagnosticCode]
      : ['REQUEST_BODY_COMPLETE', diagnosticCode]);
  });

  it.each([
    [{ message: 'Missing required proxy headers' }, 'SDK_PROXY_HEADERS_MISSING'],
    [{ message: 'Invalid proxied request URL' }, 'SDK_PROXIED_URL_INVALID'],
    [{ message: 'Missing required claims in OIDC token' }, 'OIDC_SOURCE_CLAIMS_MISSING'],
    [{ message: 'Invalid OIDC issuer' }, 'OIDC_ISSUER_REJECTED'],
    [{ code: 'ERR_JWKS_TIMEOUT', name: 'JWKSTimeout' }, 'OIDC_JWKS_TIMEOUT'],
    [{ code: 'ERR_JWT_CLAIM_VALIDATION_FAILED', name: 'JWTClaimValidationFailed', claim: 'iss' }, 'OIDC_ISSUER_REJECTED'],
    [{ code: 'ERR_JWT_CLAIM_VALIDATION_FAILED', name: 'JWTClaimValidationFailed', claim: 'aud' }, 'OIDC_AUDIENCE_REJECTED'],
    [{ code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED', name: 'JWSSignatureVerificationFailed' }, 'OIDC_SIGNATURE_REJECTED'],
    [{ code: 'ERR_JWT_EXPIRED', name: 'JWTExpired' }, 'OIDC_TOKEN_EXPIRED'],
    [{ code: 'UNRECOGNIZED', name: 'SecretFailure' }, 'OIDC_VERIFICATION_FAILED'],
  ])('reports a closed SDK verification category without diagnostic disclosure: %#', async (shape, expectedCode) => {
    const secret = 'raw-token-and-claims-must-not-appear';
    const error = Object.assign(new Error('message' in shape ? shape.message : secret), shape,
      { payload: { token: secret } });
    const invalidDefinition: typeof fakeDefinition = (_handler, invalid) => async incoming => invalid!(incoming, error);
    const diagnostics: SandboxProxyDiagnostic[] = [];
    const origin = await serve(vi.fn<typeof fetch>(), undefined, undefined,
      event => diagnostics.push(event), invalidDefinition);
    const response = await fetch(`${origin}/api/sandbox-egress/api/inference/v1/responses`, {
      method: 'POST', headers: headers(), body: '{}',
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'sandbox_proxy_denied' });
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]).toMatchObject({ code: 'REQUEST_BODY_COMPLETE', bytes: 2 });
    expect(diagnostics[1]).toMatchObject({
      format: 'motive.sandbox-proxy-diagnostic/0.1', code: expectedCode,
    });
    expect(diagnostics[1]!.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(diagnostics)).not.toContain(secret);
  });

  it('forwards one bounded stream with only fixed gateway headers', async () => {
    const encoder = new TextEncoder();
    const diagnostics: SandboxProxyDiagnostic[] = [];
    const upstream = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe(gatewayUrl); expect(init?.method).toBe('POST'); expect(init?.redirect).toBe('error');
      expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
        accept: 'text/event-stream', authorization: bearer, 'content-length': '12', 'content-type': 'application/json',
      });
      expect(await new Response(init?.body).text()).toBe('{"input":[]}');
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(encoder.encode('data: first\n\n')); controller.enqueue(encoder.encode('data: second\n\n')); controller.close();
      } }), { status: 200, headers: { 'content-type': 'text/event-stream', 'x-motive-operation-id': 'operation-test' } });
    });
    const origin = await serve(upstream, undefined, undefined, event => diagnostics.push(event));
    const response = await fetch(`${origin}/api/sandbox-egress/api/inference/v1/responses`, {
      method: 'POST', headers: headers({ cookie: 'must-not-forward', 'x-forwarded-for': 'untrusted' }), body: '{"input":[]}',
    });
    expect(response.status).toBe(200); expect(response.headers.get(SANDBOX_PROXY_HEADER)).toBe('gateway');
    expect(response.headers.get('x-motive-operation-id')).toBe('operation-test');
    expect(await response.text()).toBe('data: first\n\ndata: second\n\n');
    expect(upstream).toHaveBeenCalledOnce();
    expect(diagnostics.map(event => event.code)).toEqual([
      'REQUEST_BODY_COMPLETE', 'ADMITTED', 'FETCH_STARTED', 'UPSTREAM_RESPONSE',
    ]);
    expect(diagnostics[0]).toMatchObject({ bytes: 12 });
    expect(diagnostics[2]).toMatchObject({ bytes: 12 });
    expect(diagnostics[3]).toMatchObject({ status: 200 });
  });

  it('does not let a diagnostic observer change admission or its response', async () => {
    const upstream = vi.fn<typeof fetch>(async () => new Response('{}', {
      status: 413, headers: { 'content-type': 'application/json' },
    }));
    const origin = await serve(upstream, undefined, undefined, () => { throw new Error('observer failure'); });
    const response = await fetch(`${origin}/api/sandbox-egress/api/inference/v1/responses`, {
      method: 'POST', headers: headers(), body: '{}',
    });
    expect(response.status).toBe(413);
    expect(response.headers.get(SANDBOX_PROXY_HEADER)).toBe('gateway');
    expect(upstream).toHaveBeenCalledOnce();
  });

  it('bounds request and response streams and cancels the upstream body', async () => {
    let responseCancelled = false;
    const upstream = vi.fn<typeof fetch>(async (_url, init) => {
      await new Response(init?.body).arrayBuffer();
      return new Response(new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(16)); },
        cancel() { responseCancelled = true; },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const origin = await serve(upstream, { request: 4, response: 8 });
    const tooLarge = await fetch(`${origin}/api/sandbox-egress/api/inference/v1/responses`, {
      method: 'POST', headers: headers(), body: '{"large":true}',
    });
    expect(tooLarge.status).toBe(413); expect(tooLarge.headers.get(SANDBOX_PROXY_HEADER)).toBe('denied');

    await expect(fetch(`${origin}/api/sandbox-egress/api/inference/v1/responses`, {
      method: 'POST', headers: headers(), body: '{}',
    }).then(response => response.text())).rejects.toThrow();
    await vi.waitFor(() => expect(responseCancelled).toBe(true));
  });

  it('times out and cancels an upstream body stalled inside reader.read', async () => {
    let cancelled = false;
    const upstream = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({
      pull() { return new Promise<void>(() => {}); },
      cancel() { cancelled = true; },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const origin = await serve(upstream, { request: 64, response: 1024 }, 25);
    await expect(fetch(`${origin}/api/sandbox-egress/api/inference/v1/responses`, {
      method: 'POST', headers: headers(), body: '{}',
    })).rejects.toThrow();
    await vi.waitFor(() => expect(cancelled).toBe(true));
    expect(upstream).toHaveBeenCalledOnce();
  });

  it('interrupts an incomplete incoming body at the transport deadline without fetching', async () => {
    const upstream = vi.fn<typeof fetch>();
    const diagnostics: SandboxProxyDiagnostic[] = [];
    const origin = new URL(await serve(upstream, { request: 64, response: 1024 }, 25,
      event => diagnostics.push(event)));
    const status = await new Promise<number>((resolve, reject) => {
      const request = nodeRequest({ hostname: origin.hostname, port: origin.port,
        path: '/api/sandbox-egress/api/inference/v1/responses', method: 'POST',
        headers: { ...headers(), 'Content-Length': '2' } }, response => {
        response.resume(); response.once('end', () => { request.destroy(); resolve(response.statusCode ?? 0); });
      });
      request.once('error', reject);
      request.write('{');
    });
    expect(status).toBe(502);
    expect(upstream).not.toHaveBeenCalled();
    expect(diagnostics.map(event => event.code)).toEqual(['TRANSPORT_TIMEOUT', 'PROXY_HANDLER_FAILED']);
  });

  it('rejects a declared oversized body before reading or fetching', async () => {
    const upstream = vi.fn<typeof fetch>();
    const diagnostics: SandboxProxyDiagnostic[] = [];
    const origin = await serve(upstream, { request: 4, response: 1024 }, undefined,
      event => diagnostics.push(event));
    const response = await fetch(`${origin}/api/sandbox-egress/api/inference/v1/responses`, {
      method: 'POST', headers: headers({ 'content-length': '5' }), body: '12345',
    });
    expect(response.status).toBe(413);
    expect(upstream).not.toHaveBeenCalled();
    expect(diagnostics.map(event => event.code)).toEqual(['REQUEST_TOO_LARGE']);
  });

  it('bounds a chunked incoming body while it is being collected', async () => {
    const upstream = vi.fn<typeof fetch>();
    const diagnostics: SandboxProxyDiagnostic[] = [];
    const origin = new URL(await serve(upstream, { request: 4, response: 1024 }, undefined,
      event => diagnostics.push(event)));
    const status = await new Promise<number>((resolve, reject) => {
      const request = nodeRequest({ hostname: origin.hostname, port: origin.port,
        path: '/api/sandbox-egress/api/inference/v1/responses', method: 'POST', headers: headers() }, response => {
        response.resume(); response.once('end', () => resolve(response.statusCode ?? 0));
      });
      request.once('error', reject);
      request.end('12345');
    });
    expect(status).toBe(413);
    expect(upstream).not.toHaveBeenCalled();
    expect(diagnostics.map(event => event.code)).toEqual(['REQUEST_TOO_LARGE']);
  });

  it('fails explicitly when a declared body was consumed before the proxy', async () => {
    const upstream = vi.fn<typeof fetch>();
    const diagnostics: SandboxProxyDiagnostic[] = [];
    const app = express();
    app.use((_req, _res, next) => {
      _req.resume();
      _req.once('end', next);
    });
    app.use('/api/sandbox-egress', createSandboxGatewayProxyRouter({ appOrigin,
      expectedTeamId: 'team_motive', expectedProjectId: 'prj_motive',
      maximumRequestBytes: 64, maximumResponseBytes: 1024,
      fetch: upstream, defineProxy: fakeDefinition, audit: event => diagnostics.push(event) }));
    const server = app.listen(0, '127.0.0.1'); servers.push(server); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('test server address unavailable');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/sandbox-egress/api/inference/v1/responses`, {
      method: 'POST', headers: headers(), body: '{}',
    });
    expect(response.status).toBe(502);
    expect(response.headers.get(SANDBOX_PROXY_HEADER)).toBe('denied');
    expect(upstream).not.toHaveBeenCalled();
    expect(diagnostics.map(event => event.code)).toEqual(['REQUEST_BODY_UNAVAILABLE']);
  });

  it('fails closed without configured Vercel ownership', async () => {
    const upstream = vi.fn<typeof fetch>();
    const app = express(); app.use('/api/sandbox-egress', createSandboxGatewayProxyRouter({ appOrigin,
      maximumRequestBytes: 64, maximumResponseBytes: 64, fetch: upstream, defineProxy: fakeDefinition }));
    const server = app.listen(0, '127.0.0.1'); servers.push(server); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('test server address unavailable');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/sandbox-egress`, { method: 'POST', headers: headers(), body: '{}' });
    expect(response.status).toBe(503); expect(response.headers.get(SANDBOX_PROXY_HEADER)).toBe('denied');
    expect(upstream).not.toHaveBeenCalled();
  });
});
