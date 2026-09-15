import { json, Router, type NextFunction, type Request, type Response } from 'express';
import type {
  DeclareAssignmentIntentInput,
  FencedAssignmentInput,
  JoinParticipationInput,
  PostCheckAssessmentInput,
  ReleaseAssignmentInput,
  ReviewSubmissionInput,
  SetAgentSessionInput,
  SubmissionReproducibilityInput,
  SubmissionInvestigationInput,
  SubmissionResearchContext,
  SubmitCircleWitnessInput,
} from '../../src/lib/participation.ts';
import { ParticipationError, type ParticipationAgentContext, type ParticipationService } from './service.ts';
import type { ResearchMemoryService } from '../research-memory/index.ts';
import type { ResearchContextPage } from '../../src/lib/research-memory.ts';
import { isPublicResearchSummary } from '../../src/lib/research-summary.ts';
import type { AgentResearchSyncInput } from '../../src/lib/research-delivery-policy.ts';
import { ResearchDeliveryPolicyError, type ProjectResearchDeliveryPolicyService } from '../research-memory/delivery-policy.ts';
import { SubmissionDeliveryError } from '../research-memory/submission-delivery.ts';
import { DeliveryIntentError } from '../research-memory/delivery-intents.ts';
import { SubmissionAdmissionError, type HypothesisSubmissionAdmissionService } from '../research-memory/submission-admission.ts';
import { FindingAssessmentError, type FindingAssessmentService } from '../research-memory/finding-assessment.ts';
import type { FindingReviewDecisionInput } from '../../src/lib/finding-assessment.ts';
import { validateResearchDeliveryTargetSelection } from '../../src/lib/research-delivery-target.ts';
import { buildResearchBrief } from './research-brief.ts';

type RouterOptions = {
  service: ParticipationService;
  isActorActive: (actorId: string) => boolean | Promise<boolean>;
  researchMemory?: ResearchMemoryService;
  researchDeliveryPolicy?: ProjectResearchDeliveryPolicyService;
  researchAdmission?: HypothesisSubmissionAdmissionService;
  findingAssessment?: FindingAssessmentService;
};
type AccountLocals = { actorId?: unknown; accountName?: unknown };
type AgentLocals = { participationAgent?: ParticipationAgentContext };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const CANONICAL_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  const accepted = new Set([...required, ...optional]);
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => accepted.has(key));
}
function idempotency(req: Request): string {
  const key = req.get('Idempotency-Key');
  if (!key) throw new ParticipationError('VALIDATION', 'Idempotency-Key is required.');
  return key;
}
function reviewerAccountId(body: unknown): string {
  if (!object(body) || !exact(body, ['accountId']) || typeof body.accountId !== 'string'
    || !CANONICAL_UUID.test(body.accountId)) {
    throw new ParticipationError('VALIDATION', 'Body must contain one canonical lowercase UUID accountId.');
  }
  return body.accountId;
}
function noReviewerQuery(req: Request) {
  if (Object.keys(req.query).length !== 0) {
    throw new ParticipationError('VALIDATION', 'Reviewer management does not accept query parameters.');
  }
}
function account(res: Response): { actorId: string; accountName: string } {
  const locals = res.locals as AccountLocals;
  if (typeof locals.actorId !== 'string' || !locals.actorId.startsWith('account:') || typeof locals.accountName !== 'string' || !locals.accountName.trim()) {
    throw new ParticipationError('UNAUTHORIZED', 'A live account session is required.');
  }
  return { actorId: locals.actorId, accountName: locals.accountName.trim().slice(0, 120) };
}
function agent(res: Response): ParticipationAgentContext {
  const context = (res.locals as AgentLocals).participationAgent;
  if (!context) throw new ParticipationError('UNAUTHORIZED', 'Agent token is required.');
  return context;
}
function parameter(value: string | string[] | undefined): string {
  return typeof value === 'string' ? value : '';
}
function assignmentId(req: Request) {
  const value = parameter(req.params.assignmentId);
  if (!UUID.test(value)) throw new ParticipationError('NOT_FOUND', 'Assignment not found.');
  return value;
}
function submissionId(req: Request) {
  const value = parameter(req.params.submissionId);
  if (!UUID.test(value)) throw new ParticipationError('NOT_FOUND', 'Submission not found.');
  return value;
}
function geometryComparisonIds(req: Request): { left: string; right: string } {
  const left = parameter(req.params.submissionId); const keys = Object.keys(req.query);
  const right = req.query.against;
  if (!CANONICAL_UUID.test(left) || keys.length !== 1 || keys[0] !== 'against'
    || typeof right !== 'string' || !CANONICAL_UUID.test(right)) {
    throw new ParticipationError('VALIDATION', 'Geometry comparison requires exactly one canonical lowercase against submission UUID.');
  }
  return { left, right };
}
function contributorId(req: Request) {
  const value = parameter(req.params.contributorId);
  if (!CANONICAL_UUID.test(value)) throw new ParticipationError('VALIDATION', 'contributorId must be a canonical UUID.');
  return value;
}
function reviewedArtifactAfter(req: Request): string | undefined {
  const keys = Object.keys(req.query);
  if (!keys.length) return undefined;
  if (keys.length !== 1 || keys[0] !== 'after' || typeof req.query.after !== 'string'
    || !/^[a-f0-9]{64}$/.test(req.query.after)) {
    throw new ParticipationError('VALIDATION', 'after must be one lowercase 64-character SHA-256 digest.');
  }
  return req.query.after;
}
function fenced(body: unknown): FencedAssignmentInput {
  if (!object(body) || !exact(body, ['leaseEpoch']) || !Number.isSafeInteger(body.leaseEpoch) || Number(body.leaseEpoch) < 1) {
    throw new ParticipationError('VALIDATION', 'Body must contain the positive integer leaseEpoch only.');
  }
  return { leaseEpoch: Number(body.leaseEpoch) };
}

