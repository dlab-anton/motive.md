import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { applyPostgresMigrations, getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { encryptSecret } from '../../server/funding/vault.ts';
import { createParticipationService, type ParticipationService } from '../../server/participation/index.ts';
import { createHypothesisSubmissionAdmissionService, createHypothesisSubmissionDeliveryService,
  } from '../../server/research-memory/index.ts';
import { createResearchReviewQueueService } from '../../server/research-memory/review-queue.ts';

const baseUrl=process.env.MOTIVE_TEST_DATABASE_URL,pgDescribe=baseUrl?describe:describe.skip;
const vaultKey=Buffer.alloc(32,71),apiBaseUrl='https://queue-engine.invalid/api/v1';
function urls(raw:string,name:string){const source=new URL(raw),base=decodeURIComponent(source.pathname.slice(1));
  if(!['postgres:','postgresql:'].includes(source.protocol)||!['127.0.0.1','localhost'].includes(source.hostname)||!base||source.search||source.hash)
    throw new Error('MOTIVE_TEST_DATABASE_URL must be a plain loopback PostgreSQL URL.');
  const admin=new URL(source),test=new URL(source);admin.pathname='/postgres';test.pathname=`/${name}`;return{admin:admin.toString(),test:test.toString()};}

pgDescribe('bounded reviewer queue agents on isolated PostgreSQL',()=>{
  const requestedDatabaseName=process.env.MOTIVE_REVIEW_QUEUE_TEST_DATABASE_NAME;
  const databaseName=requestedDatabaseName&&/^motive_review_queue_[a-f0-9]{32}$/.test(requestedDatabaseName)
    ?requestedDatabaseName:`motive_review_queue_${randomUUID().replaceAll('-','')}`,issuer=`operator:${randomUUID()}`,
    owner=`account:${randomUUID()}`,reviewers=Array.from({length:8},()=>`account:${randomUUID()}`),active=new Set<string>([owner,...reviewers]);
  let admin:Pool|undefined,pool:Pool|undefined,created=false,participation:ParticipationService,projectId:string,workOrderId:string,scopeId:string,witness:string;
  let engineCalls=0;let admission:ReturnType<typeof createHypothesisSubmissionAdmissionService>;
  const queueSecret=`queue-${'q'.repeat(48)}`,childSecret=`child-${'c'.repeat(48)}`;
  const queue=()=>createResearchReviewQueueService({pool:pool!,admission,tokenSecret:queueSecret,isActorActive:async actor=>active.has(actor)});

  beforeAll(async()=>{const target=urls(baseUrl!,databaseName);admin=new Pool({connectionString:target.admin,max:1});
    await admin.query(`CREATE DATABASE ${databaseName}`);created=true;pool=new Pool({connectionString:target.test,max:8,statement_timeout:30_000});
    await applyPostgresMigrations(pool);expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    const functionAcl=await pool.query(`SELECT procedure.proname,coalesce(bool_or(access.grantee=0 AND access.privilege_type='EXECUTE'),false) AS public_execute
      FROM pg_proc procedure JOIN pg_namespace namespace ON namespace.oid=procedure.pronamespace
      LEFT JOIN LATERAL aclexplode(coalesce(procedure.proacl,acldefault('f',procedure.proowner))) access ON true
      WHERE namespace.nspname='motive' AND procedure.proname=ANY($1::text[]) GROUP BY procedure.proname ORDER BY procedure.proname`,[ [
        'guard_project_review_queue_agent_grant_insert','guard_project_review_queue_agent_grant_update',
        'guard_project_review_queue_agent_claim','guard_hypothesis_submission_admission_agent_queue_binding'] ]);
    expect(functionAcl.rows).toHaveLength(4);expect(functionAcl.rows.every(row=>row.public_execute===false)).toBe(true);
    projectId=(await new LedgerKernel(pool).createProject({actorId:issuer,idempotencyKey:randomUUID(),slug:'circle-packing',visibility:'PUBLIC',
      revisionContent:{title:'Review queue agent test'}})).id;
    for(const actor of [owner,...reviewers])await pool.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at)
      VALUES($1,'supabase',$2,'ACTIVE',clock_timestamp())`,[actor,actor.slice(8)]);
    await pool.query(`INSERT INTO motive.memberships(id,project_id,actor_id,role,scopes,granted_by) VALUES($1,$2,$3,'OWNER',ARRAY['project:admin'],$4)`,
      [randomUUID(),projectId,owner,issuer]);
    for(const actor of reviewers)await pool.query(`INSERT INTO motive.memberships(id,project_id,actor_id,role,scopes,granted_by)
      VALUES($1,$2,$3,'REVIEWER',ARRAY['project:review'],$4)`,[randomUUID(),projectId,actor,issuer]);
    participation=createParticipationService(pool,{tokenSecret:`participation-${'p'.repeat(48)}`,issuerActorId:issuer,
      isActorActive:async actor=>active.has(actor)});workOrderId=(await participation.ensureCircleWorkOrder()).id;
    witness=await readFile('public/projects/circle-packing/reference-witness.json','utf8');scopeId=randomUUID();
    await pool.query(`INSERT INTO motive.project_research_scopes(id,project_id,provider,api_base_url,tenant_id,channel_id,channel_name,
      channel_snapshot,channel_snapshot_digest,encrypted_api_key,credential_fingerprint,configuration_digest,api_version,
      inspected_source_revision,status,bound_by,verified_at) VALUES($1,$2,'hypothesis-engine',$3,$4,$5,'circle-packing','{}'::jsonb,
      $6,$7,$8,$9,'1.8.0',$10,'CONNECTED',$11,clock_timestamp())`,[scopeId,projectId,apiBaseUrl,randomUUID(),randomUUID(),
      `sha256:${'a'.repeat(64)}`,encryptSecret(vaultKey,`he_${'k'.repeat(43)}`,`research-scope:v1:${scopeId}:${projectId}`),
      `sha256:${'b'.repeat(64)}`,`sha256:${'d'.repeat(64)}`,'7'.repeat(40),owner]);
    const delivery=createHypothesisSubmissionDeliveryService({pool,vaultKey,isActorActive:async actor=>active.has(actor),
      fetch:async()=>{engineCalls+=1;throw new Error('Engine calls are forbidden.');}});
    admission=createHypothesisSubmissionAdmissionService({pool,vaultKey,isActorActive:async actor=>active.has(actor),sender:delivery,
      agentTokenSecret:childSecret});
  },45_000);

  afterAll(async()=>{await pool?.end();if(admin)try{if(created){await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',[databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);expect((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[databaseName])).rowCount).toBe(0);}}
    finally{await admin.end();}},30_000);

  async function completed(label:string,contributor=`account:${randomUUID()}`){active.add(contributor);
    await pool!.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at) VALUES($1,'supabase',$2,'ACTIVE',clock_timestamp())
      ON CONFLICT DO NOTHING`,[contributor,contributor.slice(8)]);
    const joined=await participation.join(contributor,`Contributor ${label}`,{projectSlug:'circle-packing',publishDisplayName:false,
      acceptReferenceTerms:true},`join-${randomUUID()}`);const context=await participation.authenticateBearer(joined.token);
    const claim=await participation.claimAssignment(context,workOrderId,`claim-${randomUUID()}`);if(claim.leaseEpoch===null)throw new Error('missing lease');
    await participation.declareAssignmentIntent(context,workOrderId,{leaseEpoch:claim.leaseEpoch,proposal:`Test ${label}.`,
      expectation:`Record ${label}.`,conditions:['Use the protected checker.']},`intent-${randomUUID()}`);
    const submission=await participation.submitWitness(context,workOrderId,{leaseEpoch:claim.leaseEpoch,witness,investigation:{
      format:'motive.investigation.v1',proposal:`Test ${label}.`,expectation:`Record ${label}.`,conditions:['Use the protected checker.'],
      observations:[`${label} completed.`],assessment:'The result is bounded.',nextAction:'Independent memory review.'}},`submit-${randomUUID()}`);
    const report=await pool!.query('SELECT report_digest FROM motive.participation_submission_artifacts WHERE submission_id=$1',[submission.id]);
    await participation.createPostCheckAssessment(context,submission.id,{reportDigest:String(report.rows[0].report_digest),
      assessment:'The protected report is available.',nextAction:'Assess this exact package.'},`post-${randomUUID()}`);
    await participation.completeAssignment(context,workOrderId,{leaseEpoch:claim.leaseEpoch,submissionId:submission.id},`complete-${randomUUID()}`);
    return{submissionId:submission.id,contributor};}
  async function grant(actor:string,maxDecisions:number){return queue().createGrant(actor,{maxDecisions},`grant-${randomUUID()}`);}

  it('serializes selection, binds retries and quota, and makes no engine calls',async()=>{const first=await completed('race');
    const q1=queue(),q2=queue(),[g1,g1Replay]=await Promise.all([
      q1.createGrant(reviewers[0],{maxDecisions:1},'same-grant-key'),q1.createGrant(reviewers[0],{maxDecisions:1},'same-grant-key')]);
    expect(g1Replay).toEqual(g1);const g2=await q2.createGrant(reviewers[1],{maxDecisions:4},'second-grant-key');
    const c1=await q1.authenticate(g1.token),c2=await q2.authenticate(g2.token),key1='race-claim-one',key2='race-claim-two';
    const raced=await Promise.all([q1.claim(c1,key1),q2.claim(c2,key2)]),working=raced.find(item=>item.state==='WORKING')!,empty=raced.find(item=>item.state==='EMPTY')!;
    expect(working.assignment?.submissionId).toBe(first.submissionId);expect(empty.retryAfterSeconds).toBe(30);
    expect((await pool!.query(`SELECT expires_at-created_at>interval '2 minutes' AS review_window
      FROM motive.hypothesis_submission_admission_agent_access WHERE id=$1`,[working.assignment!.access.id])).rows[0].review_window).toBe(true);
    const winner=working.grant.id===g1.grant.id?{service:q1,context:c1,key:key1}:{service:q2,context:c2,key:key2};
    const loser=working.grant.id===g1.grant.id?{service:q2,context:c2,key:key2}:{service:q1,context:c1,key:key1};
    const winnerActor=working.grant.id===g1.grant.id?reviewers[0]:reviewers[1],accountProjection=await winner.service.listGrants(winnerActor);
    expect(accountProjection.grants.find(item=>item.id===working.grant.id)?.currentAssignment).toMatchObject({submissionId:first.submissionId,
      question:'Test race.'});expect(JSON.stringify(accountProjection)).not.toContain(working.assignment!.token);
    const second=await completed('after-empty');expect((await loser.service.claim(loser.context,loser.key)).state).toBe('EMPTY');
    const next=await loser.service.claim(loser.context,'new-after-empty');expect(next.assignment?.submissionId).toBe(second.submissionId);
    const child=await admission.authenticateReviewAgent(working.assignment!.token);const body={decision:'ADMIT' as const,
      rationale:'This exact bounded result is useful shared memory.'};const decided=await admission.decideAdmissionFromAgent(child,body,'queue-decision-1');
    const original=await winner.service.claim(winner.context,winner.key);expect(original.assignment).toMatchObject({submissionId:first.submissionId,
      access:{status:'CONSUMED'}});expect(await admission.decideAdmissionFromAgent(
        await admission.authenticateReviewAgent(working.assignment!.token,true),body,'queue-decision-retry')).toEqual(decided);
    if(winner.context.grantId===g1.grant.id)expect((await winner.service.claim(winner.context,'over-quota-claim')).state).toBe('EXHAUSTED');
    await admission.decideAdmissionFromAgent(await admission.authenticateReviewAgent(next.assignment!.token),{decision:'ADMIT',
      rationale:'Retain the second exact bounded package.'},'queue-decision-2');
    const quotaSource=await completed('quota-guard');await expect(pool!.query(`INSERT INTO motive.project_review_queue_agent_claims
      (id,grant_id,project_id,submission_id,claim_idempotency_key,claim_request_digest,assignment_expires_at)
      VALUES($1,$2,$3,$4,'quota-guard-key',$5,clock_timestamp()+interval '1 minute')`,
    [randomUUID(),g1.grant.id,projectId,quotaSource.submissionId,`sha256:${'9'.repeat(64)}`])).rejects.toMatchObject({code:'42501'});
    const quotaPreview=await admission.prepareAdmissionPreview(reviewers[3],quotaSource.submissionId);await admission.decideAdmission(reviewers[3],quotaSource.submissionId,
      {packageDigest:quotaPreview.packageDigest,expectedDecisionId:null,decision:'ADMIT',rationale:'Close the quota guard fixture.'},'close-quota');
    expect((await pool!.query('SELECT count(*)::int count FROM motive.project_review_queue_agent_claims WHERE submission_id=$1',[first.submissionId])).rows[0].count).toBe(1);
    await q1.revokeGrant(reviewers[0],g1.grant.id,'close-first-grant');await q2.revokeGrant(reviewers[1],g2.grant.id,'close-second-grant');expect(engineCalls).toBe(0);
  },60_000);

  it('makes release replay durable, exposes stale packages, and fences revoked or lost authority',async()=>{
    const service=queue(),issued=await grant(reviewers[2],4),context=await service.authenticate(issued.token);
    const source=await completed('release');const claimed=await service.claim(context,'release-claim-key');expect(claimed.assignment?.submissionId).toBe(source.submissionId);
    const releaseBody={reason:'The cited evidence cannot be assessed within this session.'},released=await service.release(context,releaseBody,'release-key-1');
    expect((await service.release(context,releaseBody,'release-key-1'))).toEqual(released);
    await expect(service.release(context,{reason:'A changed reason must conflict.'},'release-key-1')).rejects.toMatchObject({code:'CONFLICT'});
    const releasedPreview=await admission.prepareAdmissionPreview(reviewers[3],source.submissionId);await admission.decideAdmission(reviewers[3],source.submissionId,
      {packageDigest:releasedPreview.packageDigest,expectedDecisionId:null,decision:'ADMIT',rationale:'Close the released fixture after verifying replay.'},'close-released');
    const changed=await completed('changed-package'),next=await service.claim(context,'changed-package-key');expect(next.assignment?.submissionId).toBe(changed.submissionId);
    const preview=await admission.prepareAdmissionPreview(reviewers[3],changed.submissionId);await admission.decideAdmission(reviewers[3],changed.submissionId,
      {packageDigest:preview.packageDigest,expectedDecisionId:null,decision:'DECLINE',rationale:'Advance the package tail for a stale-access check.'},'advance-tail-key');
    expect((await service.state(context)).assignment?.access.status).toBe('STALE');await service.release(context,{reason:'The frozen package is stale.'},'release-stale-key');
    const revokedSource=await completed('revoke'),revokedClaim=await service.claim(context,'revoke-child-key');expect(revokedClaim.assignment?.submissionId).toBe(revokedSource.submissionId);
    expect((await service.revokeGrant(reviewers[2],issued.grant.id,'revoke-parent-key')).grant.status).toBe('REVOKED');
    await expect(service.state(context)).rejects.toMatchObject({code:'FORBIDDEN'});
    await expect(admission.authenticateReviewAgent(revokedClaim.assignment!.token)).rejects.toMatchObject({code:'UNAUTHORIZED'});
    const revokedPreview=await admission.prepareAdmissionPreview(reviewers[3],revokedSource.submissionId);await admission.decideAdmission(reviewers[3],revokedSource.submissionId,
      {packageDigest:revokedPreview.packageDigest,expectedDecisionId:null,decision:'ADMIT',rationale:'Close the revoked-parent fixture.'},'close-revoked');

    const roleService=queue(),roleGrant=await grant(reviewers[4],2),roleContext=await roleService.authenticate(roleGrant.token),roleSource=await completed('role-loss');
    const roleClaim=await roleService.claim(roleContext,'role-loss-claim');expect(roleClaim.assignment?.submissionId).toBe(roleSource.submissionId);
    await pool!.query('UPDATE motive.memberships SET revoked_at=clock_timestamp() WHERE project_id=$1 AND actor_id=$2',[projectId,reviewers[4]]);
    await expect(roleService.state(roleContext)).rejects.toMatchObject({code:'FORBIDDEN'});
    await expect(admission.authenticateReviewAgent(roleClaim.assignment!.token)).rejects.toMatchObject({code:'UNAUTHORIZED'});
    const rolePreview=await admission.prepareAdmissionPreview(reviewers[3],roleSource.submissionId);await admission.decideAdmission(reviewers[3],roleSource.submissionId,
      {packageDigest:rolePreview.packageDigest,expectedDecisionId:null,decision:'ADMIT',rationale:'Close the role-loss fixture.'},'close-role-loss');
    expect(engineCalls).toBe(0);
  },60_000);

  it('hands expired reservations to another reviewer and recovers the child-link crash boundary',async()=>{
    const a=queue(),b=queue(),ga=await grant(reviewers[5],3),gb=await grant(reviewers[6],3),ca=await a.authenticate(ga.token),cb=await b.authenticate(gb.token);
    const self=await completed('self-denial',reviewers[5]);await expect(pool!.query(`INSERT INTO motive.project_review_queue_agent_claims
      (id,grant_id,project_id,submission_id,claim_idempotency_key,claim_request_digest,assignment_expires_at)
      VALUES($1,$2,$3,$4,'self-denial-key',$5,clock_timestamp()+interval '1 minute')`,
    [randomUUID(),ga.grant.id,projectId,self.submissionId,`sha256:${'8'.repeat(64)}`])).rejects.toMatchObject({code:'42501'});
    const selfPreview=await admission.prepareAdmissionPreview(reviewers[3],self.submissionId);await admission.decideAdmission(reviewers[3],self.submissionId,
      {packageDigest:selfPreview.packageDigest,expectedDecisionId:null,decision:'ADMIT',rationale:'Close the self-denial fixture.'},'close-self');
    const expiring=await completed('expiry-handoff'),claimId=randomUUID();
    await pool!.query(`INSERT INTO motive.project_review_queue_agent_claims(id,grant_id,project_id,submission_id,claim_idempotency_key,
      claim_request_digest,assignment_expires_at) VALUES($1,$2,$3,$4,'manual-expiry-key',$5,clock_timestamp()+interval '50 milliseconds')`,
    [claimId,ga.grant.id,projectId,expiring.submissionId,`sha256:${'e'.repeat(64)}`]);
    await new Promise(resolve=>setTimeout(resolve,80));const handed=await b.claim(cb,'handoff-claim-key');expect(handed.assignment?.submissionId).toBe(expiring.submissionId);
    expect((await pool!.query('SELECT expired_at IS NOT NULL AS expired FROM motive.project_review_queue_agent_claims WHERE id=$1',[claimId])).rows[0].expired).toBe(true);
    await b.release(cb,{reason:'Release the handoff fixture.'},'handoff-release-key');

    const crashSource=await completed('child-link-crash');await pool!.query(`CREATE FUNCTION motive.test_fail_queue_child_link() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD.child_access_id IS NULL AND NEW.child_access_id IS NOT NULL THEN RAISE EXCEPTION 'injected child link failure'; END IF; RETURN NEW; END $$`);
    await pool!.query(`CREATE TRIGGER test_fail_queue_child_link BEFORE UPDATE ON motive.project_review_queue_agent_claims
      FOR EACH ROW EXECUTE FUNCTION motive.test_fail_queue_child_link()`);
    await expect(a.claim(ca,'crash-claim-key')).rejects.toThrow('injected child link failure');
    const orphan=await pool!.query(`SELECT access.id,access.queue_grant_id,access.revoked_at FROM motive.hypothesis_submission_admission_agent_access access
      WHERE access.queue_grant_id=$1 AND access.submission_id=$2`,[ga.grant.id,crashSource.submissionId]);
    expect(orphan.rows).toHaveLength(1);expect(orphan.rows[0]).toMatchObject({queue_grant_id:ga.grant.id,revoked_at:null});
    await pool!.query('DROP TRIGGER test_fail_queue_child_link ON motive.project_review_queue_agent_claims');
    await pool!.query('DROP FUNCTION motive.test_fail_queue_child_link()');
    const recovered=await a.claim(ca,'crash-claim-key');expect(recovered.assignment).toMatchObject({submissionId:crashSource.submissionId,
      access:{id:orphan.rows[0].id,status:'READY'}});
    await a.revokeGrant(reviewers[5],ga.grant.id,'crash-parent-revoke');
    expect((await pool!.query('SELECT revoked_at IS NOT NULL AS revoked FROM motive.hypothesis_submission_admission_agent_access WHERE id=$1',[orphan.rows[0].id])).rows[0].revoked).toBe(true);
    const expiringGrantId=randomUUID(),expiringRaw=`motive_review_queue_${expiringGrantId.replaceAll('-','')}_${createHmac('sha256',queueSecret)
      .update(`motive-review-queue-agent-v1\0${expiringGrantId}\0${reviewers[3]}`).digest('base64url')}`;
    await pool!.query(`INSERT INTO motive.project_review_queue_agent_grants(id,project_id,reviewer_actor_id,review_kind,max_decisions,
      token_digest,token_hint,issuance_idempotency_key,issuance_request_digest,expires_at)
      VALUES($1,$2,$3,'MEMORY_ADMISSION',1,$4,$5,'short-expiry-key',$6,clock_timestamp()+interval '50 milliseconds')`,
    [expiringGrantId,projectId,reviewers[3],`sha256:${createHash('sha256').update(expiringRaw).digest('hex')}`,
      createHash('sha256').update(expiringRaw).digest('hex').slice(-12),`sha256:${'7'.repeat(64)}`]);
    const expiredContext=await a.authenticate(expiringRaw);await new Promise(resolve=>setTimeout(resolve,80));
    await expect(a.state(expiredContext)).rejects.toMatchObject({code:'FORBIDDEN'});
    expect(engineCalls).toBe(0);
  },60_000);

  it('records two successive decisions in one two-decision session without retargeting the first claim key',async()=>{
    await completed('two-decision-a');await completed('two-decision-b');const service=queue();
    const issued=await grant(reviewers[7],2),context=await service.authenticate(issued.token),callsBefore=engineCalls;
    const first=await service.claim(context,'two-decision-claim-a');expect(first.state).toBe('WORKING');
    const firstSubmission=first.assignment!.submissionId,firstAccess=first.assignment!.access.id;
    await admission.decideAdmissionFromAgent(await admission.authenticateReviewAgent(first.assignment!.token),{
      decision:'ADMIT',rationale:'The first package is useful bounded shared memory.'},'two-decision-review-a');
    const afterFirst=await service.state(context);expect(afterFirst).toMatchObject({state:'AVAILABLE',assignment:null,
      grant:{decisionsUsed:1,remainingDecisions:1}});
    const second=await service.claim(context,'two-decision-claim-b');expect(second.state).toBe('WORKING');
    expect(second.assignment!.submissionId).not.toBe(firstSubmission);
    const replayedFirst=await service.claim(context,'two-decision-claim-a');expect(replayedFirst.assignment).toMatchObject({
      submissionId:firstSubmission,access:{id:firstAccess,status:'CONSUMED'}});
    expect(replayedFirst.assignment!.submissionId).not.toBe(second.assignment!.submissionId);
    await admission.decideAdmissionFromAgent(await admission.authenticateReviewAgent(second.assignment!.token),{
      decision:'ADMIT',rationale:'The second package is independently useful bounded shared memory.'},'two-decision-review-b');
    expect(await service.state(context)).toMatchObject({state:'EXHAUSTED',assignment:null,
      grant:{decisionsUsed:2,remainingDecisions:0}});
    const counted=await pool!.query(`SELECT count(*)::int AS claims,count(DISTINCT consumed_decision_id)::int AS decisions
      FROM motive.project_review_queue_agent_claims WHERE grant_id=$1 AND consumed_at IS NOT NULL`,[issued.grant.id]);
    expect(counted.rows[0]).toEqual({claims:2,decisions:2});expect(engineCalls).toBe(callsBefore);
  },60_000);
});
