import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { applyPostgresMigrations, getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { createParticipationService, ParticipationError, type ParticipationAgentContext,
  type ParticipationService } from '../../server/participation/index.ts';
import type { AssignmentProjection } from '../../src/lib/participation.ts';

const baseUrl=process.env.MOTIVE_TEST_DATABASE_URL;
const pgDescribe=baseUrl?describe:describe.skip;
const POOL_MAX=16;
const ARRIVALS=112;

type AgentFixture={ownerActorId:string;context:ParticipationAgentContext;claimKey:string;assignment?:AssignmentProjection};
type CallOutcome<T>={label:string;durationMs:number;ok:true;value:T}|{label:string;durationMs:number;ok:false;error:unknown};
type WaveMetric={submitted:number;fulfilled:number;rejected:number;elapsedMs:number;p50Ms:number;p95Ms:number;maxMs:number;
  errorCodes:Record<string,number>};
type QaProof={passed:boolean;runId:string;checkedAt:string;testCommand:string;scope:string;
  pool:{serviceMax:number;observerMax:number;submittedApplicationPromises:number};
  correctness:Record<string,unknown>;metrics:Record<string,WaveMetric>;databaseSafety:Record<string,unknown>;
  sourceHashesSha256:Record<string,string>};

pgDescribe('external participation contention on isolated PostgreSQL',()=>{
  const databaseName=`motive_contend_${randomUUID().replaceAll('-','')}`;
  const tokenSecret=`contention-test-${'s'.repeat(48)}`;
  const issuer=`operator:participation-contention-${randomUUID()}`;
  let admin:Pool|undefined;
  let pool:Pool|undefined;
  let observer:Pool|undefined;
  let service:ParticipationService;
  let assignmentId:string;
  let qaProof:QaProof|undefined;
  let databaseCreated=false;

  beforeAll(async()=>{
    await rm('.local/participation-contention-qa.json',{force:true});
    const source=verifiedLoopbackUrl(baseUrl!);
    const adminUrl=new URL(source);adminUrl.pathname='/postgres';
    admin=new Pool({connectionString:adminUrl.toString(),max:1,connectionTimeoutMillis:5_000,
      query_timeout:30_000,statement_timeout:30_000});
    await admin.query(`CREATE DATABASE ${databaseName}`);databaseCreated=true;
    expect((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[databaseName])).rowCount).toBe(1);
    const testUrl=new URL(source);testUrl.pathname=`/${databaseName}`;
    pool=new Pool({connectionString:testUrl.toString(),max:POOL_MAX,connectionTimeoutMillis:5_000,
      query_timeout:30_000,statement_timeout:30_000});
    observer=new Pool({connectionString:testUrl.toString(),max:1,connectionTimeoutMillis:5_000,
      query_timeout:5_000,statement_timeout:5_000});
    await applyPostgresMigrations(pool);
    expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    const project=await new LedgerKernel(pool).createProject({actorId:issuer,idempotencyKey:randomUUID(),
      slug:'circle-packing',visibility:'PUBLIC',revisionContent:{title:'Isolated participation contention'}});
    expect(project.currentRevision).toBe(1);
    service=createParticipationService(pool,{tokenSecret,issuerActorId:issuer});
    assignmentId=(await service.ensureCircleWorkOrder()).id;
  },45_000);

  afterAll(async()=>{
    await Promise.allSettled([pool?.end(),observer?.end()]);
    let remaining=-1;
    if(admin&&databaseCreated){
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',[databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
      remaining=(await admin.query('SELECT count(*)::integer AS count FROM pg_database WHERE datname=$1',[databaseName])).rows[0].count;
    }
    if(admin)await admin.end();
    const cleaned=remaining===0;
    if(qaProof){
      qaProof.passed=qaProof.passed&&cleaned;
      qaProof.databaseSafety={...qaProof.databaseSafety,cleanupVerified:cleaned,remainingDatabases:remaining};
      await writeFile('.local/participation-contention-qa.json',`${JSON.stringify(qaProof,null,2)}\n`,'utf8');
    }
    expect(cleaned).toBe(true);
  });

  it('keeps 100 slots and lease fences coherent across concurrent arrival and departure waves',async()=>{
    const metrics:Record<string,WaveMetric>={};
    const unexpectedDatabaseCodes=new Set<string>();
    const enrollment=await wave(Array.from({length:ARRIVALS},(_,index)=>({label:`agent-${index+1}`,run:async()=>{
      const ownerActorId=`account:${randomUUID()}`;
      const joined=await service.join(ownerActorId,`Contention account ${index+1}`,{
        projectSlug:'circle-packing',publishDisplayName:false,acceptReferenceTerms:true},`join-${randomUUID()}`);
      const context=await service.authenticateBearer(joined.token);
      return {ownerActorId,context,claimKey:`claim-${randomUUID()}`} as AgentFixture;
    }})));
    metrics.enrollment=enrollment.metric;
    expect(enrollment.outcomes.every(outcome=>outcome.ok)).toBe(true);
    const agents=enrollment.outcomes.map(outcome=>fulfilled(outcome).value);
    expect(new Set(agents.map(agent=>agent.context.tokenId)).size).toBe(ARRIVALS);
    expect(new Set(agents.map(agent=>agent.ownerActorId)).size).toBe(ARRIVALS);

    let stopSampler=false;let sampleCount=0;let maxObservedLive=0;
    const sampler=(async()=>{
      while(!stopSampler){
        const row=(await observer!.query(`SELECT count(*)::integer AS count FROM motive.work_claims
          WHERE work_order_id=$1 AND status='ACTIVE' AND expires_at>clock_timestamp()`,[assignmentId])).rows[0];
        maxObservedLive=Math.max(maxObservedLive,Number(row.count));sampleCount+=1;
        await delay(2);
      }
    })();
    try{
      const initial=await wave(agents.map((agent,index)=>({label:`claim-${index+1}`,run:()=>service.claimAssignment(agent.context,assignmentId,agent.claimKey)})));
      metrics.initialClaim=initial.metric;collectUnexpectedCodes(initial.outcomes,unexpectedDatabaseCodes);
      const initialSuccess:AgentFixture[]=[];const initialDenied:AgentFixture[]=[];
      initial.outcomes.forEach((outcome,index)=>{
        const agent=agents[index]!;
        if(outcome.ok){agent.assignment=outcome.value;initialSuccess.push(agent);}
        else{expectCapacityConflict(outcome.error);initialDenied.push(agent);}
      });
      expect(initialSuccess).toHaveLength(100);expect(initialDenied).toHaveLength(12);
      const originalClaims=new Map(initialSuccess.map(agent=>[agent.context.actorId,structuredClone(agent.assignment!)]));
      await expectCapacity(100);
      const deniedReservationCount=await pool!.query(`SELECT count(*)::integer AS count FROM motive.idempotency_records
        WHERE action='participation.assignment.claim' AND actor_id=ANY($1::text[]) AND idempotency_key=ANY($2::text[])`,
      [initialDenied.map(agent=>agent.context.actorId),initialDenied.map(agent=>agent.claimKey)]);
      expect(Number(deniedReservationCount.rows[0].count)).toBe(0);

      const lost=initialSuccess[0]!;const firstResponse=lost.assignment!;
      const recovered=await wave([{label:'lost-response-retry',run:()=>service.claimAssignment(lost.context,assignmentId,lost.claimKey)}]);
      metrics.lostResponseReplay=recovered.metric;
      expect(fulfilled(recovered.outcomes[0]!).value).toEqual(firstResponse);
      expect(await claimEventCount(firstResponse.claimId!)).toBe(1);
      expect(await activeClaimCount(lost.context.actorId)).toBe(1);

      const renewTargets=initialSuccess.slice(1,13);
      const renewals=await wave(renewTargets.map((agent,index)=>({label:`renew-${index+1}`,
        run:()=>service.renewAssignment(agent.context,assignmentId,{leaseEpoch:agent.assignment!.leaseEpoch!},`renew-${randomUUID()}`)})));
      metrics.renew=renewals.metric;collectUnexpectedCodes(renewals.outcomes,unexpectedDatabaseCodes);
      renewals.outcomes.forEach((outcome,index)=>{
        const projection=fulfilled(outcome).value;expect(projection.leaseEpoch).toBe(1);renewTargets[index]!.assignment=projection;
      });
      await expectCapacity(100);

      const departures=initialSuccess.slice(-12);
      const mixedCalls=[
        ...departures.map((agent,index)=>({label:`release-${index+1}`,
          run:()=>service.releaseAssignment(agent.context,assignmentId,{leaseEpoch:agent.assignment!.leaseEpoch!},`release-${randomUUID()}`)})),
        ...initialDenied.map((agent,index)=>({label:`arrival-${index+1}`,
          run:()=>service.claimAssignment(agent.context,assignmentId,agent.claimKey)})),
      ];
      const mixed=await wave(mixedCalls);metrics.mixedReleaseArrival=mixed.metric;collectUnexpectedCodes(mixed.outcomes,unexpectedDatabaseCodes);
      mixed.outcomes.slice(0,departures.length).forEach((outcome,index)=>{
        const projection=fulfilled(outcome).value;expect(projection.status).toBe('RELEASED');departures[index]!.assignment=projection;
      });
      const retryAgents:AgentFixture[]=[];
      mixed.outcomes.slice(departures.length).forEach((outcome,index)=>{
        const agent=initialDenied[index]!;
        if(outcome.ok){agent.assignment=outcome.value;expect(outcome.value.status).toBe('ACTIVE');}
        else{expectCapacityConflict(outcome.error);retryAgents.push(agent);}
      });
      expect((await liveCapacity()).live).toBeLessThanOrEqual(100);
      const mixedRetry=await wave(retryAgents.map((agent,index)=>({label:`arrival-retry-${index+1}`,
        run:()=>service.claimAssignment(agent.context,assignmentId,agent.claimKey)})));
      metrics.capacityRetry=mixedRetry.metric;collectUnexpectedCodes(mixedRetry.outcomes,unexpectedDatabaseCodes);
      mixedRetry.outcomes.forEach((outcome,index)=>{retryAgents[index]!.assignment=fulfilled(outcome).value;});
      const deniedReservationsAfterRetry=await pool!.query(`SELECT count(*)::integer AS count FROM motive.idempotency_records
        WHERE action='participation.assignment.claim' AND actor_id=ANY($1::text[]) AND idempotency_key=ANY($2::text[])`,
      [initialDenied.map(agent=>agent.context.actorId),initialDenied.map(agent=>agent.claimKey)]);
      expect(Number(deniedReservationsAfterRetry.rows[0].count)).toBe(12);
      await expectCapacity(100);

      const newcomersToRelease=initialDenied.slice(0,8);
      const releaseForReclaim=await wave(newcomersToRelease.map((agent,index)=>({label:`release-new-${index+1}`,
        run:()=>service.releaseAssignment(agent.context,assignmentId,{leaseEpoch:agent.assignment!.leaseEpoch!},`release-new-${randomUUID()}`)})));
      metrics.releaseForReclaim=releaseForReclaim.metric;collectUnexpectedCodes(releaseForReclaim.outcomes,unexpectedDatabaseCodes);
      releaseForReclaim.outcomes.forEach((outcome,index)=>{newcomersToRelease[index]!.assignment=fulfilled(outcome).value;});
      const reclaimTargets=departures.slice(0,8);
      const reclaims=await wave(reclaimTargets.map((agent,index)=>({label:`reclaim-${index+1}`,run:async()=>{
        const projection=await service.claimAssignment(agent.context,assignmentId,`reclaim-${randomUUID()}`);agent.assignment=projection;return projection;
      }})));
      metrics.reclaim=reclaims.metric;collectUnexpectedCodes(reclaims.outcomes,unexpectedDatabaseCodes);
      reclaims.outcomes.forEach(outcome=>expect(fulfilled(outcome).value).toMatchObject({status:'ACTIVE',leaseEpoch:2}));
      await expectCapacity(100);
      const fenced=reclaimTargets[0]!;
      const staleFences=await wave([
        {label:'stale-renew',run:()=>service.renewAssignment(fenced.context,assignmentId,{leaseEpoch:1},`stale-renew-${randomUUID()}`)},
        {label:'stale-release',run:()=>service.releaseAssignment(fenced.context,assignmentId,{leaseEpoch:1},`stale-release-${randomUUID()}`)},
      ]);
      metrics.staleFence=staleFences.metric;collectUnexpectedCodes(staleFences.outcomes,unexpectedDatabaseCodes);
      staleFences.outcomes.forEach(outcome=>{expect(outcome.ok).toBe(false);if(!outcome.ok)expect(outcome.error).toMatchObject({code:'CONFLICT'});});
      const originalReplay=await wave([{label:'released-original-key-replay',
        run:()=>service.claimAssignment(fenced.context,assignmentId,fenced.claimKey)}]);
      metrics.releasedOriginalReplay=originalReplay.metric;
      const historicalResponse=fulfilled(originalReplay.outcomes[0]!).value;
      expect(historicalResponse).toEqual(originalClaims.get(fenced.context.actorId));
      expect(historicalResponse.claimId).not.toBe(fenced.assignment!.claimId);
      const currentAfterHistoricalReplay=await service.getAgentAssignment(fenced.context);
      expect(currentAfterHistoricalReplay.assignment).toMatchObject({claimId:fenced.assignment!.claimId,status:'ACTIVE',leaseEpoch:2});
      expect((await pool!.query('SELECT status FROM motive.work_claims WHERE id=$1',[historicalResponse.claimId])).rows[0].status).toBe('RELEASED');
      await expectCapacity(100);

      const oneDeparture=initialSuccess[1]!;
      oneDeparture.assignment=(await service.releaseAssignment(oneDeparture.context,assignmentId,
        {leaseEpoch:oneDeparture.assignment!.leaseEpoch!},`release-one-${randomUUID()}`));
      const identicalTarget=departures[8]!;const identicalKey=`identical-${randomUUID()}`;
      const identical=await wave([
        {label:'identical-a',run:()=>service.claimAssignment(identicalTarget.context,assignmentId,identicalKey)},
        {label:'identical-b',run:()=>service.claimAssignment(identicalTarget.context,assignmentId,identicalKey)},
      ]);
      metrics.concurrentIdenticalClaim=identical.metric;collectUnexpectedCodes(identical.outcomes,unexpectedDatabaseCodes);
      const identicalLeft=fulfilled(identical.outcomes[0]!).value;const identicalRight=fulfilled(identical.outcomes[1]!).value;
      expect(identicalLeft).toEqual(identicalRight);expect(identicalLeft).toMatchObject({status:'ACTIVE',leaseEpoch:2});
      identicalTarget.assignment=identicalLeft;
      expect(await claimEventCount(identicalLeft.claimId!)).toBe(1);
      expect(await activeClaimCount(identicalTarget.context.actorId)).toBe(1);
      await expectCapacity(100);

      const expiring=initialSuccess[2]!;const expiringClaimId=expiring.assignment!.claimId!;
      await pool!.query(`UPDATE motive.work_claims SET expires_at=clock_timestamp()-interval '1 second'
        WHERE id=$1 AND status='ACTIVE'`,[expiringClaimId]);
      await expect(service.renewAssignment(expiring.context,assignmentId,{leaseEpoch:1},`expired-renew-${randomUUID()}`))
        .rejects.toMatchObject({code:'EXPIRED'});
      const rolledBackExpiry=(await pool!.query(`SELECT status,expires_at<=clock_timestamp() AS logically_expired
        FROM motive.work_claims WHERE id=$1`,[expiringClaimId])).rows[0];
      expect(rolledBackExpiry).toMatchObject({status:'ACTIVE',logically_expired:true});
      const expiryFiller=departures[9]!;const expiryFill=await wave([{label:'expiry-fill',run:async()=>{
        const projection=await service.claimAssignment(expiryFiller.context,assignmentId,`expiry-fill-${randomUUID()}`);
        expiryFiller.assignment=projection;return projection;
      }}]);
      metrics.expiryReplacement=expiryFill.metric;collectUnexpectedCodes(expiryFill.outcomes,unexpectedDatabaseCodes);
      expect(fulfilled(expiryFill.outcomes[0]!).value.status).toBe('ACTIVE');
      expect((await pool!.query('SELECT status FROM motive.work_claims WHERE id=$1',[expiringClaimId])).rows[0].status).toBe('EXPIRED');
      await expectCapacity(100);

      const anotherDeparture=initialSuccess[3]!;
      anotherDeparture.assignment=await service.releaseAssignment(anotherDeparture.context,assignmentId,
        {leaseEpoch:anotherDeparture.assignment!.leaseEpoch!},`release-expired-reclaim-${randomUUID()}`);
      const expiredReclaim=await wave([{label:'expired-agent-reclaim',run:async()=>{
        const projection=await service.claimAssignment(expiring.context,assignmentId,`expired-reclaim-${randomUUID()}`);
        expiring.assignment=projection;return projection;
      }}]);
      metrics.expiredAgentReclaim=expiredReclaim.metric;collectUnexpectedCodes(expiredReclaim.outcomes,unexpectedDatabaseCodes);
      expect(fulfilled(expiredReclaim.outcomes[0]!).value).toMatchObject({status:'ACTIVE',leaseEpoch:2});
      await expect(service.renewAssignment(expiring.context,assignmentId,{leaseEpoch:1},`expired-stale-${randomUUID()}`))
        .rejects.toMatchObject({code:'CONFLICT'});
      await expectCapacity(100);

      const revocationTarget=initialSuccess[4]!;
      const revokeRenew=await wave([
        {label:'revoke-token',run:async():Promise<string>=>{await service.revokeToken(
          revocationTarget.ownerActorId,revocationTarget.context.tokenId,`revoke-race-${randomUUID()}`);return 'revoke';}},
        {label:'renew-revoking-token',run:async():Promise<string>=>{await service.renewAssignment(
          revocationTarget.context,assignmentId,{leaseEpoch:revocationTarget.assignment!.leaseEpoch!},`renew-race-${randomUUID()}`);return 'renew';}},
      ]);
      metrics.revokeRenewRace=revokeRenew.metric;collectUnexpectedCodes(revokeRenew.outcomes,unexpectedDatabaseCodes);
      expect(revokeRenew.outcomes[0]!.ok).toBe(true);
      const renewRaceOutcome=revokeRenew.outcomes[1]!;
      if(!renewRaceOutcome.ok)expect(renewRaceOutcome.error).toMatchObject({code:'UNAUTHORIZED'});
      expect((await pool!.query(`SELECT revoked_at IS NOT NULL AS revoked FROM motive.participation_agent_tokens WHERE id=$1`,
        [revocationTarget.context.tokenId])).rows[0].revoked).toBe(true);
      expect((await pool!.query(`SELECT status FROM motive.work_claims WHERE id=$1`,[revocationTarget.assignment!.claimId])).rows[0].status)
        .toBe('REVOKED');
      const freshWaiting=anotherDeparture;
      const fillRevoked=await wave([{label:'fill-revoked-slot',run:async()=>{
        const projection=await service.claimAssignment(freshWaiting.context,assignmentId,`fill-revoked-${randomUUID()}`);
        freshWaiting.assignment=projection;return projection;
      }}]);
      metrics.revokedSlotReplacement=fillRevoked.metric;collectUnexpectedCodes(fillRevoked.outcomes,unexpectedDatabaseCodes);
      expect(fulfilled(fillRevoked.outcomes[0]!).value.status).toBe('ACTIVE');
      await expectCapacity(100);
    }finally{
      stopSampler=true;await sampler;
    }

    expect(maxObservedLive).toBeLessThanOrEqual(100);expect(sampleCount).toBeGreaterThan(0);
    expect([...unexpectedDatabaseCodes]).toEqual([]);
    const finalCapacity=await liveCapacity();
    const sourceHashesSha256=await hashes([
      'tests/backend/participation-contention.postgres.test.ts','server/participation/service.ts',
      'migrations/001_ledger_kernel.sql','migrations/015_external_participation.sql',
    ]);
    qaProof={passed:true,runId:randomUUID(),checkedAt:new Date().toISOString(),
      testCommand:'node --env-file-if-exists=.env.local --import tsx .local/run-admission-backend-tests.mts tests/backend/participation-contention.postgres.test.ts',
      scope:'Synthetic participant owner identities using real service join and bearer authentication against a local PostgreSQL pool; this is not Supabase account-auth, HTTP load, or a claim about 10,000 concurrent agents.',
      pool:{serviceMax:POOL_MAX,observerMax:1,submittedApplicationPromises:ARRIVALS},
      correctness:{enrolledAgents:ARRIVALS,initialClaimsAccepted:100,initialCapacityDenied:12,
        maximumObservedLiveClaims:maxObservedLive,capacitySamples:sampleCount,finalLiveClaims:finalCapacity.live,
        finalDistinctLiveSlots:finalCapacity.distinctSlots,finalDistinctLiveAgents:finalCapacity.distinctActors,
        failedCapacityReservationsBeforeRetry:0,capacityReservationsAfterRetry:12,
        successfulClaimReplayRecovered:true,concurrentIdenticalClaimSingleEffect:true,
        releaseRenewReclaimFencing:true,releasedOriginalKeyReplaysHistoricalResponseWithoutResurrection:true,
        expiredRenewRejected:true,
        expiredRenewPhysicalStatusRolledBackUntilNextClaimSweep:true,
        expiredClaimReplacementAndReclaim:true,concurrentTokenRevocationSerializedWithRenew:true,
        revokedSlotFilledByFreshWaitingClaimant:true,unexpectedDatabaseErrorCodes:[]},
      metrics,databaseSafety:{protocol:'postgres',host:'loopback',urlOverridesRejected:true,databaseNameKind:'fresh UUID',
        forbiddenSharedDatabases:['motive_app_local','motive_test'],schemaExact:true,cleanupVerified:false,remainingDatabases:null},
      sourceHashesSha256};
  },180_000);

  async function liveCapacity(){
    const result=await pool!.query(`SELECT
      count(*) FILTER(WHERE status='ACTIVE' AND expires_at>clock_timestamp())::integer AS live,
      count(DISTINCT slot) FILTER(WHERE status='ACTIVE' AND expires_at>clock_timestamp())::integer AS distinct_slots,
      count(DISTINCT operator_actor_id) FILTER(WHERE status='ACTIVE' AND expires_at>clock_timestamp())::integer AS distinct_actors,
      count(*) FILTER(WHERE status='ACTIVE' AND expires_at<=clock_timestamp())::integer AS expired_active
      FROM motive.work_claims WHERE work_order_id=$1`,[assignmentId]);
    return {live:Number(result.rows[0].live),distinctSlots:Number(result.rows[0].distinct_slots),
      distinctActors:Number(result.rows[0].distinct_actors),expiredActive:Number(result.rows[0].expired_active)};
  }

  async function expectCapacity(expected:number){
    const state=await liveCapacity();
    expect(state).toEqual({live:expected,distinctSlots:expected,distinctActors:expected,expiredActive:0});
  }

  async function claimEventCount(claimId:string){
    const result=await pool!.query(`SELECT count(*)::integer AS count FROM motive.events
      WHERE aggregate_type='work_claim' AND aggregate_id=$1 AND event_type='external.assignment_claimed'`,[claimId]);
    return Number(result.rows[0].count);
  }

  async function activeClaimCount(actorId:string){
    const result=await pool!.query(`SELECT count(*)::integer AS count FROM motive.work_claims
      WHERE work_order_id=$1 AND operator_actor_id=$2 AND status='ACTIVE' AND expires_at>clock_timestamp()`,[assignmentId,actorId]);
    return Number(result.rows[0].count);
  }
});