function release(body: unknown): ReleaseAssignmentInput {
  if (!object(body) || !exact(body, ['leaseEpoch'], ['stopReason'])
    || !Number.isSafeInteger(body.leaseEpoch) || Number(body.leaseEpoch) < 1
    || body.stopReason !== undefined && (typeof body.stopReason !== 'string'
      || body.stopReason.length < 1 || body.stopReason.length > 1000 || body.stopReason.trim() !== body.stopReason
      || body.stopReason.includes('\u0000'))) {
    throw new ParticipationError('VALIDATION', 'Release body must contain a positive integer leaseEpoch and may contain a trimmed stopReason of 1–1000 characters.');
  }
  return { leaseEpoch: Number(body.leaseEpoch), ...(body.stopReason === undefined ? {} : { stopReason: body.stopReason }) };
}

function agentSession(body: unknown): SetAgentSessionInput {
  if (!object(body) || typeof body.status !== 'string' || typeof body.runMode !== 'string'
    || !['RUNNING', 'PAUSED'].includes(body.status)
    || !['ONE_TASK', 'THIRTY_MINUTES', 'UNTIL_STOPPED'].includes(body.runMode)
    || (body.status === 'RUNNING' && !exact(body, ['status', 'runMode']))
    || (body.status === 'PAUSED' && !exact(body, ['status', 'runMode'], ['stopReason']))
    || (body.status === 'PAUSED' && body.stopReason !== undefined
      && (typeof body.stopReason !== 'string' || body.stopReason.length < 1 || body.stopReason.length > 280
        || body.stopReason !== body.stopReason.trim()
        || /[\u0000-\u001f\u007f-\u009f\u2028\u2029\uD800-\uDFFF]/u.test(body.stopReason)))) {
    throw new ParticipationError('VALIDATION', 'Agent session declaration is invalid.');
  }
  return body as SetAgentSessionInput;
}

function assignmentIntent(body: unknown): DeclareAssignmentIntentInput {
  if (!object(body) || !exact(body, ['leaseEpoch','proposal','expectation','conditions'], ['researchContext','researchReferences','motiveReferences','experimentProtocol','researchDeliveryTarget'])
    || !Number.isSafeInteger(body.leaseEpoch) || Number(body.leaseEpoch) < 1
    || typeof body.proposal !== 'string' || typeof body.expectation !== 'string') {
    throw new ParticipationError('VALIDATION', 'Intent body must contain leaseEpoch, proposal, expectation, and conditions, with optional research context and references.');
  }
  if (!Array.isArray(body.conditions)) throw new ParticipationError('VALIDATION', 'intent.conditions must be an array.');
  const invalid = body.conditions.findIndex(item => typeof item !== 'string');
  if (invalid >= 0) throw new ParticipationError('VALIDATION', `intent.conditions[${invalid}] must be text.`);
  return { leaseEpoch: Number(body.leaseEpoch), proposal: body.proposal, expectation: body.expectation,
    conditions: body.conditions as string[],
    ...(body.researchContext === undefined ? {} : { researchContext: researchContext(body.researchContext) }),
    ...(body.researchReferences === undefined ? {} : {
      researchReferences: body.researchReferences as DeclareAssignmentIntentInput['researchReferences'] }),
    ...(body.motiveReferences === undefined ? {} : {
      motiveReferences: body.motiveReferences as DeclareAssignmentIntentInput['motiveReferences'] }),
    ...(body.experimentProtocol === undefined ? {} : {
      experimentProtocol: body.experimentProtocol as DeclareAssignmentIntentInput['experimentProtocol'] }),
    ...(body.researchDeliveryTarget === undefined ? {} : {
      researchDeliveryTarget: parseResearchDeliveryTarget(body.researchDeliveryTarget, 'intent.researchDeliveryTarget') }) };
}

function parseResearchDeliveryTarget(value: unknown, field: string) {
  try { return validateResearchDeliveryTargetSelection(value); }
  catch { throw new ParticipationError('VALIDATION', `${field} must identify one canonical retained hypothesis target.`); }
}

function postCheckAssessment(body: unknown): PostCheckAssessmentInput {
  if (!object(body) || !exact(body, ['reportDigest', 'assessment', 'nextAction'], ['publicSummary'])
    || typeof body.reportDigest !== 'string' || typeof body.assessment !== 'string' || typeof body.nextAction !== 'string'
    || body.publicSummary!==undefined&&!isPublicResearchSummary(body.publicSummary)) {
    throw new ParticipationError('VALIDATION', 'Post-check assessment body is invalid.');
  }
  return { reportDigest: body.reportDigest, assessment: body.assessment, nextAction: body.nextAction,
    ...(body.publicSummary===undefined?{}:{publicSummary:body.publicSummary}) };
}

function submissionReproducibility(body: unknown): SubmissionReproducibilityInput {
  if (!object(body) || !exact(body, ['reportDigest', 'solverSource', 'trialResults'])
    || typeof body.reportDigest !== 'string' || typeof body.solverSource !== 'string' || typeof body.trialResults !== 'string') {
    throw new ParticipationError('VALIDATION', 'Reproducibility body must contain exactly reportDigest, solverSource, and trialResults.');
  }
  return { reportDigest: body.reportDigest, solverSource: body.solverSource, trialResults: body.trialResults };
}

