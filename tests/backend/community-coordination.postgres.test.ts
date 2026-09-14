import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { applyPostgresMigrations, getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { createCommunityCoordinationService, type CommunityCoordinationService } from '../../server/coordination/service.ts';
import { createParticipationService, type ParticipationAgentContext, type ParticipationService } from '../../server/participation/index.ts';

const baseUrl=process.env.MOTIVE_TEST_DATABASE_URL,pgDescribe=baseUrl?describe:describe.skip;

export function communityCoordinationDatabaseUrls(raw:string,name:string){let source:URL;
  try{source=new URL(raw);}catch{throw new Error('MOTIVE_TEST_DATABASE_URL must be a plain loopback PostgreSQL URL.');}
  const base=decodeURIComponent(source.pathname.slice(1));
  if(!['postgres:','postgresql:'].includes(source.protocol)||!['127.0.0.1','localhost'].includes(source.hostname)
    ||!base||source.search||source.hash)
    throw new Error('MOTIVE_TEST_DATABASE_URL must be a plain loopback PostgreSQL URL.');
  const admin=new URL(source),test=new URL(source);admin.pathname='/postgres';test.pathname=`/${name}`;
  return{admin:admin.toString(),test:test.toString()};}

describe('community coordination database URL boundary',()=>{
  it('rejects shared, remote, query-overridden, fragment-bearing, and malformed sources',()=>{
    for(const sample of ['bad','postgres://secret@db.invalid/source',
      'postgres://secret@127.0.0.1/source?host=db.invalid','postgres://secret@localhost/source#override']){
      let message='';try{communityCoordinationDatabaseUrls(sample,`motive_coordination_${randomUUID().replaceAll('-','')}`);}
      catch(error){message=error instanceof Error?error.message:'';}expect(message).toMatch(/^MOTIVE_TEST_DATABASE_URL must/);
      expect(message).not.toContain(sample);expect(message).not.toContain('secret');
    }
  });
});

pgDescribe('community coordination on isolated PostgreSQL',()=>{
  const configured=process.env.MOTIVE_COMMUNITY_COORDINATION_TEST_DATABASE_NAME;
  const databaseName=configured&&/^motive_coordination_[a-f0-9]{32}$/.test(configured)
    ?configured:`motive_coordination_${randomUUID().replaceAll('-','')}`;
  const issuer=`operator:${randomUUID()}`,reviewers=Array.from({length:5},()=>`account:${randomUUID()}`),
    contributor=`account:${randomUUID()}`,active=new Set([...reviewers,contributor]);
  let admin:Pool|undefined,pool:Pool|undefined,created=false,participation:ParticipationService,coordination:CommunityCoordinationService;
  let projectId:string,workOrderId:string,evidence:{submissionId:string;reportDigest:string;artifactDigest:string},sourceContext:ParticipationAgentContext;
  let contexts:ParticipationAgentContext[],grantIds:string[],working:{context:ParticipationAgentContext;grantId:string;turnId:string};
  let waitingGrantId:string,completedPlan:any;

  beforeAll(async()=>{const urls=communityCoordinationDatabaseUrls(baseUrl!,databaseName);admin=new Pool({connectionString:urls.admin,max:1});
    await admin.query(`CREATE DATABASE ${databaseName}`);created=true;pool=new Pool({connectionString:urls.test,max:2,statement_timeout:15_000});
    await applyPostgresMigrations(pool);expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    projectId=(await new LedgerKernel(pool).createProject({actorId:issuer,idempotencyKey:randomUUID(),slug:'circle-packing',visibility:'PUBLIC',
      revisionContent:{title:'Community coordination test'}})).id;
    for(const actor of [...reviewers,contributor])await pool.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at)
      VALUES($1,'supabase',$2,'ACTIVE',clock_timestamp())`,[actor,actor.slice(8)]);
    for(const actor of reviewers)await pool.query(`INSERT INTO motive.memberships(id,project_id,actor_id,role,scopes,granted_by)
      VALUES($1,$2,$3,'REVIEWER',ARRAY['project:review'],$4)`,[randomUUID(),projectId,actor,issuer]);
    participation=createParticipationService(pool,{tokenSecret:`coordination-${'p'.repeat(48)}`,issuerActorId:issuer,
      isActorActive:async actor=>active.has(actor)});workOrderId=(await participation.ensureCircleWorkOrder()).id;
    const joins=[];for(const actor of reviewers)joins.push(await participation.join(actor,'Volunteer',{projectSlug:'circle-packing',
      publishDisplayName:true,acceptReferenceTerms:true},`join-${randomUUID()}`));
    contexts=[];for(const joined of joins)contexts.push(await participation.authenticateBearer(joined.token));
    const source=await participation.join(contributor,'Evidence source',{projectSlug:'circle-packing',publishDisplayName:false,
      acceptReferenceTerms:true},`join-${randomUUID()}`);sourceContext=await participation.authenticateBearer(source.token);
    const claim=await participation.claimAssignment(sourceContext,workOrderId,`claim-${randomUUID()}`);
    const witness=await readFile('public/projects/circle-packing/reference-witness.json','utf8');
    const submission=await participation.submitWitness(sourceContext,workOrderId,{leaseEpoch:claim.leaseEpoch!,witness},`submit-${randomUUID()}`);
    const report=await participation.publicReport(submission.id);
    evidence={submissionId:submission.id,reportDigest:String(report.reportDigest),artifactDigest:submission.artifactSha256};
    coordination=createCommunityCoordinationService({pool,isActorActive:async actor=>{
      const row=await pool!.query("SELECT status='ACTIVE' active FROM motive.account_identities WHERE actor_id=$1",[actor]);
      return active.has(actor)&&row.rows[0]?.active===true;},assertContext:async(_client,boundProject,context)=>{
      if(boundProject!==projectId||context.scopeId!=='11111111-1111-4111-8111-111111111111')throw new Error('context mismatch');}});
  },45_000);

  afterAll(async()=>{await pool?.end();if(admin)try{if(created){await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',[databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);expect((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[databaseName])).rowCount).toBe(0);}}
    finally{await admin.end();}},30_000);

  it('requires explicit eligible account grants and binds idempotency across operations',async()=>{
    const ordinary=await coordination.accountState(contributor);expect(ordinary).toMatchObject({eligible:false,reason:'MEMBERSHIP_REQUIRED'});
    expect((await coordination.state(await participation.authenticateBearer((await participation.join(contributor,'Second source',{
      projectSlug:'circle-packing',publishDisplayName:false,acceptReferenceTerms:true},`join-${randomUUID()}`)).token))).state).toBe('NOT_ENROLLED');
    const first=await coordination.createGrant(reviewers[0]!,{agentTokenId:contexts[0]!.tokenId,maxTurns:1},'coordination-grant-one');
    expect((await coordination.createGrant(reviewers[0]!,{agentTokenId:contexts[0]!.tokenId,maxTurns:1},'coordination-grant-one')).replayed).toBe(true);
    await expect(coordination.createGrant(reviewers[0]!,{agentTokenId:contexts[0]!.tokenId,maxTurns:2},'coordination-grant-one'))
      .rejects.toMatchObject({code:'CONFLICT'});
    await expect(coordination.createGrant(reviewers[0]!,{agentTokenId:contexts[0]!.tokenId,maxTurns:1},'coordination-grant-other'))
      .rejects.toMatchObject({code:'CONFLICT'});
    const second=await coordination.createGrant(reviewers[1]!,{agentTokenId:contexts[1]!.tokenId,maxTurns:1},'coordination-grant-two');
    grantIds=[first.grant.id,second.grant.id];expect(first.grant.firstSeenAt).toBeNull();
  });

  it('serializes two-connection claims without pool starvation and supports replay, release, and takeover',async()=>{
    const keys=['coordination-race-one','coordination-race-two'];
    const raced=await Promise.all(contexts.slice(0,2).map((context,index)=>coordination.claim(context,{grantId:grantIds[index]!},keys[index]!)));
    expect(raced.filter(item=>item.state==='WORKING')).toHaveLength(1);expect(raced.filter(item=>item.state==='WAITING')).toHaveLength(1);
    const winner=raced.findIndex(item=>item.state==='WORKING'),turn=raced[winner]!.turn!;
    expect((await coordination.claim(contexts[winner]!,{grantId:grantIds[winner]!},keys[winner]!)).turn?.id).toBe(turn.id);
    await expect(coordination.createGrant(reviewers[winner]!,{agentTokenId:contexts[winner]!.tokenId,maxTurns:1},'active-final-reissue'))
      .rejects.toMatchObject({code:'CONFLICT'});
    await expect(coordination.release(contexts[winner]!,{grantId:grantIds[winner]!,turnId:turn.id,reason:'Yield for takeover.'},keys[winner]!))
      .rejects.toMatchObject({code:'CONFLICT'});
    expect((await coordination.release(contexts[winner]!,{grantId:grantIds[winner]!,turnId:turn.id,reason:'Yield for takeover.'},
      'coordination-release')).turn.status).toBe('RELEASED');
    const successor=winner===0?1:0,claimed=await coordination.claim(contexts[successor]!,{grantId:grantIds[successor]!},'coordination-takeover');
    expect(claimed).toMatchObject({state:'WORKING',turn:{id:expect.any(String)}});
    working={context:contexts[successor]!,grantId:grantIds[successor]!,turnId:claimed.turn!.id};
  },15_000);

  it('publishes immutable evidence-linked unreviewed advice and hides private research snapshot ids',async()=>{
    const researchContext={scopeId:'11111111-1111-4111-8111-111111111111',snapshotId:'22222222-2222-4222-8222-222222222222',
      snapshotDigest:`sha256:${'c'.repeat(64)}`};
    const plan={format:'motive.community-coordination-plan.v1' as const,summary:'Test one bounded evidence-linked branch.',
      limitations:'Volunteer advice is unreviewed.',researchContext,priorities:[{kind:'EXPERIMENT' as const,
        question:'Can a bounded perturbation improve the retained score?',expectation:'The exact checker may show an improvement.',
        test:'Run one finite seeded batch and preserve every checked result.',positiveInterpretation:'Prioritize one replication.',
        negativeInterpretation:'Retain the counterexample and change branch.',inconclusiveInterpretation:'Record the limit before retrying.',
        motiveReferences:[evidence]}]};
    const completed=await coordination.complete(working.context,{grantId:working.grantId,turnId:working.turnId,plan},'coordination-complete');
    completedPlan=plan;
    expect(completed).toMatchObject({classification:'PUBLIC_UNREVIEWED_ADVICE',replayed:false});
    expect((await coordination.complete(working.context,{grantId:working.grantId,turnId:working.turnId,plan},'coordination-complete')).replayed).toBe(true);
    const publicState=await coordination.publicProjection();expect(publicState).toMatchObject({coordinatorAvailable:false,activeTurn:null,
      currentSuggestions:{summary:plan.summary,limitations:plan.limitations,memoryReferenced:true,stale:false}});
    expect(JSON.stringify(publicState)).not.toContain(researchContext.scopeId);expect(JSON.stringify(publicState)).not.toContain(researchContext.snapshotId);
    expect((await coordination.claim(working.context,{grantId:working.grantId},'coordination-unchanged')).state).toBe('EXHAUSTED');
    await expect(coordination.complete(working.context,{grantId:working.grantId,turnId:working.turnId,plan:{...plan,summary:'Changed replay.'}},
      'coordination-complete')).rejects.toMatchObject({code:'CONFLICT'});
    const replacement=await coordination.createGrant(working.context.ownerActorId,{agentTokenId:working.context.tokenId,maxTurns:2},'exhausted-reissue');
    waitingGrantId=replacement.grant.id;
    expect((await coordination.publicProjection()).coordinatorAvailable).toBe(true);
    expect((await coordination.claim(working.context,{grantId:waitingGrantId},'still-current-advice')).state).toBe('WAITING');
    await expect(pool!.query("UPDATE motive.community_coordination_plans SET plan='{}'::jsonb WHERE id=$1",[completed.id]))
      .rejects.toMatchObject({code:'55000'});
    await expect(coordination.complete(working.context,{grantId:working.grantId,turnId:working.turnId,plan:{...plan,priorities:[{
      ...plan.priorities[0]!,motiveReferences:[{...evidence,reportDigest:`sha256:${'f'.repeat(64)}`}]}]}},'coordination-bad-ref'))
      .rejects.toMatchObject({code:'CONFLICT'});
  });

  it('uses DB-clock expiry, changed research signals, and current token/role/account fences',async()=>{
    await participation.createPostCheckAssessment(sourceContext,evidence.submissionId,{reportDigest:evidence.reportDigest,
      assessment:'The retained report remains exact.',nextAction:'Use this new review signal.'},'coordination-post-check');
    const expiredTurnId=randomUUID();await pool!.query(`WITH anchor AS (SELECT clock_timestamp() at)
      INSERT INTO motive.community_coordination_turns
      (id,grant_id,project_id,project_revision,research_signal_digest,expires_at,hard_expires_at,last_seen_at,created_at)
      SELECT $1,$2,$3,1,$4,at-interval '1 second',at+interval '10 minutes',at-interval '10 minutes',at-interval '10 minutes'
      FROM anchor`,
    [expiredTurnId,waitingGrantId,projectId,`sha256:${'0'.repeat(64)}`]);
    await expect(coordination.renew(working.context,{grantId:waitingGrantId,turnId:expiredTurnId},'expired-renew'))
      .rejects.toMatchObject({code:'CONFLICT'});
    await expect(coordination.release(working.context,{grantId:waitingGrantId,turnId:expiredTurnId,reason:'Expired.'},'expired-release'))
      .rejects.toMatchObject({code:'CONFLICT'});
    await expect(coordination.complete(working.context,{grantId:waitingGrantId,turnId:expiredTurnId,plan:completedPlan},'expired-complete'))
      .rejects.toMatchObject({code:'CONFLICT'});

    const tokenGrant=await coordination.createGrant(reviewers[2]!,{agentTokenId:contexts[2]!.tokenId,maxTurns:2},'token-fence-grant');
    const tokenTurn=await coordination.claim(contexts[2]!,{grantId:tokenGrant.grant.id},'token-fence-claim');
    expect(tokenTurn.state).toBe('WORKING');
    await pool!.query('UPDATE motive.participation_agent_tokens SET revoked_at=clock_timestamp() WHERE id=$1',[contexts[2]!.tokenId]);
    await expect(coordination.renew(contexts[2]!,{grantId:tokenGrant.grant.id,turnId:tokenTurn.turn!.id},'token-fence-renew'))
      .rejects.toMatchObject({code:'FORBIDDEN'});

    const roleGrant=await coordination.createGrant(reviewers[3]!,{agentTokenId:contexts[3]!.tokenId,maxTurns:2},'role-fence-grant');
    const roleTurn=await coordination.claim(contexts[3]!,{grantId:roleGrant.grant.id},'role-fence-claim');expect(roleTurn.state).toBe('WORKING');
    await pool!.query('UPDATE motive.memberships SET revoked_at=clock_timestamp() WHERE project_id=$1 AND actor_id=$2',[projectId,reviewers[3]]);
    await expect(coordination.complete(contexts[3]!,{grantId:roleGrant.grant.id,turnId:roleTurn.turn!.id,plan:completedPlan},'role-fence-complete'))
      .rejects.toMatchObject({code:'FORBIDDEN'});

    const accountGrant=await coordination.createGrant(reviewers[4]!,{agentTokenId:contexts[4]!.tokenId,maxTurns:2},'account-fence-grant');
    const accountTurn=await coordination.claim(contexts[4]!,{grantId:accountGrant.grant.id},'account-fence-claim');expect(accountTurn.state).toBe('WORKING');
    active.delete(reviewers[4]!);
    await expect(coordination.release(contexts[4]!,{grantId:accountGrant.grant.id,turnId:accountTurn.turn!.id,reason:'Unavailable.'},'account-fence-release'))
      .rejects.toMatchObject({code:'UNAUTHORIZED'});
    active.add(reviewers[4]!);const revoked=await coordination.revokeGrant(reviewers[4]!,accountGrant.grant.id,'account-revoke-grant');
    expect(revoked.grant.status).toBe('REVOKED');
    await expect(coordination.renew(contexts[4]!,{grantId:accountGrant.grant.id,turnId:accountTurn.turn!.id},'revoked-grant-renew'))
      .rejects.toMatchObject({code:'FORBIDDEN'});
  },20_000);
});
