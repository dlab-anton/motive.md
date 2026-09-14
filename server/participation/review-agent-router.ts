import { json, Router, type NextFunction, type Request, type Response } from 'express';
import {
  SubmissionAdmissionError,
  type HypothesisSubmissionAdmissionService,
  type IssueResearchAdmissionAgentAccessInput,
  type DecideResearchAdmissionFromAgentInput,
  type ResearchAdmissionAgentContext,
} from '../research-memory/submission-admission.ts';
import { ReviewQueueError, type ResearchReviewQueueService, type ReviewQueueAgentContext } from '../research-memory/review-queue.ts';
import { isCreateReviewQueueGrantInput, isReleaseReviewQueueClaimInput } from '../../src/lib/review-queue.ts';

type AccountLocals = { actorId?: unknown; accountName?: unknown };
type ReviewAgentLocals = { researchAdmissionAgent?: ResearchAdmissionAgentContext };
type QueueAgentLocals = { reviewQueueAgent?: ReviewQueueAgentContext };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const KEY = /^[A-Za-z0-9._~-]{8,200}$/;
const BEARER = /^Bearer ([A-Za-z0-9._~-]{20,512})$/;

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = [...keys].sort();
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected);
}

function noQuery(req: Request): void {
  if (Object.keys(req.query).length) throw new SubmissionAdmissionError('VALIDATION', 'Research review agent routes do not accept query parameters.');
}

function idempotency(req: Request): string {
  const key = req.get('Idempotency-Key');
  if (!key || !KEY.test(key)) throw new SubmissionAdmissionError('VALIDATION', 'A valid Idempotency-Key is required.');
  return key;
}

function parameter(value: string | string[] | undefined, label: 'Submission' | 'Review access' | 'Research snapshot'): string {
  const result = typeof value === 'string' ? value : '';
  if (!UUID.test(result)) throw new SubmissionAdmissionError('NOT_FOUND', `${label} was not found.`);
  return result;
}

function account(res: Response): string {
  const locals = res.locals as AccountLocals;
  if (typeof locals.actorId !== 'string' || !locals.actorId.startsWith('account:')
      || typeof locals.accountName !== 'string' || !locals.accountName.trim()) {
    throw new SubmissionAdmissionError('UNAUTHORIZED', 'A live account session is required.');
  }
  return locals.actorId;
}

function reviewAgent(res: Response): ResearchAdmissionAgentContext {
  const context = (res.locals as ReviewAgentLocals).researchAdmissionAgent;
  if (!context) throw new SubmissionAdmissionError('UNAUTHORIZED', 'A review agent token is required.');
  return context;
}

function issueInput(value: unknown): IssueResearchAdmissionAgentAccessInput {
  if (!object(value) || !exact(value, ['packageDigest', 'expectedDecisionId'])
      || typeof value.packageDigest !== 'string' || !DIGEST.test(value.packageDigest)
      || !(value.expectedDecisionId === null || typeof value.expectedDecisionId === 'string' && UUID.test(value.expectedDecisionId))) {
    throw new SubmissionAdmissionError('VALIDATION', 'Review agent access must contain exactly packageDigest and expectedDecisionId.');
  }
  return { packageDigest: value.packageDigest, expectedDecisionId: value.expectedDecisionId };
}

function decisionInput(value: unknown): DecideResearchAdmissionFromAgentInput {
  if (!object(value) || !exact(value, ['decision', 'rationale']) || !['ADMIT', 'DECLINE'].includes(String(value.decision))
      || typeof value.rationale !== 'string' || value.rationale.trim() !== value.rationale
      || value.rationale.length < 1 || value.rationale.length > 2000) {
    throw new SubmissionAdmissionError('VALIDATION', 'Review agent decision must contain exactly decision and rationale.');
  }
  return { decision: value.decision as 'ADMIT' | 'DECLINE', rationale: value.rationale };
}

function emptyBody(value: unknown): void {
  if (!object(value) || Object.keys(value).length) throw new SubmissionAdmissionError('VALIDATION', 'Review agent revocation body must be an empty object.');
}

function errorResponse(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (error instanceof SubmissionAdmissionError || error instanceof ReviewQueueError) {
    res.status(error.statusCode).json({ error: error.code.toLowerCase(), message: error.message });
    return;
  }
  const parseError = error as { type?: unknown };
  if (error instanceof SyntaxError || parseError?.type === 'entity.parse.failed' || parseError?.type === 'entity.too.large') {
    res.status(400).json({ error: 'validation', message: 'Request JSON is invalid.' });
    return;
  }
  res.status(500).json({ error: 'internal_error', message: 'Research review agent request failed.' });
}

