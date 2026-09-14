import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { Pool } from 'pg';

import { LedgerKernel } from '../packages/accounting/src/kernel.ts';
import { getPostgresSchemaStatus } from '../packages/accounting/src/migrations.ts';
import { createParticipationService } from '../server/participation/service.ts';
import {
  createProjectResearchDeliveryPolicyService,
  createResearchMemoryService,
} from '../server/research-memory/index.ts';
import { PINNED_REVIEWED_WRITEBACK_CONTRACT } from '../server/research-memory/pinned-writeback-contract.ts';
import { circlePackingProfile, getProject } from '../src/lib/projects.ts';
import { setProjectReviewer } from './set-project-reviewer.ts';

const DATABASE = /^motive_byo_[a-f0-9]{32}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const API_KEY = /^he_[A-Za-z0-9_-]{43}$/;
const ALLOWED_API_PORT = '4336';
const ALLOWED_APP_PORT = '4335';
const MAX_RESPONSE_BYTES = 256 * 1024;

export type ByoSyntheticAccountInput = Readonly<{
  role: 'OWNER' | 'REVIEWER' | 'CONTRIBUTOR';
  name: string;
  email: string;
  password: string;
}>;

export type ByoAccountSession = Readonly<{
  role: ByoSyntheticAccountInput['role'];
  subjectId: string;
  actorId: string;
  name: string;
  email: string;
  password: string;
  cookie: string;
}>;

export type ByoDatabaseSeed = Readonly<{
  projectSlug: 'circle-packing';
  projectId: string;
  projectRevision: number;
  workOrderId: string;
  workOrderRevision: number;
  workOrderTermsDigest: string;
  issuerActorId: string;
  accounts: Readonly<{
    owner: ByoSyntheticAccountInput;
    reviewer: ByoSyntheticAccountInput;
    contributor: ByoSyntheticAccountInput;
  }>;
}>;

export type ByoEnrollment = Readonly<{
  safe: Readonly<{
    format: 'motive.byo-rehearsal-fixture/0.1';
    projectSlug: 'circle-packing';
    projectId: string;
    projectRevision: number;
    workOrderId: string;
    workOrderRevision: number;
    scopeId: string;
    policyId: string;
    workspaceId: string;
    channelId: string;
    channelName: string;
    ownerActorId: string;
    reviewerActorId: string;
    contributorActorId: string;
    contributorCredentialId: string;
    readiness: Readonly<{
      anonymousAccountDenied: true;
      ownerCanManageReviewers: true;
      reviewerCanReview: true;
      contributorCanReview: false;
      reviewerHasNoAgentCredential: true;
      contributorAssignmentStatus: 'AVAILABLE';
      researchSyncStatus: 'AVAILABLE';
      engineReadCount: number;
      submissions: 0;
      deliveries: 0;
      writeIntents: 0;
      syncRequests: 0;
      admissionDecisions: 0;
      findingDecisions: 0;
    }>;
    disclosure: 'Synthetic local BetterAuth accounts authenticated into exact durable PostgreSQL identities; owner and reviewer authority was granted only by explicit local operator commands.';
  }>;
  private: Readonly<{
    owner: ByoAccountSession;
    reviewer: ByoAccountSession;
    contributor: ByoAccountSession;
    contributorBearer: string;
  }>;
}>;

type EngineBinding = Readonly<{
  apiBaseUrl: string;
  workspaceId: string;
  channelId: string;
  channelName: string;
  apiKey: string;
}>;

export type ByoAccountRequest = Readonly<{
  apiOrigin: string;
  appOrigin: string;
  path: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
}>;

export type RehearsalHttpResult<T = unknown> = Readonly<{ status: number; body: T }>;

function loopbackOrigin(raw: string, port: string, label: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`${label} must be an absolute loopback HTTP origin.`); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
    || url.port !== port || url.username || url.password || url.search || url.hash
    || !['', '/'].includes(url.pathname)) {
    throw new Error(`${label} must be the dedicated loopback rehearsal origin on port ${port}.`);
  }
  return url.origin;
}

function engineApiBase(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Hypothesis API base must be the loopback rehearsal API.'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
    || url.port !== '4337' || url.username || url.password || url.search || url.hash
    || url.pathname.replace(/\/+$/, '') !== '/api/v1') {
    throw new Error('Hypothesis API base must be the loopback rehearsal API on port 4337 under /api/v1.');
  }
  return `${url.origin}/api/v1`;
}