function agentResearchSync(body: unknown): AgentResearchSyncInput {
  if (!object(body) || !exact(body, ['policyId','reportDigest']) || typeof body.policyId !== 'string'
    || !CANONICAL_UUID.test(body.policyId) || typeof body.reportDigest !== 'string' || !DIGEST.test(body.reportDigest)) {
    throw new ParticipationError('VALIDATION', 'Research sync body must contain exactly policyId and reportDigest.');
  }
  return { policyId: body.policyId, reportDigest: body.reportDigest };
}

function admissionDecision(body: unknown) {
  if (!object(body) || !exact(body, ['packageDigest','expectedDecisionId','decision','rationale'])
    || typeof body.packageDigest !== 'string' || !DIGEST.test(body.packageDigest)
    || !(body.expectedDecisionId === null || typeof body.expectedDecisionId === 'string' && CANONICAL_UUID.test(body.expectedDecisionId))
    || !['ADMIT','DECLINE'].includes(String(body.decision)) || typeof body.rationale !== 'string') {
    throw new ParticipationError('VALIDATION', 'Research admission review must contain exactly packageDigest, expectedDecisionId, decision, and rationale.');
  }
  return { packageDigest: body.packageDigest, expectedDecisionId: body.expectedDecisionId,
    decision: body.decision as 'ADMIT'|'DECLINE', rationale: body.rationale };
}

function noAdmissionQuery(req: Request) {
  if (Object.keys(req.query).length) {
    throw new ParticipationError('VALIDATION', 'Research admission routes do not accept query parameters.');
  }
}

function findingDecision(body:unknown):FindingReviewDecisionInput{
  const keys=['packageDigest','expectedDecisionId','decision','outcome','finding','limitations','novelty','duplicateOfSubmissionId','rationale'];
  if(!object(body)||!exact(body,keys)||typeof body.packageDigest!=='string'||!DIGEST.test(body.packageDigest)
    ||!(body.expectedDecisionId===null||typeof body.expectedDecisionId==='string'&&CANONICAL_UUID.test(body.expectedDecisionId))
    ||!['ACCEPT','DECLINE'].includes(String(body.decision))||typeof body.rationale!=='string'
    ||body.rationale.trim()!==body.rationale||body.rationale.length<1||body.rationale.length>2000)
    throw new ParticipationError('VALIDATION','Finding review body is invalid.');
  if(body.decision==='DECLINE'){
    if(body.outcome!==null||body.finding!==null||body.limitations!==null||body.novelty!==null||body.duplicateOfSubmissionId!==null)
      throw new ParticipationError('VALIDATION','Declined finding fields must be null.');
  }else if(!['SUPPORTED','CONTRADICTED','INCONCLUSIVE'].includes(String(body.outcome))
    ||typeof body.finding!=='string'||body.finding.trim()!==body.finding||body.finding.length<1||body.finding.length>2000
    ||typeof body.limitations!=='string'||body.limitations.trim()!==body.limitations||body.limitations.length<1||body.limitations.length>2000
    ||!['DISTINCT','DUPLICATE'].includes(String(body.novelty))
    ||body.novelty==='DISTINCT'&&body.duplicateOfSubmissionId!==null
    ||body.novelty==='DUPLICATE'&&!(typeof body.duplicateOfSubmissionId==='string'&&CANONICAL_UUID.test(body.duplicateOfSubmissionId)))
    throw new ParticipationError('VALIDATION','Accepted finding fields are invalid.');
  return body as FindingReviewDecisionInput;
}

function noFindingQuery(req:Request){if(Object.keys(req.query).length)
  throw new ParticipationError('VALIDATION','Finding review routes do not accept query parameters.');}

function agentFindingIds(req:Request){
  const reviewSubmissionId=parameter(req.params.reviewSubmissionId);
  const targetSubmissionId=parameter(req.params.targetSubmissionId);
  if(!CANONICAL_UUID.test(reviewSubmissionId)||!CANONICAL_UUID.test(targetSubmissionId))
    throw new ParticipationError('VALIDATION','Finding review submission identifiers must be canonical lowercase UUIDs.');
  return{reviewSubmissionId,targetSubmissionId};
}

function findingHistoryBefore(req:Request):string|undefined{
  const keys=Object.keys(req.query);
  if(keys.some(key=>key!=='before'))throw new ParticipationError('VALIDATION','Finding review history query is invalid.');
  const before=req.query.before;
  if(before===undefined)return undefined;
  if(typeof before!=='string'||!CANONICAL_UUID.test(before))
    throw new ParticipationError('VALIDATION','before must be a canonical UUID.');
  return before;
}

function researchJournalBefore(req:Request,allowBefore=true):string|undefined{
  const keys=Object.keys(req.query);
  if(keys.some(key=>key!=='before')||!allowBefore&&keys.length)
    throw new ParticipationError('VALIDATION','Research journal query is invalid.');
  const before=req.query.before;
  if(before===undefined)return undefined;
  if(typeof before!=='string'||!CANONICAL_UUID.test(before))
    throw new ParticipationError('VALIDATION','before must be a canonical UUID.');
  return before;
}

function submissionOwnershipIds(req:Request):string[]{
  if(Object.keys(req.query).length!==1||!Object.hasOwn(req.query,'ids')||typeof req.query.ids!=='string')
    throw new ParticipationError('VALIDATION','Submission ownership query is invalid.');
  const ids=req.query.ids.split(',');
  if(ids.length<1||ids.length>64||new Set(ids).size!==ids.length||ids.some(id=>!CANONICAL_UUID.test(id)))
    throw new ParticipationError('VALIDATION','ids must contain 1 to 64 distinct canonical UUIDs.');
  return ids;
}

