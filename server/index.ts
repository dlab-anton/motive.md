import express from 'express';
import { createMotiveConnectorRouters, routeMotiveConnectorAlias } from './mcp/router.ts';
import { rateLimit } from 'express-rate-limit';
import type Database from 'better-sqlite3';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import type { SupportAction } from '../src/lib/support.ts';
import { parseAllocateCreditsInput } from '../src/lib/credits.ts';
import { openApplicationDatabase } from './app-database.ts';
import { isTrustedAppOrigin, loadApplicationConfig } from './app-config.ts';
import { loadApplicationGatewayProfiles } from './app-profiles.ts';
import { LedgerKernel } from '../packages/accounting/src/kernel.ts';
import { createInferenceGateway } from './gateway/app.ts';
import { createSandboxGatewayProxyRouter } from './gateway/sandbox-proxy.ts';
import { vercelGatewayLifecycleOptions } from './vercel-lifetime.ts';
import { createAgentRateLimitKeyGenerator } from './agent-rate-limit.ts';
import { OpenRouterFundingService, createOpenRouterFundingRouter, parseFundingVaultKey } from './funding/index.ts';
import { createParticipationService, createParticipationRouters } from './participation/index.ts';
import { createCommunityCoordinationService, CommunityCoordinationError } from './coordination/service.ts';
import { createCommunityCoordinationRouters } from './coordination/router.ts';
import { createResearchAdmissionAgentRouters, createResearchReviewQueueAccountRouter,
  createResearchReviewQueueAgentRouter } from './participation/review-agent-router.ts';
import { createResearchReviewQueueService } from './research-memory/review-queue.ts';
import { createResearchMemoryService, createProjectResearchDeliveryPolicyService,
  createHypothesisSubmissionAdmissionService, ResearchMemoryError } from './research-memory/index.ts';
import { createFindingAssessmentService } from './research-memory/finding-assessment.ts';
import { createHypothesisSubmissionDeliveryService } from './research-memory/submission-delivery.ts';
import { resolveResearchDeliveryTarget } from './research-memory/research-delivery-target.ts';
import { createResearchObservationRouter } from './research-memory/observation-router.ts';
import { createCircleResultsService, CircleResultsError } from './circle-results/index.ts';
import { createCircleResultsRouters } from './circle-results/router.ts';
import { createCircleArtifactObjectStore } from './project-runs/runtime.ts';
import { ProjectRunProjectionService, ProjectRunProjectionError } from './project-runs/projection.ts';
import { createProjectRunPublicRouter } from './project-runs/router.ts';
import { AccountError, AccountService, PostgresAccountStore, createLocalAccountStore, createSupabaseAccountAuthority,
  loadAccountConfiguration, type AccountStore } from './accounts/index.ts';
import { createLocalAccountIdentityBridge } from './accounts/local-identity.ts';

type ApplicationRuntime = {
  app: express.Express;
  apiHost: string;
  apiPort: number;
  beginDrain: () => void;
  close: () => Promise<void>;
};

async function composeApplication(): Promise<ApplicationRuntime> {
let projectDatabase: Awaited<ReturnType<typeof openApplicationDatabase>> = null;
let db: Database.Database | null = null;
let gateway: ReturnType<typeof createInferenceGateway> | null = null;
try {
const appConfig = loadApplicationConfig();
const accountConfig = loadAccountConfiguration();
const contextTransport = process.env.MOTIVE_HYPOTHESIS_CONTEXT_TRANSPORT ?? 'legacy';
if (contextTransport !== 'legacy' && contextTransport !== 'channel-context-v1') {
  throw new Error('MOTIVE_HYPOTHESIS_CONTEXT_TRANSPORT_INVALID');
}
if (process.env.VERCEL === '1' && accountConfig.provider !== 'supabase') {
  throw new Error('VERCEL_SUPABASE_ACCOUNT_PROVIDER_REQUIRED');
}
const directory = resolve(process.env.MOTIVE_DATA_DIR || '.local');
projectDatabase = await openApplicationDatabase();

function createLocalAuth(database: Database.Database, secret: string,
  beforeDelete?: (nativeUser: Readonly<{ subjectId: string; createdAt: Date }>) => Promise<void>) {
  return betterAuth({
    database,
    secret,
    baseURL: appConfig.appOrigin,
    trustedOrigins: [...appConfig.trustedOrigins],
    emailAndPassword: { enabled: true, minPasswordLength: 10 },
    user: { deleteUser: { enabled: true, ...(beforeDelete
      ? { beforeDelete: (user: { id: string; createdAt: Date }) => beforeDelete({ subjectId: user.id, createdAt: user.createdAt }) }
      : {}) } },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 60, max: 10 },
        '/sign-up/email': { window: 60, max: 10 },
      },
    },
  });
}