async function assertRehearsalDatabase(pool: Pool): Promise<string> {
  const result = await pool.query<{ database_name: string }>('SELECT current_database() AS database_name');
  const database = result.rows[0]?.database_name;
  if (result.rowCount !== 1 || typeof database !== 'string' || !DATABASE.test(database)) {
    throw new Error('BYO rehearsal fixture mutations require a fresh motive_byo_<32hex> database.');
  }
  const status = await getPostgresSchemaStatus(pool);
  if (!status.exact) throw new Error('BYO rehearsal fixture requires the exact current PostgreSQL schema.');
  return database;
}

function account(role: ByoSyntheticAccountInput['role']): ByoSyntheticAccountInput {
  const id = randomUUID();
  const label = role.toLowerCase();
  return {
    role,
    name: `Synthetic BYO ${role[0]}${role.slice(1).toLowerCase()}`,
    email: `byo-${label}-${id}@example.test`,
    password: `Byo-${randomBytes(32).toString('base64url')}`,
  };
}

function projectContent() {
  const project = getProject('circle-packing');
  if (!project) throw new Error('The shared circle-packing project profile is missing.');
  return {
    title: project.title,
    purpose: project.goal,
    next_step: project.next,
    stage: 'preparation',
    description: project.description,
    story: project.story,
    beneficiaries: project.beneficiaries,
    scope: project.scope,
    acceptance: project.acceptance,
    output: project.output,
    challenge: circlePackingProfile,
    spending_authorized: false,
    execution_authorized: false,
  };
}

export async function seedByoRehearsalDatabase(pool: Pool, input: Readonly<{
  projectSlug: 'circle-packing';
  issuerActorId: string;
  tokenSecret: string;
}>): Promise<ByoDatabaseSeed> {
  await assertRehearsalDatabase(pool);
  if (input.projectSlug !== 'circle-packing' || input.issuerActorId !== 'operator:seed'
    || Buffer.byteLength(input.tokenSecret, 'utf8') < 32) {
    throw new Error('BYO rehearsal project seed input is invalid.');
  }
  const ledger = new LedgerKernel(pool);
  const project = await ledger.createProject({
    actorId: input.issuerActorId,
    idempotencyKey: 'byo-rehearsal-circle-project-v1',
    slug: input.projectSlug,
    visibility: 'PUBLIC',
    revisionContent: projectContent(),
  });
  const participation = createParticipationService(pool, {
    tokenSecret: input.tokenSecret,
    issuerActorId: input.issuerActorId,
  });
  const work = await participation.ensureCircleWorkOrder();
  const storedWork = await pool.query<{ revision: number }>('SELECT revision FROM motive.work_orders WHERE id=$1', [work.id]);
  const controller = await pool.query<{ spending_enabled: boolean }>('SELECT spending_enabled FROM motive.controller_state WHERE singleton=TRUE');
  if (controller.rowCount !== 1 || controller.rows[0]?.spending_enabled !== false) {
    throw new Error('BYO rehearsal must start with controller spending disabled.');
  }
  const content = await pool.query<{ spending: boolean; execution: boolean }>(`SELECT
    (content->>'spending_authorized')::boolean AS spending,
    (content->>'execution_authorized')::boolean AS execution
    FROM motive.project_revisions WHERE project_id=$1 AND revision=$2`, [project.id, project.currentRevision]);
  if (content.rowCount !== 1 || content.rows[0]?.spending !== false || content.rows[0]?.execution !== false) {
    throw new Error('BYO rehearsal project spending and execution must remain disabled.');
  }
  const workOrderRevision = Number(storedWork.rows[0]?.revision);
  if (storedWork.rowCount !== 1 || !Number.isSafeInteger(workOrderRevision) || workOrderRevision < 1) {
    throw new Error('BYO rehearsal work order was not retained exactly once.');
  }
  return {
    projectSlug: 'circle-packing',
    projectId: project.id,
    projectRevision: project.currentRevision,
    workOrderId: work.id,
    workOrderRevision,
    workOrderTermsDigest: work.termsDigest,
    issuerActorId: input.issuerActorId,
    accounts: { owner: account('OWNER'), reviewer: account('REVIEWER'), contributor: account('CONTRIBUTOR') },
  };
}