function researchContextPage(query: Request['query']): ResearchContextPage {
  const allowed = new Set(['activeOffset', 'archivedOffset', 'insightOffset']);
  if (Object.keys(query).some(key => !allowed.has(key))) throw new ParticipationError('VALIDATION', 'Research context query contains an unknown parameter.');
  const result: ResearchContextPage = {};
  for (const name of allowed) {
    const value = query[name];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
      throw new ParticipationError('VALIDATION', `${name} must be a canonical nonnegative integer.`);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed > 100000) throw new ParticipationError('VALIDATION', `${name} must be at most 100000.`);
    result[name as keyof ResearchContextPage] = parsed;
  }
  return result;
}

function researchHypothesisEvidenceOffset(query: Request['query']): number {
  const keys = Object.keys(query);
  if (keys.some(key => key !== 'evidenceOffset')) {
    throw new ParticipationError('VALIDATION', 'Hypothesis research context query contains an unknown parameter.');
  }
  const value = query.evidenceOffset;
  if (value === undefined) return 0;
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new ParticipationError('VALIDATION', 'evidenceOffset must be a canonical nonnegative integer.');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 100000) {
    throw new ParticipationError('VALIDATION', 'evidenceOffset must be at most 100000.');
  }
  return parsed;
}

function investigation(value: unknown): SubmissionInvestigationInput {
  if (!object(value)) throw new ParticipationError('VALIDATION', 'investigation must be an object.');
  if (!exact(value, ['format', 'proposal', 'expectation', 'conditions', 'observations', 'assessment', 'nextAction'], ['researchContext', 'researchReferences', 'motiveReferences', 'experimentProtocol', 'researchDeliveryTarget'])) {
    throw new ParticipationError('VALIDATION', 'investigation fields must be exactly format, proposal, expectation, conditions, observations, assessment, and nextAction, with optional research context, references, and experimentProtocol.');
  }
  if (value.format !== 'motive.investigation.v1') {
    throw new ParticipationError('VALIDATION', 'investigation.format must equal motive.investigation.v1.');
  }
  const { proposal, expectation, assessment, nextAction } = value;
  for (const [field, item] of Object.entries({ proposal, expectation, assessment, nextAction })) {
    if (typeof item !== 'string') throw new ParticipationError('VALIDATION', `investigation.${field} must be text.`);
  }
  if (!Array.isArray(value.conditions)) throw new ParticipationError('VALIDATION', 'investigation.conditions must be an array.');
  const invalidCondition = value.conditions.findIndex(item => typeof item !== 'string');
  if (invalidCondition >= 0) throw new ParticipationError('VALIDATION', `investigation.conditions[${invalidCondition}] must be text.`);
  if (!Array.isArray(value.observations)) throw new ParticipationError('VALIDATION', 'investigation.observations must be an array.');
  const invalidObservation = value.observations.findIndex(item => typeof item !== 'string');
  if (invalidObservation >= 0) throw new ParticipationError('VALIDATION', `investigation.observations[${invalidObservation}] must be text.`);
  return { format: 'motive.investigation.v1', proposal: proposal as string, expectation: expectation as string,
    conditions: value.conditions as string[], observations: value.observations as string[], assessment: assessment as string, nextAction: nextAction as string,
    ...(value.researchContext === undefined ? {} : { researchContext: researchContext(value.researchContext) }),
    ...(value.researchReferences === undefined ? {} : { researchReferences: value.researchReferences as SubmissionInvestigationInput['researchReferences'] }),
    ...(value.motiveReferences === undefined ? {} : { motiveReferences: value.motiveReferences as SubmissionInvestigationInput['motiveReferences'] }),
    ...(value.experimentProtocol === undefined ? {} : { experimentProtocol: value.experimentProtocol as SubmissionInvestigationInput['experimentProtocol'] }),
    ...(value.researchDeliveryTarget === undefined ? {} : {
      researchDeliveryTarget: parseResearchDeliveryTarget(value.researchDeliveryTarget, 'investigation.researchDeliveryTarget') }) };
}

function protocolMatchRequest(body: unknown): { experimentProtocol: unknown; cursor?: string } {
  if (!object(body) || !exact(body, ['experimentProtocol'], ['cursor'])
    || (body.cursor !== undefined && typeof body.cursor !== 'string')) {
    throw new ParticipationError('VALIDATION', 'Protocol match body must contain experimentProtocol and may contain cursor.');
  }
  return { experimentProtocol: body.experimentProtocol, ...(body.cursor === undefined ? {} : { cursor: body.cursor as string }) };
}

function researchContext(value: unknown): SubmissionResearchContext {
  if (!object(value) || !exact(value, ['scopeId', 'snapshotId', 'snapshotDigest'])
    || typeof value.scopeId !== 'string' || !CANONICAL_UUID.test(value.scopeId)
    || typeof value.snapshotId !== 'string' || !CANONICAL_UUID.test(value.snapshotId)
    || typeof value.snapshotDigest !== 'string' || !DIGEST.test(value.snapshotDigest)) {
    throw new ParticipationError('VALIDATION', 'Research context must identify one canonical retained snapshot.');
  }
  return { scopeId: value.scopeId, snapshotId: value.snapshotId, snapshotDigest: value.snapshotDigest };
}