let auth: ReturnType<typeof createLocalAuth> | null = null;
let localSecret: string | null = null;
let accountStore: AccountStore;
const localIdentity = accountConfig.provider === 'local-better-auth' && projectDatabase
  ? createLocalAccountIdentityBridge(projectDatabase) : null;
if (accountConfig.provider === 'local-better-auth') {
  const { default: BetterSqliteDatabase } = await import('better-sqlite3');
  mkdirSync(directory, { recursive: true });
  const secretPath = resolve(directory, 'auth-secret');
  if (!process.env.BETTER_AUTH_SECRET && !existsSync(secretPath)) writeFileSync(secretPath, randomBytes(48).toString('base64url'), { mode: 0o600, flag: 'wx' });
  localSecret = process.env.BETTER_AUTH_SECRET || readFileSync(secretPath, 'utf8');
  db = new BetterSqliteDatabase(resolve(directory, 'motive.sqlite'));
  db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON');
  const localAuth = createLocalAuth(db, localSecret, localIdentity?.retire);
  await (await getMigrations(localAuth.options)).runMigrations();
  auth = localAuth;
  accountStore = createLocalAccountStore(db);
} else {
  if (!projectDatabase || !accountConfig.supabase) throw new Error('SUPABASE_ACCOUNT_DATABASE_REQUIRED');
  accountStore = new PostgresAccountStore(projectDatabase);
}
const supabaseRemote = accountConfig.supabase ? createSupabaseAccountAuthority(accountConfig.supabase) : null;
let funding: OpenRouterFundingService | null = null;
const accountService = supabaseRemote ? new AccountService({ store: accountStore, remote: supabaseRemote, pool: projectDatabase,
  disconnectFunding: async actorId => { await funding?.disconnect(actorId); } }) : null;
const isAccountActorActive = async (actorId: string) => accountConfig.provider === 'local-better-auth'
  ? Boolean(db && actorId.startsWith('account:') && db.prepare('SELECT id FROM user WHERE id = ?').get(actorId.slice(8))
    && (!localIdentity || await localIdentity.isActive(actorId)))
  : Boolean(accountService && await accountService.isActorActive(actorId));
