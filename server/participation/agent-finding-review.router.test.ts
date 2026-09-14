import { once } from 'node:events';
import express from 'express';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { createParticipationRouters } from './router.ts';
import { validateAssignmentIntent,type ParticipationAgentContext,type ParticipationService } from './service.ts';

const reviewSubmissionId='11111111-1111-4111-8111-111111111111';
const targetSubmissionId='22222222-2222-4222-8222-222222222222';
const tokenId='33333333-3333-4333-8333-333333333333';
const projectId='44444444-4444-4444-8444-444444444444';
const context:ParticipationAgentContext={tokenId,actorId:`agent:${tokenId}`,ownerActorId:'account:reviewer',projectId,
  expiresAt:'2099-01-01T00:00:00.000Z'};
const packageDigest=`sha256:${'a'.repeat(64)}`;

describe('agent finding review routes',()=>{
  const servers:Array<ReturnType<express.Express['listen']>>=[];
  afterEach(async()=>Promise.all(servers.splice(0).map(async server=>{server.close();await once(server,'close');})));

  async function serve(){
    const authenticateBearer=vi.fn(async()=>context);
    const previewFromAgent=vi.fn(async()=>({format:'motive.finding-review.preview/0.1',submissionId:targetSubmissionId,
      package:{},packageDigest,latestDecision:null,reviewerAgentTokenId:tokenId,reviewSubmissionId,reviewDecision:null}));
    const decideFromAgent=vi.fn(async()=>({format:'motive.finding-review.decision/0.1',submissionId:targetSubmissionId,
      reviewerAgentTokenId:tokenId,reviewSubmissionId,replayed:false}));
    const routers=createParticipationRouters({service:{authenticateBearer} as unknown as ParticipationService,
      isActorActive:async()=>true,findingAssessment:{previewFromAgent,decideFromAgent} as never});
    const app=express();app.use('/api/agent',routers.agentRouter);
    const server=app.listen(0,'127.0.0.1');servers.push(server);await once(server,'listening');
    const address=server.address();if(!address||typeof address==='string')throw new Error('bind');
    return{base:`http://127.0.0.1:${address.port}`,previewFromAgent,decideFromAgent};
  }

  it('derives authority from bearer context and strictly validates identifiers, body, query, and idempotency',async()=>{
    const fixture=await serve();const root=`${fixture.base}/api/agent/finding-reviews/${reviewSubmissionId}/targets/${targetSubmissionId}`;
    const headers={Authorization:'Bearer fixture-secret'};
    const preview=await fetch(`${root}/preview`,{headers});expect(preview.status).toBe(200);
    expect(preview.headers.get('cache-control')).toBe('no-store');
    expect(fixture.previewFromAgent).toHaveBeenCalledWith(context,reviewSubmissionId,targetSubmissionId);
    const input={packageDigest,expectedDecisionId:null,decision:'DECLINE',outcome:null,finding:null,limitations:null,
      novelty:null,duplicateOfSubmissionId:null,rationale:'The exact replication remains inconclusive.'};
    const saved=await fetch(`${root}/decisions`,{method:'POST',headers:{...headers,'content-type':'application/json',
      'idempotency-key':'agent-finding-1'},body:JSON.stringify(input)});
    expect(saved.status).toBe(201);
    expect(fixture.decideFromAgent).toHaveBeenCalledWith(context,reviewSubmissionId,targetSubmissionId,input,'agent-finding-1');
    expect((await fetch(`${root}/preview?unexpected=1`,{headers})).status).toBe(400);
    expect((await fetch(`${fixture.base}/api/agent/finding-reviews/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA/targets/${targetSubmissionId}/preview`,
      {headers})).status).toBe(400);
    expect((await fetch(`${root}/decisions`,{method:'POST',headers:{...headers,'content-type':'application/json'},
      body:JSON.stringify(input)})).status).toBe(400);
    expect((await fetch(`${root}/decisions`,{method:'POST',headers:{...headers,'content-type':'application/json',
      'idempotency-key':'agent-finding-2'},body:JSON.stringify({...input,reviewerActorId:context.ownerActorId})})).status).toBe(400);
  });

  it('keeps legacy intents valid and binds an optional automatic-review marker to one exact reference',()=>{
    const base={leaseEpoch:1,proposal:'Run one bounded replication.',expectation:'Retain exact evidence.',
      conditions:['Use the declared target.'],motiveReferences:[{submissionId:targetSubmissionId,
        reportDigest:`sha256:${'b'.repeat(64)}`,artifactDigest:`sha256:${'c'.repeat(64)}`}]};
    expect(validateAssignmentIntent(base)).not.toHaveProperty('experimentProtocol');
    const marked={...base,experimentProtocol:{format:'motive.experiment-protocol.v1' as const,
      procedure:'Replicate the pinned finding.',purpose:'REPLICATION' as const,
      inputs:[{name:'review_target_submission_id',value:targetSubmissionId}]}};
    expect(validateAssignmentIntent(marked)).toMatchObject({experimentProtocol:{purpose:'REPLICATION'}});
    expect(validateAssignmentIntent({...marked,motiveReferences:[...base.motiveReferences,{submissionId:reviewSubmissionId,
      reportDigest:`sha256:${'d'.repeat(64)}`,artifactDigest:`sha256:${'e'.repeat(64)}`}]})).toMatchObject({
      motiveReferences:[{submissionId:targetSubmissionId},{submissionId:reviewSubmissionId}]});
    expect(()=>validateAssignmentIntent({...marked,experimentProtocol:{...marked.experimentProtocol,purpose:'EXPLORATORY'}}))
      .toThrow(/review_target_submission_id/);
    expect(()=>validateAssignmentIntent({...marked,motiveReferences:[{...base.motiveReferences[0],
      submissionId:reviewSubmissionId}]})).toThrow(/review_target_submission_id/);
  });
});