async function boundedBody(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('Rehearsal API response exceeded its byte limit.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error('Rehearsal API response exceeded its byte limit.');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('Rehearsal API returned invalid JSON.'); }
}

function cookieHeader(headers: Headers): string {
  const values = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [headers.get('set-cookie') ?? ''];
  const cookies = values.flatMap(value => value.split(/,(?=\s*[A-Za-z0-9_.-]+=)/))
    .map(value => value.trim().split(';', 1)[0] ?? '')
    .filter(value => /^[A-Za-z0-9_.-]+=[^;\s]+$/.test(value));
  if (!cookies.length) throw new Error('BetterAuth did not return a session cookie.');
  return cookies.join('; ');
}

async function rawRequest(input: ByoAccountRequest & { cookie?: string; allowedPrefix: '/api/participation/' | '/api/auth/' }): Promise<RehearsalHttpResult> {
  const apiOrigin = loopbackOrigin(input.apiOrigin, ALLOWED_API_PORT, 'motiveApiOrigin');
  const appOrigin = loopbackOrigin(input.appOrigin, ALLOWED_APP_PORT, 'appOrigin');
  const method = input.method ?? 'GET';
  if (!input.path.startsWith(input.allowedPrefix) || input.path.startsWith('//') || input.path.includes('://')
    || input.path.includes('\\') || input.path.includes('#')
    || method === 'GET' && input.body !== undefined || method === 'GET' && input.idempotencyKey !== undefined) {
    throw new Error('Rehearsal HTTP request is outside its allowed account API boundary.');
  }
  const target = new URL(input.path, apiOrigin);
  if (target.origin !== apiOrigin || !target.pathname.startsWith(input.allowedPrefix)) {
    throw new Error('Rehearsal HTTP request is outside its allowed account API boundary.');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  const abort = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(target, {
      method,
      redirect: 'error',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Origin: appOrigin,
        ...(input.cookie ? { Cookie: input.cookie } : {}),
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        ...(input.idempotencyKey ? { 'Idempotency-Key': input.idempotencyKey } : {}),
      },
      ...(method === 'POST' ? { body: JSON.stringify(input.body ?? {}) } : {}),
    });
    return { status: response.status, body: await boundedBody(response) };
  } catch {
    if (controller.signal.aborted) throw new Error('Rehearsal API request timed out or was aborted.');
    throw new Error('Rehearsal API request failed.');
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', abort);
  }
}

export async function requestRehearsalAccount<T = unknown>(session: ByoAccountSession, input: ByoAccountRequest): Promise<RehearsalHttpResult<T>> {
  if (!/^account:[A-Za-z0-9._~-]{1,480}$/.test(session.actorId)
    || session.actorId !== `account:${session.subjectId}` || !session.cookie) {
    throw new Error('Rehearsal account session is invalid.');
  }
  return rawRequest({ ...input, cookie: session.cookie, allowedPrefix: '/api/participation/' }) as Promise<RehearsalHttpResult<T>>;
}

