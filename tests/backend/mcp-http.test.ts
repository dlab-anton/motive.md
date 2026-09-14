import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { applyPostgresMigrations } from '../../packages/accounting/src/migrations.ts';
import { createParticipationService, type ParticipationService } from '../../server/participation/service.ts';
import { createMotiveConnectorRouters, routeMotiveConnectorAlias } from '../../server/mcp/router.ts';

function loopbackDatabaseUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('MCP HTTP tests require a valid loopback PostgreSQL URL.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
      || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.search || url.hash) throw new Error('MCP HTTP tests require a plain loopback PostgreSQL URL.');
  return raw;
}

const baseUrl = loopbackDatabaseUrl(process.env.MOTIVE_TEST_DATABASE_URL);
const pgDescribe = baseUrl ? describe : describe.skip;

pgDescribe('hosted MCP OAuth and Streamable HTTP integration', () => {
  const databaseName = `motive_mcp_http_${randomUUID().replaceAll('-', '')}`;
  const ownerId = randomUUID();
  const ownerActorId = `account:${ownerId}`;
  const issuerActorId = `operator:mcp-http-${randomUUID()}`;
  const tokenSecret = `mcp-http-test-${'s'.repeat(48)}`;
  let credentialId: string;
  let participation: ParticipationService;
  let admin: Pool;
  let pool: Pool;
  let server: ReturnType<ReturnType<typeof express>['listen']>;
  let origin: string;

  beforeAll(async () => {
    const source = new URL(baseUrl!);
    const adminUrl = new URL(source);
    adminUrl.pathname = '/postgres';
    admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const testUrl = new URL(source);
    testUrl.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: testUrl.toString(), max: 2 });
    await applyPostgresMigrations(pool);
    await pool.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at)
      VALUES($1,'supabase',$2,'ACTIVE',clock_timestamp())`, [ownerActorId, ownerId]);
    await new LedgerKernel(pool).createProject({ actorId: issuerActorId, idempotencyKey: randomUUID(),
      slug: 'circle-packing', visibility: 'PUBLIC', revisionContent: { title: 'MCP HTTP test' } });
    participation = createParticipationService(pool, { tokenSecret, issuerActorId,
      isActorActive: async actor => actor === ownerActorId });
    await participation.ensureCircleWorkOrder();
    const joined = await participation.join(ownerActorId, 'OAuth HTTP Test', { projectSlug: 'circle-packing',
      publishDisplayName: false, acceptReferenceTerms: true }, `initial-${randomUUID()}`);
    credentialId = joined.credential.id;

    const app = express();
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server address is unavailable.');
    origin = `http://127.0.0.1:${address.port}`;
    const routers = createMotiveConnectorRouters({ pool, participation, appOrigin: origin });
    app.use(routeMotiveConnectorAlias);
    app.use('/api/mcp-oauth', routers.oauth);
    app.use('/api/mcp', routers.mcp);
    app.use('/api/mcp-consent', express.json(), (_req, res, next) => {
      res.locals.actorId = ownerActorId;
      res.locals.accountName = 'OAuth HTTP Test';
      next();
    }, routers.consent);
  }, 30_000);

  afterAll(async () => {
    if (server) { server.close(); await once(server, 'close'); }
    await pool?.end();
    if (admin) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
      await admin.end();
    }
  });

  it('completes DCR, consent, PKCE, MCP initialization, refresh, and underlying credential revocation', async () => {
    const metadataResponse = await fetch(`${origin}/.well-known/oauth-authorization-server`);
    expect(metadataResponse.status).toBe(200);
    const metadata = await metadataResponse.json() as Record<string, unknown>;
    expect(metadata).toMatchObject({ issuer: `${origin}/`, authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`,
      code_challenge_methods_supported: ['S256'], scopes_supported: ['motive:project'],
      token_endpoint_auth_methods_supported: ['none'] });
    const protectedResponse = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`);
    await expect(protectedResponse.json()).resolves.toMatchObject({ resource: `${origin}/mcp`,
      authorization_servers: [`${origin}/`] });

    const callback = 'http://127.0.0.1/cowork/callback';
    const registrationResponse = await fetch(`${origin}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [callback], token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
        client_name: 'Cowork integration test', scope: 'motive:project' }) });
    expect(registrationResponse.status).toBe(201);
    const registered = await registrationResponse.json() as { client_id: string };
    expect(registered.client_id).toMatch(/^[a-f0-9-]{36}$/);

    const verifier = 'v'.repeat(64);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorization = new URL('/authorize', origin);
    for (const [key, value] of Object.entries({ response_type: 'code', client_id: registered.client_id,
      redirect_uri: callback, code_challenge: challenge, code_challenge_method: 'S256',
      scope: 'motive:project', state: 'cowork-state', resource: `${origin}/mcp` })) authorization.searchParams.set(key, value);
    const authorizationResponse = await fetch(authorization, { redirect: 'manual' });
    expect(authorizationResponse.status).toBe(302);
    const connectLocation = new URL(authorizationResponse.headers.get('location')!);
    expect(connectLocation.origin).toBe(origin);
    expect(connectLocation.pathname).toBe('/connect/motive');
    const requestId = connectLocation.searchParams.get('request')!;

    const consentResponse = await fetch(`${origin}/api/mcp-consent/${requestId}`);
    expect(consentResponse.status).toBe(200);
    await expect(consentResponse.json()).resolves.toMatchObject({ clientName: 'Cowork integration test',
      projectSlug: 'circle-packing', scopes: ['motive:project'], credentials: [{ id: credentialId }] });
    const approvalResponse = await fetch(`${origin}/api/mcp-consent/${requestId}/approve`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credentialId,
        acceptReferenceTerms: true, publishDisplayName: false }) });
    expect(approvalResponse.status).toBe(200);
    const callbackUrl = new URL(((await approvalResponse.json()) as { redirectUrl: string }).redirectUrl);
    expect(callbackUrl.origin + callbackUrl.pathname).toBe(callback);
    expect(callbackUrl.searchParams.get('state')).toBe('cowork-state');
    const code = callbackUrl.searchParams.get('code')!;

    const wrongPkce = await fetch(`${origin}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: registered.client_id, code,
        code_verifier: 'wrong-verifier'.repeat(5), redirect_uri: callback, resource: `${origin}/mcp` }) });
    expect(wrongPkce.status).toBe(400);
    await expect(wrongPkce.json()).resolves.toMatchObject({ error: 'invalid_grant' });
    const tokenResponse = await fetch(`${origin}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: registered.client_id, code,
        code_verifier: verifier, redirect_uri: callback, resource: `${origin}/mcp` }) });
    expect(tokenResponse.status).toBe(200);
    const tokens = await tokenResponse.json() as { access_token: string; refresh_token: string };
    expect(tokens.access_token).toMatch(/^motive_oauth_access_/);
    expect(tokens.refresh_token).toMatch(/^motive_oauth_refresh_/);

    const mcp = async (token: string, body: unknown) => fetch(`${origin}/mcp`, { method: 'POST', headers: {
      Authorization: `Bearer ${token}`, Origin: origin, Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json', 'MCP-Protocol-Version': '2025-11-25',
    }, body: JSON.stringify(body) });
    const initialized = await mcp(tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'cowork-test', version: '1.0.0' },
    } });
    expect(initialized.status).toBe(200);
    await expect(initialized.json()).resolves.toMatchObject({ result: { protocolVersion: '2025-11-25', capabilities: { tools: {} } } });
    const listed = await mcp(tokens.access_token, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    expect(listed.status).toBe(200);
    const listPayload = await listed.json() as { result: { tools: Array<{ name: string }> } };
    expect(listPayload.result.tools).toHaveLength(25);
    expect(listPayload.result.tools.map(tool => tool.name)).toContain('get_work_queue');

    const directFetch = globalThis.fetch.bind(globalThis);
    const outbound: Array<{ url: string; authorization: string | null }> = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === 'https://motive-md.vercel.app') {
        const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
        outbound.push({ url: url.href, authorization: headers.get('authorization') });
        return new Response('# Exact contributor skill\r\n', { status: 200,
          headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
      }
      return directFetch(input, init);
    });
    try {
      const document = await mcp(tokens.access_token, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: {
        name: 'read_project_document', arguments: { document: 'contributor_skill' },
      } });
      expect(document.status).toBe(200);
      const documentPayload = await document.json() as { result: { content: Array<{ text: string }> } };
      expect(documentPayload.result.content[0]?.text).toBe('# Exact contributor skill\r\n');
      expect(outbound).toEqual([{ url: 'https://motive-md.vercel.app/agents/SKILL.md', authorization: null }]);
    } finally { fetchSpy.mockRestore(); }

    const refreshResponse = await fetch(`${origin}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: registered.client_id,
        refresh_token: tokens.refresh_token, resource: `${origin}/mcp` }) });
    expect(refreshResponse.status).toBe(200);
    const refreshed = await refreshResponse.json() as { access_token: string; refresh_token: string };
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);

    const credentialsBefore = (await participation.getMe(ownerActorId)).credentials.length;
    const newAgentAuthorization = new URL(authorization);
    newAgentAuthorization.searchParams.set('state', 'new-agent-state');
    const newAgentStart = await fetch(newAgentAuthorization, { redirect: 'manual' });
    const newAgentRequest = new URL(newAgentStart.headers.get('location')!).searchParams.get('request')!;
    const newAgentApproval = await fetch(`${origin}/api/mcp-consent/${newAgentRequest}/approve`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credentialId: 'new',
        acceptReferenceTerms: true, publishDisplayName: false }) });
    expect(newAgentApproval.status).toBe(200);
    expect((await participation.getMe(ownerActorId)).credentials).toHaveLength(credentialsBefore + 1);

    await participation.revokeToken(ownerActorId, credentialId, `revoke-${randomUUID()}`);
    const rejected = await mcp(refreshed.access_token, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource/mcp');
  });
});