function verifiedLoopbackUrl(raw:string):URL{
  let source:URL;
  try{source=new URL(raw);}catch{throw new Error('Participation contention tests require a valid loopback PostgreSQL bootstrap URL.');}
  if(!['postgres:','postgresql:'].includes(source.protocol)||source.search||source.hash
    ||!['127.0.0.1','localhost','::1','[::1]'].includes(source.hostname)){
    throw new Error('Participation contention tests require a PostgreSQL URL with no overrides on a verified loopback host.');
  }
  if(!decodeURIComponent(source.pathname).replace(/^\//,''))throw new Error('Participation contention tests require a source database name.');
  return source;
}

describe('participation contention bootstrap safety',()=>{
  it.each([
    'not-a-url',
    'https://127.0.0.1/postgres',
    'postgres://example.com/postgres',
    'postgres://127.0.0.1/postgres?host=example.com',
    'postgres://127.0.0.1/postgres#override',
  ])('rejects an unsafe bootstrap without attempting a connection: %s',raw=>{
    let message='';try{verifiedLoopbackUrl(raw);}catch(error){message=error instanceof Error?error.message:'';}
    expect(message).toMatch(/^Participation contention tests require /);
    expect(message).not.toContain(raw);
  });
});

async function wave<T>(calls:Array<{label:string;run:()=>Promise<T>}>):Promise<{outcomes:Array<CallOutcome<T>>;metric:WaveMetric}>{
  const started=performance.now();
  const outcomes=await Promise.all(calls.map(async call=>{
    const callStarted=performance.now();
    try{const value=await call.run();return {label:call.label,durationMs:performance.now()-callStarted,ok:true,value} as CallOutcome<T>;}
    catch(error){return {label:call.label,durationMs:performance.now()-callStarted,ok:false,error} as CallOutcome<T>;}
  }));
  const durations=outcomes.map(outcome=>outcome.durationMs).sort((left,right)=>left-right);
  const errorCodes:Record<string,number>={};
  for(const outcome of outcomes)if(!outcome.ok){const code=errorCode(outcome.error);errorCodes[code]=(errorCodes[code]??0)+1;}
  return {outcomes,metric:{submitted:calls.length,fulfilled:outcomes.filter(outcome=>outcome.ok).length,
    rejected:outcomes.filter(outcome=>!outcome.ok).length,elapsedMs:rounded(performance.now()-started),
    p50Ms:percentile(durations,.5),p95Ms:percentile(durations,.95),maxMs:rounded(durations.at(-1)??0),errorCodes}};
}

function fulfilled<T>(outcome:CallOutcome<T>):Extract<CallOutcome<T>,{ok:true}>{
  expect(outcome.ok).toBe(true);
  if(!outcome.ok)throw outcome.error;
  return outcome;
}

function expectCapacityConflict(error:unknown){
  expect(error).toBeInstanceOf(ParticipationError);
  expect(error).toMatchObject({code:'CONFLICT',message:'No external assignment capacity is available.'});
}

function collectUnexpectedCodes<T>(outcomes:Array<CallOutcome<T>>,target:Set<string>){
  for(const outcome of outcomes){
    if(outcome.ok||outcome.error instanceof ParticipationError)continue;
    target.add(errorCode(outcome.error));
  }
}

function errorCode(error:unknown):string{
  if(error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'&&/^[A-Za-z0-9_]{1,32}$/.test(error.code))return error.code;
  return 'UNCLASSIFIED';
}

function percentile(sorted:number[],fraction:number):number{
  if(!sorted.length)return 0;
  return rounded(sorted[Math.max(0,Math.ceil(sorted.length*fraction)-1)]!);
}

function rounded(value:number):number{return Math.round(value*1000)/1000;}
function delay(milliseconds:number){return new Promise<void>(resolve=>setTimeout(resolve,milliseconds));}

async function hashes(paths:string[]):Promise<Record<string,string>>{
  const entries=await Promise.all(paths.map(async path=>[path,createHash('sha256').update(await readFile(path)).digest('hex')] as const));
  return Object.fromEntries(entries);
}