function errorResponse(error: unknown, _req: Request, res: Response, next: NextFunction) {
  if(error instanceof FindingAssessmentError){res.status(error.statusCode).json({error:error.code.toLowerCase(),message:error.message});return;}
  if (error instanceof SubmissionAdmissionError) {
    res.status(error.statusCode).json({ error:error.code.toLowerCase(),message:error.message }); return;
  }
  if (error instanceof DeliveryIntentError) {
    res.status(error.statusCode).json({ error:error.code.toLowerCase(),message:error.message }); return;
  }
  if (error instanceof SubmissionDeliveryError) {
    const status = { VALIDATION:400,UNAUTHORIZED:401,FORBIDDEN:403,NOT_FOUND:404,CONFLICT:409,UNVERIFIED_CONTRACT:409 }[error.code];
    res.status(status).json({ error:error.code.toLowerCase(),message:error.message }); return;
  }
  if (error instanceof ResearchDeliveryPolicyError) {
    const status = { VALIDATION:400,UNAUTHORIZED:401,FORBIDDEN:403,NOT_FOUND:404,CONFLICT:409 }[error.code];
    res.status(status).json({ error:error.code.toLowerCase(),message:error.message }); return;
  }
  if (!(error instanceof ParticipationError)) { next(error); return; }
  const status = { VALIDATION: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, EXPIRED: 410 }[error.code];
  res.status(status).json({ error: error.code.toLowerCase(), message: error.message });
}

