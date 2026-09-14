import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { digestCanonicalJson } from '../../packages/domain/src/contracts.ts';
import { applyPostgresMigrations, getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { createParticipationService, ParticipationError, type ParticipationService } from '../../server/participation/index.ts';

const baseUrl=process.env.MOTIVE_TEST_DATABASE_URL;
const pgDescribe=baseUrl?describe:describe.skip;

pgDescribe('research journal pagination on isolated PostgreSQL',()=>{
  const databaseName=`motive_research_journal_${randomUUID().replaceAll('-','')}`;
  const issuer=`operator:research-journal-${randomUUID()}`;
  const tokenSecret='research-journal-test-secret-longer-than-thirty-two-bytes';
  let admin:Pool;let pool:Pool;let service:ParticipationService;let projectId:string;let assignmentId:string;let testUrl:string;

  beforeAll(async()=>{
    const source=new URL(baseUrl!);
    expect(['localhost','127.0.0.1']).toContain(source.hostname);
    const adminUrl=new URL(source);adminUrl.pathname='/postgres';
    admin=new Pool({connectionString:adminUrl.toString(),max:1});await admin.query(`CREATE DATABASE ${databaseName}`);
    const isolated=new URL(source);isolated.pathname=`/${databaseName}`;testUrl=isolated.toString();
    pool=new Pool({connectionString:testUrl,max:4});await applyPostgresMigrations(pool);
    expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    projectId=(await new LedgerKernel(pool).createProject({actorId:issuer,idempotencyKey:randomUUID(),slug:'circle-packing',
      visibility:'PUBLIC',revisionContent:{title:'Research journal pagination test'}})).id;
    service=createParticipationService(pool,{tokenSecret,issuerActorId:issuer});
    assignmentId=(await service.ensureCircleWorkOrder()).id;
  },30_000);

  afterAll(async()=>{
    await pool?.end();
    if(admin){await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',[databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);await admin.end();}
  });

  async function participant(name:string,publish=false,owner=`account:${randomUUID()}`){
    await pool.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at)
      VALUES($1,'supabase',$2,'ACTIVE',clock_timestamp())`,[owner,randomUUID()]);
    const joined=await service.join(owner,name,{projectSlug:'circle-packing',publishDisplayName:publish,
      acceptReferenceTerms:true},`join-${randomUUID()}`);
    const context=await service.authenticateBearer(joined.token);
    const claim=await service.claimAssignment(context,assignmentId,`claim-${randomUUID()}`);
    return{owner,joined,context,claim};
  }

  async function insertSubmission(input:{projectId:string;workOrderId:string;tokenId:string;claimId:string;
    leaseEpoch:number;createdAt:string;id?:string;motiveReferences?:Array<{
      submissionId:string;reportDigest:string;artifactDigest:string}>;provenanceOverride?:Record<string,unknown>}){
    const id=input.id??randomUUID();const witness=Buffer.from(`{"journal":"${id}"}`);
    const witnessDigest=digestCanonicalJson({kind:'journal-witness',id});
    const reportBody={format:'journal-test-report',submissionId:id};const reportDigest=digestCanonicalJson(reportBody);
    const provenance=input.provenanceOverride??(input.motiveReferences?
      {investigation:{investigation:{motiveReferences:input.motiveReferences}}}:{});
    await pool.query(`INSERT INTO motive.submissions
      (id,project_id,work_order_id,work_order_revision,origin,operator_actor_id,claim_id,lease_epoch,format,base_commit,
       artifact_manifest_digest,provenance,usage_status,license_acceptance_ref,status,created_at)
      SELECT $1,$2,$3,work.revision,'EXTERNAL','agent:' || token.id::text,$4,$5,'motive.submission/0.1',$6,$7,
        $8::jsonb,'unmetered_external',token.license_acceptance_ref,'REJECTED',$9::timestamptz
      FROM motive.work_orders work JOIN motive.participation_agent_tokens token ON token.id=$10
      WHERE work.id=$3`,[id,input.projectId,input.workOrderId,input.claimId,input.leaseEpoch,'0'.repeat(40),
      digestCanonicalJson({kind:'journal-manifest',id}),JSON.stringify(provenance),input.createdAt,input.tokenId]);
    await pool.query(`INSERT INTO motive.participation_submission_artifacts
      (submission_id,project_id,agent_token_id,witness_format,witness_bytes,witness_digest,report,report_body,
       report_digest,contributor_display_name,created_at)
      SELECT $1,$2,token.id,'motive.csqv.witness.v1',$3,$4,'REJECTED',$5::jsonb,$6,token.public_display_name,$7::timestamptz
      FROM motive.participation_agent_tokens token WHERE token.id=$8`,[id,input.projectId,witness,witnessDigest,
      JSON.stringify(reportBody),reportDigest,input.createdAt,input.tokenId]);
    return id;
  }

  async function foreignSubmission(createdAt:string,motiveReferences?:Array<{
    submissionId:string;reportDigest:string;artifactDigest:string}>){
    const foreignIssuer=`operator:foreign-journal-${randomUUID()}`;
    const foreignProject=(await new LedgerKernel(pool).createProject({actorId:foreignIssuer,idempotencyKey:randomUUID(),
      slug:`foreign-${randomUUID()}`,visibility:'PUBLIC',revisionContent:{title:'Foreign journal project'}})).id;
    const sourceWork=(await pool.query('SELECT * FROM motive.work_orders WHERE id=$1',[assignmentId])).rows[0];
    const workOrderId=randomUUID();const terms={...(sourceWork.terms as Record<string,unknown>),project_id:foreignProject};
    const termsDigest=digestCanonicalJson(terms);
    await pool.query(`INSERT INTO motive.work_orders
      (id,project_id,work_order_key,revision,project_revision,terms_format,terms,terms_digest,created_by)
      VALUES($1,$2,'foreign-journal',1,1,'motive.work-order/0.1',$3::jsonb,$4,$5)`,
    [workOrderId,foreignProject,JSON.stringify(terms),termsDigest,foreignIssuer]);
    await pool.query(`INSERT INTO motive.work_order_states(work_order_id,state,state_revision,updated_by)
      VALUES($1,'READY',1,$2)`,[workOrderId,foreignIssuer]);
    const owner=`account:${randomUUID()}`,tokenId=randomUUID(),claimId=randomUUID();
    await pool.query(`INSERT INTO motive.participation_agent_tokens
      (id,project_id,owner_actor_id,agent_name,public_display_name,token_digest,token_hint,license_acceptance_ref,expires_at)
      VALUES($1,$2,$3,'Foreign journal agent','Foreign journal contributor',$4,$5,'journal-test',clock_timestamp()+interval '1 day')`,
    [tokenId,foreignProject,owner,digestCanonicalJson({tokenId}),'f'.repeat(12)]);
    await pool.query(`INSERT INTO motive.work_claims
      (id,project_id,work_order_id,operator_actor_id,origin,slot,lease_epoch,terms_digest,status,expires_at,released_at)
      VALUES($1,$2,$3,$4,'EXTERNAL',1,1,$5,'RELEASED',clock_timestamp()+interval '1 day',clock_timestamp())`,
    [claimId,foreignProject,workOrderId,`agent:${tokenId}`,termsDigest]);
    return insertSubmission({projectId:foreignProject,workOrderId,tokenId,claimId,leaseEpoch:1,createdAt,motiveReferences});
  }

  it('traverses 41 immutable entries with exact keysets and preserves all historical owner credentials',async()=>{
    const contributor=await participant('Private journal owner');const originalIds:string[]=[];
    for(let index=0;index<41;index+=1){
      const microseconds=String(index===21?21:index+1).padStart(6,'0');
      originalIds.push(await insertSubmission({projectId,workOrderId:assignmentId,tokenId:contributor.context.tokenId,
        claimId:contributor.claim.claimId!,leaseEpoch:contributor.claim.leaseEpoch!,
        createdAt:`2026-09-09T01:00:00.${microseconds}Z`}));
    }
    const ordered=(await pool.query(`SELECT submission.id::text FROM motive.submissions submission
      JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=submission.id
      WHERE submission.project_id=$1 ORDER BY submission.created_at DESC,submission.id DESC`,[projectId])).rows.map(row=>String(row.id));
    expect(ordered).toHaveLength(41);
    const first=await service.publicResearchJournal();
    expect(first.items.map(item=>item.submission.id)).toEqual(ordered.slice(0,20));
    expect(first.nextCursor).toBe(ordered[19]);
    expect(JSON.stringify(first)).not.toContain(contributor.owner);
    for(const item of first.items){expect(item.update.submissionId).toBe(item.submission.id);
      expect(item.submission.contributorDisplayName).toBeNull();expect(item.update.contributorDisplayName).toBeNull();}

    const insertedBetweenPages=await insertSubmission({projectId,workOrderId:assignmentId,tokenId:contributor.context.tokenId,
      claimId:contributor.claim.claimId!,leaseEpoch:contributor.claim.leaseEpoch!,createdAt:'2026-09-09T01:00:01.000001Z'});
    const second=await service.publicResearchJournal(first.nextCursor!);
    const third=await service.publicResearchJournal(second.nextCursor!);
    expect([...first.items,...second.items,...third.items].map(item=>item.submission.id)).toEqual(ordered);
    expect(second.nextCursor).toBe(ordered[39]);expect(third.items.map(item=>item.submission.id)).toEqual(ordered.slice(40));
    expect(third.nextCursor).toBeNull();expect(second.items.some(item=>item.submission.id===insertedBetweenPages)).toBe(false);
    const focused=await service.publicResearchJournalEntry(ordered.at(-1)!);
    expect(focused.submission.id).toBe(ordered.at(-1));expect(focused.update.submissionId).toBe(ordered.at(-1));

    const historicalSubmissionIds:string[]=[];
    for(let index=0;index<12;index+=1){
      historicalSubmissionIds.push(await insertSubmission({projectId,workOrderId:assignmentId,
        tokenId:contributor.context.tokenId,claimId:contributor.claim.claimId!,leaseEpoch:contributor.claim.leaseEpoch!,
        createdAt:`2026-09-09T00:59:59.${String(index+1).padStart(6,'0')}Z`}));
    }

    for(let index=0;index<51;index+=1){const tokenId=randomUUID(),digest=digestCanonicalJson({owner:contributor.owner,index});
      await pool.query(`INSERT INTO motive.participation_agent_tokens
        (id,project_id,owner_actor_id,agent_name,token_digest,token_hint,license_acceptance_ref,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,'journal-test',clock_timestamp()+interval '1 day')`,
      [tokenId,projectId,contributor.owner,`Historical journal token ${index}`,digest,digest.slice(-12)]);}
    await pool.query(`UPDATE motive.participation_agent_tokens SET revoked_at=clock_timestamp() WHERE id=$1`,
      [contributor.context.tokenId]);
    const tokenCount=await pool.query(`SELECT count(*)::integer AS count FROM motive.participation_agent_tokens
      WHERE project_id=$1 AND owner_actor_id=$2`,[projectId,contributor.owner]);
    expect(tokenCount.rows[0].count).toBe(52);
    const ownedIds:string[]=[];let ownedCursor:string|undefined;
    do{const page=await service.ownedResearchJournal(contributor.owner,ownedCursor);ownedIds.push(...page.items.map(item=>item.submission.id));
      ownedCursor=page.nextCursor??undefined;}while(ownedCursor);
    expect(ownedIds).toHaveLength(54);expect(ownedIds.length).toBeGreaterThan(50);
    expect(ownedIds).toContain(ordered.at(-1));expect(ownedIds).toContain(insertedBetweenPages);
    expect(ownedIds).toContain(historicalSubmissionIds[0]);
    expect(JSON.stringify(await service.ownedResearchJournal(contributor.owner))).not.toContain(contributor.owner);
    const requested=[...historicalSubmissionIds,...originalIds,insertedBetweenPages];
    const ownership=await service.submissionOwnership(contributor.owner,requested);
    expect(requested).toHaveLength(54);expect(ownership).toEqual({format:'motive.submission-ownership/0.1',
      ownedSubmissionIds:requested});
    expect(JSON.stringify(ownership)).not.toContain(contributor.owner);
  },30_000);

  it('rejects missing, cross-project, and foreign-owner cursors without widening scope',async()=>{
    const owner=await participant('Shared journal identity',true);
    const ownerSubmission=await insertSubmission({projectId,workOrderId:assignmentId,tokenId:owner.context.tokenId,
      claimId:owner.claim.claimId!,leaseEpoch:owner.claim.leaseEpoch!,createdAt:'2026-09-09T02:00:00.000001Z'});
    const other=await participant('Shared journal identity',true);
    const otherSubmission=await insertSubmission({projectId,workOrderId:assignmentId,tokenId:other.context.tokenId,
      claimId:other.claim.claimId!,leaseEpoch:other.claim.leaseEpoch!,createdAt:'2026-09-09T02:00:00.000002Z'});
    const foreign=await foreignSubmission('2026-09-09T02:00:00.000003Z');
    const missing=randomUUID();
    for(const action of [
      ()=>service.publicResearchJournal(randomUUID()),()=>service.publicResearchJournal(foreign),
      ()=>service.ownedResearchJournal(owner.owner,otherSubmission),()=>service.ownedResearchJournal(owner.owner,missing),
      ()=>service.publicResearchJournalEntry(foreign),
    ])await expect(action()).rejects.toMatchObject({code:'NOT_FOUND'} satisfies Partial<ParticipationError>);
    await expect(service.ownedResearchJournal(owner.owner,ownerSubmission.toUpperCase())).rejects.toMatchObject({code:'VALIDATION'});
    expect((await service.ownedResearchJournal(owner.owner)).items.map(item=>item.submission.id)).toContain(ownerSubmission);
    expect((await service.ownedResearchJournal(owner.owner)).items.map(item=>item.submission.id)).not.toContain(otherSubmission);
    expect(await service.submissionOwnership(owner.owner,[otherSubmission,ownerSubmission,foreign,missing])).toEqual({
      format:'motive.submission-ownership/0.1',ownedSubmissionIds:[ownerSubmission]});
  },30_000);

  it('lists only later exact direct citations and paginates within that filtered sequence',async()=>{
    const source=await participant('Citation source contributor',true);
    const target=await insertSubmission({projectId,workOrderId:assignmentId,tokenId:source.context.tokenId,
      claimId:source.claim.claimId!,leaseEpoch:source.claim.leaseEpoch!,
      createdAt:'2026-09-10T01:00:00.500000Z',provenanceOverride:{investigation:{investigation:{
        proposal:'Legacy proposal must yield to the retained public question.'}}}});
    const alternateTarget=await insertSubmission({projectId,workOrderId:assignmentId,tokenId:source.context.tokenId,
      claimId:source.claim.claimId!,leaseEpoch:source.claim.leaseEpoch!,
      createdAt:'2026-09-10T01:00:00.600000Z',provenanceOverride:{investigation:{investigation:{
        proposal:'What did the legacy experiment ask?'}}}});
    const uncited=await insertSubmission({projectId,workOrderId:assignmentId,tokenId:source.context.tokenId,
      claimId:source.claim.claimId!,leaseEpoch:source.claim.leaseEpoch!,
      createdAt:'2026-09-10T01:00:00.650000Z'});
    const absentLabelTarget=await insertSubmission({projectId,workOrderId:assignmentId,tokenId:source.context.tokenId,
      claimId:source.claim.claimId!,leaseEpoch:source.claim.leaseEpoch!,
      createdAt:'2026-09-10T01:00:00.625000Z'});
    const targetReport=(await pool.query(`SELECT report_digest FROM motive.participation_submission_artifacts
      WHERE submission_id=$1 AND project_id=$2`,[target,projectId])).rows[0];
    await pool.query(`INSERT INTO motive.participation_post_check_assessments
      (submission_id,project_id,agent_token_id,report_digest,assessment,next_action,request_digest,public_question,public_finding)
      VALUES($1,$2,$3,$4,'Retain the modern summary.','Continue carefully.',$5,$6,$7)`,
    [target,projectId,source.context.tokenId,targetReport.report_digest,digestCanonicalJson({target,kind:'post-check'}),
      'What did the modern retained experiment ask?','It retained a bounded answer.']);
    const references=await pool.query(`SELECT submission_id::text,report_digest,witness_digest
      FROM motive.participation_submission_artifacts WHERE submission_id=ANY($1::uuid[]) AND project_id=$2`,
    [[target,alternateTarget,absentLabelTarget],projectId]);
    const referenceFor=(submissionId:string)=>{const row=references.rows.find(item=>item.submission_id===submissionId);
      return{submissionId,reportDigest:String(row.report_digest),artifactDigest:String(row.witness_digest)};};
    const reference=referenceFor(target);const alternateReference=referenceFor(alternateTarget);
    const absentLabelReference=referenceFor(absentLabelTarget);

    const matchingContributor=await participant('Exact citation contributor',true);
    await service.declareAssignmentIntent(matchingContributor.context,assignmentId,{
      leaseEpoch:matchingContributor.claim.leaseEpoch!,proposal:'Test a later result that directly cites the exact target.',
      expectation:'The later-work query will include only the exact immutable target reference.',
      conditions:['Use the declared Motive reference.'],motiveReferences:[reference]},`declare-${randomUUID()}`);
    const earlier=await insertSubmission({projectId,workOrderId:assignmentId,tokenId:matchingContributor.context.tokenId,
      claimId:matchingContributor.claim.claimId!,leaseEpoch:matchingContributor.claim.leaseEpoch!,
      createdAt:'2026-09-10T01:00:00.400000Z',motiveReferences:[reference]});
    const mismatchContributor=await participant('Other-target citation contributor',true);
    await service.declareAssignmentIntent(mismatchContributor.context,assignmentId,{
      leaseEpoch:mismatchContributor.claim.leaseEpoch!,proposal:'Test a later result that cites a different exact target.',
      expectation:'A citation to another target will not appear in this target sequence.',
      conditions:['Use the other declared Motive reference.'],motiveReferences:[alternateReference]},`declare-${randomUUID()}`);
    const mismatch=await insertSubmission({projectId,workOrderId:assignmentId,tokenId:mismatchContributor.context.tokenId,
      claimId:mismatchContributor.claim.claimId!,leaseEpoch:mismatchContributor.claim.leaseEpoch!,
      createdAt:'2026-09-10T01:00:00.700000Z',motiveReferences:[alternateReference]});
    const absentLabelContributor=await participant('No-label citation contributor',true);
    await service.declareAssignmentIntent(absentLabelContributor.context,assignmentId,{
      leaseEpoch:absentLabelContributor.claim.leaseEpoch!,proposal:'Cite a source without a retained question or proposal.',
      expectation:'The citation identity remains available with a null question.',
      conditions:['Use the declared unlabeled Motive reference.'],motiveReferences:[absentLabelReference]},`declare-${randomUUID()}`);
    const absentLabelCitation=await insertSubmission({projectId,workOrderId:assignmentId,
      tokenId:absentLabelContributor.context.tokenId,claimId:absentLabelContributor.claim.claimId!,
      leaseEpoch:absentLabelContributor.claim.leaseEpoch!,createdAt:'2026-09-10T01:00:00.750000Z',
      motiveReferences:[absentLabelReference]});
    const foreignRow=await foreignSubmission('2026-09-10T01:00:00.800000Z');
    let malformed:string,wrongReport:string,wrongArtifact:string,foreignCiting:string;
    await pool.query('ALTER TABLE motive.submissions DISABLE TRIGGER submission_motive_references_guard');
    try{
      malformed=await insertSubmission({projectId,workOrderId:assignmentId,tokenId:source.context.tokenId,
        claimId:source.claim.claimId!,leaseEpoch:source.claim.leaseEpoch!,createdAt:'2026-09-10T01:00:00.850000Z',
        provenanceOverride:{investigation:{investigation:{motiveReferences:{malformed:true}}}}});
      wrongReport=await insertSubmission({projectId,workOrderId:assignmentId,tokenId:source.context.tokenId,
        claimId:source.claim.claimId!,leaseEpoch:source.claim.leaseEpoch!,createdAt:'2026-09-10T01:00:00.860000Z',
        motiveReferences:[{...reference,reportDigest:digestCanonicalJson({wrong:'report'})}]});
      wrongArtifact=await insertSubmission({projectId,workOrderId:assignmentId,tokenId:source.context.tokenId,
        claimId:source.claim.claimId!,leaseEpoch:source.claim.leaseEpoch!,createdAt:'2026-09-10T01:00:00.870000Z',
        motiveReferences:[{...reference,artifactDigest:digestCanonicalJson({wrong:'artifact'})}]});
      foreignCiting=await foreignSubmission('2026-09-10T01:00:00.880000Z',[reference]);
    }
    finally{await pool.query('ALTER TABLE motive.submissions ENABLE TRIGGER submission_motive_references_guard');}

    const matching:string[]=[];
    for(let index=0;index<22;index+=1){matching.push(await insertSubmission({projectId,workOrderId:assignmentId,
      tokenId:matchingContributor.context.tokenId,claimId:matchingContributor.claim.claimId!,leaseEpoch:matchingContributor.claim.leaseEpoch!,
      createdAt:`2026-09-10T01:00:01.${String(index+1).padStart(6,'0')}Z`,motiveReferences:[reference]}));}
    const ordered=[...matching].reverse();
    const first=await service.publicResearchCitations(target);
    expect(first.items.map(item=>item.submission.id)).toEqual(ordered.slice(0,20));
    expect(first.items.map(item=>item.submission.id)).not.toContain(foreignRow);
    expect(first.items.map(item=>item.submission.id)).not.toContain(foreignCiting!);
    expect(first.nextCursor).toBe(ordered[19]);
    expect(first.items[0]?.update.citedEarlierMotiveSubmissions).toEqual([{
      submissionId:target,agentName:source.joined.credential.agentName,
      question:'What did the modern retained experiment ask?',
      reportHref:`/api/public/projects/circle-packing/submissions/${target}/report`,
      investigationHref:`/api/public/projects/circle-packing/submissions/${target}/investigation`,
      postCheckAssessmentHref:`/api/public/projects/circle-packing/submissions/${target}/post-check-assessment`}]);
    expect((await service.publicResearchJournalEntry(mismatch)).update.citedEarlierMotiveSubmissions).toEqual([{
      submissionId:alternateTarget,agentName:source.joined.credential.agentName,question:'What did the legacy experiment ask?',
      reportHref:`/api/public/projects/circle-packing/submissions/${alternateTarget}/report`,
      investigationHref:`/api/public/projects/circle-packing/submissions/${alternateTarget}/investigation`,
      postCheckAssessmentHref:null}]);
    expect((await service.publicResearchJournalEntry(absentLabelCitation)).update.citedEarlierMotiveSubmissions).toEqual([{
      submissionId:absentLabelTarget,agentName:source.joined.credential.agentName,question:null,
      reportHref:`/api/public/projects/circle-packing/submissions/${absentLabelTarget}/report`,
      investigationHref:null,postCheckAssessmentHref:null}]);
    const second=await service.publicResearchCitations(target,first.nextCursor!);
    expect(second.items.map(item=>item.submission.id)).toEqual(ordered.slice(20));
    expect(second.nextCursor).toBeNull();

    expect(await service.publicResearchCitations(uncited)).toEqual({format:'motive.research-journal-page/0.1',
      items:[],nextCursor:null});
    for(const cursor of [uncited,earlier,mismatch,malformed!,wrongReport!,wrongArtifact!,foreignCiting!]){
      await expect(service.publicResearchCitations(target,cursor)).rejects.toMatchObject({code:'NOT_FOUND'});
    }
    const foreign=await foreignSubmission('2026-09-10T01:00:02.000000Z');
    for(const missing of [foreign,randomUUID()]){
      await expect(service.publicResearchCitations(missing)).rejects.toMatchObject({code:'NOT_FOUND'});
    }
  },30_000);

  it('keeps the page query count fixed as the journal grows',async()=>{
    const owned=(await pool.query(`SELECT token.owner_actor_id,artifact.submission_id::text
      FROM motive.participation_submission_artifacts artifact
      JOIN motive.participation_agent_tokens token ON token.id=artifact.agent_token_id
      WHERE artifact.project_id=$1 LIMIT 1`,[projectId])).rows[0];
    const countedPool=new Pool({connectionString:testUrl,max:1});let queries=0;const instrumented=new WeakSet<PoolClient>();
    const connect=countedPool.connect.bind(countedPool);
    Object.defineProperty(countedPool,'connect',{value:async()=>{const client=await connect();const query=client.query.bind(client);
      if(!instrumented.has(client)){client.query=((...args:unknown[])=>{queries+=1;
        return (query as unknown as (...values:unknown[])=>unknown)(...args);}) as PoolClient['query'];instrumented.add(client);}
      return client;}});
    try{
      const counted=createParticipationService(countedPool,{tokenSecret,issuerActorId:issuer});
      const page=await counted.publicResearchJournal();expect(page.items).toHaveLength(20);expect(queries).toBe(4);
      queries=0;
      expect(await counted.submissionOwnership(String(owned.owner_actor_id),[String(owned.submission_id)])).toEqual({
        format:'motive.submission-ownership/0.1',ownedSubmissionIds:[String(owned.submission_id)]});
      expect(queries).toBe(4);
    }finally{await countedPool.end();}
  },30_000);
});
