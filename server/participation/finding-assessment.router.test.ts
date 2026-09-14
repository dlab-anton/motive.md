import { once } from 'node:events';
import express from 'express';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { createParticipationRouters } from './router.ts';
import type { ParticipationService } from './service.ts';

const submissionId='11111111-1111-4111-8111-111111111111';
const decisionId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const contributorId='44444444-4444-4444-8444-444444444444';
const actorId='account:reviewer';const packageDigest=`sha256:${'a'.repeat(64)}`;

describe('finding assessment routes',()=>{
  const servers:Array<ReturnType<express.Express['listen']>>=[];
  afterEach(async()=>Promise.all(servers.splice(0).map(async server=>{server.close();await once(server,'close');})));

  async function serve(session=true){
    const eligibility=vi.fn(async()=>({format:'motive.finding-review.eligibility/0.1' as const,submissionId,canReview:true,reason:'ELIGIBLE' as const}));
    const preview=vi.fn(async()=>({format:'motive.finding-review.preview/0.1' as const,submissionId,package:{} as never,packageDigest,latestDecision:null}));
    const decide=vi.fn(async()=>({format:'motive.finding-review.decision/0.1' as const,submissionId,replayed:false} as never));
    const publicReview=vi.fn(async()=>({format:'motive.finding-review.public/0.1' as const,submissionId,available:true,reason:null,latestDecision:null}));
    const publicHistory=vi.fn(async()=>({format:'motive.finding-review.history/0.1' as const,submissionId,
      latestDecisionId:null,items:[],nextCursor:null}));
    const publicContributorAcceptedFindings=vi.fn(async()=>({format:'motive.contributor-journal/0.1' as const,projectSlug:'circle-packing' as const,
      contributorId,items:[],nextCursor:null}));
    const app=express();app.use(express.json());if(session)app.use((_req,res,next)=>{res.locals.actorId=actorId;res.locals.accountName='Reviewer';next();});
    const routers=createParticipationRouters({service:{publicContributorAcceptedFindings} as unknown as ParticipationService,isActorActive:async()=>true,
      findingAssessment:{eligibility,preview,decide,publicReview,publicHistory} as never});
    app.use('/api/participation',routers.accountRouter);app.use('/api/public/projects/circle-packing',routers.publicRouter);
    const server=app.listen(0);servers.push(server);await once(server,'listening');const address=server.address();
    if(!address||typeof address==='string')throw new Error('bind');return{base:`http://127.0.0.1:${address.port}`,eligibility,preview,decide,
      publicReview,publicHistory,publicContributorAcceptedFindings};
  }

  it('derives the reviewer, strictly validates the body and exposes only the public projection',async()=>{
    const fixture=await serve();const root=`${fixture.base}/api/participation/submissions/${submissionId}/finding-review`;
    const eligibility=await fetch(`${root}/eligibility`);expect(eligibility.status).toBe(200);expect(eligibility.headers.get('cache-control')).toBe('no-store');
    const preview=await fetch(`${root}/preview`);expect(preview.status).toBe(200);
    const input={packageDigest,expectedDecisionId:null,decision:'ACCEPT',outcome:'SUPPORTED',finding:'A bounded finding.',
      limitations:'One frozen experiment only.',novelty:'DISTINCT',duplicateOfSubmissionId:null,rationale:'The completed evidence supports this scoped assessment.'};
    const saved=await fetch(`${root}/reviews`,{method:'POST',headers:{'content-type':'application/json','idempotency-key':'finding-review-1'},body:JSON.stringify(input)});
    expect(saved.status).toBe(201);expect(fixture.decide).toHaveBeenCalledWith(actorId,submissionId,input,'finding-review-1');
    for(const invalid of [{...input,reviewerActorId:actorId},{...input,packageDigest:'bad'},{...input,decision:'DECLINE'}]){
      expect((await fetch(`${root}/reviews`,{method:'POST',headers:{'content-type':'application/json','idempotency-key':'finding-review-2'},body:JSON.stringify(invalid)})).status).toBe(400);
    }
    expect((await fetch(`${root}/preview?scopeId=x`)).status).toBe(400);
    const publicResult=await fetch(`${fixture.base}/api/public/projects/circle-packing/submissions/${submissionId}/finding-review`);
    expect(await publicResult.json()).toEqual({format:'motive.finding-review.public/0.1',submissionId,available:true,reason:null,latestDecision:null});
    expect(fixture.eligibility).toHaveBeenCalledWith(actorId,submissionId);expect(fixture.preview).toHaveBeenCalledWith(actorId,submissionId);
    expect(fixture.publicReview).toHaveBeenCalledWith('circle-packing',submissionId);
    const history=await fetch(`${fixture.base}/api/public/projects/circle-packing/submissions/${submissionId}/finding-review/history?before=${decisionId}`);
    expect(history.status).toBe(200);expect(history.headers.get('cache-control')).toBe('no-store');
    expect(await history.json()).toEqual({format:'motive.finding-review.history/0.1',submissionId,latestDecisionId:null,items:[],nextCursor:null});
    expect(fixture.publicHistory).toHaveBeenCalledWith('circle-packing',submissionId,decisionId);
    for(const query of ['?unknown=1',`?before=${decisionId}&before=${decisionId}`,`?before=${decisionId.toUpperCase()}`,
      '?before=not-a-uuid','?before='])
      expect((await fetch(`${fixture.base}/api/public/projects/circle-packing/submissions/${submissionId}/finding-review/history${query}`)).status).toBe(400);
    const accepted=await fetch(`${fixture.base}/api/public/projects/circle-packing/contributors/${contributorId}/accepted-findings`);
    expect(accepted.status).toBe(200);expect(await accepted.json()).toMatchObject({contributorId,items:[],nextCursor:null});
    expect(fixture.publicContributorAcceptedFindings).toHaveBeenCalledWith(contributorId,undefined);
  });

  it('requires an authenticated account and reports unavailable composition',async()=>{
    const anonymous=await serve(false);expect((await fetch(`${anonymous.base}/api/participation/submissions/${submissionId}/finding-review/preview`)).status).toBe(401);
    const app=express();app.use(express.json());app.use((_req,res,next)=>{res.locals.actorId=actorId;res.locals.accountName='Reviewer';next();});
    const routers=createParticipationRouters({service:{} as ParticipationService,isActorActive:async()=>true});
    app.use('/api/participation',routers.accountRouter);app.use('/api/public/projects/circle-packing',routers.publicRouter);
    const server=app.listen(0);servers.push(server);await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw new Error('bind');
    const base=`http://127.0.0.1:${address.port}`;
    expect((await fetch(`${base}/api/participation/submissions/${submissionId}/finding-review/eligibility`)).status).toBe(503);
    expect((await fetch(`${base}/api/public/projects/circle-packing/submissions/${submissionId}/finding-review`)).status).toBe(503);
    expect((await fetch(`${base}/api/public/projects/circle-packing/submissions/${submissionId}/finding-review/history`)).status).toBe(503);
  });
});