export function createParticipationRouters(options: RouterOptions) {
  const accountRouter = Router();
  accountRouter.use('/reviewers', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  accountRouter.use('/finding-review-queue', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  accountRouter.use('/memory-review-queue', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  accountRouter.use('/research-handoffs', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  accountRouter.post('/join', async (req, res) => {
    const identity = account(res); const body = req.body;
    if (!object(body) || !exact(body, ['projectSlug', 'publishDisplayName', 'acceptReferenceTerms'])
      || body.projectSlug !== 'circle-packing'
      || typeof body.publishDisplayName !== 'boolean' || body.acceptReferenceTerms !== true) {
      throw new ParticipationError('VALIDATION', 'Join body is invalid.');
    }
    const input: JoinParticipationInput = { projectSlug: 'circle-packing', publishDisplayName: body.publishDisplayName,
      acceptReferenceTerms: true };
    res.status(201).json(await options.service.join(identity.actorId, identity.accountName, input, idempotency(req)));
  });
  accountRouter.get('/me', async (_req, res) => res.json(await options.service.getMe(account(res).actorId)));
  accountRouter.get('/tokens/:tokenId/work-queue', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (Object.keys(req.query).length) throw new ParticipationError('VALIDATION', 'Agent work queue does not accept query parameters.');
    const tokenId = parameter(req.params.tokenId);
    if (!CANONICAL_UUID.test(tokenId)) throw new ParticipationError('NOT_FOUND', 'Agent credential not found.');
    res.json(await options.service.getOwnedAgentWorkQueue(account(res).actorId, tokenId));
  });
  accountRouter.get('/reviewers', async (req, res) => {
    noReviewerQuery(req); res.json(await options.service.projectReviewers(account(res).actorId));
  });
  accountRouter.post('/reviewers', async (req, res) => {
    noReviewerQuery(req); const identity = account(res); const accountId = reviewerAccountId(req.body);
    res.json(await options.service.grantProjectReviewer(identity.actorId, accountId, idempotency(req)));
  });
  accountRouter.post('/reviewers/remove', async (req, res) => {
    noReviewerQuery(req); const identity = account(res); const accountId = reviewerAccountId(req.body);
    res.json(await options.service.removeProjectReviewer(identity.actorId, accountId, idempotency(req)));
  });
  accountRouter.get('/finding-review-queue',async(req,res)=>{
    const identity=account(res);const before=researchJournalBefore(req);
    res.json(await options.service.findingReviewQueue(identity.actorId,before));});
  accountRouter.get('/memory-review-queue',async(req,res)=>{
    const identity=account(res);const before=researchJournalBefore(req);
    res.json(await options.service.memoryReviewQueue(identity.actorId,before));});
  accountRouter.get('/research-updates',async(req,res)=>{res.set('Cache-Control','no-store');
    const identity=account(res);const before=researchJournalBefore(req);
    res.json(await options.service.ownedResearchJournal(identity.actorId,before));});
  accountRouter.get('/research-handoffs',async(req,res)=>{
    const identity=account(res);const before=researchJournalBefore(req);
    res.json(await options.service.ownedResearchHandoffs(identity.actorId,before));});
  accountRouter.get('/submission-ownership',async(req,res)=>{res.set('Cache-Control','no-store');
    const identity=account(res);const ids=submissionOwnershipIds(req);
    res.json(await options.service.submissionOwnership(identity.actorId,ids));});
  accountRouter.post('/tokens/:tokenId/revoke', async (req, res) => {
    const identity = account(res);
    const tokenId = parameter(req.params.tokenId);
    if (!UUID.test(tokenId) || !object(req.body) || Object.keys(req.body).length) throw new ParticipationError('VALIDATION', 'Token revoke request is invalid.');
    res.json(await options.service.revokeToken(identity.actorId, tokenId, idempotency(req)));
  });
  accountRouter.post('/submissions/:submissionId/reviews', async (req, res) => {
    const identity = account(res); const body = req.body;
    if (!object(body) || !exact(body, ['decision', 'rationale']) || !['ACCEPTED', 'REJECTED'].includes(String(body.decision))
      || typeof body.rationale !== 'string' || !body.rationale.trim() || body.rationale.length > 2000) {
      throw new ParticipationError('VALIDATION', 'Review body is invalid.');
    }
    const input: ReviewSubmissionInput = { decision: body.decision as ReviewSubmissionInput['decision'], rationale: body.rationale.trim() };
    res.status(201).json(await options.service.reviewSubmission(identity.actorId, submissionId(req), input, idempotency(req)));
  });
  accountRouter.use('/submissions/:submissionId/finding-review',(_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  accountRouter.get('/submissions/:submissionId/finding-review/eligibility',async(req,res)=>{
    noFindingQuery(req);const identity=account(res);
    if(!options.findingAssessment){res.status(503).json({error:'Finding review is not configured.'});return;}
    res.json(await options.findingAssessment.eligibility(identity.actorId,submissionId(req)));});
  accountRouter.get('/submissions/:submissionId/finding-review/preview',async(req,res)=>{
    noFindingQuery(req);const identity=account(res);
    if(!options.findingAssessment){res.status(503).json({error:'Finding review is not configured.'});return;}
    res.json(await options.findingAssessment.preview(identity.actorId,submissionId(req)));});
  accountRouter.post('/submissions/:submissionId/finding-review/reviews',async(req,res)=>{
    noFindingQuery(req);const identity=account(res);
    if(!options.findingAssessment){res.status(503).json({error:'Finding review is not configured.'});return;}
    res.status(201).json(await options.findingAssessment.decide(identity.actorId,submissionId(req),findingDecision(req.body),idempotency(req)));});
  accountRouter.get('/submissions/:submissionId/research-admission/eligibility', async (req, res) => {
    const identity = account(res);
    noAdmissionQuery(req);
    if (!options.researchAdmission) { res.status(503).json({ error: 'Research admission is not configured.' }); return; }
    const eligibility = await options.researchAdmission.admissionEligibility(identity.actorId, submissionId(req));
    res.json({ canReview: eligibility.canReview, reason: eligibility.reason });
  });
  accountRouter.post('/submissions/:submissionId/research-admission/prepare', async (req, res) => {
    const identity = account(res);
    noAdmissionQuery(req);
    if (!object(req.body) || Object.keys(req.body).length) {
      throw new ParticipationError('VALIDATION', 'Research admission preparation body must be an empty object.');
    }
    if (!options.researchAdmission) { res.status(503).json({ error: 'Research admission is not configured.' }); return; }
    res.json(await options.researchAdmission.prepareAdmissionPreview(identity.actorId, submissionId(req)));
  });
  accountRouter.post('/submissions/:submissionId/research-admission/reviews', async (req, res) => {
    const identity = account(res); noAdmissionQuery(req); const input = admissionDecision(req.body);
    if (!options.researchAdmission) { res.status(503).json({ error: 'Research admission is not configured.' }); return; }
    res.status(201).json(await options.researchAdmission.decideAdmission(identity.actorId, submissionId(req), input, idempotency(req)));
  });
  accountRouter.use(errorResponse);

  const agentRouter = Router();
  agentRouter.use(json({ limit: '128kb', strict: true }));
  agentRouter.use('/research-context/hypotheses/:hypothesisId', (_req, res, next) => {
    res.set('Cache-Control', 'no-store'); next();
  });
  agentRouter.use(async (req, res, next) => {
    try {
      const header = req.get('Authorization');
      if (!header?.startsWith('Bearer ') || header.length > 512) throw new ParticipationError('UNAUTHORIZED', 'Agent token is required.');
      const context = await options.service.authenticateBearer(header.slice(7));
      if (!await options.isActorActive(context.ownerActorId)) throw new ParticipationError('UNAUTHORIZED', 'The owning account is no longer active.');
      (res.locals as AgentLocals).participationAgent = context; next();
    } catch (error) { next(error); }
  });
  agentRouter.get('/assignment', async (_req, res) => res.json(await options.service.getAgentAssignment(agent(res))));
  agentRouter.post('/session', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (Object.keys(req.query).length) throw new ParticipationError('VALIDATION', 'Agent session does not accept query parameters.');
    res.status(201).json(await options.service.setAgentSession(agent(res), agentSession(req.body), idempotency(req)));
  });
  agentRouter.get('/work-queue', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (Object.keys(req.query).length) throw new ParticipationError('VALIDATION', 'Agent work queue does not accept query parameters.');
    res.json(await options.service.agentWorkQueue(agent(res)));
  });
  agentRouter.use('/finding-reviews/:reviewSubmissionId/targets/:targetSubmissionId',(_req,res,next)=>{
    res.set('Cache-Control','no-store');next();
  });
  agentRouter.get('/finding-reviews/:reviewSubmissionId/targets/:targetSubmissionId/preview',async(req,res)=>{
    noFindingQuery(req);
    if(!options.findingAssessment){res.status(503).json({error:'Finding review is not configured.'});return;}
    const ids=agentFindingIds(req);
    res.json(await options.findingAssessment.previewFromAgent(agent(res),ids.reviewSubmissionId,ids.targetSubmissionId));
  });
  agentRouter.post('/finding-reviews/:reviewSubmissionId/targets/:targetSubmissionId/decisions',async(req,res)=>{
    noFindingQuery(req);
    if(!options.findingAssessment){res.status(503).json({error:'Finding review is not configured.'});return;}
    const ids=agentFindingIds(req);
    res.status(201).json(await options.findingAssessment.decideFromAgent(agent(res),ids.reviewSubmissionId,
      ids.targetSubmissionId,findingDecision(req.body),idempotency(req)));
  });
  agentRouter.post('/experiment-protocol-matches', async (req, res) => {
    const body = protocolMatchRequest(req.body);
    res.json(await options.service.experimentProtocolMatches(agent(res), body.experimentProtocol, body.cursor));
  });
  agentRouter.get('/research-context', async (req, res) => {
    // Reuses the live account, project membership and bearer checks above.
    await options.service.getAgentAssignment(agent(res));
    if (!options.researchMemory) { res.status(503).json({ error: 'Research memory is not configured.' }); return; }
    res.json(await options.researchMemory.getContext('circle-packing', researchContextPage(req.query)));
  });
  agentRouter.get('/research-context/hypotheses/:hypothesisId', async (req, res) => {
    await options.service.getAgentAssignment(agent(res));
    const hypothesisId = parameter(req.params.hypothesisId);
    if (!CANONICAL_UUID.test(hypothesisId)) throw new ParticipationError('VALIDATION', 'hypothesisId must be a canonical lowercase UUID.');
    const evidenceOffset = researchHypothesisEvidenceOffset(req.query);
    if (!options.researchMemory) { res.status(503).json({ error: 'Research memory is not configured.' }); return; }
    res.json(await options.researchMemory.getHypothesisContext('circle-packing', hypothesisId, evidenceOffset));
  });
  agentRouter.get('/research-context/retained-latest', async (req, res) => {
    await options.service.getAgentAssignment(agent(res));
    if (Object.keys(req.query).length) throw new ParticipationError('VALIDATION', 'Retained research context does not accept query parameters.');
    if (!options.researchMemory) { res.status(503).json({ error: 'Research memory is not configured.' }); return; }
    res.json(await options.researchMemory.getLatestRetainedContext('circle-packing'));
  });
  agentRouter.get('/research-context/snapshots/:snapshotId', async (req, res) => {
    const context = agent(res);
    await options.service.getAgentAssignment(context);
    const id = parameter(req.params.snapshotId);
    if (!UUID.test(id)) throw new ParticipationError('NOT_FOUND', 'Research snapshot not found.');
    if (!options.researchMemory) { res.status(503).json({ error: 'Research memory is not configured.' }); return; }
    res.json(await options.researchMemory.getSnapshot(context.projectId, id));
  });
  agentRouter.get('/research-sync-capability', async (_req,res) => {
    const context=agent(res); await options.service.getAgentAssignment(context);
    if(!options.researchDeliveryPolicy){res.status(503).json({error:'Research delivery policy is not configured.'});return;}
    res.json(await options.researchDeliveryPolicy.capability(context));
  });
  agentRouter.post('/assignments/:assignmentId/claim', async (req, res) => {
    if (!object(req.body) || Object.keys(req.body).length) throw new ParticipationError('VALIDATION', 'Claim body must be an empty object.');
    res.status(201).json(await options.service.claimAssignment(agent(res), assignmentId(req), idempotency(req)));
  });
  agentRouter.post('/assignments/:assignmentId/renew', async (req, res) =>
    res.json(await options.service.renewAssignment(agent(res), assignmentId(req), fenced(req.body), idempotency(req))));
  agentRouter.post('/assignments/:assignmentId/intent', async (req, res) =>
    res.status(201).json(await options.service.declareAssignmentIntent(agent(res), assignmentId(req), assignmentIntent(req.body), idempotency(req))));
  agentRouter.post('/assignments/:assignmentId/release', async (req, res) =>
    res.json(await options.service.releaseAssignment(agent(res), assignmentId(req), release(req.body), idempotency(req))));
  agentRouter.post('/assignments/:assignmentId/submissions', async (req, res) => {
    const body = req.body;
    if (!object(body) || !exact(body, ['leaseEpoch', 'witness'], ['investigation']) || typeof body.witness !== 'string') {
      throw new ParticipationError('VALIDATION', 'Submission body must contain leaseEpoch and witness, with an optional investigation record.');
    }
    const input: SubmitCircleWitnessInput = { ...fenced({ leaseEpoch: body.leaseEpoch }), witness: body.witness,
      ...(body.investigation === undefined ? {} : { investigation: investigation(body.investigation) }) };
    res.status(201).json(await options.service.submitWitness(agent(res), assignmentId(req), input, idempotency(req)));
  });
  agentRouter.post('/assignments/:assignmentId/complete', async (req, res) => {
    const body = req.body;
    if (!object(body) || !exact(body, ['leaseEpoch', 'submissionId']) || !UUID.test(String(body.submissionId))) {
      throw new ParticipationError('VALIDATION', 'Completion body must contain leaseEpoch and submissionId only.');
    }
    res.json(await options.service.completeAssignment(agent(res), assignmentId(req),
      { ...fenced({ leaseEpoch: body.leaseEpoch }), submissionId: String(body.submissionId) }, idempotency(req)));
  });
  agentRouter.post('/submissions/:submissionId/post-check-assessment', async (req, res) => {
    res.status(201).json(await options.service.createPostCheckAssessment(agent(res), submissionId(req),
      postCheckAssessment(req.body), idempotency(req)));
  });
  agentRouter.post('/submissions/:submissionId/reproducibility', async (req, res) => {
    res.status(201).json(await options.service.createSubmissionReproducibility(agent(res), submissionId(req),
      submissionReproducibility(req.body), idempotency(req)));
  });
  agentRouter.post('/submissions/:submissionId/research-sync', async (req,res) => {
    if(!options.researchDeliveryPolicy){res.status(503).json({error:'Research delivery policy is not configured.'});return;}
    const context=agent(res),id=submissionId(req),input=agentResearchSync(req.body),key=idempotency(req);
    const recovered=options.researchAdmission
      ?await options.researchAdmission.syncRecoveredFinding(context,id,input.policyId,input.reportDigest)
      :null;
    res.json(recovered??await options.researchDeliveryPolicy.syncFromAgent(context,id,input,key));
  });
  agentRouter.use(errorResponse);

  const publicRouter = Router();
  publicRouter.get('/', async (_req, res) => res.json(await options.service.publicProjection()));
  publicRouter.get('/research-brief', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (Object.keys(req.query).length) throw new ParticipationError('VALIDATION', 'Research brief does not accept query parameters.');
    res.json(buildResearchBrief(await options.service.publicProjection()));
  });
  publicRouter.get('/research-updates',async(req,res)=>{res.set('Cache-Control','no-store');
    const before=researchJournalBefore(req);res.json(await options.service.publicResearchJournal(before));});
  publicRouter.get('/research-updates/:submissionId',async(req,res)=>{res.set('Cache-Control','no-store');
    researchJournalBefore(req,false);res.json(await options.service.publicResearchJournalEntry(submissionId(req)));});
  publicRouter.get('/research-updates/:submissionId/citing',async(req,res)=>{res.set('Cache-Control','no-store');
    const before=researchJournalBefore(req);res.json(await options.service.publicResearchCitations(submissionId(req),before));});
  publicRouter.get('/research-handoffs',async(req,res)=>{res.set('Cache-Control','no-store');
    const before=researchJournalBefore(req);res.json(await options.service.publicResearchHandoffs(before));});
  publicRouter.get('/research-handoffs/:eventId',async(req,res)=>{res.set('Cache-Control','no-store');
    researchJournalBefore(req,false);res.json(await options.service.publicResearchHandoff(parameter(req.params.eventId)));});
  publicRouter.get('/contributors/:contributorId/research-updates',async(req,res)=>{res.set('Cache-Control','no-store');
    const before=researchJournalBefore(req);res.json(await options.service.publicContributorResearchJournal(contributorId(req),before));});
  publicRouter.get('/contributors/:contributorId/accepted-findings',async(req,res)=>{res.set('Cache-Control','no-store');
    const before=researchJournalBefore(req);res.json(await options.service.publicContributorAcceptedFindings(contributorId(req),before));});
  publicRouter.get('/contributors/:contributorId/reviewed-artifacts',async(req,res)=>{res.set('Cache-Control','no-store');
    const after=reviewedArtifactAfter(req);
    res.json(await options.service.publicContributorReviewedArtifacts(contributorId(req),after));});
  publicRouter.get('/research-scope', async (_req, res) => res.json(options.researchMemory ? await options.researchMemory.getPublicScope('circle-packing') : null));
  publicRouter.get('/submissions/:submissionId/geometry-comparison', async (req, res) => {
    res.set('Cache-Control', 'no-store'); const ids = geometryComparisonIds(req);
    res.json(await options.service.publicGeometryComparison(ids.left, ids.right));
  });
  publicRouter.get('/submissions/:submissionId/artifact', async (req, res) => {
    const id = submissionId(req); const artifact = await options.service.publicArtifact(id);
    res.set({ 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ETag: `"${artifact.digest}"`,
      'Content-Disposition': `attachment; filename="circle-packing-${id}.json"` }).send(artifact.bytes);
  });
  publicRouter.get('/submissions/:submissionId/report', async (req, res) => res.json(await options.service.publicReport(submissionId(req))));
  publicRouter.get('/submissions/:submissionId/investigation', async (req, res) => res.json(await options.service.publicInvestigation(submissionId(req))));
  publicRouter.get('/submissions/:submissionId/post-check-assessment', async (req, res) =>
    res.json(await options.service.publicPostCheckAssessment(submissionId(req))));
  publicRouter.get('/submissions/:submissionId/research-admission', async (req, res) => {
    noAdmissionQuery(req);
    if (!options.researchAdmission) { res.status(503).json({ error: 'Research admission is not configured.' }); return; }
    const admission = await options.researchAdmission.publicAdmission('circle-packing', submissionId(req));
    res.json({ format: admission.format, submissionId: admission.submissionId, status: admission.status,
      latestReview: admission.latestReview ? { decision: admission.latestReview.decision,
        rationale: admission.latestReview.rationale, reviewedAt: admission.latestReview.reviewedAt } : null });
  });
  publicRouter.get('/submissions/:submissionId/finding-review/history',async(req,res)=>{res.set('Cache-Control','no-store');
    if(!options.findingAssessment){res.status(503).json({error:'Finding review is not configured.'});return;}
    res.json(await options.findingAssessment.publicHistory('circle-packing',submissionId(req),findingHistoryBefore(req)));});
  publicRouter.get('/submissions/:submissionId/finding-review',async(req,res)=>{res.set('Cache-Control','no-store');noFindingQuery(req);
    if(!options.findingAssessment){res.status(503).json({error:'Finding review is not configured.'});return;}
    res.json(await options.findingAssessment.publicReview('circle-packing',submissionId(req)));});
  publicRouter.get('/submissions/:submissionId/reproducibility', async (req, res) =>
    res.json(await options.service.publicSubmissionReproducibility(submissionId(req))));
  const reproducibilityFile = (role: 'SOLVER_SOURCE' | 'TRIAL_RESULTS') => async (req: Request, res: Response) => {
    const file = await options.service.publicSubmissionReproducibilityFile(submissionId(req), role);
    res.set({ 'Content-Type': `${file.mediaType}; charset=utf-8`, 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `attachment; filename="${file.name}"`, ETag: `"${file.digest}"` }).send(file.bytes);
  };
  publicRouter.get('/submissions/:submissionId/reproducibility/solver-source.txt', reproducibilityFile('SOLVER_SOURCE'));
  publicRouter.get('/submissions/:submissionId/reproducibility/trial-results.txt', reproducibilityFile('TRIAL_RESULTS'));
  publicRouter.use(errorResponse);
  return { accountRouter, agentRouter, publicRouter };
}
