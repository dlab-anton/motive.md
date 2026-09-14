import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { applyPostgresMigrations } from '../../packages/accounting/src/migrations.ts';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { MotiveOAuthProvider } from '../../server/mcp/oauth-provider.ts';

function loopbackDatabaseUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('MCP OAuth tests require a valid loopback PostgreSQL URL.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
      || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.search || url.hash) {
    throw new Error('MCP OAuth tests require a plain loopback PostgreSQL URL.');
  }
  return raw;
}

const baseUrl = loopbackDatabaseUrl(process.env.MOTIVE_TEST_DATABASE_URL);
const pgDescribe = baseUrl ? describe : describe.skip;

function sha(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

pgDescribe('durable MCP OAuth provider on isolated PostgreSQL', () => {
  const databaseName = `motive_mcp_oauth_${randomUUID().replaceAll('-', '')}`;
  const ownerId = randomUUID();
  const ownerActorId = `account:${ownerId}`;
  const credentialId = randomUUID();
  const credentialExpiry = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
  const appOrigin = 'https://motive.example';
  const resource = new URL('/mcp', appOrigin);
  let admin: Pool;
  let pool: Pool;
  let provider: MotiveOAuthProvider;
  let resolverFailure: 'none' | 'inactive' | 'transient' = 'none';

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
    const project = await new LedgerKernel(pool).createProject({ actorId: ownerActorId, idempotencyKey: randomUUID(),
      slug: 'circle-packing', visibility: 'PUBLIC', revisionContent: { title: 'OAuth test' } });
    await pool.query(`INSERT INTO motive.participation_agent_tokens
      (id,project_id,owner_actor_id,agent_name,token_digest,token_hint,license_acceptance_ref,expires_at)
      VALUES($1,$2,$3,'OAuth Agent',$4,'abcdef123456','test-terms',$5)`,
    [credentialId, project.id, ownerActorId, sha('underlying-project-key'), credentialExpiry]);
    provider = new MotiveOAuthProvider({ pool, appOrigin,
      resolveCredential: async (owner, credential) => {
        if (resolverFailure === 'transient') throw new Error('temporary database failure');
        if (resolverFailure === 'inactive') throw Object.assign(new Error('unavailable'), { code: 'UNAUTHORIZED' });
        const active = await pool.query(`SELECT expires_at FROM motive.participation_agent_tokens
          WHERE owner_actor_id=$1 AND id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()`, [owner, credential]);
        if (active.rowCount !== 1) throw Object.assign(new Error('unavailable'), { code: 'UNAUTHORIZED' });
        return { projectKey: 'private-project-key-canary', expiresAt: active.rows[0].expires_at.toISOString() };
      } });
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
      await admin.end();
    }
  });

  async function client(callback = 'https://client.example/oauth/callback'): Promise<OAuthClientInformationFull> {
    const value = { client_id: randomUUID(), client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: [callback], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'], client_name: 'Connector test', scope: 'motive:project' } satisfies OAuthClientInformationFull;
    return provider.clientsStore.registerClient!(value);
  }

  async function authorize(currentClient: OAuthClientInformationFull, state = 'client-state') {
    let location = '';
    await provider.authorize(currentClient, { state, scopes: [], codeChallenge: 'a'.repeat(43),
      redirectUri: currentClient.redirect_uris[0]!, resource }, { redirect: (_status: number, target: string) => {
        location = target;
      } } as never);
    const requestId = new URL(location).searchParams.get('request')!;
    return { requestId, location };
  }

  it('keeps public registration bounded and returns safe consent metadata', async () => {
    await expect(client('https://client.example/callback#fragment')).rejects.toMatchObject({ errorCode: 'invalid_client_metadata' });
    const currentClient = await client();
    await expect(provider.authorize(currentClient, { scopes: ['motive:project'], codeChallenge: 'a'.repeat(44),
      redirectUri: currentClient.redirect_uris[0]!, resource }, {} as never)).rejects.toMatchObject({ errorCode: 'invalid_request' });
    const pending = await authorize(currentClient);
    expect(pending.location).toMatch(/^https:\/\/motive\.example\/connect\/motive\?request=/);
    await expect(provider.getConsent(pending.requestId)).resolves.toEqual(expect.objectContaining({
      clientName: 'Connector test', redirectUri: currentClient.redirect_uris[0], projectSlug: 'circle-packing',
      scopes: ['motive:project'],
    }));
  });

  it('issues digest-only one-use codes and rotating tokens bound to client, redirect, and resource', async () => {
    const currentClient = await client();
    const { requestId } = await authorize(currentClient);
    const approved = await provider.approveConsent(requestId, ownerActorId, credentialId);
    const approvedUrl = new URL(approved.redirectUrl);
    const code = approvedUrl.searchParams.get('code')!;
    expect(approvedUrl.searchParams.get('state')).toBe('client-state');
    expect(await provider.challengeForAuthorizationCode(currentClient, code)).toBe('a'.repeat(43));
    const tokens = await provider.exchangeAuthorizationCode(currentClient, code, undefined,
      currentClient.redirect_uris[0], resource);
    await expect(provider.exchangeAuthorizationCode(currentClient, code, undefined,
      currentClient.redirect_uris[0], resource)).rejects.toMatchObject({ errorCode: 'invalid_grant' });
    const info = await provider.verifyAccessToken(tokens.access_token);
    expect(info).toMatchObject({ clientId: currentClient.client_id, scopes: ['motive:project'],
      extra: { ownerActorId, credentialId, grantId: expect.any(String) } });
    await pool.query('UPDATE motive.mcp_oauth_grants SET resource=$2 WHERE id=$1', [info.extra!.grantId, 'https://other.example/mcp']);
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toMatchObject({ errorCode: 'invalid_token' });
    await pool.query('UPDATE motive.mcp_oauth_grants SET resource=$2 WHERE id=$1', [info.extra!.grantId, resource.href]);
    const stored = JSON.stringify((await pool.query(`SELECT code_digest FROM motive.mcp_oauth_authorization_codes
      UNION ALL SELECT token_digest FROM motive.mcp_oauth_access_tokens
      UNION ALL SELECT token_digest FROM motive.mcp_oauth_refresh_tokens`)).rows);
    expect(stored).not.toContain(code);
    expect(stored).not.toContain(tokens.access_token);
    expect(stored).not.toContain(tokens.refresh_token);
    expect(stored).not.toContain('private-project-key-canary');

    const rotated = await provider.exchangeRefreshToken(currentClient, tokens.refresh_token!, [], resource);
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
    await expect(provider.exchangeRefreshToken(currentClient, tokens.refresh_token!, [], resource))
      .rejects.toMatchObject({ errorCode: 'invalid_grant' });
    await expect(provider.verifyAccessToken(rotated.access_token)).rejects.toMatchObject({ errorCode: 'invalid_token' });
  });

  it('denies pending consent without issuing a code and revokes a whole grant by either token', async () => {
    const deniedClient = await client();
    const denied = await authorize(deniedClient, 'denied-state');
    const denial = new URL((await provider.denyConsent(denied.requestId)).redirectUrl);
    expect(denial.searchParams.get('error')).toBe('access_denied');
    expect(denial.searchParams.get('state')).toBe('denied-state');

    const currentClient = await client();
    const { requestId } = await authorize(currentClient);
    const code = new URL((await provider.approveConsent(requestId, ownerActorId, credentialId)).redirectUrl).searchParams.get('code')!;
    const tokens = await provider.exchangeAuthorizationCode(currentClient, code, undefined, currentClient.redirect_uris[0], resource);
    await provider.revokeToken(currentClient, { token: tokens.refresh_token!, token_type_hint: 'refresh_token' });
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toMatchObject({ errorCode: 'invalid_token' });
    await expect(provider.revokeToken(currentClient, { token: 'unknown' })).resolves.toBeUndefined();
  });

  it('does not reserve the two-connection pool while resolving concurrent credential authority', async () => {
    const currentClient = await client();
    const requests = await Promise.all([authorize(currentClient, 'one'), authorize(currentClient, 'two')]);
    const approvals = await Promise.all(requests.map(item => provider.approveConsent(item.requestId, ownerActorId, credentialId)));
    const codes = approvals.map(item => new URL(item.redirectUrl).searchParams.get('code')!);
    const tokens = await Promise.all(codes.map(code => provider.exchangeAuthorizationCode(currentClient, code, undefined,
      currentClient.redirect_uris[0], resource)));
    await expect(Promise.all(tokens.map(item => provider.verifyAccessToken(item.access_token)))).resolves.toHaveLength(2);
  });

  it('does not consume or revoke a refresh family on transient resolver failure', async () => {
    const currentClient = await client();
    const { requestId } = await authorize(currentClient);
    const code = new URL((await provider.approveConsent(requestId, ownerActorId, credentialId)).redirectUrl).searchParams.get('code')!;
    const tokens = await provider.exchangeAuthorizationCode(currentClient, code, undefined, currentClient.redirect_uris[0], resource);
    resolverFailure = 'transient';
    await expect(provider.exchangeRefreshToken(currentClient, tokens.refresh_token!, [], resource))
      .rejects.toMatchObject({ errorCode: 'temporarily_unavailable' });
    resolverFailure = 'none';
    await expect(provider.exchangeRefreshToken(currentClient, tokens.refresh_token!, [], resource))
      .resolves.toMatchObject({ access_token: expect.stringMatching(/^motive_oauth_access_/) });
  });
});
