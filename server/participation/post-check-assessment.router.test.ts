import { once } from 'node:events';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ParticipationError, type ParticipationService } from './service.ts';
import { createParticipationRouters } from './router.ts';

const submissionId = '11111111-1111-4111-8111-111111111111';
const context = { tokenId: '22222222-2222-4222-8222-222222222222', actorId: 'agent:token',
  ownerActorId: 'account:owner', projectId: '33333333-3333-4333-8333-333333333333', expiresAt: '2026-10-01T00:00:00.000Z' };
const result = { format: 'motive.post-check-assessment.public.v1', submissionId,
  reportDigest: `sha256:${'a'.repeat(64)}`, createdAt: '2026-09-08T00:00:00.000Z',
  attribution: { kind: 'AGENT_DECLARED', credentialId: context.tokenId, agentName: 'Clear Finch', modelName: null,
    contributorDisplayName: null }, assessment: 'Rejected by the protected checker.', nextAction: 'Revise the candidate.',
  disposition: 'AGENT_DECLARED_UNVERIFIED',
  notice: 'This post-check assessment and next action are contributor statements tied to the protected checker report. They do not indicate support or acceptance.' } as const;

describe('post-check assessment routes', () => {
  const servers: Array<ReturnType<express.Express['listen']>> = [];
  afterEach(async () => Promise.all(servers.splice(0).map(async server => {
    server.close(); await once(server, 'close');
  })));

  async function serve() {
    const createPostCheckAssessment = vi.fn(async () => result);
    const publicPostCheckAssessment = vi.fn(async () => result);
    const service = { authenticateBearer: vi.fn(async () => context), createPostCheckAssessment,
      publicPostCheckAssessment } as unknown as ParticipationService;
    const routers = createParticipationRouters({ service, isActorActive: async () => true });
    const app = express();
    app.use('/api/agent', routers.agentRouter);
    app.use('/api/public/projects/circle-packing', routers.publicRouter);
    const server = app.listen(0); servers.push(server); await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind.');
    return { base: `http://127.0.0.1:${address.port}`, createPostCheckAssessment, publicPostCheckAssessment };
  }

  it('parses the exact POST contract and exposes the public GET', async () => {
    const fixture = await serve();
    const body = { reportDigest: result.reportDigest, assessment: result.assessment, nextAction: result.nextAction };
    const posted = await fetch(`${fixture.base}/api/agent/submissions/${submissionId}/post-check-assessment`, {
      method: 'POST', headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json',
        'Idempotency-Key': 'post-check-key' }, body: JSON.stringify(body),
    });
    expect(posted.status).toBe(201);
    expect(await posted.json()).toEqual(result);
    expect(fixture.createPostCheckAssessment).toHaveBeenCalledWith(context, submissionId, body, 'post-check-key');
    const publicResponse = await fetch(`${fixture.base}/api/public/projects/circle-packing/submissions/${submissionId}/post-check-assessment`);
    expect(publicResponse.status).toBe(200);
    expect(await publicResponse.json()).toEqual(result);
    expect(fixture.publicPostCheckAssessment).toHaveBeenCalledWith(submissionId);
  });

  it('accepts an exact bounded public summary and rejects malformed or multiline summaries before the service write',async()=>{
    const fixture=await serve();const base={reportDigest:result.reportDigest,assessment:result.assessment,nextAction:result.nextAction};
    const publicSummary={question:'Did the checked candidate improve the reference score? 😀',finding:'The checker found no improvement in this candidate.'};
    const accepted=await fetch(`${fixture.base}/api/agent/submissions/${submissionId}/post-check-assessment`,{method:'POST',headers:{Authorization:'Bearer valid-token','Content-Type':'application/json','Idempotency-Key':'summary-key'},body:JSON.stringify({...base,publicSummary})});
    expect(accepted.status).toBe(201);expect(fixture.createPostCheckAssessment).toHaveBeenCalledWith(context,submissionId,{...base,publicSummary},'summary-key');
    fixture.createPostCheckAssessment.mockClear();
    for(const invalid of [{question:'Question only.'},{question:'First line\nsecond line',finding:'Bounded.'},{question:'Q?',finding:'x'.repeat(321)},{question:'Q?',finding:'Fine.',extra:true},{question:'Q?',finding:'lone \ud800 surrogate'}]){
      const response=await fetch(`${fixture.base}/api/agent/submissions/${submissionId}/post-check-assessment`,{method:'POST',headers:{Authorization:'Bearer valid-token','Content-Type':'application/json','Idempotency-Key':'invalid-summary'},body:JSON.stringify({...base,publicSummary:invalid})});expect(response.status).toBe(400);
    }
    expect(fixture.createPostCheckAssessment).not.toHaveBeenCalled();
  });

  it('rejects unknown fields and a missing idempotency key before the service write', async () => {
    const fixture = await serve();
    const body = { reportDigest: result.reportDigest, assessment: result.assessment, nextAction: result.nextAction };
    const unknown = await fetch(`${fixture.base}/api/agent/submissions/${submissionId}/post-check-assessment`, {
      method: 'POST', headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json',
        'Idempotency-Key': 'post-check-key' }, body: JSON.stringify({ ...body, acceptance: 'ACCEPTED' }),
    });
    expect(unknown.status).toBe(400);
    const missingKey = await fetch(`${fixture.base}/api/agent/submissions/${submissionId}/post-check-assessment`, {
      method: 'POST', headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    expect(missingKey.status).toBe(400);
    expect(fixture.createPostCheckAssessment).not.toHaveBeenCalled();
  });

  it('maps an immutable-body conflict to HTTP 409', async () => {
    const fixture = await serve();
    fixture.createPostCheckAssessment.mockRejectedValueOnce(
      new ParticipationError('CONFLICT', 'The submission already has a different immutable post-check assessment.'),
    );
    const response = await fetch(`${fixture.base}/api/agent/submissions/${submissionId}/post-check-assessment`, {
      method: 'POST', headers: { Authorization: 'Bearer valid-token', 'Content-Type': 'application/json',
        'Idempotency-Key': 'post-check-key' }, body: JSON.stringify({ reportDigest: result.reportDigest,
        assessment: result.assessment, nextAction: result.nextAction }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'conflict' });
  });
});
