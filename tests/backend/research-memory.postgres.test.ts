import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { Pool } from 'pg';
import { afterAll,beforeAll,describe,expect,it } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { digestCanonicalJson } from '../../packages/domain/src/contracts.ts';
import { applyPostgresMigrations,getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { createResearchMemoryService,ResearchMemoryError,type ResearchMemoryService } from '../../server/research-memory/index.ts';
import { createParticipationRouters } from '../../server/participation/router.ts';
import type { ParticipationService } from '../../server/participation/service.ts';

const baseUrl=process.env.MOTIVE_TEST_DATABASE_URL; const pgDescribe=baseUrl?describe:describe.skip;
pgDescribe('project research memory on isolated PostgreSQL',()=>{
  const databaseName=`motive_research_${randomUUID().replaceAll('-','')}`; let admin:Pool;let pool:Pool;let service:ResearchMemoryService;
  const actor=`account:${randomUUID()}`; const tenantId=randomUUID(); const channelId=randomUUID(); const activeId=randomUUID(); const archivedId=randomUUID();
  const activeEvidenceId=randomUUID(); const archivedEvidenceId=randomUUID(); const insightId=randomUUID();
  const apiKey=`he_${'a'.repeat(43)}`; const date='2026-09-07T10:00:00.000Z';
  let fetchCalls=0;
  const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
  const fetcher:typeof fetch=async(input,init)=>{
    fetchCalls+=1;
    const url=new URL(String(input)); const key=new Headers(init?.headers).get('X-API-Key');
    if(url.pathname.endsWith('/health'))return json({status:'ok',version:'1.8.0',database:'ok'});
    if(key!==apiKey&&key!==`he_${'b'.repeat(43)}`)return json({detail:'bad key'},401);
    if(url.pathname.endsWith('/keys'))return json([{id:randomUUID(),prefix:key!.slice(0,10),tenant_id:tenantId,is_active:true,created_at:date}]);
    if(url.pathname.endsWith('/channels/circle-packing'))return json({id:channelId,name:'circle-packing',goal:'Improve the frozen N=101 reference.',created_by:'operator',updated_by:null,metadata:null,created_at:date,updated_at:date});
    if(url.pathname.endsWith('/hypotheses')){
      const archived=url.searchParams.get('is_archived')==='true'; const id=archived?archivedId:activeId;
      if(!archived&&url.searchParams.get('offset')==='6')return json({items:[],total:7,offset:6,limit:6});
      return json({items:[{id,statement:archived?'A completed prior test.':'A bounded perturbation improves the exact sum.',context:'One local search step.',falsification_criteria:'The exact score does not increase.',status:archived?'archived':'testing',confidence:0.4,initial_confidence:0.5,tags:[],created_by:'portable-agent',parent_id:null,is_archived:archived,evidence_counts:{supporting:0,contradicting:1,neutral:0},deadline:null,metadata:{tenant_id:'must-not-leak'},null_hypothesis:null,experimental_design:null,significance_level:null,outcome:archived?{result:'no improvement',narrative:'The exact checker rejected the proposal.',secret:'omit-me'}:null,channel:'circle-packing',created_at:date,updated_at:date}],total:1,offset:0,limit:6});
    }
    if(url.pathname.endsWith(`/hypotheses/${activeId}/evidence`))return json({items:[{id:activeEvidenceId,hypothesis_id:activeId,content:'Exact score was unchanged.',source:'motive:submission',evidence_type:'neutral',strength:0.8,confidence_after:0.4,created_by:'portable-agent',created_at:date}],total:1,offset:0,limit:20});
    if(url.pathname.endsWith(`/hypotheses/${archivedId}/evidence`))return json({items:[{id:archivedEvidenceId,hypothesis_id:archivedId,content:'Candidate was rejected.',source:'motive:submission',evidence_type:'contradicting',strength:1,confidence_after:0.1,created_by:'portable-agent',created_at:date}],total:1,offset:0,limit:20});
    if(url.pathname.endsWith('/insights'))return json({items:[{id:insightId,channel:'circle-packing',insight_type:'pattern',content:'Tiny overlaps must remain exact failures.',created_by:'portable-agent',updated_by:null,metadata:{tenant_id:'omit'},created_at:date,updated_at:date}],total:1,offset:0,limit:20});
    return json({detail:'not found'},404);
  };
  beforeAll(async()=>{const source=new URL(baseUrl!);const adminUrl=new URL(source);adminUrl.pathname='/postgres';admin=new Pool({connectionString:adminUrl.toString(),max:1});
    await admin.query(`CREATE DATABASE ${databaseName}`);const testUrl=new URL(source);testUrl.pathname=`/${databaseName}`;pool=new Pool({connectionString:testUrl.toString(),max:8});
    await applyPostgresMigrations(pool);expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    await new LedgerKernel(pool).createProject({actorId:actor,idempotencyKey:randomUUID(),slug:'circle-packing',visibility:'PUBLIC',revisionContent:{title:'Research test'}});
    service=createResearchMemoryService({pool,vaultKey:Buffer.alloc(32,7),fetch:fetcher,now:()=>new Date(date)});
  },30000);
  afterAll(async()=>{await pool?.end();if(admin){await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',[databaseName]);await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);await admin.end();}});

  it('verifies and encrypts an operator-owned scope with exact replay and redacted public projection',async()=>{
    const input={apiBaseUrl:'http://127.0.0.1:8000/api/v1',tenantId,channelId,channelName:'circle-packing',apiKey};
    const linked=await service.linkScope(actor,'circle-packing',input); const replay=await service.linkScope(actor,'circle-packing',input);
    expect(replay.scopeId).toBe(linked.scopeId);expect(await service.getPublicScope('circle-packing')).toEqual(linked);
    const stored=await pool.query('SELECT encrypted_api_key,tenant_id,channel_snapshot_digest,status FROM motive.project_research_scopes WHERE id=$1',[linked.scopeId]);
    expect(stored.rows[0].encrypted_api_key.toString('utf8')).not.toContain(apiKey);expect(stored.rows[0].tenant_id).toBe(tenantId);
    expect(JSON.stringify(linked)).not.toContain(tenantId);expect(stored.rows[0].status).toBe('CONNECTED');
  });

  it('retains bounded active and archived context, validates references, and supports explicit scope replacement',async()=>{
    const context=await service.getContext('circle-packing');
    expect(context).toMatchObject({channelName:'circle-packing',hypothesesTotal:2,hypothesesTruncated:false,activeHypothesesTotal:1,archivedHypothesesTotal:1,insightsTotal:1});
    expect(context.hypotheses.map(item=>item.id)).toEqual([activeId,archivedId]);
    expect(JSON.stringify(context)).not.toContain('must-not-leak');expect(JSON.stringify(context)).not.toContain('omit-me');
    const secondPage=await service.getContext('circle-packing',{activeOffset:6});
    expect(secondPage).toMatchObject({page:{activeOffset:6,archivedOffset:0,insightOffset:0},activeHypothesesTotal:7,hypothesesTruncated:true});
    expect(secondPage.hypotheses.map(item=>item.id)).toEqual([archivedId]);
    const project=await pool.query("SELECT id FROM motive.projects WHERE slug='circle-packing'");const projectId=project.rows[0].id as string;
    expect((await service.getSnapshot(projectId,context.snapshotId)).snapshotDigest).toBe(context.snapshotDigest);
    const emptyPayload={format:'motive.research-context.v1',scopeId:context.scopeId,projectSlug:'circle-packing',
      channelName:'circle-packing',channelGoal:'Improve the frozen N=101 reference.',hypotheses:[],hypothesesTotal:0,
      hypothesesTruncated:false,activeHypothesesTotal:0,archivedHypothesesTotal:0,insights:[],insightsTotal:0,
      insightsTruncated:false,page:{activeOffset:0,archivedOffset:0,insightOffset:0,activeLimit:6,archivedLimit:6,insightLimit:20}};
    const emptyContext={scopeId:context.scopeId,snapshotId:randomUUID(),snapshotDigest:digestCanonicalJson(emptyPayload)};
    await pool.query(`INSERT INTO motive.research_context_snapshots(id,scope_id,project_id,snapshot_digest,payload,api_version,retrieved_at)
      VALUES($1,$2,$3,$4,$5::jsonb,'1.8.0',$6)`,[emptyContext.snapshotId,emptyContext.scopeId,projectId,emptyContext.snapshotDigest,JSON.stringify(emptyPayload),date]);
    const upstreamCalls=fetchCalls;
    await service.assertContext(projectId,emptyContext);
    expect(fetchCalls).toBe(upstreamCalls);
    await expect(service.assertContext(projectId,{...emptyContext,snapshotDigest:`sha256:${'0'.repeat(64)}`})).rejects.toBeInstanceOf(ResearchMemoryError);
    await expect(service.assertContext(projectId,{...emptyContext,scopeId:randomUUID()})).rejects.toBeInstanceOf(ResearchMemoryError);
    const foreign=await new LedgerKernel(pool).createProject({actorId:actor,idempotencyKey:randomUUID(),slug:`foreign-${randomUUID()}`,
      visibility:'PRIVATE',revisionContent:{title:'Foreign research test'}});
    await expect(service.assertContext(foreign.id,emptyContext)).rejects.toBeInstanceOf(ResearchMemoryError);
    await expect(service.assertContext(projectId,{...emptyContext,scopeId:emptyContext.scopeId.toUpperCase()})).rejects.toBeInstanceOf(ResearchMemoryError);
    await expect(service.assertContext(projectId,{...emptyContext,extra:true} as typeof emptyContext)).rejects.toBeInstanceOf(ResearchMemoryError);
    expect(fetchCalls).toBe(upstreamCalls);
    await service.assertReferences(projectId,[{scopeId:context.scopeId,snapshotId:context.snapshotId,hypothesisId:activeId,evidenceIds:[activeEvidenceId],observedUpdatedAt:date,snapshotDigest:context.snapshotDigest}]);
    await expect(service.assertReferences(projectId,[{scopeId:context.scopeId,snapshotId:context.snapshotId,hypothesisId:activeId,evidenceIds:[archivedEvidenceId],observedUpdatedAt:date,snapshotDigest:context.snapshotDigest}])).rejects.toBeInstanceOf(ResearchMemoryError);
    const replacement=await service.linkScope(actor,'circle-packing',{apiBaseUrl:'http://127.0.0.1:8000/api/v1',tenantId,channelId,channelName:'circle-packing',apiKey:`he_${'b'.repeat(43)}`,replace:true});
    expect(replacement.scopeId).not.toBe(context.scopeId);
    const states=await pool.query('SELECT id,status,replaced_by FROM motive.project_research_scopes ORDER BY created_at');
    expect(states.rows).toEqual([expect.objectContaining({id:context.scopeId,status:'REPLACED',replaced_by:replacement.scopeId}),expect.objectContaining({id:replacement.scopeId,status:'CONNECTED'})]);
  });
});

describe('research-context route pagination',()=>{
  it('keeps strict pagination behind bearer and live-account checks',async()=>{
    const calls:unknown[]=[]; const context={tokenId:randomUUID(),actorId:`agent:${randomUUID()}`,ownerActorId:`account:${randomUUID()}`,projectId:randomUUID(),expiresAt:new Date(Date.now()+60000).toISOString()};
    const participation={authenticateBearer:async()=>context,getAgentAssignment:async()=>({})} as unknown as ParticipationService;
    const research={getContext:async(_slug:string,page:unknown)=>{calls.push(page);return {page};}} as unknown as ResearchMemoryService;
    const {agentRouter}=createParticipationRouters({service:participation,researchMemory:research,isActorActive:async()=>true});
    const app=express();app.use('/api/agent',agentRouter);const server=app.listen(0);await once(server,'listening');
    try{const address=server.address();if(!address||typeof address==='string')throw new Error('Test server did not bind.');const origin=`http://127.0.0.1:${address.port}`;
      const headers={Authorization:'Bearer test-token'};
      const accepted=await fetch(`${origin}/api/agent/research-context?activeOffset=6&archivedOffset=0&insightOffset=100000`,{headers});
      expect(accepted.status).toBe(200);expect(calls).toEqual([{activeOffset:6,archivedOffset:0,insightOffset:100000}]);
      for(const query of ['other=1','activeOffset=01','activeOffset=-1','activeOffset=1.0','activeOffset=100001','activeOffset=1&activeOffset=2']){
        const response=await fetch(`${origin}/api/agent/research-context?${query}`,{headers});expect(response.status,query).toBe(400);
      }
      expect(calls).toHaveLength(1);
    }finally{server.close();await once(server,'close');}
  });
});