const gatewayProfiles = loadApplicationGatewayProfiles();
const sandboxGatewayProxy = createSandboxGatewayProxyRouter({
  appOrigin: appConfig.appOrigin,
  expectedTeamId: process.env.MOTIVE_VERCEL_TEAM_ID,
  expectedProjectId: process.env.MOTIVE_VERCEL_PROJECT_ID,
  // The proxy is a transport ceiling. The selected reviewed gateway profile
  // applies its lower request limit before admission or provider dispatch.
  maximumRequestBytes: 4 * 1024 * 1024,
  maximumResponseBytes: Math.max(64 * 1024, ...gatewayProfiles.map(profile => profile.limits.maxResponseBytes)),
  audit: diagnostic => console.info(JSON.stringify(diagnostic)),
});
const vaultKeyPath = resolve(directory, 'funding-vault-key');
if (projectDatabase && accountConfig.provider === 'local-better-auth' && !process.env.MOTIVE_FUNDING_VAULT_KEY && !existsSync(vaultKeyPath)) writeFileSync(vaultKeyPath, randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' });
const vaultKeyText = process.env.MOTIVE_FUNDING_VAULT_KEY
  || (accountConfig.provider === 'local-better-auth' && existsSync(vaultKeyPath) ? readFileSync(vaultKeyPath, 'utf8').trim() : '');
if (projectDatabase && accountConfig.provider === 'supabase' && !vaultKeyText) throw new Error('MOTIVE_FUNDING_VAULT_KEY_REQUIRED');
funding = projectDatabase ? new OpenRouterFundingService({
  pool: projectDatabase,
  vaultKey: parseFundingVaultKey(vaultKeyText),
  callbackUrl: appConfig.fundingCallbackUrl,
  allowedCallbackOrigins: appConfig.trustedOrigins,
  gatewayUrl: appConfig.gatewayUrl,
  profiles: gatewayProfiles,
  isActorActive: isAccountActorActive,
}) : null;
gateway = funding && projectDatabase ? createInferenceGateway({
  ledger: new LedgerKernel(projectDatabase),
  profiles: gatewayProfiles,
  resolveCredential: funding.resolveCredential.bind(funding),
  ...(process.env.VERCEL === '1' ? vercelGatewayLifecycleOptions : {}),
}) : null;
const researchDelivery = projectDatabase ? createHypothesisSubmissionDeliveryService({ pool: projectDatabase,
  vaultKey: parseFundingVaultKey(vaultKeyText), isActorActive: isAccountActorActive,
}) : null;
const researchMemory = projectDatabase ? createResearchMemoryService({ pool: projectDatabase,
  vaultKey: parseFundingVaultKey(vaultKeyText),
  contextTransport,
  ...(researchDelivery ? { confirmedEvidenceContributions: researchDelivery.confirmedEvidenceContributions.bind(researchDelivery) } : {}),
}) : null;
const researchDeliveryPolicy = projectDatabase ? createProjectResearchDeliveryPolicyService({pool:projectDatabase,
  vaultKey:parseFundingVaultKey(vaultKeyText),isActorActive:isAccountActorActive}) : null;
const researchAdmission = projectDatabase ? createHypothesisSubmissionAdmissionService({ pool: projectDatabase,
  vaultKey: parseFundingVaultKey(vaultKeyText), isActorActive: isAccountActorActive,
  agentTokenSecret: accountConfig.provider === 'supabase' ? accountConfig.agentTokenSecret! : localSecret! }) : null;
const findingAssessment = projectDatabase ? createFindingAssessmentService({pool:projectDatabase,isActorActive:isAccountActorActive,
  ...(researchAdmission ? {admitAgentFinding:researchAdmission.admitFromAgentFinding.bind(researchAdmission)} : {})}) : null;
const reviewAgentRouters = researchAdmission ? createResearchAdmissionAgentRouters(researchAdmission) : null;
const reviewQueue = projectDatabase && researchAdmission ? createResearchReviewQueueService({
  pool: projectDatabase, admission: researchAdmission, isActorActive: isAccountActorActive,
  tokenSecret: accountConfig.provider === 'supabase' ? accountConfig.agentTokenSecret! : localSecret!,
}) : null;
const participation = projectDatabase ? createParticipationService(projectDatabase, {
  tokenSecret: accountConfig.provider === 'supabase' ? accountConfig.agentTokenSecret! : localSecret!, issuerActorId: 'operator:seed',
  isActorActive: isAccountActorActive,
  resolveResearchDeliveryTarget,
  ...(researchAdmission ? { nextReadyRecoveredFinding: researchAdmission.nextReadyRecoveredFinding.bind(researchAdmission) } : {}),
  ...(researchDeliveryPolicy ? { nextReadyResearchDelivery: researchDeliveryPolicy.nextReadyDelivery.bind(researchDeliveryPolicy) } : {}),
  ...(researchMemory ? { validateResearchContext: researchMemory.assertContext.bind(researchMemory),
    validateResearchReferences: researchMemory.assertReferences.bind(researchMemory) } : {}),
}) : null;
if (participation) await participation.ensureCircleWorkOrder();
const participationRouters = participation ? createParticipationRouters({ service: participation,
  isActorActive: isAccountActorActive,
  ...(researchMemory ? { researchMemory } : {}),
  ...(researchDeliveryPolicy ? { researchDeliveryPolicy } : {}),
  ...(researchAdmission ? { researchAdmission } : {}),
  ...(findingAssessment ? { findingAssessment } : {}),
}) : null;
const circleResults = projectDatabase ? createCircleResultsService({ pool: projectDatabase, objects: createCircleArtifactObjectStore() }) : null;
const communityCoordination = projectDatabase ? createCommunityCoordinationService({
  pool: projectDatabase, isActorActive: isAccountActorActive,
  ...(researchMemory ? { assertContext: async (client, projectId, context) => {
    try { await researchMemory.assertContext(projectId, context, client); }
    catch (error) {
      if (error instanceof ResearchMemoryError) throw new CommunityCoordinationError('CONFLICT', 'The retained research context is unavailable or changed.');
      throw error;
    }
  } } : {}),
}) : null;
const communityCoordinationRouters = communityCoordination && participation
  ? createCommunityCoordinationRouters({ service: communityCoordination, participation }) : null;
const circleResultRouters = circleResults ? createCircleResultsRouters(circleResults, isAccountActorActive) : null;
const projectRuns = projectDatabase ? new ProjectRunProjectionService(projectDatabase, isAccountActorActive) : null;
const connectors = projectDatabase && participation ? createMotiveConnectorRouters({
  pool: projectDatabase, participation, appOrigin: appConfig.appOrigin,
}) : null;
const app = express();
app.use(routeMotiveConnectorAlias);
app.disable('x-powered-by');
app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
if (connectors) {
  app.use('/api/mcp-oauth', connectors.oauth);
  app.use('/api/mcp', connectors.mcp);
}
app.use('/api/sandbox-egress', sandboxGatewayProxy);
app.get('/api/account-config', (_req, res) => { res.json(accountConfig.public); });
if (auth) {
  const localAuth = auth;
  app.all('/api/auth/*splat', toNodeHandler(localAuth));
}
else app.all('/api/auth/*splat', (_req, res) => { res.status(404).json({ error: 'Local account authentication is not enabled.' }); });
if (participationRouters) {
  const agentRateLimitKeyGenerator = createAgentRateLimitKeyGenerator();
  app.use('/api/agent', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Too many agent requests. Retry shortly.' },
    ...(agentRateLimitKeyGenerator ? { keyGenerator: agentRateLimitKeyGenerator } : {}) }));
  if (communityCoordinationRouters) {
    app.use('/api/agent/coordination', communityCoordinationRouters.agentRouter);
    app.use('/api/public/projects/circle-packing/coordination', communityCoordinationRouters.publicRouter);
  }
  app.use('/api/agent', participationRouters.agentRouter);
  app.use('/api/public/projects/circle-packing', participationRouters.publicRouter);
} else app.use(['/api/agent', '/api/public'], (_req, res) => { res.status(503).json({ error: 'The project database is not connected.' }); });
if (circleResultRouters) app.use('/api/public/projects/circle-packing/hosted-results', circleResultRouters.publicRouter);
if (researchDelivery) app.use('/api/public/projects/circle-packing', createResearchObservationRouter(researchDelivery));
if (reviewAgentRouters) {
  const reviewerRateLimitKeyGenerator = createAgentRateLimitKeyGenerator();
  app.use('/api/review-agent', rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Too many review requests. Retry shortly.' },
    ...(reviewerRateLimitKeyGenerator ? { keyGenerator: reviewerRateLimitKeyGenerator } : {}) }));
  app.use('/api/review-agent', reviewAgentRouters.agentRouter);
} else app.use('/api/review-agent', (_req, res) => { res.status(503).json({ error: 'Research review is not configured.' }); });
if (reviewQueue) {
  const queueRateLimitKeyGenerator = createAgentRateLimitKeyGenerator();
  app.use('/api/review-queue-agent', rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Too many review session requests. Retry shortly.' },
    ...(queueRateLimitKeyGenerator ? { keyGenerator: queueRateLimitKeyGenerator } : {}) }));
  app.use('/api/review-queue-agent', createResearchReviewQueueAgentRouter(reviewQueue));
} else app.use('/api/review-queue-agent', (_req, res) => { res.status(503).json({ error: 'Research review is not configured.' }); });
if (projectRuns) {
  app.get('/api/public/projects/circle-packing/runs', async (_req, res) => { res.json(await projectRuns.publicCircleRuns()); });
  app.use('/api/public/projects/circle-packing', createProjectRunPublicRouter(projectRuns));
}
if (gateway) app.use('/api/inference', gateway.app);
else app.use('/api/inference', (_req, res) => { res.status(503).json({ error: 'The model gateway is not configured.' }); });
// Public project reads and bearer-only agent routes are mounted before the
// browser-session middleware. Their handlers enforce their own authority.
app.get('/api/health', async (_req, res) => {
  try {
    if (!projectDatabase) { res.status(503).json({ ready: false, error: 'The project database is not connected.' }); return; }
    await projectDatabase.query('SELECT 1');
    res.json({ ready: true, accounts: true, projectDatabase: true });
  } catch { res.status(503).json({ ready: false, error: 'The project database is unavailable.' }); }
});
app.use(express.json({ limit: '16kb' }));
app.post('/api/account/delete', async (req, res, next) => {
  if (!isTrustedAppOrigin(appConfig, req.headers.origin) || !req.is('application/json')) {
    res.status(403).json({ error: 'Request origin not allowed.' }); return;
  }
  if (accountConfig.provider !== 'supabase' || !accountService) {
    res.status(404).json({ error: 'Use local account deletion for this account provider.' }); return;
  }
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).join(',') !== 'password'
      || typeof req.body.password !== 'string' || req.body.password.length < 1 || req.body.password.length > 128) {
    res.status(400).json({ error: 'Password confirmation is required.' }); return;
  }
  try {
    const principal = await accountService.authenticate(req.get('authorization'), false);
    if (!principal) { res.status(401).json({ error: 'Sign in to delete your account.' }); return; }
    await accountService.deleteAccount(principal, req.body.password);
    res.sendStatus(204);
  } catch (error) { next(error); }
});
app.use('/api', async (req, res, next) => {
  if (req.method !== 'GET' && (!isTrustedAppOrigin(appConfig, req.headers.origin) || !req.is('application/json'))) { res.status(403).json({ error: 'Request origin not allowed.' }); return; }
  try {
    if (accountConfig.provider === 'local-better-auth' && auth) {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      if (!session) { res.status(401).json({ error: 'Sign in to manage your account.' }); return; }
      const principal = { provider: 'local-better-auth' as const, subjectId: session.user.id,
        actorId: `account:${session.user.id}` as const, name: session.user.name, email: session.user.email,
        createdAt: session.user.createdAt, emailVerified: session.user.emailVerified };
      await localIdentity?.establish(principal);
      await accountStore.establish(principal);
      res.locals.userId = principal.subjectId; res.locals.actorId = principal.actorId; res.locals.accountName = principal.name;
    } else {
      const principal = await accountService?.authenticate(req.get('authorization'));
      if (!principal) { res.status(401).json({ error: 'Sign in with a confirmed email to manage your account.' }); return; }
      res.locals.userId = principal.subjectId; res.locals.actorId = principal.actorId; res.locals.accountName = principal.name;
    }
    next();
  } catch (error) { next(error); }
});
if (connectors) app.use('/api/mcp-consent', connectors.consent);
if (funding) app.use('/api/funding', createOpenRouterFundingRouter(funding));
else app.use('/api/funding', (_req, res) => { res.status(503).json({ error: 'The project database is not connected.' }); });
if (communityCoordinationRouters) app.use('/api/participation/coordination', communityCoordinationRouters.accountRouter);
if (participationRouters) app.use('/api/participation', participationRouters.accountRouter);
else app.use('/api/participation', (_req, res) => { res.status(503).json({ error: 'The project database is not connected.' }); });
if (reviewQueue) app.use('/api/participation', createResearchReviewQueueAccountRouter(reviewQueue));
if (reviewAgentRouters) app.use('/api/participation', reviewAgentRouters.accountRouter);
if (circleResultRouters) app.use('/api/hosted-results', circleResultRouters.accountRouter);
else app.use('/api/hosted-results', (_req, res) => { res.status(503).json({ error: 'The project database is not connected.' }); });
app.get('/api/workspace', async (_req, res, next) => {
  try { res.json(await accountStore.workspace(res.locals.actorId)); } catch (error) { next(error); }
});
app.post('/api/support', async (req, res, next) => {
  const input = req.body;
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== 'following,goal,type'
      || input.type !== 'follow' || typeof input.goal !== 'string' || typeof input.following !== 'boolean') {
    res.status(400).json({ error: 'Only following a public project is available.' }); return;
  }
  try { res.json(await accountStore.follow(res.locals.actorId, input as SupportAction)); } catch (error) { next(error); }
});
app.post('/api/profile', async (req, res, next) => {
  if (typeof req.body?.bio !== 'string' || req.body.bio.length > 280) { res.status(400).json({ error: 'Keep your bio under 280 characters.' }); return; }
  try { res.json({ bio: await accountStore.setBio(res.locals.actorId, req.body.bio.trim()) }); } catch (error) { next(error); }
});
app.get('/api/credits', async (_req, res, next) => {
  try { res.json(await accountStore.readWallet(res.locals.actorId)); } catch (error) { next(error); }
});
app.post('/api/credits/allocations', async (req, res, next) => {
  const input = parseAllocateCreditsInput(req.body);
  if (!input) { res.status(400).json({ error: 'Use a positive whole-credit amount for a current public project.' }); return; }
  const idempotencyKey = req.get('Idempotency-Key');
  if (!idempotencyKey || !/^[\x21-\x7e]{1,128}$/.test(idempotencyKey)) {
    res.status(400).json({ error: 'Idempotency-Key must contain 1 to 128 visible ASCII characters.' }); return;
  }
  try {
    const { replayed, ...response } = await accountStore.allocate(res.locals.actorId, idempotencyKey, input);
    res.status(replayed ? 200 : 201).json(response);
  } catch (error) {
    if (error instanceof AccountError && ['IDEMPOTENCY_CONFLICT','INSUFFICIENT_CREDITS'].includes(error.code)) { res.status(409).json({ error: error.message }); return; }
    next(error);
  }
});
app.use('/api', (_req, res) => { res.status(404).json({ error: 'not_found' }); });
app.use((error: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof ProjectRunProjectionError) {
    res.status(error.status).json({ error: error.code, message: error.message }); return;
  }
  if (error instanceof CircleResultsError) {
    res.status(error.status).json({ error: error.code, message: error.message }); return;
  }
  if (error instanceof ResearchMemoryError) {
    const status = { VALIDATION: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, UPSTREAM: 502 }[error.code];
    res.status(status).json({ error: 'research_memory_unavailable', message: error.message }); return;
  }
  if (error instanceof AccountError) { res.status(error.status).json({ error: error.code.toLowerCase(), message: error.message }); return; }
  if ('type' in error && error.type === 'entity.too.large') { res.status(413).json({ error: 'The submitted data exceeds the request size limit.' }); return; }
  if ('type' in error && error.type === 'entity.parse.failed') { res.status(400).json({ error: 'The request must contain valid JSON.' }); return; }
  console.error('API request failed:', error.name, 'code' in error ? String(error.code) : 'unclassified', 'constraint' in error ? String(error.constraint) : '');
  const message = req.method === 'GET' || req.method === 'HEAD'
    ? 'Unable to load this information. Please try again.'
    : 'Unable to save this change. Please try again.';
  res.status(500).json({ error: message });
});

return {
  app, apiHost: appConfig.apiHost, apiPort: appConfig.apiPort,
  beginDrain: () => { gateway?.beginDrain(); },
  close: async () => {
    await gateway?.drain();
    await projectDatabase?.end();
    db?.close();
  },
};
} catch (error) {
  gateway?.beginDrain();
  await Promise.allSettled([gateway?.drain() ?? Promise.resolve(), projectDatabase?.end() ?? Promise.resolve()]);
  try { db?.close(); } catch { /* preserve the initialization failure */ }
  throw error;
}
}

/** Build one isolated application composition. Failed builds release their resources and may be retried. */
export async function createApplication(): Promise<express.Express> {
  return (await composeApplication()).app;
}

if (process.env.VERCEL !== '1') {
  const runtime = await composeApplication();
  const server = runtime.app.listen(runtime.apiPort, runtime.apiHost,
    () => console.log(`motive.md application service listening on ${runtime.apiHost}:${runtime.apiPort}`));
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
    runtime.beginDrain();
    server.close(() => {
      void (async () => {
        await runtime.close();
        process.exit(0);
      })();
    });
  });
}
