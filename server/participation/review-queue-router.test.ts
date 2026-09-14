import { once } from 'node:events';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResearchReviewQueueService } from '../research-memory/review-queue.ts';
import { createResearchReviewQueueAccountRouter, createResearchReviewQueueAgentRouter } from './review-agent-router.ts';

const actorId='account:queue-reviewer',grantId='11111111-1111-4111-8111-111111111111';
const token=`motive_review_queue_${'a'.repeat(32)}_${'b'.repeat(43)}`;
const grant={id:grantId,projectSlug:'circle-packing' as const,reviewKind:'MEMORY_ADMISSION' as const,status:'ACTIVE' as const,
  maxDecisions:3,decisionsUsed:0,remainingDecisions:3,expiresAt:'2026-09-09T12:00:00.000Z',revokedAt:null,
  firstSeenAt:null,lastSeenAt:null,createdAt:'2026-09-09T11:00:00.000Z',currentAssignment:null};

describe('review queue agent routers',()=>{
  const servers:Array<ReturnType<express.Express['listen']>>=[];
  afterEach(async()=>Promise.all(servers.splice(0).map(async server=>{server.close();await once(server,'close');})));
  async function serve(session=true){
    const context={grantId,tokenDigest:`sha256:${'c'.repeat(64)}`,reviewerActorId:actorId,
      projectId:'22222222-2222-4222-8222-222222222222'};
    const state={format:'motive.review-queue-agent-state/0.1' as const,state:'EMPTY' as const,grant,assignment:null,retryAfterSeconds:30};
    const released={format:'motive.review-queue-release/0.1' as const,claimId:'33333333-3333-4333-8333-333333333333',
      submissionId:'44444444-4444-4444-8444-444444444444',reason:'The evidence needed for review is unavailable.',releasedAt:'2026-09-09T11:05:00.000Z'};
    const listGrants=vi.fn(async()=>({format:'motive.review-queue-grants/0.1' as const,grants:[grant]}));
    const createGrant=vi.fn(async()=>({grant,token})),revokeGrant=vi.fn(async()=>({grant:{...grant,status:'REVOKED' as const}}));
    const authenticate=vi.fn(async()=>context),assignment=vi.fn(async()=>state),claim=vi.fn(async()=>state),release=vi.fn(async()=>released);
    const service={listGrants,createGrant,revokeGrant,authenticate,state:assignment,claim,release} as unknown as ResearchReviewQueueService;
    const app=express();let accountFallthrough=0,agentFallthrough=0;
    app.use('/api/participation',(req,res,next)=>{if(session){res.locals.actorId=actorId;res.locals.accountName='Reviewer';}next();},
      createResearchReviewQueueAccountRouter(service),(_req,res)=>{accountFallthrough+=1;res.status(598).end();});
    app.use('/api/review-queue-agent',createResearchReviewQueueAgentRouter(service),(_req,res)=>{agentFallthrough+=1;res.status(599).end();});
    const server=app.listen(0);servers.push(server);await once(server,'listening');const address=server.address();if(!address||typeof address==='string')throw new Error('bind');
    return{base:`http://127.0.0.1:${address.port}`,context,state,released,listGrants,createGrant,revokeGrant,authenticate,assignment,claim,release,
      falls:()=>({accountFallthrough,agentFallthrough})};
  }
  const auth={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};

  it('creates, lists, and revokes only from the authenticated account identity',async()=>{const f=await serve();const base=`${f.base}/api/participation/review-queue-agent-access`;
    const listed=await fetch(base);expect(listed.status).toBe(200);expect(await listed.json()).toMatchObject({grants:[{id:grantId}]});
    const created=await fetch(base,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'queue-create-1'},body:'{"maxDecisions":3}'});
    expect(created.status).toBe(201);expect(await created.json()).toEqual({grant,token});expect(f.createGrant).toHaveBeenCalledWith(actorId,{maxDecisions:3},'queue-create-1');
    const revoked=await fetch(`${base}/${grantId}/revoke`,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'queue-revoke-1'},body:'{}'});
    expect(revoked.status).toBe(200);expect(await revoked.json()).toMatchObject({grant:{status:'REVOKED'}});
    expect(f.revokeGrant).toHaveBeenCalledWith(actorId,grantId,'queue-revoke-1');
  });

  it('keeps queue credentials bearer-only and binds claim and release idempotency',async()=>{const f=await serve();const base=`${f.base}/api/review-queue-agent`;
    expect((await fetch(`${base}/assignment`)).status).toBe(401);
    const assigned=await fetch(`${base}/assignment`,{headers:auth});expect(assigned.status).toBe(200);expect(await assigned.json()).toEqual(f.state);
    const claimed=await fetch(`${base}/claim`,{method:'POST',headers:{...auth,'Idempotency-Key':'queue-claim-1'},body:'{}'});
    expect(claimed.status).toBe(201);expect(f.claim).toHaveBeenCalledWith(f.context,'queue-claim-1');
    const released=await fetch(`${base}/release`,{method:'POST',headers:{...auth,'Idempotency-Key':'queue-release-1'},
      body:JSON.stringify({reason:f.released.reason})});expect(released.status).toBe(201);expect(await released.json()).toEqual(f.released);
    expect(f.release).toHaveBeenCalledWith(f.context,{reason:f.released.reason},'queue-release-1');
  });

  it('rejects malformed input and lets unrelated account paths reach older routers',async()=>{const f=await serve(false);const account=`${f.base}/api/participation`;
    expect((await fetch(`${account}/review-queue-agent-access`)).status).toBe(401);
    const invalid=await fetch(`${account}/review-queue-agent-access`,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'queue-create-1'},body:'{"maxDecisions":11}'});
    expect(invalid.status).toBe(400);expect(f.createGrant).not.toHaveBeenCalled();
    expect((await fetch(`${account}/some-older-route`)).status).toBe(598);expect(f.falls().accountFallthrough).toBe(1);
    const unknown=await fetch(`${f.base}/api/review-queue-agent/unknown`,{headers:auth});expect(unknown.status).toBe(404);
    expect(f.falls().agentFallthrough).toBe(0);
  });
});
