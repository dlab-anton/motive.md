import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  AccessDeniedError,
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
  TemporarilyUnavailableError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

const SCOPE = 'motive:project';
const PROJECT_SLUG = 'circle-packing';
const CLIENT_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const REQUEST_LIFETIME_MS = 10 * 60 * 1000;
const CODE_LIFETIME_MS = 5 * 60 * 1000;
const ACCESS_LIFETIME_MS = 60 * 60 * 1000;
const GRANT_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PKCE = /^[A-Za-z0-9_-]{43}$/;

type ResolveCredential = (ownerActorId: string, tokenId: string) => Promise<{
  projectKey: string;
  expiresAt: string;
}>;

export type McpOAuthProviderOptions = Readonly<{
  pool: Pool;
  appOrigin: string;
  resolveCredential: ResolveCredential;
  now?: () => Date;
}>;

export type McpOAuthConsent = Readonly<{
  clientName: string;
  redirectUri: string;
  projectSlug: typeof PROJECT_SLUG;
  scopes: readonly string[];
  expiresAt: string;
}>;

type ExchangeOutcome =
  | { kind: 'tokens'; tokens: OAuthTokens }
  | { kind: 'replay' }
  | { kind: 'invalid' };

function inactiveAuthority(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  return ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'EXPIRED'].includes(String(error.code));
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function opaque(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

function text(row: QueryResultRow, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`Invalid OAuth database field ${key}.`);
  return value;
}

function date(row: QueryResultRow, key: string): Date {
  const value = row[key];
  const result = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(result.getTime())) throw new Error(`Invalid OAuth database date ${key}.`);
  return result;
}

function exactResource(resource: URL | undefined, expected: string): string {
  if (!resource || resource.href !== expected) throw new InvalidTargetError('The MCP resource must be specified exactly.');
  return resource.href;
}

function exactScopes(scopes: readonly string[] | undefined): string[] {
  if (!scopes?.length) return [SCOPE];
  if (scopes.length !== 1 || scopes[0] !== SCOPE) throw new InvalidScopeError(`Only ${SCOPE} is supported.`);
  return [SCOPE];
}

function callbackAllowed(raw: string): boolean {
  if (raw.length > 2048) return false;
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.username || url.password || url.hash) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

function callbackMatches(requested: string, registered: string): boolean {
  if (requested === registered) return true;
  let left: URL;
  let right: URL;
  try { left = new URL(requested); right = new URL(registered); } catch { return false; }
  const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
  return loopback.has(left.hostname) && left.hostname === right.hostname && left.protocol === right.protocol
    && left.pathname === right.pathname && left.search === right.search;
}

function redirect(raw: string, values: Record<string, string | undefined>): string {
  const url = new URL(raw);
  for (const [key, value] of Object.entries(values)) if (value !== undefined) url.searchParams.set(key, value);
  return url.href;
}