export function createResearchAdmissionAgentRouters(service: HypothesisSubmissionAdmissionService) {
  const accountRouter = Router();
  accountRouter.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  accountRouter.use(json({ limit: '16kb', strict: true }));
  accountRouter.get('/submissions/:submissionId/research-admission/agent-access', async (req, res) => {
    const actorId = account(res); noQuery(req);
    res.json(await service.getAgentAccess(actorId, parameter(req.params.submissionId, 'Submission')));
  });
  accountRouter.post('/submissions/:submissionId/research-admission/agent-access', async (req, res) => {
    const actorId = account(res); noQuery(req); const input = issueInput(req.body);
    res.status(201).json(await service.issueAgentAccess(actorId, parameter(req.params.submissionId, 'Submission'), input, idempotency(req)));
  });
  accountRouter.post('/submissions/:submissionId/research-admission/agent-access/:accessId/revoke', async (req, res) => {
    const actorId = account(res); noQuery(req); emptyBody(req.body);
    res.json(await service.revokeAgentAccess(actorId, parameter(req.params.submissionId, 'Submission'),
      parameter(req.params.accessId, 'Review access'), idempotency(req)));
  });
  accountRouter.use((_req, res) => { res.status(404).json({ error: 'not_found', message: 'Research review agent route was not found.' }); });
  accountRouter.use(errorResponse);

  const agentRouter = Router();
  agentRouter.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  agentRouter.use(async (req, res, next) => {
    try {
      const token = BEARER.exec(req.get('Authorization') ?? '')?.[1];
      if (!token) throw new SubmissionAdmissionError('UNAUTHORIZED', 'A review agent token is required.');
      const allowConsumedQueueReplay=req.method==='POST'&&req.path==='/decision';
      (res.locals as ReviewAgentLocals).researchAdmissionAgent = allowConsumedQueueReplay
        ? await service.authenticateReviewAgent(token,true) : await service.authenticateReviewAgent(token);
      next();
    } catch (error) { next(error); }
  });
  agentRouter.use(json({ limit: '16kb', strict: true }));
  agentRouter.get('/assignment', async (req, res) => {
    noQuery(req);
    res.json(await service.reviewAgentAssignment(reviewAgent(res)));
  });
  agentRouter.get('/research-context/snapshots/:snapshotId', async (req, res) => {
    noQuery(req);
    res.json(await service.reviewAgentSnapshot(reviewAgent(res),parameter(req.params.snapshotId,'Research snapshot')));
  });
  agentRouter.post('/decision', async (req, res) => {
    noQuery(req);
    res.status(201).json(await service.decideAdmissionFromAgent(reviewAgent(res), decisionInput(req.body), idempotency(req)));
  });
  agentRouter.use((_req, res) => { res.status(404).json({ error: 'not_found', message: 'Research review agent route was not found.' }); });
  agentRouter.use(errorResponse);
  return { accountRouter, agentRouter };
}

export function createResearchReviewQueueAccountRouter(service: ResearchReviewQueueService) {
  const router=Router();
  router.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  router.use(json({limit:'16kb',strict:true}));
  router.get('/review-queue-agent-access',async(req,res)=>{noQuery(req);res.json(await service.listGrants(account(res)));});
  router.post('/review-queue-agent-access',async(req,res)=>{
    noQuery(req);if(!isCreateReviewQueueGrantInput(req.body))throw new ReviewQueueError('VALIDATION','Review queue agent access request is invalid.');
    res.status(201).json(await service.createGrant(account(res),req.body,idempotency(req)));
  });
  router.post('/review-queue-agent-access/:grantId/revoke',async(req,res)=>{
    noQuery(req);emptyBody(req.body);res.json(await service.revokeGrant(account(res),parameter(req.params.grantId,'Review access'),idempotency(req)));
  });
  router.use(errorResponse);return router;
}

export function createResearchReviewQueueAgentRouter(service: ResearchReviewQueueService) {
  const router=Router();
  router.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  router.use(async(req,res,next)=>{try{const token=BEARER.exec(req.get('Authorization')??'')?.[1];
    if(!token)throw new ReviewQueueError('UNAUTHORIZED','A review queue agent token is required.');
    (res.locals as QueueAgentLocals).reviewQueueAgent=await service.authenticate(token);next();}catch(error){next(error);}});
  router.use(json({limit:'16kb',strict:true}));
  const context=(res:Response)=>{const value=(res.locals as QueueAgentLocals).reviewQueueAgent;
    if(!value)throw new ReviewQueueError('UNAUTHORIZED','A review queue agent token is required.');return value;};
  router.get('/assignment',async(req,res)=>{noQuery(req);res.json(await service.state(context(res)));});
  router.post('/claim',async(req,res)=>{noQuery(req);emptyBody(req.body);res.status(201).json(await service.claim(context(res),idempotency(req)));});
  router.post('/release',async(req,res)=>{noQuery(req);
    if(!isReleaseReviewQueueClaimInput(req.body))throw new ReviewQueueError('VALIDATION','Review queue release request is invalid.');
    res.status(201).json(await service.release(context(res),req.body,idempotency(req)));});
  router.use((_req,res)=>{res.status(404).json({error:'not_found',message:'Review queue agent route was not found.'});});
  router.use(errorResponse);return router;
}