async function signUp(input: ByoSyntheticAccountInput, origins: { motiveApiOrigin: string; appOrigin: string }): Promise<ByoAccountSession> {
  const apiOrigin = loopbackOrigin(origins.motiveApiOrigin, ALLOWED_API_PORT, 'motiveApiOrigin');
  const appOrigin = loopbackOrigin(origins.appOrigin, ALLOWED_APP_PORT, 'appOrigin');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let response: Response;
  try {
    response = await fetch(`${apiOrigin}/api/auth/sign-up/email`, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Origin: appOrigin },
      body: JSON.stringify({ name: input.name, email: input.email, password: input.password }),
    });
  } catch {
    throw new Error('Synthetic BetterAuth sign-up failed.');
  } finally { clearTimeout(timer); }
  const cookie = cookieHeader(response.headers);
  const body = await boundedBody(response) as { user?: { id?: unknown; name?: unknown; email?: unknown } };
  if (response.status !== 200 || typeof body.user?.id !== 'string' || !/^[A-Za-z0-9._~-]{1,480}$/.test(body.user.id)
    || body.user.name !== input.name || body.user.email !== input.email) {
    throw new Error('Synthetic BetterAuth sign-up returned an invalid account response.');
  }
  return { role: input.role, subjectId: body.user.id, actorId: `account:${body.user.id}`,
    name: input.name, email: input.email, password: input.password, cookie };
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} response is invalid.`);
  return value as Record<string, unknown>;
}

function expectStatus(result: RehearsalHttpResult, status: number, label: string): Record<string, unknown> {
  if (result.status !== status) throw new Error(`${label} returned HTTP ${result.status}.`);
  return expectRecord(result.body, label);
}

export async function enrollByoRehearsal(pool: Pool, input: Readonly<{
  motiveApiOrigin: string;
  appOrigin: string;
  seed: ByoDatabaseSeed;
  engine: EngineBinding;
  vaultKey: Uint8Array;
}>): Promise<ByoEnrollment> {
  const database = await assertRehearsalDatabase(pool);
  loopbackOrigin(input.motiveApiOrigin, ALLOWED_API_PORT, 'motiveApiOrigin');
  loopbackOrigin(input.appOrigin, ALLOWED_APP_PORT, 'appOrigin');
  if (input.seed.projectSlug !== 'circle-packing' || !UUID.test(input.seed.projectId) || !UUID.test(input.seed.workOrderId)
    || !UUID.test(input.engine.workspaceId) || !UUID.test(input.engine.channelId)
    || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(input.engine.channelName) || !API_KEY.test(input.engine.apiKey)
    || input.vaultKey.byteLength !== 32) throw new Error('BYO rehearsal enrollment input is invalid.');
  const approvedEngineApiBase = engineApiBase(input.engine.apiBaseUrl);
  const exactSeed = await pool.query(`SELECT project.id,project.current_revision,work.id AS work_order_id,work.revision AS work_order_revision,
    work.terms_digest FROM motive.projects project JOIN motive.work_orders work ON work.project_id=project.id
    WHERE project.id=$1 AND project.slug='circle-packing' AND project.visibility='PUBLIC' AND work.id=$2`,
  [input.seed.projectId, input.seed.workOrderId]);
  if (exactSeed.rowCount !== 1 || Number(exactSeed.rows[0].current_revision) !== input.seed.projectRevision
    || Number(exactSeed.rows[0].work_order_revision) !== input.seed.workOrderRevision
    || exactSeed.rows[0].terms_digest !== input.seed.workOrderTermsDigest) throw new Error('BYO rehearsal seed no longer matches the database.');

  const owner = await signUp(input.seed.accounts.owner, input);
  const reviewer = await signUp(input.seed.accounts.reviewer, input);
  const contributor = await signUp(input.seed.accounts.contributor, input);
  for (const account of [owner, reviewer, contributor]) {
    expectStatus(await requestRehearsalAccount(account, {
      apiOrigin: input.motiveApiOrigin, appOrigin: input.appOrigin, path: '/api/participation/me',
    }), 200, `${account.role} authenticated identity`);
  }
  const actors = [owner.actorId, reviewer.actorId, contributor.actorId];
  const established = await pool.query<{ actor_id: string; provider: string; subject_id: string; status: string }>(
    `SELECT actor_id,provider,subject_id,status FROM motive.account_identities
      WHERE actor_id=ANY($1::text[]) ORDER BY actor_id`, [actors],
  );
  const exactIdentities = new Map(established.rows.map(row => [row.actor_id, row]));
  for (const account of [owner, reviewer, contributor]) {
    const identity = exactIdentities.get(account.actorId);
    if (identity?.provider !== 'local-better-auth' || identity.subject_id !== account.subjectId || identity.status !== 'ACTIVE') {
      throw new Error(`${account.role} authenticated identity was not retained exactly in PostgreSQL.`);
    }
  }
  if (established.rowCount !== 3) throw new Error('Authenticated local accounts did not establish exactly three durable identities.');
  const automaticAuthority = await pool.query<{ memberships: number; wallets: number; tokens: number }>(`SELECT
    (SELECT count(*)::int FROM motive.memberships WHERE actor_id=ANY($1::text[])) AS memberships,
    (SELECT count(*)::int FROM motive.account_credit_wallets WHERE actor_id=ANY($1::text[])) AS wallets,
    (SELECT count(*)::int FROM motive.participation_agent_tokens WHERE owner_actor_id=ANY($1::text[])) AS tokens`, [actors]);
  const automatic = automaticAuthority.rows[0];
  if (!automatic || automatic.memberships !== 0 || automatic.wallets !== 0 || automatic.tokens !== 0) {
    throw new Error('Authenticated local identity establishment unexpectedly granted project authority, a durable wallet, or an agent credential.');
  }
  const operatorEnv = { ...process.env, MOTIVE_ACCOUNT_PROVIDER: 'local-better-auth',
    MOTIVE_DATA_DIR: resolve('.local', database) };
  const ownerGrant = await setProjectReviewer({ pool, selector: { accountEmail: owner.email }, role: 'OWNER',
    apply: true, env: operatorEnv });
  const reviewerGrant = await setProjectReviewer({ pool, selector: { accountEmail: reviewer.email }, role: 'REVIEWER',
    apply: true, env: operatorEnv });
  if (ownerGrant.actorId !== owner.actorId || ownerGrant.role !== 'OWNER' || ownerGrant.status !== 'ACTIVE'
    || reviewerGrant.actorId !== reviewer.actorId || reviewerGrant.role !== 'REVIEWER' || reviewerGrant.status !== 'ACTIVE') {
    throw new Error('Explicit local operator commands did not grant the exact owner and reviewer accounts.');
  }

  let engineReadCount = 0;
  const readOnlyEngineFetch: typeof fetch = async (request, init) => {
    const method = init?.method ?? (request instanceof Request ? request.method : 'GET');
    if (method !== 'GET') throw new Error('BYO bootstrap blocked a non-GET Hypothesis request.');
    engineReadCount += 1;
    return fetch(request, init);
  };
  const research = createResearchMemoryService({ pool, vaultKey: input.vaultKey, fetch: readOnlyEngineFetch });
  const scope = await research.linkScope(owner.actorId, input.seed.projectSlug, {
    apiBaseUrl: approvedEngineApiBase,
    tenantId: input.engine.workspaceId,
    channelId: input.engine.channelId,
    channelName: input.engine.channelName,
    apiKey: input.engine.apiKey,
  });
  if (engineReadCount !== 3) throw new Error('BYO research-scope bootstrap performed an unexpected number of engine reads.');
  const activeActors = new Set([owner.actorId, reviewer.actorId, contributor.actorId]);
  const policies = createProjectResearchDeliveryPolicyService({
    pool,
    vaultKey: input.vaultKey,
    isActorActive: actorId => activeActors.has(actorId),
    fetch: readOnlyEngineFetch,
  });
  const policy = await policies.approve(owner.actorId, {
    projectSlug: input.seed.projectSlug,
    scopeId: scope.scopeId,
    workOrderId: input.seed.workOrderId,
    idempotencyKey: 'byo-rehearsal-policy-v1',
    approvedApiBaseUrl: approvedEngineApiBase,
    contract: PINNED_REVIEWED_WRITEBACK_CONTRACT,
  }, true);
  if (policy.status !== 'ACTIVE' || policy.permittedOperations.join(',') !== 'DRAFT_HYPOTHESIS,NEUTRAL_EVIDENCE') {
    throw new Error('BYO rehearsal research delivery policy is not the pinned bounded policy.');
  }

  const joined = expectStatus(await requestRehearsalAccount(contributor, {
    apiOrigin: input.motiveApiOrigin,
    appOrigin: input.appOrigin,
    path: '/api/participation/join',
    method: 'POST',
    idempotencyKey: 'byo-rehearsal-contributor-join-v1',
    body: { projectSlug: 'circle-packing', publishDisplayName: true, acceptReferenceTerms: true },
  }), 201, 'Contributor join');
  const token = joined.token;
  const credential = expectRecord(joined.credential, 'Contributor credential');
  const assignment = expectRecord(joined.assignment, 'Contributor assignment');
  if (typeof token !== 'string' || !token.startsWith('motive_agent_') || !UUID.test(String(credential.id))
    || assignment.status !== 'AVAILABLE' || assignment.id !== input.seed.workOrderId) {
    throw new Error('Contributor join returned an invalid agent credential or assignment.');
  }

  const anonymous = await rawRequest({ apiOrigin: input.motiveApiOrigin, appOrigin: input.appOrigin,
    path: '/api/participation/me', method: 'GET', allowedPrefix: '/api/participation/' });
  if (anonymous.status !== 401) throw new Error('Signed-out account access was not denied.');
  const reviewerAgentDeniedResponse = await fetch(`${loopbackOrigin(input.motiveApiOrigin, ALLOWED_API_PORT, 'motiveApiOrigin')}/api/agent/assignment`, {
    method: 'GET', redirect: 'error', headers: { Accept: 'application/json', Cookie: reviewer.cookie },
  });
  await boundedBody(reviewerAgentDeniedResponse);
  if (reviewerAgentDeniedResponse.status !== 401) throw new Error('Reviewer session unexpectedly acted as an agent credential.');
  const ownerMe = expectStatus(await requestRehearsalAccount(owner, { apiOrigin: input.motiveApiOrigin, appOrigin: input.appOrigin,
    path: '/api/participation/me' }), 200, 'Owner account');
  const reviewerMe = expectStatus(await requestRehearsalAccount(reviewer, { apiOrigin: input.motiveApiOrigin, appOrigin: input.appOrigin,
    path: '/api/participation/me' }), 200, 'Reviewer account');
  const contributorMe = expectStatus(await requestRehearsalAccount(contributor, { apiOrigin: input.motiveApiOrigin, appOrigin: input.appOrigin,
    path: '/api/participation/me' }), 200, 'Contributor account');
  if (ownerMe.canManageReviewers !== true || reviewerMe.canReview !== true || reviewerMe.canManageReviewers !== false
    || contributorMe.canReview !== false || !Array.isArray(reviewerMe.credentials) || reviewerMe.credentials.length !== 0) {
    throw new Error('Synthetic account roles are not separated as required.');
  }
  const agentHeaders = { Accept: 'application/json', Authorization: `Bearer ${token}` };
  const assignmentResponse = await fetch(`${loopbackOrigin(input.motiveApiOrigin, ALLOWED_API_PORT, 'motiveApiOrigin')}/api/agent/assignment`,
    { method: 'GET', redirect: 'error', headers: agentHeaders });
  const agentAssignment = expectStatus({ status: assignmentResponse.status, body: await boundedBody(assignmentResponse) }, 200, 'Agent assignment');
  if (expectRecord(agentAssignment.assignment, 'Agent assignment projection').status !== 'AVAILABLE') {
    throw new Error('Contributor agent assignment is not available.');
  }
  const capabilityResponse = await fetch(`${loopbackOrigin(input.motiveApiOrigin, ALLOWED_API_PORT, 'motiveApiOrigin')}/api/agent/research-sync-capability`,
    { method: 'GET', redirect: 'error', headers: agentHeaders });
  const capability = expectStatus({ status: capabilityResponse.status, body: await boundedBody(capabilityResponse) }, 200, 'Research sync capability');
  if (capability.status !== 'AVAILABLE' || capability.policyId !== policy.id) throw new Error('Research sync capability is unavailable.');

  const counts = await pool.query<{ submissions: number; deliveries: number; intents: number; sync_requests: number;
    admissions: number; findings: number }>(`SELECT
    (SELECT count(*)::int FROM motive.participation_submission_artifacts WHERE project_id=$1) AS submissions,
    (SELECT count(*)::int FROM motive.hypothesis_submission_deliveries WHERE project_id=$1) AS deliveries,
    (SELECT count(*)::int FROM motive.hypothesis_writeback_intents WHERE project_id=$1) AS intents,
    (SELECT count(*)::int FROM motive.agent_research_sync_requests WHERE project_id=$1) AS sync_requests,
    (SELECT count(*)::int FROM motive.hypothesis_submission_delivery_admission_decisions decision
      JOIN motive.hypothesis_submission_deliveries delivery ON delivery.id=decision.delivery_id WHERE delivery.project_id=$1) AS admissions,
    (SELECT count(*)::int FROM motive.finding_review_decisions WHERE project_id=$1) AS findings`, [input.seed.projectId]);
  const count = counts.rows[0];
  if (!count || count.submissions !== 0 || count.deliveries !== 0 || count.intents !== 0 || count.sync_requests !== 0
    || count.admissions !== 0 || count.findings !== 0) {
    throw new Error('BYO bootstrap unexpectedly created research or review records.');
  }
  return {
    safe: {
      format: 'motive.byo-rehearsal-fixture/0.1', projectSlug: 'circle-packing', projectId: input.seed.projectId,
      projectRevision: input.seed.projectRevision, workOrderId: input.seed.workOrderId,
      workOrderRevision: input.seed.workOrderRevision, scopeId: scope.scopeId, policyId: policy.id,
      workspaceId: input.engine.workspaceId, channelId: input.engine.channelId, channelName: input.engine.channelName,
      ownerActorId: owner.actorId, reviewerActorId: reviewer.actorId, contributorActorId: contributor.actorId,
      contributorCredentialId: String(credential.id),
      readiness: { anonymousAccountDenied: true, ownerCanManageReviewers: true, reviewerCanReview: true,
        contributorCanReview: false, reviewerHasNoAgentCredential: true, contributorAssignmentStatus: 'AVAILABLE',
        researchSyncStatus: 'AVAILABLE', engineReadCount, submissions: 0, deliveries: 0, writeIntents: 0,
        syncRequests: 0, admissionDecisions: 0, findingDecisions: 0 },
      disclosure: 'Synthetic local BetterAuth accounts authenticated into exact durable PostgreSQL identities; owner and reviewer authority was granted only by explicit local operator commands.',
    },
    private: { owner, reviewer, contributor, contributorBearer: token },
  };
}