export class MotiveOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  readonly skipLocalPkceValidation = false;
  private readonly appOrigin: string;
  private readonly resource: string;
  private readonly now: () => Date;

  constructor(private readonly options: McpOAuthProviderOptions) {
    const origin = new URL(options.appOrigin);
    if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) {
      throw new Error('MCP OAuth appOrigin must be an origin URL.');
    }
    this.appOrigin = origin.origin;
    this.resource = new URL('/mcp', this.appOrigin).href;
    this.now = options.now ?? (() => new Date());
    this.clientsStore = Object.freeze({
      getClient: this.getClient.bind(this),
      registerClient: this.registerClient.bind(this),
    });
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  private async cleanup(client: PoolClient, now: Date): Promise<void> {
    // Client deletion cascades only through this bounded OAuth domain.
    await client.query('DELETE FROM motive.mcp_oauth_clients WHERE expires_at<=$1', [now]);
    await client.query(`DELETE FROM motive.mcp_oauth_authorization_requests request
      WHERE request.expires_at<=$1 AND request.decision IS NULL`, [now]);
  }

  private async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    if (!UUID.test(clientId)) return undefined;
    const result = await this.options.pool.query(
      'SELECT metadata FROM motive.mcp_oauth_clients WHERE client_id=$1 AND expires_at>$2',
      [clientId, this.now()],
    );
    if (result.rowCount !== 1 || !result.rows[0]?.metadata) return undefined;
    return result.rows[0].metadata as OAuthClientInformationFull;
  }

  private async registerClient(input: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>): Promise<OAuthClientInformationFull> {
    const candidate = input as OAuthClientInformationFull;
    if (!UUID.test(candidate.client_id) || candidate.client_secret !== undefined
        || candidate.token_endpoint_auth_method !== 'none') {
      throw new InvalidClientMetadataError('Only generated public clients are supported.');
    }
    if (!Array.isArray(candidate.redirect_uris) || candidate.redirect_uris.length < 1
        || candidate.redirect_uris.length > 20 || candidate.redirect_uris.some(uri => !callbackAllowed(uri))
        || candidate.redirect_uris.reduce((total, uri) => total + uri.length, 0) > 2048) {
      throw new InvalidClientMetadataError('Redirect URIs must be bounded HTTPS or loopback HTTP callbacks.');
    }
    const grantTypes = candidate.grant_types ?? ['authorization_code', 'refresh_token'];
    if (!grantTypes.includes('authorization_code') || grantTypes.some(value => !['authorization_code', 'refresh_token'].includes(value))) {
      throw new InvalidClientMetadataError('Only authorization_code and refresh_token grants are supported.');
    }
    const responseTypes = candidate.response_types ?? ['code'];
    if (responseTypes.length !== 1 || responseTypes[0] !== 'code') {
      throw new InvalidClientMetadataError('Only the code response type is supported.');
    }
    if (candidate.scope !== undefined && candidate.scope !== SCOPE) {
      throw new InvalidClientMetadataError(`Only ${SCOPE} is supported.`);
    }
    const clientName = candidate.client_name?.trim() || 'MCP client';
    if (clientName.length > 120) throw new InvalidClientMetadataError('Client name is too long.');
    const issuedAtSeconds = candidate.client_id_issued_at ?? Math.floor(this.now().getTime() / 1000);
    const issuedAt = new Date(issuedAtSeconds * 1000);
    if (!Number.isFinite(issuedAt.getTime())) throw new InvalidClientMetadataError('Client issue time is invalid.');
    const metadata: OAuthClientInformationFull = {
      ...candidate,
      client_name: clientName,
      token_endpoint_auth_method: 'none',
      grant_types: grantTypes,
      response_types: responseTypes,
      scope: SCOPE,
      client_id_issued_at: Math.floor(issuedAt.getTime() / 1000),
    };
    if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > 8192) {
      throw new InvalidClientMetadataError('Client metadata is too large.');
    }
    await this.transaction(async client => {
      const now = this.now();
      await this.cleanup(client, now);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('motive.mcp_oauth_clients',0))");
      const count = await client.query('SELECT count(*)::integer AS count FROM motive.mcp_oauth_clients WHERE expires_at>$1', [now]);
      if (Number(count.rows[0]?.count) >= 10_000) throw new InvalidClientMetadataError('Client registry capacity is reached.');
      await client.query(`INSERT INTO motive.mcp_oauth_clients
        (client_id,metadata,redirect_uris,client_name,issued_at,expires_at,created_at)
        VALUES($1,$2::jsonb,$3,$4,$5,$6,$7)`, [metadata.client_id, JSON.stringify(metadata), metadata.redirect_uris,
        clientName, issuedAt, new Date(issuedAt.getTime() + CLIENT_LIFETIME_MS), now]);
    });
    return metadata;
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (!client.redirect_uris.some(uri => callbackMatches(params.redirectUri, uri))) throw new InvalidRequestError('Unregistered redirect_uri.');
    if (!PKCE.test(params.codeChallenge)) throw new InvalidRequestError('PKCE challenge is invalid.');
    if (params.state !== undefined && (params.state.length < 1 || params.state.length > 1024)) {
      throw new InvalidRequestError('State is too large.');
    }
    const scopes = exactScopes(params.scopes);
    const resource = exactResource(params.resource, this.resource);
    const id = randomUUID();
    const now = this.now();
    await this.transaction(async database => {
      await this.cleanup(database, now);
      await database.query(`INSERT INTO motive.mcp_oauth_authorization_requests
        (id,client_id,redirect_uri,resource,scopes,state,code_challenge,expires_at,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, client.client_id, params.redirectUri, resource, scopes,
        params.state ?? null, params.codeChallenge, new Date(now.getTime() + REQUEST_LIFETIME_MS), now]);
    });
    res.redirect(302, new URL(`/connect/motive?request=${encodeURIComponent(id)}`, this.appOrigin).href);
  }

  async getConsent(requestId: string): Promise<McpOAuthConsent> {
    if (!UUID.test(requestId)) throw new InvalidRequestError('Authorization request is invalid.');
    const result = await this.options.pool.query(`SELECT request.redirect_uri,request.scopes,request.expires_at,client.client_name
      FROM motive.mcp_oauth_authorization_requests request
      JOIN motive.mcp_oauth_clients client ON client.client_id=request.client_id
      WHERE request.id=$1 AND request.decision IS NULL AND request.expires_at>$2 AND client.expires_at>$2`, [requestId, this.now()]);
    if (result.rowCount !== 1) throw new InvalidRequestError('Authorization request is invalid or expired.');
    const row = result.rows[0];
    return Object.freeze({ clientName: text(row, 'client_name'), redirectUri: text(row, 'redirect_uri'),
      projectSlug: PROJECT_SLUG, scopes: Object.freeze([...(row.scopes as string[])]), expiresAt: date(row, 'expires_at').toISOString() });
  }

  async approveConsent(requestId: string, ownerActorId: string, credentialId: string): Promise<{ redirectUrl: string }> {
    if (!UUID.test(requestId) || !UUID.test(credentialId) || !/^account:[A-Za-z0-9._~-]{1,480}$/.test(ownerActorId)) {
      throw new InvalidRequestError('Consent approval is invalid.');
    }
    const { expiresAt } = await this.options.resolveCredential(ownerActorId, credentialId);
    const credentialExpiry = new Date(expiresAt);
    const now = this.now();
    if (!Number.isFinite(credentialExpiry.getTime()) || credentialExpiry <= now) throw new AccessDeniedError('Agent credential is unavailable.');
    return this.transaction(async client => {
      const request = await client.query(`SELECT request.*,oauth_client.expires_at AS client_expires_at
        FROM motive.mcp_oauth_authorization_requests request
        JOIN motive.mcp_oauth_clients oauth_client ON oauth_client.client_id=request.client_id
        WHERE request.id=$1 FOR UPDATE OF request`, [requestId]);
      if (request.rowCount !== 1 || request.rows[0].decision || date(request.rows[0], 'expires_at') <= now
          || date(request.rows[0], 'client_expires_at') <= now) throw new InvalidRequestError('Authorization request is invalid or expired.');
      const credential = await client.query(`SELECT token.project_id FROM motive.participation_agent_tokens token
        JOIN motive.projects project ON project.id=token.project_id AND project.slug=$3
        JOIN motive.memberships membership ON membership.project_id=token.project_id AND membership.actor_id=token.owner_actor_id
          AND membership.revoked_at IS NULL
        JOIN motive.account_identities identity ON identity.actor_id=token.owner_actor_id AND identity.status='ACTIVE'
        WHERE token.id=$1 AND token.owner_actor_id=$2 AND token.revoked_at IS NULL AND token.expires_at>$4 FOR SHARE OF token`,
      [credentialId, ownerActorId, PROJECT_SLUG, now]);
      if (credential.rowCount !== 1) throw new AccessDeniedError('Agent credential is unavailable.');
      const grantId = randomUUID();
      const grantExpiry = new Date(Math.min(now.getTime() + GRANT_LIFETIME_MS, credentialExpiry.getTime(),
        date(request.rows[0], 'client_expires_at').getTime()));
      await client.query(`INSERT INTO motive.mcp_oauth_grants
        (id,client_id,owner_actor_id,credential_id,project_id,resource,scopes,expires_at,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [grantId, request.rows[0].client_id, ownerActorId, credentialId,
        credential.rows[0].project_id, request.rows[0].resource, request.rows[0].scopes, grantExpiry, now]);
      const rawCode = opaque('motive_oauth_code_');
      await client.query(`INSERT INTO motive.mcp_oauth_authorization_codes
        (id,code_digest,request_id,grant_id,client_id,redirect_uri,resource,code_challenge,expires_at,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [randomUUID(), digest(rawCode), requestId, grantId,
        request.rows[0].client_id, request.rows[0].redirect_uri, request.rows[0].resource,
        request.rows[0].code_challenge, new Date(now.getTime() + CODE_LIFETIME_MS), now]);
      await client.query(`UPDATE motive.mcp_oauth_authorization_requests SET decision='APPROVED',decided_at=$2 WHERE id=$1`, [requestId, now]);
      return { redirectUrl: redirect(text(request.rows[0], 'redirect_uri'), { code: rawCode,
        state: request.rows[0].state ?? undefined }) };
    });
  }

  async denyConsent(requestId: string): Promise<{ redirectUrl: string }> {
    if (!UUID.test(requestId)) throw new InvalidRequestError('Authorization request is invalid.');
    return this.transaction(async client => {
      const now = this.now();
      const request = await client.query(`SELECT * FROM motive.mcp_oauth_authorization_requests
        WHERE id=$1 FOR UPDATE`, [requestId]);
      if (request.rowCount !== 1 || request.rows[0].decision || date(request.rows[0], 'expires_at') <= now) {
        throw new InvalidRequestError('Authorization request is invalid or expired.');
      }
      await client.query(`UPDATE motive.mcp_oauth_authorization_requests SET decision='DENIED',decided_at=$2 WHERE id=$1`, [requestId, now]);
      return { redirectUrl: redirect(text(request.rows[0], 'redirect_uri'), { error: 'access_denied',
        error_description: 'The project connection was denied.', state: request.rows[0].state ?? undefined }) };
    });
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const result = await this.options.pool.query(`SELECT code.code_challenge FROM motive.mcp_oauth_authorization_codes code
      JOIN motive.mcp_oauth_grants grant_row ON grant_row.id=code.grant_id
      WHERE code.code_digest=$1 AND code.client_id=$2 AND code.consumed_at IS NULL AND code.expires_at>$3
        AND grant_row.revoked_at IS NULL AND grant_row.expires_at>$3`, [digest(authorizationCode), client.client_id, this.now()]);
    if (result.rowCount !== 1) throw new InvalidGrantError('Authorization code is invalid or expired.');
    return text(result.rows[0], 'code_challenge');
  }

  private async issueTokens(client: PoolClient, grant: QueryResultRow, now: Date): Promise<OAuthTokens> {
    const grantExpiry = date(grant, 'expires_at');
    if (grantExpiry <= now) throw new InvalidGrantError('Grant is expired.');
    const access = opaque('motive_oauth_access_');
    const refresh = opaque('motive_oauth_refresh_');
    const accessExpiry = new Date(Math.min(now.getTime() + ACCESS_LIFETIME_MS, grantExpiry.getTime()));
    const refreshId = randomUUID();
    await client.query(`INSERT INTO motive.mcp_oauth_access_tokens(id,token_digest,grant_id,expires_at,created_at)
      VALUES($1,$2,$3,$4,$5)`, [randomUUID(), digest(access), grant.id, accessExpiry, now]);
    await client.query(`INSERT INTO motive.mcp_oauth_refresh_tokens(id,token_digest,grant_id,expires_at,created_at)
      VALUES($1,$2,$3,$4,$5)`, [refreshId, digest(refresh), grant.id, grantExpiry, now]);
    return { access_token: access, token_type: 'Bearer', expires_in: Math.max(1, Math.floor((accessExpiry.getTime() - now.getTime()) / 1000)),
      scope: (grant.scopes as string[]).join(' '), refresh_token: refresh };
  }

  private async currentCredential(client: PoolClient, grant: QueryResultRow, now: Date): Promise<boolean> {
    const result = await client.query(`SELECT 1 FROM motive.participation_agent_tokens token
      JOIN motive.projects project ON project.id=token.project_id AND project.slug=$4
      JOIN motive.memberships membership ON membership.project_id=token.project_id AND membership.actor_id=token.owner_actor_id
        AND membership.revoked_at IS NULL
      JOIN motive.account_identities identity ON identity.actor_id=token.owner_actor_id AND identity.status='ACTIVE'
      WHERE token.id=$1 AND token.owner_actor_id=$2 AND token.project_id=$3
        AND token.revoked_at IS NULL AND token.expires_at>$5 FOR SHARE OF token`,
    [grant.credential_id, grant.owner_actor_id, grant.project_id, PROJECT_SLUG, now]);
    return result.rowCount === 1;
  }

  async exchangeAuthorizationCode(clientInfo: OAuthClientInformationFull, authorizationCode: string, _codeVerifier?: string,
    redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    const expectedResource = exactResource(resource, this.resource);
    const now = this.now();
    const codeDigest = digest(authorizationCode);
    const preflight = await this.options.pool.query(`SELECT grant_row.owner_actor_id,grant_row.credential_id
      FROM motive.mcp_oauth_authorization_codes code JOIN motive.mcp_oauth_grants grant_row ON grant_row.id=code.grant_id
      WHERE code.code_digest=$1 AND code.client_id=$2 AND code.redirect_uri=$3 AND code.resource=$4
        AND code.consumed_at IS NULL AND code.expires_at>$5 AND grant_row.revoked_at IS NULL AND grant_row.expires_at>$5`,
    [codeDigest, clientInfo.client_id, redirectUri ?? '', expectedResource, now]);
    if (preflight.rowCount !== 1) throw new InvalidGrantError('Authorization code binding is invalid or expired.');
    try {
      const { expiresAt } = await this.options.resolveCredential(text(preflight.rows[0], 'owner_actor_id'), text(preflight.rows[0], 'credential_id'));
      const credentialExpiry = new Date(expiresAt);
      if (!Number.isFinite(credentialExpiry.getTime()) || credentialExpiry <= now) throw new InvalidGrantError('Agent credential is unavailable.');
    } catch (error) {
      if (error instanceof InvalidGrantError || inactiveAuthority(error)) throw new InvalidGrantError('Agent credential is unavailable.');
      throw new TemporarilyUnavailableError('Agent credential authority could not be verified.');
    }
    const outcome = await this.transaction<ExchangeOutcome>(async client => {
      const result = await client.query(`SELECT code.*,grant_row.owner_actor_id,grant_row.credential_id,
          grant_row.project_id,grant_row.scopes,grant_row.expires_at AS grant_expires_at,grant_row.revoked_at AS grant_revoked_at
        FROM motive.mcp_oauth_authorization_codes code JOIN motive.mcp_oauth_grants grant_row ON grant_row.id=code.grant_id
        WHERE code.code_digest=$1 FOR UPDATE OF code,grant_row`, [codeDigest]);
      if (result.rowCount !== 1) throw new InvalidGrantError('Authorization code is invalid.');
      const row = result.rows[0];
      if (row.client_id !== clientInfo.client_id || redirectUri !== row.redirect_uri || expectedResource !== row.resource
          || row.consumed_at || row.grant_revoked_at || date(row, 'expires_at') <= now || date(row, 'grant_expires_at') <= now) {
        throw new InvalidGrantError('Authorization code binding is invalid or expired.');
      }
      if (!await this.currentCredential(client, row, now)) {
        await client.query('UPDATE motive.mcp_oauth_grants SET revoked_at=COALESCE(revoked_at,$2) WHERE id=$1', [row.grant_id, now]);
        return { kind: 'invalid' };
      }
      await client.query('UPDATE motive.mcp_oauth_authorization_codes SET consumed_at=$2 WHERE id=$1', [row.id, now]);
      return { kind: 'tokens', tokens: await this.issueTokens(client,
        { id: row.grant_id, scopes: row.scopes, expires_at: row.grant_expires_at }, now) };
    });
    if (outcome.kind !== 'tokens') throw new InvalidGrantError('Agent credential is unavailable.');
    return outcome.tokens;
  }

  async exchangeRefreshToken(clientInfo: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const expectedResource = exactResource(resource, this.resource);
    const requestedScopes = exactScopes(scopes);
    const now = this.now();
    const refreshDigest = digest(refreshToken);
    const preflight = await this.options.pool.query(`SELECT refresh.consumed_at,refresh.revoked_at,
        grant_row.id AS grant_id,grant_row.client_id,grant_row.owner_actor_id,grant_row.credential_id,
        grant_row.resource,grant_row.scopes,grant_row.expires_at AS grant_expires_at,grant_row.revoked_at AS grant_revoked_at
      FROM motive.mcp_oauth_refresh_tokens refresh JOIN motive.mcp_oauth_grants grant_row ON grant_row.id=refresh.grant_id
      WHERE refresh.token_digest=$1`, [refreshDigest]);
    if (preflight.rowCount !== 1 || preflight.rows[0].client_id !== clientInfo.client_id
        || preflight.rows[0].resource !== expectedResource
        || requestedScopes.join(' ') !== (preflight.rows[0].scopes as string[]).join(' ')) {
      throw new InvalidGrantError('Refresh token is invalid or expired.');
    }
    const preflightRow = preflight.rows[0];
    if (!preflightRow.consumed_at && !preflightRow.revoked_at && !preflightRow.grant_revoked_at
        && date(preflightRow, 'grant_expires_at') > now) {
      try {
        const { expiresAt } = await this.options.resolveCredential(text(preflightRow, 'owner_actor_id'), text(preflightRow, 'credential_id'));
        const credentialExpiry = new Date(expiresAt);
        if (!Number.isFinite(credentialExpiry.getTime()) || credentialExpiry <= now) throw new InvalidGrantError('Agent credential is unavailable.');
      } catch (error) {
        if (!inactiveAuthority(error) && !(error instanceof InvalidGrantError)) {
          throw new TemporarilyUnavailableError('Agent credential authority could not be verified.');
        }
        await this.transaction(async client => {
          await client.query('UPDATE motive.mcp_oauth_grants SET revoked_at=COALESCE(revoked_at,$2) WHERE id=$1 AND client_id=$3',
            [preflightRow.grant_id, now, clientInfo.client_id]);
        });
        throw new InvalidGrantError('Agent credential is unavailable.');
      }
    }
    const outcome = await this.transaction<ExchangeOutcome>(async client => {
      const result = await client.query(`SELECT refresh.*,grant_row.client_id,grant_row.owner_actor_id,grant_row.credential_id,
          grant_row.project_id,grant_row.resource,grant_row.scopes,grant_row.expires_at AS grant_expires_at,grant_row.revoked_at AS grant_revoked_at
        FROM motive.mcp_oauth_refresh_tokens refresh JOIN motive.mcp_oauth_grants grant_row ON grant_row.id=refresh.grant_id
        WHERE refresh.token_digest=$1 FOR UPDATE OF refresh,grant_row`, [refreshDigest]);
      if (result.rowCount !== 1) return { kind: 'invalid' };
      const row = result.rows[0];
      if (row.client_id !== clientInfo.client_id || row.resource !== expectedResource
          || requestedScopes.join(' ') !== (row.scopes as string[]).join(' ')) return { kind: 'invalid' };
      if (row.consumed_at || row.revoked_at) {
        await client.query('UPDATE motive.mcp_oauth_grants SET revoked_at=COALESCE(revoked_at,$2) WHERE id=$1', [row.grant_id, now]);
        return { kind: 'replay' };
      }
      if (row.grant_revoked_at || date(row, 'expires_at') <= now || date(row, 'grant_expires_at') <= now) return { kind: 'invalid' };
      if (!await this.currentCredential(client, row, now)) {
        await client.query('UPDATE motive.mcp_oauth_grants SET revoked_at=COALESCE(revoked_at,$2) WHERE id=$1', [row.grant_id, now]);
        return { kind: 'invalid' };
      }
      const tokens = await this.issueTokens(client, { id: row.grant_id, scopes: row.scopes, expires_at: row.grant_expires_at }, now);
      const replacementDigest = digest(tokens.refresh_token!);
      const replacement = await client.query('SELECT id FROM motive.mcp_oauth_refresh_tokens WHERE token_digest=$1', [replacementDigest]);
      await client.query(`UPDATE motive.mcp_oauth_refresh_tokens SET consumed_at=$2,replacement_id=$3 WHERE id=$1`,
        [row.id, now, replacement.rows[0].id]);
      return { kind: 'tokens', tokens };
    });
    if (outcome.kind === 'replay') throw new InvalidGrantError('Refresh token replay revoked the grant.');
    if (outcome.kind === 'invalid') throw new InvalidGrantError('Refresh token is invalid or expired.');
    return outcome.tokens;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (!/^motive_oauth_access_[A-Za-z0-9_-]{43}$/.test(token)) throw new InvalidTokenError('Access token is invalid.');
    const now = this.now();
    const result = await this.options.pool.query(`SELECT access.expires_at,grant_row.id AS grant_id,grant_row.client_id,
        grant_row.owner_actor_id,grant_row.credential_id,grant_row.resource,grant_row.scopes,grant_row.expires_at AS grant_expires_at
      FROM motive.mcp_oauth_access_tokens access JOIN motive.mcp_oauth_grants grant_row ON grant_row.id=access.grant_id
      WHERE access.token_digest=$1 AND access.revoked_at IS NULL AND access.expires_at>$2
        AND grant_row.revoked_at IS NULL AND grant_row.expires_at>$2`, [digest(token), now]);
    if (result.rowCount !== 1) throw new InvalidTokenError('Access token is invalid or expired.');
    const row = result.rows[0];
    if (row.resource !== this.resource || !Array.isArray(row.scopes)
        || row.scopes.length !== 1 || row.scopes[0] !== SCOPE) {
      throw new InvalidTokenError('Access token audience or scope is invalid.');
    }
    try { await this.options.resolveCredential(text(row, 'owner_actor_id'), text(row, 'credential_id')); }
    catch { throw new InvalidTokenError('Access token authority is no longer active.'); }
    return { token, clientId: text(row, 'client_id'), scopes: [...(row.scopes as string[])],
      expiresAt: Math.floor(date(row, 'expires_at').getTime() / 1000), resource: new URL(text(row, 'resource')),
      extra: { ownerActorId: text(row, 'owner_actor_id'), credentialId: text(row, 'credential_id'), grantId: text(row, 'grant_id') } };
  }

  async revokeToken(clientInfo: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const tokenDigest = digest(request.token);
    await this.transaction(async client => {
      const result = await client.query(`SELECT grant_row.id FROM motive.mcp_oauth_grants grant_row WHERE grant_row.client_id=$2 AND grant_row.id IN (
        SELECT grant_id FROM motive.mcp_oauth_access_tokens WHERE token_digest=$1
        UNION SELECT grant_id FROM motive.mcp_oauth_refresh_tokens WHERE token_digest=$1) FOR UPDATE`, [tokenDigest, clientInfo.client_id]);
      if (result.rowCount === 1) {
        await client.query('UPDATE motive.mcp_oauth_grants SET revoked_at=COALESCE(revoked_at,$2) WHERE id=$1', [result.rows[0].id, this.now()]);
      }
    });
  }
}

export { MotiveOAuthProvider as DurableMcpOAuthProvider };

export function createDurableMcpOAuthProvider(options: McpOAuthProviderOptions): MotiveOAuthProvider {
  return new MotiveOAuthProvider(options);
}
