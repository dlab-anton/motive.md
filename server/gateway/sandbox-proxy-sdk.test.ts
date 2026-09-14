import express from 'express';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSandboxGatewayProxyRouter,
  SANDBOX_PROXY_HEADER,
  type SandboxProxyDiagnostic,
  type SandboxProxyDiagnosticCode,
} from './sandbox-proxy.ts';

const appOrigin = 'https://motive.example';
const gatewayUrl = `${appOrigin}/api/inference/v1/responses`;
const bearer = `Bearer ${'p'.repeat(46)}`;
const exactBody = '{  }\n';
const teamId = 'team_motive';
const projectId = 'prj_motive';
const servers: Server[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  })));
});

async function signedToken(input: {
  issuer: string;
  audience: string;
  privateKey: CryptoKey;
  kid: string;
}): Promise<string> {
  return new SignJWT({
    team_id: teamId,
    project_id: projectId,
    sandbox_id: 'sbx_synthetic',
    sandbox_name: 'synthetic-sandbox',
  })
    .setProtectedHeader({ alg: 'RS256', kid: input.kid })
    .setIssuer(input.issuer)
    .setAudience(input.audience)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(input.privateKey);
}

async function fixture(input: { audience?: string; wrongSignature?: boolean }) {
  const suffix = crypto.randomUUID();
  const issuer = `https://oidc.vercel.com/synthetic-${suffix}`;
  const jwksUrl = `${issuer}/.well-known/jwks`;
  const kid = `key-${suffix}`;
  const signing = await generateKeyPair('RS256');
  const published = await exportJWK(signing.publicKey);
  const other = input.wrongSignature ? await generateKeyPair('RS256') : null;
  const token = await signedToken({
    issuer,
    audience: input.audience ?? `${appOrigin}/api/sandbox-egress`,
    privateKey: other?.privateKey ?? signing.privateKey,
    kid,
  });
  const key: JWK = { ...published, alg: 'RS256', use: 'sig', kid };
  const realFetch = globalThis.fetch;
  const jwksRequests: string[] = [];
  vi.stubGlobal('fetch', async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof request === 'string' || request instanceof URL ? request : request.url);
    if (url.href === jwksUrl) {
      jwksRequests.push(url.href);
      expect(init?.method).toBe('GET');
      expect(init?.redirect).toBe('manual');
      return Response.json({ keys: [key] });
    }
    if (url.hostname === '127.0.0.1') return realFetch(request, init);
    throw new Error('UNEXPECTED_TEST_NETWORK_TARGET');
  });

  const upstream = vi.fn<typeof fetch>(async (_url, init) => {
    expect(new Headers(init?.headers).get('authorization')).toBe(bearer);
    expect(new Headers(init?.headers).get('content-length')).toBe(String(Buffer.byteLength(exactBody)));
    expect(await new Response(init?.body).text()).toBe(exactBody);
    return Response.json({ error: 'synthetic_gateway_rejection' }, { status: 401 });
  });
  const diagnostics: SandboxProxyDiagnostic[] = [];
  const app = express();
  app.use('/api/sandbox-egress', createSandboxGatewayProxyRouter({
    appOrigin,
    expectedTeamId: teamId,
    expectedProjectId: projectId,
    maximumRequestBytes: 64,
    maximumResponseBytes: 1024,
    fetch: upstream,
    audit: event => diagnostics.push(event),
  }));
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TEST_SERVER_ADDRESS_UNAVAILABLE');

  const response = await fetch(`http://127.0.0.1:${address.port}/api/sandbox-egress/api/inference/v1/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: bearer,
      'Vercel-Forwarded-Host': 'motive.example',
      'Vercel-Forwarded-Scheme': 'https',
      'Vercel-Forwarded-Port': '443',
      'Vercel-Forwarded-Path': '/api/inference/v1/responses',
      'Vercel-Sandbox-OIDC-Token': token,
    },
    body: exactBody,
  });
  return { response, upstream, diagnostics, jwksRequests, jwksUrl };
}

describe('Sandbox gateway proxy with the installed SDK verifier', () => {
  it('verifies a locally signed SDK request and admits it to the fixed upstream', async () => {
    const result = await fixture({});
    expect(result.response.status).toBe(401);
    expect(result.response.headers.get(SANDBOX_PROXY_HEADER)).toBe('gateway');
    expect(await result.response.json()).toEqual({ error: 'synthetic_gateway_rejection' });
    expect(result.upstream).toHaveBeenCalledOnce();
    expect(result.jwksRequests).toEqual([result.jwksUrl]);
    expect(result.diagnostics.map(item => item.code)).toEqual([
      'REQUEST_BODY_COMPLETE', 'ADMITTED', 'FETCH_STARTED', 'UPSTREAM_RESPONSE',
    ]);
    expect(result.diagnostics[0]).toMatchObject({ bytes: Buffer.byteLength(exactBody) });
    expect(result.diagnostics[2]).toMatchObject({ bytes: Buffer.byteLength(exactBody) });
    expect(result.diagnostics[3]).toMatchObject({ status: 401 });
  });

  it.each([
    ['wrong audience', { audience: `${appOrigin}/api/other` }, 'OIDC_AUDIENCE_REJECTED'],
    ['wrong signature', { wrongSignature: true }, 'OIDC_SIGNATURE_REJECTED'],
  ] as const)('denies a signed token with %s before upstream', async (_label, changed, expectedCode) => {
    const result = await fixture(changed);
    expect(result.response.status).toBe(403);
    expect(result.response.headers.get(SANDBOX_PROXY_HEADER)).toBe('denied');
    expect(await result.response.json()).toEqual({ error: 'sandbox_proxy_denied' });
    expect(result.upstream).not.toHaveBeenCalled();
    expect(result.jwksRequests).toEqual([result.jwksUrl]);
    expect(result.diagnostics.map(item => item.code)).toEqual([
      'REQUEST_BODY_COMPLETE', expectedCode satisfies SandboxProxyDiagnosticCode,
    ]);
  });
});
