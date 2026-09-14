import { once } from 'node:events';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SubmissionAdmissionError } from '../research-memory/submission-admission.ts';
import { createParticipationRouters } from './router.ts';
import type { ParticipationService } from './service.ts';

const submissionId='11111111-1111-4111-8111-111111111111';
const actorId='account:admission-reviewer';
const packageDigest=`sha256:${'a'.repeat(64)}`;
const decisionId='22222222-2222-4222-8222-222222222222';
const rationale='This independent review admits the checked observation as neutral research context.';

describe('submission research admission routes',()=>{
  const servers:Array<ReturnType<express.Express['listen']>>=[];
  afterEach(async()=>Promise.all(servers.splice(0).map(async server=>{server.close();await once(server,'close');})));

  async function serve(options:{session?:boolean;admission?:boolean}={}){
    const eligibility=vi.fn(async()=>({canReview:true,reason:'ELIGIBLE' as const}));
    const preview={format:'motive.research-delivery-admission-preview/0.1',package:{proposal:'A bounded test.'},
      packageDigest,latestDecision:null};
    const prepareAdmissionPreview=vi.fn(async()=>preview);
    const decision={format:'motive.research-delivery-admission/0.1',id:decisionId,deliveryId:'33333333-3333-4333-8333-333333333333',
      packageDigest,previousDecisionId:null,decision:'ADMIT' as const,rationale,reviewerActorId:actorId,createdAt:'2026-09-08T00:00:00.000Z'};
    const decideAdmission=vi.fn(async()=>decision);
    const publicAdmission=vi.fn(async()=>({format:'motive.research-delivery-admission-public/0.1',
      submissionId,status:'ADMITTED' as const,latestReview:{decision:'ADMIT' as const,rationale,reviewedAt:decision.createdAt},
      privatePackage:{must:'not leak'},reviewerActorId:actorId}));
    const researchAdmission=options.admission===false?undefined:{
      admissionEligibility:eligibility,prepareAdmissionPreview,decideAdmission,publicAdmission};
    const service={} as ParticipationService;
    const routers=createParticipationRouters({service,isActorActive:async()=>true,
      ...(researchAdmission?{researchAdmission:researchAdmission as never}:{})});
    const app=express();app.use(express.json());
    if(options.session!==false)app.use((_req,res,next)=>{res.locals.actorId=actorId;res.locals.accountName='Reviewer';next();});
    app.use('/api/participation',routers.accountRouter);
    app.use('/api/public/projects/circle-packing',routers.publicRouter);
    const server=app.listen(0);servers.push(server);await once(server,'listening');
    const address=server.address();if(!address||typeof address==='string')throw new Error('bind');
    return{base:`http://127.0.0.1:${address.port}`,eligibility,prepareAdmissionPreview,decideAdmission,publicAdmission};
  }

  it('routes eligibility, local preparation, an idempotent decision, and the safe public projection',async()=>{
    const fixture=await serve();
    const eligibility=await fetch(`${fixture.base}/api/participation/submissions/${submissionId}/research-admission/eligibility`);
    expect(eligibility.status).toBe(200);expect(await eligibility.json()).toEqual({canReview:true,reason:'ELIGIBLE'});
    expect(fixture.eligibility).toHaveBeenCalledWith(actorId,submissionId);

    const prepared=await fetch(`${fixture.base}/api/participation/submissions/${submissionId}/research-admission/prepare`,{
      method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    expect(prepared.status).toBe(200);expect((await prepared.json()).packageDigest).toBe(packageDigest);
    expect(fixture.prepareAdmissionPreview).toHaveBeenCalledWith(actorId,submissionId);

    const input={packageDigest,expectedDecisionId:null,decision:'ADMIT',rationale};
    const reviewed=await fetch(`${fixture.base}/api/participation/submissions/${submissionId}/research-admission/reviews`,{
      method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'admission-review-1'},body:JSON.stringify(input)});
    expect(reviewed.status).toBe(201);expect((await reviewed.json()).id).toBe(decisionId);
    expect(fixture.decideAdmission).toHaveBeenCalledWith(actorId,submissionId,input,'admission-review-1');

    const publicResult=await fetch(`${fixture.base}/api/public/projects/circle-packing/submissions/${submissionId}/research-admission`);
    expect(publicResult.status).toBe(200);
    const publicBody=await publicResult.json();
    expect(publicBody).toEqual({format:'motive.research-delivery-admission-public/0.1',submissionId,status:'ADMITTED',
      latestReview:{decision:'ADMIT',rationale,reviewedAt:'2026-09-08T00:00:00.000Z'}});
    expect(JSON.stringify(publicBody)).not.toContain('privatePackage');
    expect(JSON.stringify(publicBody)).not.toContain(actorId);
  });

  it('rejects missing account authority and preserves an own-submission denial',async()=>{
    const unauthenticated=await serve({session:false});
    const denied=await fetch(`${unauthenticated.base}/api/participation/submissions/${submissionId}/research-admission/prepare`,{
      method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    expect(denied.status).toBe(401);expect(unauthenticated.prepareAdmissionPreview).not.toHaveBeenCalled();

    const own=await serve();
    own.prepareAdmissionPreview.mockRejectedValueOnce(new SubmissionAdmissionError('FORBIDDEN',
      'The original contributor cannot independently review this submission.',403));
    const response=await fetch(`${own.base}/api/participation/submissions/${submissionId}/research-admission/prepare`,{
      method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    expect(response.status).toBe(403);expect(await response.json()).toMatchObject({error:'forbidden'});
  });

  it('rejects spoofed fields and malformed review bindings before the service',async()=>{
    const fixture=await serve();const base=`${fixture.base}/api/participation/submissions/${submissionId}/research-admission`;
    const prepare=await fetch(`${base}/prepare`,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({scopeId:'caller-controlled'})});
    expect(prepare.status).toBe(400);
    const querySpoof=await fetch(`${base}/prepare?contractDigest=${encodeURIComponent(packageDigest)}`,{
      method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    expect(querySpoof.status).toBe(400);
    const request=(body:unknown,key=true)=>fetch(`${base}/reviews`,{method:'POST',
      headers:{'Content-Type':'application/json',...(key?{'Idempotency-Key':'admission-review-1'}:{})},body:JSON.stringify(body)});
    const valid={packageDigest,expectedDecisionId:null,decision:'ADMIT',rationale};
    expect((await request({...valid,approvedApiBaseUrl:'https://caller.invalid'})).status).toBe(400);
    expect((await request({...valid,packageDigest:'bad'})).status).toBe(400);
    expect((await request({...valid,expectedDecisionId:'NOT-A-UUID'})).status).toBe(400);
    expect((await request(valid,false)).status).toBe(400);
    expect(fixture.prepareAdmissionPreview).not.toHaveBeenCalled();
    expect(fixture.decideAdmission).not.toHaveBeenCalled();
  });

  it('returns an explicit unavailable response when admission is not composed',async()=>{
    const fixture=await serve({admission:false});
    const accountBase=`${fixture.base}/api/participation/submissions/${submissionId}/research-admission`;
    const eligibility=await fetch(`${accountBase}/eligibility`);
    const prepared=await fetch(`${accountBase}/prepare`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    const reviewed=await fetch(`${accountBase}/reviews`,{method:'POST',headers:{'Content-Type':'application/json',
      'Idempotency-Key':'admission-review-1'},body:JSON.stringify({packageDigest,expectedDecisionId:null,decision:'DECLINE',rationale})});
    const publicResult=await fetch(`${fixture.base}/api/public/projects/circle-packing/submissions/${submissionId}/research-admission`);
    expect([eligibility.status,prepared.status,reviewed.status,publicResult.status]).toEqual([503,503,503,503]);
  });
});
