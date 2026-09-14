import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import express from 'express';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { applyPostgresMigrations, getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { createParticipationRouters, createParticipationService, type ParticipationService } from '../../server/participation/index.ts';
import type { DeclareAssignmentIntentInput, PublicResearchHandoffPage } from '../../src/lib/participation.ts';

const baseUrl=process.env.MOTIVE_TEST_DATABASE_URL;
const pgDescribe=baseUrl?describe:describe.skip;
const tokenSecret='research-handoff-test-secret-longer-than-thirty-two-bytes';

pgDescribe('research stop handoffs on isolated PostgreSQL',()=>{
  const databaseName=`motive_research_handoff_${randomUUID().replaceAll('-','')}`;
  const issuer=`operator:research-handoff-${randomUUID()}`;
  let admin:Pool;let pool:Pool;let service:ParticipationService;let assignmentId:string;
  let server:Server;let origin:string;

  beforeAll(async()=>{
    const source=new URL(baseUrl!);expect(['localhost','127.0.0.1']).toContain(source.hostname);
    const adminUrl=new URL(source);adminUrl.pathname='/postgres';
    admin=new Pool({connectionString:adminUrl.toString(),max:1});await admin.query(`CREATE DATABASE ${databaseName}`);
    const isolated=new URL(source);isolated.pathname=`/${databaseName}`;
    pool=new Pool({connectionString:isolated.toString(),max:5});await applyPostgresMigrations(pool);
    expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    await new LedgerKernel(pool).createProject({actorId:issuer,idempotencyKey:randomUUID(),slug:'circle-packing',
      visibility:'PUBLIC',revisionContent:{title:'Research handoff test'}});
    service=createParticipationService(pool,{tokenSecret,issuerActorId:issuer,isActorActive:()=>true});
    assignmentId=(await service.ensureCircleWorkOrder()).id;
    const routers=createParticipationRouters({service,isActorActive:()=>true});
    const app=express();app.use(express.json());
    app.use('/api/participation',(req,res,next)=>{const actor=req.get('x-test-account');
      if(actor){res.locals.actorId=actor;res.locals.accountName='Test account';}next();},routers.accountRouter);
    app.use('/api/agent',routers.agentRouter);
    app.use('/api/public/projects/circle-packing',routers.publicRouter);
    server=app.listen(0,'127.0.0.1');await once(server,'listening');
    const address=server.address();if(!address||typeof address==='string')throw new Error('Test server did not bind.');
    origin=`http://127.0.0.1:${address.port}`;
  },30_000);

  afterAll(async()=>{
    if(server){server.close();await once(server,'close');}
    await pool?.end();
    if(admin){await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',[databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);await admin.end();}
  });

  async function participant(name:string,publish=true,owner=`account:${randomUUID()}`){
    await pool.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at)
      VALUES($1,'supabase',$2,'ACTIVE',clock_timestamp())`,[owner,randomUUID()]);
    const joined=await service.join(owner,name,{projectSlug:'circle-packing',publishDisplayName:publish,
      acceptReferenceTerms:true},`join-${randomUUID()}`);
    const context=await service.authenticateBearer(joined.token);
    const claim=await service.claimAssignment(context,assignmentId,`claim-${randomUUID()}`);
    return{owner,joined,context,claim};
  }

  function intent(leaseEpoch:number,label:string):DeclareAssignmentIntentInput{return{leaseEpoch,
    proposal:`Test the bounded ${label} question.`,expectation:`The ${label} condition may improve the exact score.`,
    conditions:['Use the frozen reference and the protected checker.']};}

  async function agentRelease(token:string,body:unknown,key:string){return fetch(`${origin}/api/agent/assignments/${assignmentId}/release`,{
    method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':key},
    body:JSON.stringify(body)});}

  async function json<T>(response:Response):Promise<T>{return response.json() as Promise<T>;}

  it('atomically releases, replays and publishes one bounded unfinished experiment without creating evidence',async()=>{
    const fixture=await participant('Visible researcher');const declared=intent(fixture.claim.leaseEpoch!,'initialization');
    await service.declareAssignmentIntent(fixture.context,assignmentId,declared,`intent-${randomUUID()}`);
    expect((await fetch(`${origin}/api/agent/assignments/${assignmentId}/release`,{method:'POST',
      headers:{'Content-Type':'application/json','Idempotency-Key':`unauthorized-${randomUUID()}`},
      body:JSON.stringify({leaseEpoch:fixture.claim.leaseEpoch,stopReason:'Must not be recorded.'})})).status).toBe(401);
    expect((await fetch(`${origin}/api/participation/research-handoffs`)).status).toBe(401);
    const before=await pool.query(`SELECT
      (SELECT count(*)::integer FROM motive.submissions) submissions,
      (SELECT count(*)::integer FROM motive.finding_review_decisions) findings,
      (SELECT count(*)::integer FROM motive.hypothesis_submission_delivery_results) engine_results`);
    for(const body of [
      {leaseEpoch:fixture.claim.leaseEpoch,stopReason:null},
      {leaseEpoch:fixture.claim.leaseEpoch,stopReason:''},
      {leaseEpoch:fixture.claim.leaseEpoch,stopReason:' padded '},
      {leaseEpoch:fixture.claim.leaseEpoch,stopReason:'bad\u0000text'},
      {leaseEpoch:fixture.claim.leaseEpoch,stopReason:7},
      {leaseEpoch:fixture.claim.leaseEpoch,stopReason:'bounded',unknown:true},
    ]) expect((await agentRelease(fixture.joined.token,body,`invalid-${randomUUID()}`)).status).toBe(400);
    await expect(service.releaseAssignment(fixture.context,assignmentId,
      {leaseEpoch:fixture.claim.leaseEpoch!,stopReason:' direct\u0000invalid'} as never,`direct-${randomUUID()}`))
      .rejects.toMatchObject({code:'VALIDATION'});

    const stopReason='The local solver could not initialize within the allowed time; no result was produced.';
    const key=`release-${randomUUID()}`;const body={leaseEpoch:fixture.claim.leaseEpoch,stopReason};
    const first=await agentRelease(fixture.joined.token,body,key);expect(first.status).toBe(200);
    const firstBody=await json(first);const replay=await agentRelease(fixture.joined.token,body,key);
    expect(replay.status).toBe(200);expect(await json(replay)).toEqual(firstBody);
    expect((await agentRelease(fixture.joined.token,{...body,stopReason:'Changed under the same key.'},key)).status).toBe(409);

    const project=await service.publicProjection();expect(project.activeResearchIntents).toEqual([]);
    expect(project.recentResearchHandoffs).toHaveLength(1);
    const handoff=project.recentResearchHandoffs![0]!;
    expect(handoff).toEqual({id:expect.stringMatching(/^[a-f0-9-]{36}$/),claimId:fixture.claim.claimId,
      assignmentId,agentName:fixture.joined.credential.agentName,contributorDisplayName:'Visible researcher',
      createdAt:expect.any(String),stopReason,intent:{proposal:declared.proposal,expectation:declared.expectation,
        conditions:declared.conditions,workOrderRevision:1,declaredAt:expect.any(String)},
      interpretationStatus:'AGENT_DECLARED_UNVERIFIED'});
    expect(JSON.stringify(handoff)).not.toMatch(/credential|actor|idempotency|researchContext/i);

    const listResponse=await fetch(`${origin}/api/public/projects/circle-packing/research-handoffs`);
    expect(listResponse.status).toBe(200);expect(listResponse.headers.get('cache-control')).toBe('no-store');
    expect((await json<PublicResearchHandoffPage>(listResponse)).items[0]).toEqual(handoff);
    const exactResponse=await fetch(`${origin}/api/public/projects/circle-packing/research-handoffs/${handoff.id}`);
    expect(exactResponse.status).toBe(200);expect(exactResponse.headers.get('cache-control')).toBe('no-store');
    expect(await json(exactResponse)).toEqual(handoff);
    const after=await pool.query(`SELECT
      (SELECT count(*)::integer FROM motive.submissions) submissions,
      (SELECT count(*)::integer FROM motive.finding_review_decisions) findings,
      (SELECT count(*)::integer FROM motive.hypothesis_submission_delivery_results) engine_results`);
    expect(after.rows[0]).toEqual(before.rows[0]);

    await service.revokeToken(fixture.owner,fixture.joined.credential.id,`revoke-${randomUUID()}`);
    expect(await service.publicResearchHandoff(handoff.id)).toEqual(handoff);
  },30_000);

  it('preserves private naming and legacy release behavior, including release after a submission',async()=>{
    const privateFixture=await participant('Private researcher',false);
    await service.declareAssignmentIntent(privateFixture.context,assignmentId,intent(privateFixture.claim.leaseEpoch!,'private'),
      `intent-${randomUUID()}`);
    await service.releaseAssignment(privateFixture.context,assignmentId,{leaseEpoch:privateFixture.claim.leaseEpoch!,
      stopReason:'The bounded dependency was unavailable; this does not establish an outcome.'},`release-${randomUUID()}`);
    await service.join(privateFixture.owner,'Later public name',{projectSlug:'circle-packing',publishDisplayName:true,
      acceptReferenceTerms:true},`rejoin-${randomUUID()}`);
    const privateHandoff=(await service.ownedResearchHandoffs(privateFixture.owner)).items[0]!;
    expect(privateHandoff.contributorDisplayName).toBeNull();
    expect((await service.publicResearchHandoff(privateHandoff.id)).contributorDisplayName).toBeNull();
    expect((await service.publicProjection()).activity.find(item=>item.id===privateHandoff.id)?.contributorDisplayName).toBeNull();

    const legacy=await participant('Legacy researcher');const legacyKey=`release-${randomUUID()}`;
    const legacyBody={leaseEpoch:legacy.claim.leaseEpoch!};
    const first=await agentRelease(legacy.joined.token,legacyBody,legacyKey);expect(first.status).toBe(200);
    expect((await agentRelease(legacy.joined.token,legacyBody,legacyKey)).status).toBe(200);
    expect((await agentRelease(legacy.joined.token,{...legacyBody,stopReason:'Late changed note.'},legacyKey)).status).toBe(409);
    expect((await service.publicResearchHandoffs()).items.some(item=>item.claimId===legacy.claim.claimId)).toBe(false);
    expect((await service.publicProjection()).recentResearchHandoffs?.some(item=>item.claimId===legacy.claim.claimId)).toBe(false);

    const submitted=await participant('Submitted researcher');
    const submission=await service.submitWitness(submitted.context,assignmentId,{leaseEpoch:submitted.claim.leaseEpoch!,
      witness:'{"format":"motive.csqv.witness.v1","n":101,"circles":[]}'},`submit-${randomUUID()}`);
    await service.releaseAssignment(submitted.context,assignmentId,{leaseEpoch:submitted.claim.leaseEpoch!,
      stopReason:'The protected report exists; further work stopped because the local time allowance ended.'},`release-${randomUUID()}`);
    expect((await service.publicResearchHandoffs()).items).toContainEqual(expect.objectContaining({
      claimId:submitted.claim.claimId,intent:null}));
    expect(await service.publicReport(submission.id)).toMatchObject({binding:{submissionId:submission.id}});
  },30_000);

  it('pages stable timestamp ties, rejects ineligible cursors, and isolates the account view',async()=>{
    const owner=await participant('Paging researcher');const ids:string[]=[];
    let claim=owner.claim;
    for(let index=0;index<22;index+=1){
      if(index>0)claim=await service.claimAssignment(owner.context,assignmentId,`claim-${randomUUID()}`);
      await service.declareAssignmentIntent(owner.context,assignmentId,intent(claim.leaseEpoch!,`page-${index}`),`intent-${randomUUID()}`);
      await service.releaseAssignment(owner.context,assignmentId,{leaseEpoch:claim.leaseEpoch!,stopReason:`Stopped page ${index}.`},
        `release-${randomUUID()}`);
      const event=await pool.query(`SELECT id::text FROM motive.events WHERE aggregate_id=$1 AND event_type='external.assignment_released'`,[claim.claimId]);
      ids.push(String(event.rows[0].id));
    }
    const binding=(await pool.query(`SELECT work.project_id,work.terms_digest,token.public_display_name,token.agent_name
      FROM motive.work_orders work JOIN motive.participation_agent_tokens token ON token.id=$2 WHERE work.id=$1`,
    [assignmentId,owner.joined.credential.id])).rows[0];
    for(let index=0;index<2;index+=1){
      const claimId=randomUUID(),eventId=randomUUID();
      await pool.query(`INSERT INTO motive.work_claims
        (id,project_id,work_order_id,operator_actor_id,origin,slot,lease_epoch,terms_digest,status,expires_at,released_at)
        VALUES($1,$2,$3,$4,'EXTERNAL',$5,$6,$7,'RELEASED','2026-09-09T06:10:00Z','2026-09-09T06:00:00Z')`,
      [claimId,binding.project_id,assignmentId,owner.context.actorId,90+index,100+index,binding.terms_digest]);
      await pool.query(`INSERT INTO motive.events
        (id,project_id,aggregate_type,aggregate_id,event_type,payload,actor_id,created_at)
        VALUES($1,$2,'work_claim',$3,'external.assignment_released',$4::jsonb,$5,'2026-09-09T06:00:00Z')`,
      [eventId,binding.project_id,claimId,JSON.stringify({contributor_id:owner.joined.credential.id,
        contributor_display_name:binding.public_display_name,agent_name:binding.agent_name,claim_id:claimId,
        stop_reason:`Timestamp tie ${index}.`}),owner.context.actorId]);
      ids.push(eventId);
    }
    const expected=(await pool.query(`SELECT event.id::text FROM motive.events event
      JOIN motive.work_claims claim ON claim.id=event.aggregate_id
      WHERE claim.operator_actor_id=$1 AND event.event_type='external.assignment_released'
        AND jsonb_typeof(event.payload->'stop_reason')='string'
      ORDER BY event.created_at DESC,event.id DESC`,[owner.context.actorId])).rows.map(row=>String(row.id));
    const first=await service.ownedResearchHandoffs(owner.owner);expect(first.items.map(item=>item.id)).toEqual(expected.slice(0,20));
    expect(first.nextCursor).toBe(expected[19]);
    const second=await service.ownedResearchHandoffs(owner.owner,first.nextCursor!);
    expect(second.items.map(item=>item.id)).toEqual(expected.slice(20));expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items,...second.items].map(item=>item.id)).size).toBe(expected.length);

    const foreign=await participant('Foreign cursor researcher');
    await service.releaseAssignment(foreign.context,assignmentId,{leaseEpoch:foreign.claim.leaseEpoch!,stopReason:'Foreign stop.'},
      `release-${randomUUID()}`);
    const foreignId=(await service.ownedResearchHandoffs(foreign.owner)).items[0]!.id;
    await expect(service.ownedResearchHandoffs(owner.owner,foreignId)).rejects.toMatchObject({code:'NOT_FOUND'});
    expect((await fetch(`${origin}/api/participation/research-handoffs`,{headers:{'x-test-account':owner.owner}})).status).toBe(200);
    expect((await fetch(`${origin}/api/participation/research-handoffs?before=${foreignId}`,{headers:{'x-test-account':owner.owner}})).status).toBe(404);
    expect((await fetch(`${origin}/api/public/projects/circle-packing/research-handoffs?unknown=1`)).status).toBe(400);
    expect((await fetch(`${origin}/api/public/projects/circle-packing/research-handoffs?before=${ids[0]}&before=${ids[1]}`)).status).toBe(400);
    expect((await fetch(`${origin}/api/public/projects/circle-packing/research-handoffs?before=${ids[0]!.toUpperCase()}`)).status).toBe(400);
    expect((await fetch(`${origin}/api/public/projects/circle-packing/research-handoffs/${randomUUID()}`)).status).toBe(404);
    const publicHead=await service.publicResearchHandoffs();const projection=await service.publicProjection();
    expect(projection.recentResearchHandoffs).toHaveLength(6);
    expect(projection.recentResearchHandoffs).toEqual(publicHead.items.slice(0,6));
  },30_000);
});
