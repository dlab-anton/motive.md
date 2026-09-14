import { Router, raw, type Request, type Response, type NextFunction } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Pool } from 'pg';
import { createOAuthMetadata, mcpAuthMetadataRouter, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { MotiveClient } from '../../packages/claude-desktop-mcp/src/client.ts';
import { ParticipationError, type ParticipationService } from '../participation/service.ts';
import { MotiveOAuthProvider } from './oauth-provider.ts';
import { createMcpSchemaReadiness } from './readiness.ts';
import { createMotiveMcpHttpHandler } from './transport.ts';
import { createAgentRateLimitKeyGenerator } from '../agent-rate-limit.ts';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SCOPE = 'motive:project';

/** Keep local hosting and Vercel's public OAuth/MCP URLs identical. */
export function routeMotiveConnectorAlias(req: Request, _res: Response, next: NextFunction) {
  const path = req.url.split('?')[0];
  const query = req.url.slice(path.length);
  if (/^\/mcp\/?$/.test(path)) req.url = `/api/mcp${query}`;
  else if (/^\/(authorize|token|register|revoke)$/.test(path)) req.url = `/api/mcp-oauth${path}${query}`;
  else if (path === '/.well-known/oauth-authorization-server') req.url = `/api/mcp-oauth${path}${query}`;
  else if (/^\/\.well-known\/oauth-protected-resource(?:\/mcp)?$/.test(path)) {
    req.url = `/api/mcp-oauth/.well-known/oauth-protected-resource/mcp${query}`;
  }
  next();
}

export function createMotiveConnectorRouters(options: {
  pool: Pool; participation: ParticipationService; appOrigin: string;
}) {
  const { pool, participation } = options;
  const appOrigin = new URL(options.appOrigin).origin;
  const resource = new URL('/mcp', appOrigin);
  const origins = [appOrigin, 'https://claude.ai', 'https://claude.com', 'https://chatgpt.com'];
  const resolveCredential = participation.resolveConnectorCredential.bind(participation);
  const clientKey = createAgentRateLimitKeyGenerator();
  const platformRateLimit = clientKey ? { rateLimit: { keyGenerator: clientKey } } : {};
  const provider = new MotiveOAuthProvider({ pool, appOrigin, resolveCredential });
  const isReady = createMcpSchemaReadiness(pool);
  const ready = async (_req: Request, res: Response, next: NextFunction) => {
    res.set('Cache-Control', 'no-store');
    if (!await isReady()) {
      res.set('Retry-After', '5').status(503).json({ error: 'The connector is temporarily unavailable. Try again shortly.' });
      return;
    }
    next();
  };
  const authOptions = { provider, issuerUrl: new URL(appOrigin), resourceServerUrl: resource,
    scopesSupported: [SCOPE], resourceName: 'Motive circle-packing project',
    authorizationOptions: platformRateLimit, tokenOptions: platformRateLimit,
    clientRegistrationOptions: platformRateLimit, revocationOptions: platformRateLimit,
    serviceDocumentationUrl: new URL('/agents/SKILL.md', appOrigin) };
  const oauth = Router();
  oauth.use(ready);
  // The SDK supports more client modes; this provider deliberately registers public clients only.
  const metadata = createOAuthMetadata(authOptions);
  metadata.token_endpoint_auth_methods_supported = ['none'];
  metadata.revocation_endpoint_auth_methods_supported = ['none'];
  oauth.use(mcpAuthMetadataRouter({ ...authOptions, oauthMetadata: metadata }));
  oauth.use(mcpAuthRouter(authOptions));

  const mcp = Router();
  mcp.use(ready);
  mcp.use((req, res, next) => {
    const origin = req.get('Origin');
    if (origin && !origins.includes(origin)) { res.status(403).json({ error: 'Origin not allowed.' }); return; }
    if (origin) {
      res.set('Access-Control-Allow-Origin', origin);
      res.vary('Origin');
      res.set('Access-Control-Expose-Headers', 'WWW-Authenticate, MCP-Protocol-Version');
    }
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, MCP-Protocol-Version');
      res.status(204).end(); return;
    }
    next();
  });
  mcp.use(requireBearerAuth({ verifier: provider, requiredScopes: [SCOPE],
    resourceMetadataUrl: new URL('/.well-known/oauth-protected-resource/mcp', appOrigin).href }));
  mcp.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false,
    keyGenerator: req => String(req.auth?.extra?.grantId), message: { error: 'Too many connector requests. Retry shortly.' } }));
  mcp.use(raw({ type: () => true, limit: '256kb', inflate: false }));
  const handle = createMotiveMcpHttpHandler({ allowedOrigins: origins });
  mcp.all('/', async (req, res, next) => {
    try {
      const owner = req.auth?.extra?.ownerActorId;
      const credentialId = req.auth?.extra?.credentialId;
      if (typeof owner !== 'string' || typeof credentialId !== 'string') {
        res.status(401).json({ error: 'The connector authorization is invalid.' }); return;
      }
      const credential = await resolveCredential(owner, credentialId);
      const headers = new Headers();
      for (const name of ['accept', 'content-type', 'content-length', 'origin', 'mcp-protocol-version']) {
        const value = req.get(name); if (value) headers.set(name, value);
      }
      // The OAuth token is consumed here. Only a separately derived project credential reaches Motive's fixed API.
      const request = new globalThis.Request(resource, { method: req.method, headers,
        ...(req.method !== 'GET' && req.method !== 'HEAD' && Buffer.isBuffer(req.body) ? { body: new Uint8Array(req.body).buffer } : {}) });
      const response = await handle(request, { client: new MotiveClient(credential.projectKey) });
      response.headers.forEach((value, name) => res.set(name, value));
      res.status(response.status).send(Buffer.from(await response.arrayBuffer()));
    } catch (error) { next(error); }
  });

  // Mount after Motive's account authentication + trusted-origin middleware.
  const consent = Router();
  consent.use(ready);
  consent.param('requestId', (_req, res, next, value) => {
    if (!UUID.test(value)) { res.status(400).json({ error: 'This connection request is invalid.' }); return; }
    next();
  });
  consent.get('/:requestId', async (req, res, next) => {
    try {
      const details = await provider.getConsent(String(req.params.requestId));
      const me = await participation.getMe(String(res.locals.actorId));
      res.json({ ...details, credentials: me.credentials.filter(item => !item.revokedAt && Date.parse(item.expiresAt) > Date.now()) });
    } catch (error) { next(error); }
  });
  consent.post('/:requestId/approve', async (req, res, next) => {
    try {
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).sort().join(',') !== 'acceptReferenceTerms,credentialId,publishDisplayName'
        || body.acceptReferenceTerms !== true || body.publishDisplayName !== false
        || (body.credentialId !== 'new' && (typeof body.credentialId !== 'string' || !UUID.test(body.credentialId)))) {
        res.status(400).json({ error: 'Choose an agent and accept the project terms.' }); return;
      }
      const requestId = String(req.params.requestId);
      await provider.getConsent(requestId);
      const owner = String(res.locals.actorId);
      let credentialId = body.credentialId as string;
      if (credentialId === 'new') {
        const joined = await participation.join(owner, String(res.locals.accountName), {
          projectSlug: 'circle-packing', acceptReferenceTerms: true, publishDisplayName: false,
        }, `mcp-consent-${requestId}`);
        credentialId = joined.credential.id;
      }
      res.json(await provider.approveConsent(requestId, owner, credentialId));
    } catch (error) { next(error); }
  });
  consent.post('/:requestId/deny', async (req, res, next) => {
    try { res.json(await provider.denyConsent(String(req.params.requestId))); }
    catch (error) { next(error); }
  });
  const safeError = (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    if (error instanceof OAuthError) { res.status(400).json({ error: error.message }); return; }
    if (error instanceof ParticipationError) {
      const status = { UNAUTHORIZED: 401, FORBIDDEN: 403, VALIDATION: 400, NOT_FOUND: 404, CONFLICT: 409, EXPIRED: 410 }[error.code];
      res.status(status).json({ error: error.message }); return;
    }
    const status = error && typeof error === 'object' && 'status' in error && error.status === 413 ? 413 : 503;
    res.status(status).json({ error: status === 413 ? 'The connector request is too large.' : 'The connector is temporarily unavailable.' });
  };
  mcp.use(safeError); oauth.use(safeError); consent.use(safeError);
  return { oauth, mcp, consent, provider };
}
