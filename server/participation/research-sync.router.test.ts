import {once} from 'node:events';import express from 'express';import {afterEach,describe,expect,it,vi} from 'vitest';
import type {ParticipationService} from './service.ts';import {createParticipationRouters} from './router.ts';
import {DeliveryIntentError} from '../research-memory/delivery-intents.ts';
const submissionId='11111111-1111-4111-8111-111111111111',policyId='22222222-2222-4222-8222-222222222222';
const reportDigest=`sha256:${'a'.repeat(64)}`;const context={tokenId:'33333333-3333-4333-8333-333333333333',actorId:'agent:33333333-3333-4333-8333-333333333333',
  ownerActorId:'account:owner',projectId:'44444444-4444-4444-8444-444444444444',expiresAt:'2026-10-01T00:00:00.000Z'};
describe('agent research sync routes',()=>{const servers:Array<ReturnType<express.Express['listen']>>=[];afterEach(async()=>Promise.all(servers.splice(0).map(async s=>{s.close();await once(s,'close');})));
  async function serve(){const syncFromAgent=vi.fn(async()=>({format:'motive.hypothesis-submission-delivery/0.1',status:'DRAFT_RECORDED'}));
    const syncRecoveredFinding=vi.fn(async()=>null);
    const capability=vi.fn(async()=>({format:'motive.agent-research-sync-capability/0.1',status:'AVAILABLE',policyId}));
    const service={authenticateBearer:vi.fn(async()=>context),getAgentAssignment:vi.fn(async()=>({}))} as unknown as ParticipationService;
    const {agentRouter}=createParticipationRouters({service,isActorActive:async()=>true,
      researchDeliveryPolicy:{syncFromAgent,capability} as never,researchAdmission:{syncRecoveredFinding} as never});
    const app=express();app.use('/api/agent',agentRouter);const server=app.listen(0);servers.push(server);await once(server,'listening');const a=server.address();if(!a||typeof a==='string')throw new Error('bind');
    return{base:`http://127.0.0.1:${a.port}`,syncFromAgent,syncRecoveredFinding,capability};}
  it('projects capability and passes only exact policy/report input with the durable key',async()=>{const f=await serve();const headers={Authorization:'Bearer token','Content-Type':'application/json','Idempotency-Key':'research-sync-1'};
    const cap=await fetch(`${f.base}/api/agent/research-sync-capability`,{headers:{Authorization:'Bearer token'}});expect(cap.status).toBe(200);expect((await cap.json()).status).toBe('AVAILABLE');
    const response=await fetch(`${f.base}/api/agent/submissions/${submissionId}/research-sync`,{method:'POST',headers,body:JSON.stringify({policyId,reportDigest})});
    expect(response.status).toBe(200);expect(f.syncRecoveredFinding).toHaveBeenCalledWith(context,submissionId,policyId,reportDigest);
    expect(f.syncFromAgent).toHaveBeenCalledWith(context,submissionId,{policyId,reportDigest},'research-sync-1');});
  it('returns an exact recovered finding sync before the ordinary source flow',async()=>{const f=await serve();
    const recovered={format:'motive.hypothesis-submission-delivery/0.1',status:'EVIDENCE_RECORDED',deliveryId:'legacy'};
    f.syncRecoveredFinding.mockResolvedValueOnce(recovered as never);
    const response=await fetch(`${f.base}/api/agent/submissions/${submissionId}/research-sync`,{method:'POST',headers:{Authorization:'Bearer token','Content-Type':'application/json','Idempotency-Key':'research-sync-1'},body:JSON.stringify({policyId,reportDigest})});
    expect(response.status).toBe(200);expect(await response.json()).toEqual(recovered);
    expect(f.syncRecoveredFinding).toHaveBeenCalledWith(context,submissionId,policyId,reportDigest);
    expect(f.syncFromAgent).not.toHaveBeenCalled();});
  it('rejects extra fields, malformed digests, and missing keys before sync',async()=>{const f=await serve();const request=(body:unknown,key=true)=>fetch(`${f.base}/api/agent/submissions/${submissionId}/research-sync`,{method:'POST',headers:{Authorization:'Bearer token','Content-Type':'application/json',...(key?{'Idempotency-Key':'research-sync-1'}:{})},body:JSON.stringify(body)});
    expect((await request({policyId,reportDigest,conclusion:'accepted'})).status).toBe(400);expect((await request({policyId,reportDigest:'bad'})).status).toBe(400);
    expect((await request({policyId,reportDigest},false)).status).toBe(400);expect(f.syncFromAgent).not.toHaveBeenCalled();});
  it('preserves delivery-intent authority and immutable-key statuses',async()=>{const f=await serve();const request=()=>fetch(`${f.base}/api/agent/submissions/${submissionId}/research-sync`,{method:'POST',headers:{Authorization:'Bearer token','Content-Type':'application/json','Idempotency-Key':'research-sync-1'},body:JSON.stringify({policyId,reportDigest})});
    f.syncFromAgent.mockRejectedValueOnce(new DeliveryIntentError('FORBIDDEN','Current research delivery policy authority is unavailable.',403));
    const forbidden=await request();expect(forbidden.status).toBe(403);expect(await forbidden.json()).toEqual({error:'forbidden',message:'Current research delivery policy authority is unavailable.'});
    f.syncFromAgent.mockRejectedValueOnce(new DeliveryIntentError('CONFLICT','Idempotency-Key is already bound to another preparation request.',409));
    const conflict=await request();expect(conflict.status).toBe(409);expect(await conflict.json()).toEqual({error:'conflict',message:'Idempotency-Key is already bound to another preparation request.'});
  });
});
