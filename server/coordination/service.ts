import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { digestCanonicalJson } from '../../packages/domain/src/contracts.ts';
import {
  COMMUNITY_COORDINATION_CLASSIFICATION,
  COMMUNITY_COORDINATION_PROJECT_SLUG,
  isClaimCommunityCoordinationTurnInput,
  isCommunityCoordinationPlanInput,
  isCompleteCommunityCoordinationTurnInput,
  isCreateCommunityCoordinationGrantInput,
  isReleaseCommunityCoordinationTurnInput,
  isRenewCommunityCoordinationTurnInput,
  type ClaimCommunityCoordinationTurnInput,
  type CommunityCoordinationAccountState,
  type CommunityCoordinationAgentState,
  type CommunityCoordinationGrant,
  type CommunityCoordinationPlanInput,
  type CommunityCoordinationPlanRecord,
  type CommunityCoordinationTurn,
  type CompleteCommunityCoordinationTurnInput,
  type CreateCommunityCoordinationGrantInput,
  type CreateCommunityCoordinationGrantResponse,
  type PublicCommunityCoordinationPlan,
  type PublicCommunityCoordinationProjection,
  type ReleaseCommunityCoordinationTurnInput,
  type RenewCommunityCoordinationTurnInput,
} from '../../src/lib/community-coordination.ts';
import type { SubmissionResearchContext } from '../../src/lib/participation.ts';
import type { ParticipationAgentContext } from '../participation/service.ts';

type Operation = 'GRANT' | 'REVOKE' | 'CLAIM' | 'RENEW' | 'RELEASE' | 'COMPLETE';
type RequestOutcome = 'CREATED' | 'REVOKED' | 'ASSIGNED' | 'WAITING' | 'EXHAUSTED' | 'RENEWED' | 'RELEASED' | 'COMPLETED';
type PriorRequest = { operation: Operation; outcome: RequestOutcome; resourceId: string | null };

export type CommunityCoordinationServiceOptions = Readonly<{
  pool: Pool;
  isActorActive(actorId: string): Promise<boolean>;
  assertContext?(client: PoolClient, projectId: string, context: SubmissionResearchContext): Promise<void>;
  now?: () => Date;
}>;

export class CommunityCoordinationError extends Error {
  readonly statusCode: number;
  constructor(readonly code: 'VALIDATION' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT', message: string) {
    super(message); this.name = 'CommunityCoordinationError';
    this.statusCode = code === 'VALIDATION' ? 400 : code === 'UNAUTHORIZED' ? 401 : code === 'FORBIDDEN' ? 403
      : code === 'NOT_FOUND' ? 404 : 409;
  }
}

function fail(code: CommunityCoordinationError['code'], message: string): never { throw new CommunityCoordinationError(code, message); }
function text(row: QueryResultRow, key: string): string { if (typeof row[key] !== 'string') fail('CONFLICT', `${key} is invalid.`); return row[key]; }
function iso(value: unknown): string { const date = value instanceof Date ? value : new Date(String(value)); if (!Number.isFinite(date.getTime())) fail('CONFLICT', 'Stored date is invalid.'); return date.toISOString(); }

export class CommunityCoordinationService {
  constructor(private readonly options: CommunityCoordinationServiceOptions) {}

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.options.pool.connect();
    try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  private turn(row: QueryResultRow): CommunityCoordinationTurn {
    const status: CommunityCoordinationTurn['status'] = row.completed_at ? 'COMPLETED' : row.released_at ? 'RELEASED'
      : row.expired_at || new Date(row.expires_at).getTime() <= (this.options.now?.() ?? new Date()).getTime() ? 'EXPIRED' : 'ACTIVE';
    return { id: text(row, 'id'), grantId: text(row, 'grant_id'), projectSlug: COMMUNITY_COORDINATION_PROJECT_SLUG,
      signalDigest: text(row, 'research_signal_digest'), status, expiresAt: iso(row.expires_at), hardExpiresAt: iso(row.hard_expires_at),
      releasedAt: row.released_at ? iso(row.released_at) : null, releaseReason: row.release_reason === null ? null : text(row, 'release_reason'),
      completedAt: row.completed_at ? iso(row.completed_at) : null, createdAt: iso(row.created_at) };
  }

  private grant(row: QueryResultRow): CommunityCoordinationGrant {
    const used = Number(row.turns_used ?? 0), max = Number(row.max_turns), expired = new Date(row.expires_at).getTime() <= (this.options.now?.() ?? new Date()).getTime();
    const status: CommunityCoordinationGrant['status'] = row.revoked_at ? 'REVOKED' : expired ? 'EXPIRED' : used >= max ? 'EXHAUSTED' : 'ACTIVE';
    return { id: text(row, 'id'), projectSlug: COMMUNITY_COORDINATION_PROJECT_SLUG, agentTokenId: text(row, 'agent_token_id'),
      status, maxTurns: max, turnsUsed: used, remainingTurns: Math.max(0, max-used), expiresAt: iso(row.expires_at),
      revokedAt: row.revoked_at ? iso(row.revoked_at) : null, firstSeenAt: row.first_seen_at ? iso(row.first_seen_at) : null,
      lastSeenAt: row.last_seen_at ? iso(row.last_seen_at) : null, currentTurn: row.turn_id ? this.turn({ ...row, id: row.turn_id,
        grant_id: row.id, research_signal_digest: row.turn_signal_digest, expires_at: row.turn_expires_at,
        hard_expires_at: row.turn_hard_expires_at, released_at: row.turn_released_at, release_reason: row.turn_release_reason,
        expired_at: row.turn_expired_at, completed_at: row.turn_completed_at, created_at: row.turn_created_at }) : null,
      createdAt: iso(row.created_at) };
  }

  private grantSql(where: string): string { return `SELECT grant_row.*,
    (SELECT count(*)::integer FROM motive.community_coordination_turns used WHERE used.grant_id=grant_row.id) turns_used,
    current.id turn_id,current.research_signal_digest turn_signal_digest,current.expires_at turn_expires_at,
    current.hard_expires_at turn_hard_expires_at,current.released_at turn_released_at,current.release_reason turn_release_reason,
    current.expired_at turn_expired_at,current.completed_at turn_completed_at,current.created_at turn_created_at
    FROM motive.community_coordination_grants grant_row LEFT JOIN LATERAL (
      SELECT turn.* FROM motive.community_coordination_turns turn WHERE turn.grant_id=grant_row.id
        AND turn.released_at IS NULL AND turn.expired_at IS NULL AND turn.completed_at IS NULL
      ORDER BY turn.created_at DESC,turn.id DESC LIMIT 1) current ON true WHERE ${where}`; }

  private async project(client: PoolClient): Promise<QueryResultRow> {
    const found = await client.query("SELECT id,current_revision FROM motive.projects WHERE slug=$1 AND visibility='PUBLIC'", [COMMUNITY_COORDINATION_PROJECT_SLUG]);
    if (found.rowCount !== 1) fail('NOT_FOUND', 'Community coordination project is unavailable.'); return found.rows[0];
  }

  private async mutationLocks(client:PoolClient,projectId:string,actorId:string):Promise<void>{
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`community-coordination:project:${projectId}`]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`community-coordination:actor:${actorId}`]);
  }

  private async authority(client: PoolClient, actorId: string, agentTokenId?: string, lock = false): Promise<QueryResultRow | null> {
    const project = await this.project(client);
    const params: unknown[] = [project.id, actorId];
    const tokenClause = agentTokenId ? 'AND token.id=$3' : '';
    if (agentTokenId) params.push(agentTokenId);
    const found = await client.query(`SELECT project.id project_id,project.current_revision,token.id agent_token_id,token.agent_name,
      token.public_display_name,token.expires_at token_expires_at,membership.role
      FROM motive.projects project JOIN motive.memberships membership ON membership.project_id=project.id AND membership.actor_id=$2
      JOIN motive.account_identities identity ON identity.actor_id=membership.actor_id
      JOIN motive.participation_agent_tokens token ON token.project_id=project.id AND token.owner_actor_id=membership.actor_id ${tokenClause}
      WHERE project.id=$1 AND membership.revoked_at IS NULL AND membership.role IN ('OWNER','STEWARD','REVIEWER')
        AND identity.status='ACTIVE' AND token.revoked_at IS NULL AND token.expires_at>clock_timestamp()
      ORDER BY token.created_at DESC,token.id DESC${lock ? ' FOR SHARE OF membership,identity,token' : ''}`, params);
    return found.rows[0] ?? null;
  }

  private async participant(client:PoolClient,context:ParticipationAgentContext):Promise<boolean>{
    const found=await client.query(`SELECT 1 FROM motive.participation_agent_tokens token
      JOIN motive.account_identities identity ON identity.actor_id=token.owner_actor_id
      JOIN motive.memberships membership ON membership.project_id=token.project_id AND membership.actor_id=token.owner_actor_id
      WHERE token.id=$1 AND token.project_id=$2 AND token.owner_actor_id=$3 AND token.revoked_at IS NULL
        AND token.expires_at>clock_timestamp() AND identity.status='ACTIVE' AND membership.revoked_at IS NULL
      FOR SHARE OF token,identity,membership`,[context.tokenId,context.projectId,context.ownerActorId]);
    return found.rowCount===1;
  }

  private async prior(client: PoolClient, actorId: string, key: string, operation: Operation, requestDigest: string): Promise<PriorRequest | null> {
    if (!/^[A-Za-z0-9._~-]{8,200}$/.test(key)) fail('VALIDATION', 'A valid Idempotency-Key is required.');
    const found = await client.query(`SELECT operation,outcome,resource_id FROM motive.community_coordination_requests
      WHERE actor_id=$1 AND idempotency_key=$2 FOR UPDATE`, [actorId,key]);
    if (!found.rowCount) return null;
    const digest = await client.query(`SELECT request_digest FROM motive.community_coordination_requests WHERE actor_id=$1 AND idempotency_key=$2`,[actorId,key]);
    if (found.rows[0].operation !== operation || digest.rows[0].request_digest !== requestDigest) fail('CONFLICT', 'Idempotency-Key is bound to another coordination request.');
    return { operation, outcome: found.rows[0].outcome, resourceId: found.rows[0].resource_id };
  }

  private async remember(client: PoolClient, actorId: string, key: string, operation: Operation, requestDigest: string,
    outcome: RequestOutcome, resourceId: string | null): Promise<void> {
    await client.query(`INSERT INTO motive.community_coordination_requests(id,actor_id,idempotency_key,operation,request_digest,outcome,resource_id)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [randomUUID(),actorId,key,operation,requestDigest,outcome,resourceId]);
  }

  async accountState(actorId: string): Promise<CommunityCoordinationAccountState> {
    if (!/^account:[A-Za-z0-9._~-]+$/.test(actorId)) fail('UNAUTHORIZED', 'A live account is required.');
    const active = await this.options.isActorActive(actorId);
    return this.transaction(async client => {
      const project = await this.project(client);
      const membership = await client.query(`SELECT role FROM motive.memberships WHERE project_id=$1 AND actor_id=$2 AND revoked_at IS NULL`,[project.id,actorId]);
      const tokens = await client.query(`SELECT id,agent_name,expires_at FROM motive.participation_agent_tokens
        WHERE project_id=$1 AND owner_actor_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp() ORDER BY created_at DESC,id DESC LIMIT 50`,[project.id,actorId]);
      const grants = await client.query(`${this.grantSql('grant_row.project_id=$1 AND grant_row.owner_actor_id=$2')} ORDER BY grant_row.created_at DESC,grant_row.id DESC LIMIT 50`,[project.id,actorId]);
      const allowed = active && membership.rowCount === 1 && ['OWNER','STEWARD','REVIEWER'].includes(String(membership.rows[0].role));
      const reason: CommunityCoordinationAccountState['reason'] = !active ? 'ACCOUNT_INACTIVE' : !allowed ? 'MEMBERSHIP_REQUIRED'
        : !tokens.rowCount ? 'NO_ACTIVE_AGENT_TOKEN' : 'ELIGIBLE';
      return { format:'motive.community-coordination-account-state.v1',projectSlug:COMMUNITY_COORDINATION_PROJECT_SLUG,
        eligible:reason==='ELIGIBLE',reason,agentTokens:tokens.rows.map(row=>({id:text(row,'id'),agentName:text(row,'agent_name'),expiresAt:iso(row.expires_at)})),
        grants:grants.rows.map(row=>this.grant(row)) };
    });
  }

  async createGrant(actorId: string, input: CreateCommunityCoordinationGrantInput, idempotencyKey: string): Promise<CreateCommunityCoordinationGrantResponse> {
    if(!isCreateCommunityCoordinationGrantInput(input))fail('VALIDATION','Community coordination grant request is invalid.');
    const requestDigest=digestCanonicalJson({operation:'GRANT',input});
    if (!await this.options.isActorActive(actorId)) fail('UNAUTHORIZED','A current active account is required.');
    return this.transaction(async client=>{
      const project=await this.project(client);await this.mutationLocks(client,project.id,actorId);
      const prior=await this.prior(client,actorId,idempotencyKey,'GRANT',requestDigest);
      if(prior){const row=await client.query(this.grantSql('grant_row.id=$1 AND grant_row.owner_actor_id=$2'),[prior.resourceId,actorId]);
        if(row.rowCount!==1)fail('CONFLICT','Retained coordination grant is unavailable.');return{grant:this.grant(row.rows[0]),replayed:true};}
      if(!Number.isInteger(input.maxTurns)||input.maxTurns<1||input.maxTurns>5)fail('VALIDATION','Coordination maxTurns must be 1 through 5.');
      const authority=await this.authority(client,actorId,input.agentTokenId,true);if(!authority)fail('FORBIDDEN','Current approved project authority and participant token are required.');
      const existing=await client.query(`SELECT id FROM motive.community_coordination_grants grant_row
        WHERE agent_token_id=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp()
          AND ((SELECT count(*) FROM motive.community_coordination_turns used WHERE used.grant_id=grant_row.id)<grant_row.max_turns
            OR EXISTS(SELECT 1 FROM motive.community_coordination_turns open_turn WHERE open_turn.grant_id=grant_row.id
              AND open_turn.released_at IS NULL AND open_turn.expired_at IS NULL AND open_turn.completed_at IS NULL)) LIMIT 1`,[input.agentTokenId]);
      if(existing.rowCount)fail('CONFLICT','This participant token already has a coordination session; revoke it before reissuing.');
      const id=randomUUID();await client.query(`INSERT INTO motive.community_coordination_grants
        (id,project_id,agent_token_id,owner_actor_id,max_turns,issuance_idempotency_key,issuance_request_digest,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval '1 hour')`,
      [id,authority.project_id,input.agentTokenId,actorId,input.maxTurns,idempotencyKey,requestDigest]);
      await this.remember(client,actorId,idempotencyKey,'GRANT',requestDigest,'CREATED',id);
      const row=await client.query(this.grantSql('grant_row.id=$1'),[id]);return{grant:this.grant(row.rows[0]),replayed:false};
    });
  }

  async revokeGrant(actorId:string,grantId:string,idempotencyKey:string):Promise<{grant:CommunityCoordinationGrant;replayed:boolean}>{
    if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(grantId))fail('VALIDATION','Coordination grant id is invalid.');
    const requestDigest=digestCanonicalJson({operation:'REVOKE',grantId});if(!await this.options.isActorActive(actorId))fail('UNAUTHORIZED','A current active account is required.');
    return this.transaction(async client=>{const project=await this.project(client);await this.mutationLocks(client,project.id,actorId);
      const prior=await this.prior(client,actorId,idempotencyKey,'REVOKE',requestDigest);if(prior){const row=await client.query(this.grantSql('grant_row.id=$1 AND grant_row.owner_actor_id=$2'),[prior.resourceId,actorId]);
        if(row.rowCount!==1)fail('CONFLICT','Retained coordination grant is unavailable.');return{grant:this.grant(row.rows[0]),replayed:true};}
      const locked=await client.query('SELECT project_id FROM motive.community_coordination_grants WHERE id=$1 AND owner_actor_id=$2 FOR UPDATE',[grantId,actorId]);
      if(locked.rowCount!==1)fail('NOT_FOUND','Coordination grant was not found.');
      await client.query('UPDATE motive.community_coordination_grants SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE id=$1',[grantId]);
      await client.query(`UPDATE motive.community_coordination_turns SET released_at=clock_timestamp(),release_reason='Parent coordination session revoked.'
        WHERE grant_id=$1 AND released_at IS NULL AND expired_at IS NULL AND completed_at IS NULL`,[grantId]);
      await this.remember(client,actorId,idempotencyKey,'REVOKE',requestDigest,'REVOKED',grantId);
      const row=await client.query(this.grantSql('grant_row.id=$1'),[grantId]);return{grant:this.grant(row.rows[0]),replayed:false};});
  }

  private async signal(client:PoolClient,projectId:string):Promise<{digest:string;projectRevision:number}>{
    const result=await client.query(`SELECT project.current_revision,
      (SELECT jsonb_build_array(submission.id,artifact.report_digest,artifact.witness_digest,submission.created_at)
       FROM motive.submissions submission JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=submission.id
       WHERE submission.project_id=project.id ORDER BY submission.created_at DESC,submission.id DESC LIMIT 1) newest_submission,
      (SELECT jsonb_build_array(item.submission_id,item.request_digest,item.created_at) FROM motive.participation_post_check_assessments item
       WHERE item.project_id=project.id ORDER BY item.created_at DESC,item.submission_id DESC LIMIT 1) newest_post_check,
      (SELECT jsonb_build_array(item.submission_id,item.request_digest,item.solver_source_digest,item.trial_results_digest,item.created_at)
       FROM motive.participation_submission_reproducibility item WHERE item.project_id=project.id
       ORDER BY item.created_at DESC,item.submission_id DESC LIMIT 1) newest_reproducibility,
      (SELECT jsonb_build_array(item.id,item.request_digest,item.created_at) FROM motive.finding_review_decisions item
       WHERE item.project_id=project.id ORDER BY item.created_at DESC,item.id DESC LIMIT 1) newest_finding,
      (SELECT jsonb_build_array(item.id,item.request_digest,item.created_at) FROM motive.hypothesis_submission_delivery_admission_decisions item
       JOIN motive.hypothesis_submission_deliveries delivery ON delivery.id=item.delivery_id WHERE delivery.project_id=project.id
       ORDER BY item.created_at DESC,item.id DESC LIMIT 1) newest_admission
      FROM motive.projects project WHERE project.id=$1`,[projectId]);
    if(result.rowCount!==1)fail('NOT_FOUND','Community coordination project is unavailable.');const row=result.rows[0];
    const projectRevision=Number(row.current_revision);return{projectRevision,digest:digestCanonicalJson({projectRevision,
      newestSubmission:row.newest_submission,newestPostCheck:row.newest_post_check,newestReproducibility:row.newest_reproducibility,
      newestFinding:row.newest_finding,newestAdmission:row.newest_admission})};
  }

  private async fenceDepartures(client:PoolClient,projectId:string):Promise<void>{
    await client.query(`UPDATE motive.community_coordination_turns turn_row SET released_at=clock_timestamp(),
      release_reason='Coordinator authority became unavailable.' FROM motive.community_coordination_grants grant_row
      WHERE turn_row.grant_id=grant_row.id AND turn_row.project_id=$1 AND turn_row.released_at IS NULL AND turn_row.expired_at IS NULL
        AND turn_row.completed_at IS NULL AND (grant_row.revoked_at IS NOT NULL OR grant_row.expires_at<=clock_timestamp()
          OR NOT EXISTS(SELECT 1 FROM motive.participation_agent_tokens token JOIN motive.account_identities identity ON identity.actor_id=token.owner_actor_id
            JOIN motive.memberships membership ON membership.project_id=token.project_id AND membership.actor_id=token.owner_actor_id
            WHERE token.id=grant_row.agent_token_id AND token.project_id=grant_row.project_id AND token.owner_actor_id=grant_row.owner_actor_id
              AND token.revoked_at IS NULL AND token.expires_at>clock_timestamp() AND identity.status='ACTIVE' AND membership.revoked_at IS NULL
              AND membership.role IN ('OWNER','STEWARD','REVIEWER')))`,[projectId]);
    await client.query(`UPDATE motive.community_coordination_turns SET expired_at=clock_timestamp()
      WHERE project_id=$1 AND released_at IS NULL AND expired_at IS NULL AND completed_at IS NULL AND expires_at<=clock_timestamp()`,[projectId]);
  }

  private async lockGrant(client:PoolClient,context:ParticipationAgentContext,grantId:string,markSeen=true):Promise<{row:QueryResultRow;grant:CommunityCoordinationGrant}>{
    const found=await client.query(this.grantSql('grant_row.id=$1')+' FOR UPDATE OF grant_row',[grantId]);if(found.rowCount!==1)fail('NOT_FOUND','Coordination grant was not found.');
    const row=found.rows[0];if(row.agent_token_id!==context.tokenId||row.owner_actor_id!==context.ownerActorId||row.project_id!==context.projectId)
      fail('FORBIDDEN','Coordination grant does not belong to this participant token.');
    if(!await this.authority(client,context.ownerActorId,context.tokenId,true))
      fail('FORBIDDEN','Current coordination authority is unavailable.');
    let projection=this.grant(row);if(projection.status==='REVOKED'||projection.status==='EXPIRED')fail('FORBIDDEN','Coordination grant is no longer active.');
    if(markSeen){await client.query(`UPDATE motive.community_coordination_grants SET first_seen_at=coalesce(first_seen_at,clock_timestamp()),last_seen_at=clock_timestamp() WHERE id=$1`,[grantId]);
      const refreshed=await client.query(this.grantSql('grant_row.id=$1'),[grantId]);projection=this.grant(refreshed.rows[0]);return{row:refreshed.rows[0],grant:projection};}
    return{row,grant:projection};
  }

  private async planIsCurrent(client:PoolClient,projectId:string,signalDigest:string):Promise<boolean>{
    const found=await client.query(`SELECT 1 FROM motive.community_coordination_plans plan JOIN motive.community_coordination_grants grant_row ON grant_row.id=plan.grant_id
      JOIN motive.participation_agent_tokens token ON token.id=grant_row.agent_token_id JOIN motive.account_identities identity ON identity.actor_id=grant_row.owner_actor_id
      JOIN motive.memberships membership ON membership.project_id=grant_row.project_id AND membership.actor_id=grant_row.owner_actor_id
      WHERE plan.project_id=$1 AND plan.research_signal_digest=$2 AND grant_row.revoked_at IS NULL
        AND token.revoked_at IS NULL AND identity.status='ACTIVE' AND membership.revoked_at IS NULL
        AND membership.role IN ('OWNER','STEWARD','REVIEWER') LIMIT 1`,[projectId,signalDigest]);return found.rowCount===1;
  }

  private async agentState(client:PoolClient,context:ParticipationAgentContext,grant?:CommunityCoordinationGrant,retainedTurnId?:string):Promise<CommunityCoordinationAgentState>{
    if(!grant){const found=await client.query(`${this.grantSql('grant_row.agent_token_id=$1 AND grant_row.owner_actor_id=$2 AND grant_row.revoked_at IS NULL AND grant_row.expires_at>clock_timestamp()')}
      ORDER BY grant_row.created_at DESC,grant_row.id DESC LIMIT 1`,[context.tokenId,context.ownerActorId]);if(!found.rowCount)return{format:'motive.community-coordination-agent-state.v1',state:'NOT_ENROLLED',grant:null,turn:null,retryAfterSeconds:null};grant=this.grant(found.rows[0]);}
    if(retainedTurnId){const retained=await client.query('SELECT * FROM motive.community_coordination_turns WHERE id=$1 AND grant_id=$2',[retainedTurnId,grant.id]);
      if(retained.rowCount===1){const turn=this.turn(retained.rows[0]);return{format:'motive.community-coordination-agent-state.v1',state:turn.status==='ACTIVE'?'WORKING':grant.status==='EXHAUSTED'?'EXHAUSTED':'AVAILABLE',grant,turn,retryAfterSeconds:null};}}
    if(grant.currentTurn?.status==='ACTIVE')return{format:'motive.community-coordination-agent-state.v1',state:'WORKING',grant,turn:grant.currentTurn,retryAfterSeconds:null};
    if(grant.status==='EXHAUSTED')return{format:'motive.community-coordination-agent-state.v1',state:'EXHAUSTED',grant,turn:null,retryAfterSeconds:null};
    const signal=await this.signal(client,context.projectId),open=await client.query(`SELECT 1 FROM motive.community_coordination_turns WHERE project_id=$1
      AND released_at IS NULL AND expired_at IS NULL AND completed_at IS NULL AND expires_at>clock_timestamp() LIMIT 1`,[context.projectId]);
    const waiting=Boolean(open.rowCount)||await this.planIsCurrent(client,context.projectId,signal.digest);
    return{format:'motive.community-coordination-agent-state.v1',state:waiting?'WAITING':'AVAILABLE',grant,turn:null,retryAfterSeconds:waiting?60:null};
  }

  async state(context:ParticipationAgentContext):Promise<CommunityCoordinationAgentState>{
    if(!await this.options.isActorActive(context.ownerActorId))fail('UNAUTHORIZED','A current active account is required.');
    return this.transaction(async client=>{
    const project=await this.project(client);if(project.id!==context.projectId)fail('FORBIDDEN','This token is not scoped to the coordination project.');
    await this.mutationLocks(client,context.projectId,context.ownerActorId);
    if(!await this.participant(client,context))fail('FORBIDDEN','Current participant identity is unavailable.');
    await this.fenceDepartures(client,context.projectId);
    const initial=await this.agentState(client,context);if(!initial.grant)return initial;const current=await this.lockGrant(client,context,initial.grant.id);return this.agentState(client,context,current.grant);});}

  async claim(context:ParticipationAgentContext,input:ClaimCommunityCoordinationTurnInput,idempotencyKey:string):Promise<CommunityCoordinationAgentState>{
    if(!isClaimCommunityCoordinationTurnInput(input))fail('VALIDATION','Community coordination claim request is invalid.');
    if(!await this.options.isActorActive(context.ownerActorId))fail('UNAUTHORIZED','A current active account is required.');
    const requestDigest=digestCanonicalJson({operation:'CLAIM',input});return this.transaction(async client=>{
      await this.mutationLocks(client,context.projectId,context.ownerActorId);
      const prior=await this.prior(client,context.ownerActorId,idempotencyKey,'CLAIM',requestDigest),locked=await this.lockGrant(client,context,input.grantId);
      if(prior){if(prior.outcome==='WAITING')return{format:'motive.community-coordination-agent-state.v1',state:'WAITING',grant:locked.grant,turn:null,retryAfterSeconds:60};
        if(prior.outcome==='EXHAUSTED')return{format:'motive.community-coordination-agent-state.v1',state:'EXHAUSTED',grant:locked.grant,turn:null,retryAfterSeconds:null};
        return this.agentState(client,context,locked.grant,prior.resourceId??undefined);}
      await this.fenceDepartures(client,context.projectId);const refreshed=await this.lockGrant(client,context,input.grantId);
      if(refreshed.grant.status==='EXHAUSTED'){await this.remember(client,context.ownerActorId,idempotencyKey,'CLAIM',requestDigest,'EXHAUSTED',null);return this.agentState(client,context,refreshed.grant);}
      const existing=await client.query(`SELECT 1 FROM motive.community_coordination_turns WHERE project_id=$1 AND released_at IS NULL AND expired_at IS NULL
        AND completed_at IS NULL LIMIT 1`,[context.projectId]),signal=await this.signal(client,context.projectId);
      if(existing.rowCount||await this.planIsCurrent(client,context.projectId,signal.digest)){await this.remember(client,context.ownerActorId,idempotencyKey,'CLAIM',requestDigest,'WAITING',null);
        return{format:'motive.community-coordination-agent-state.v1',state:'WAITING',grant:refreshed.grant,turn:null,retryAfterSeconds:60};}
      const id=randomUUID();await client.query(`WITH anchor AS (SELECT clock_timestamp() at)
        INSERT INTO motive.community_coordination_turns
        (id,grant_id,project_id,project_revision,research_signal_digest,expires_at,hard_expires_at,last_seen_at,created_at)
        SELECT $1,$2,$3,$4,$5,least(anchor.at+interval '5 minutes',grant_row.expires_at),
          least(anchor.at+interval '30 minutes',grant_row.expires_at),anchor.at,anchor.at
        FROM anchor,motive.community_coordination_grants grant_row WHERE grant_row.id=$2`,
      [id,input.grantId,context.projectId,signal.projectRevision,signal.digest]);await this.remember(client,context.ownerActorId,idempotencyKey,'CLAIM',requestDigest,'ASSIGNED',id);
      const after=await this.lockGrant(client,context,input.grantId);return this.agentState(client,context,after.grant,id);});
  }

  private async exactTurn(client:PoolClient,grantId:string,turnId:string):Promise<QueryResultRow>{const found=await client.query(`SELECT *,expires_at<=clock_timestamp() lease_expired FROM motive.community_coordination_turns
    WHERE id=$1 AND grant_id=$2 FOR UPDATE`,[turnId,grantId]);if(found.rowCount!==1)fail('NOT_FOUND','Coordination turn was not found.');return found.rows[0];}

  async renew(context:ParticipationAgentContext,input:RenewCommunityCoordinationTurnInput,idempotencyKey:string):Promise<CommunityCoordinationAgentState>{
    if(!isRenewCommunityCoordinationTurnInput(input))fail('VALIDATION','Community coordination renewal request is invalid.');
    if(!await this.options.isActorActive(context.ownerActorId))fail('UNAUTHORIZED','A current active account is required.');
    const requestDigest=digestCanonicalJson({operation:'RENEW',input});return this.transaction(async client=>{await this.mutationLocks(client,context.projectId,context.ownerActorId);
      const prior=await this.prior(client,context.ownerActorId,idempotencyKey,'RENEW',requestDigest),locked=await this.lockGrant(client,context,input.grantId);if(prior)return this.agentState(client,context,locked.grant,prior.resourceId??undefined);
      const turn=await this.exactTurn(client,input.grantId,input.turnId);if(turn.project_id!==context.projectId||turn.released_at||turn.expired_at||turn.completed_at||turn.lease_expired)
        fail('CONFLICT','Coordination turn is no longer renewable.');
      await client.query(`UPDATE motive.community_coordination_turns SET expires_at=least(clock_timestamp()+interval '5 minutes',hard_expires_at),last_seen_at=clock_timestamp() WHERE id=$1`,[input.turnId]);
      await this.remember(client,context.ownerActorId,idempotencyKey,'RENEW',requestDigest,'RENEWED',input.turnId);const after=await this.lockGrant(client,context,input.grantId);return this.agentState(client,context,after.grant,input.turnId);});}

  async release(context:ParticipationAgentContext,input:ReleaseCommunityCoordinationTurnInput,idempotencyKey:string):Promise<{turn:CommunityCoordinationTurn;replayed:boolean}>{
    if(!isReleaseCommunityCoordinationTurnInput(input))fail('VALIDATION','Community coordination release request is invalid.');
    if(!await this.options.isActorActive(context.ownerActorId))fail('UNAUTHORIZED','A current active account is required.');
    const requestDigest=digestCanonicalJson({operation:'RELEASE',input});return this.transaction(async client=>{await this.mutationLocks(client,context.projectId,context.ownerActorId);
      const prior=await this.prior(client,context.ownerActorId,idempotencyKey,'RELEASE',requestDigest);await this.lockGrant(client,context,input.grantId);
      if(prior){const row=await this.exactTurn(client,input.grantId,prior.resourceId!);return{turn:this.turn(row),replayed:true};}
      const row=await this.exactTurn(client,input.grantId,input.turnId);if(row.project_id!==context.projectId||row.released_at||row.expired_at||row.completed_at||row.lease_expired)fail('CONFLICT','Coordination turn is no longer releasable.');
      const saved=await client.query(`UPDATE motive.community_coordination_turns SET released_at=clock_timestamp(),release_reason=$2,last_seen_at=clock_timestamp()
        WHERE id=$1 RETURNING *`,[input.turnId,input.reason]);await this.remember(client,context.ownerActorId,idempotencyKey,'RELEASE',requestDigest,'RELEASED',input.turnId);
      return{turn:this.turn(saved.rows[0]),replayed:false};});}

  private async assertReferences(client:PoolClient,projectId:string,plan:CommunityCoordinationPlanInput):Promise<void>{
    const references=plan.priorities.flatMap(priority=>priority.motiveReferences);const result=await client.query(`SELECT input.submission_id FROM
      jsonb_to_recordset($2::jsonb) input(submission_id uuid,report_digest text,artifact_digest text)
      JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=input.submission_id AND artifact.project_id=$1
        AND artifact.report_digest=input.report_digest AND artifact.witness_digest=input.artifact_digest
      JOIN motive.submissions submission ON submission.id=artifact.submission_id AND submission.project_id=artifact.project_id`,
    [projectId,JSON.stringify(references.map(reference=>({submission_id:reference.submissionId,report_digest:reference.reportDigest,artifact_digest:reference.artifactDigest})))]);
    if(result.rowCount!==references.length)fail('CONFLICT','Coordination evidence reference is unavailable or changed.');
  }

  private planRecord(row:QueryResultRow,replayed:boolean):CommunityCoordinationPlanRecord{return{id:text(row,'id'),turnId:text(row,'turn_id'),
    projectSlug:COMMUNITY_COORDINATION_PROJECT_SLUG,projectRevision:Number(row.project_revision),signalDigest:text(row,'research_signal_digest'),
    planDigest:text(row,'plan_digest'),classification:COMMUNITY_COORDINATION_CLASSIFICATION,plan:row.plan as CommunityCoordinationPlanInput,
    createdAt:iso(row.created_at),replayed};}

  async complete(context:ParticipationAgentContext,input:CompleteCommunityCoordinationTurnInput,idempotencyKey:string):Promise<CommunityCoordinationPlanRecord>{
    if(!isCompleteCommunityCoordinationTurnInput(input)||!isCommunityCoordinationPlanInput(input.plan))fail('VALIDATION','Community coordination plan is invalid.');const requestDigest=digestCanonicalJson({operation:'COMPLETE',input});
    if(!await this.options.isActorActive(context.ownerActorId))fail('UNAUTHORIZED','A current active account is required.');
    return this.transaction(async client=>{await this.mutationLocks(client,context.projectId,context.ownerActorId);
      const prior=await this.prior(client,context.ownerActorId,idempotencyKey,'COMPLETE',requestDigest);await this.lockGrant(client,context,input.grantId);
      if(prior){const found=await client.query('SELECT * FROM motive.community_coordination_plans WHERE id=$1',[prior.resourceId]);if(found.rowCount!==1)fail('CONFLICT','Retained coordination plan is unavailable.');return this.planRecord(found.rows[0],true);}
      const turn=await this.exactTurn(client,input.grantId,input.turnId),project=await this.project(client);
      if(turn.project_id!==context.projectId||turn.released_at||turn.expired_at||turn.completed_at||turn.lease_expired||Number(turn.project_revision)!==Number(project.current_revision))
        fail('CONFLICT','Coordination turn is no longer completable against the current project revision.');await this.assertReferences(client,context.projectId,input.plan);
      if(input.plan.researchContext){if(!this.options.assertContext)fail('CONFLICT','Retained research context validation is unavailable.');
        await this.options.assertContext(client,context.projectId,input.plan.researchContext);}
      const id=randomUUID(),planDigest=digestCanonicalJson(input.plan);const saved=await client.query(`INSERT INTO motive.community_coordination_plans
        (id,turn_id,grant_id,project_id,project_revision,research_signal_digest,plan,plan_digest)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING *`,[id,input.turnId,input.grantId,context.projectId,turn.project_revision,
        turn.research_signal_digest,JSON.stringify(input.plan),planDigest]);await client.query(`UPDATE motive.community_coordination_turns
        SET completed_at=clock_timestamp(),last_seen_at=clock_timestamp() WHERE id=$1`,[input.turnId]);
      await this.remember(client,context.ownerActorId,idempotencyKey,'COMPLETE',requestDigest,'COMPLETED',id);return this.planRecord(saved.rows[0],false);});}

  private publicPlan(row:QueryResultRow,currentSignal:string):PublicCommunityCoordinationPlan{const plan=row.plan as CommunityCoordinationPlanInput;
    return{id:text(row,'id'),projectRevision:Number(row.project_revision),signalDigest:text(row,'research_signal_digest'),planDigest:text(row,'plan_digest'),
      classification:COMMUNITY_COORDINATION_CLASSIFICATION,summary:plan.summary,limitations:plan.limitations,
      priorities:plan.priorities,memoryReferenced:Boolean(plan.researchContext),
      stale:row.research_signal_digest!==currentSignal||Number(row.project_revision)!==Number(row.current_revision),authorAvailable:Boolean(row.author_available),
      agentName:text(row,'agent_name'),publicDisplayName:row.public_display_name===null?null:text(row,'public_display_name'),createdAt:iso(row.created_at)};}

  async publicProjection():Promise<PublicCommunityCoordinationProjection>{return this.transaction(async client=>{const project=await this.project(client),signal=await this.signal(client,project.id);
    const plans=await client.query(`SELECT plan.*,project.current_revision,token.agent_name,token.public_display_name,
      (grant_row.revoked_at IS NULL AND token.revoked_at IS NULL
        AND identity.status='ACTIVE' AND membership.revoked_at IS NULL AND membership.role IN ('OWNER','STEWARD','REVIEWER')) author_available
      FROM motive.community_coordination_plans plan JOIN motive.projects project ON project.id=plan.project_id
      JOIN motive.community_coordination_grants grant_row ON grant_row.id=plan.grant_id JOIN motive.participation_agent_tokens token ON token.id=grant_row.agent_token_id
      JOIN motive.account_identities identity ON identity.actor_id=grant_row.owner_actor_id
      JOIN motive.memberships membership ON membership.project_id=grant_row.project_id AND membership.actor_id=grant_row.owner_actor_id
      WHERE plan.project_id=$1 ORDER BY plan.created_at DESC,plan.id DESC LIMIT 20`,[project.id]);
    const history=plans.rows.map(row=>this.publicPlan(row,signal.digest)),currentSuggestions=history.find(item=>item.authorAvailable)??null;
    const active=await client.query(`SELECT turn_row.id,turn_row.created_at,turn_row.expires_at,
      greatest(turn_row.last_seen_at,grant_row.last_seen_at) last_seen_at,token.agent_name,token.public_display_name
      FROM motive.community_coordination_turns turn_row JOIN motive.community_coordination_grants grant_row ON grant_row.id=turn_row.grant_id
      JOIN motive.participation_agent_tokens token ON token.id=grant_row.agent_token_id JOIN motive.account_identities identity ON identity.actor_id=grant_row.owner_actor_id
      JOIN motive.memberships membership ON membership.project_id=grant_row.project_id AND membership.actor_id=grant_row.owner_actor_id
      WHERE turn_row.project_id=$1 AND turn_row.released_at IS NULL AND turn_row.expired_at IS NULL AND turn_row.completed_at IS NULL
        AND turn_row.expires_at>clock_timestamp() AND grant_row.revoked_at IS NULL AND grant_row.expires_at>clock_timestamp()
        AND token.revoked_at IS NULL AND token.expires_at>clock_timestamp() AND identity.status='ACTIVE' AND membership.revoked_at IS NULL
        AND membership.role IN ('OWNER','STEWARD','REVIEWER') LIMIT 1`,[project.id]);
    const available=await client.query(`SELECT 1 FROM motive.community_coordination_grants grant_row
      JOIN motive.participation_agent_tokens token ON token.id=grant_row.agent_token_id
      JOIN motive.account_identities identity ON identity.actor_id=grant_row.owner_actor_id
      JOIN motive.memberships membership ON membership.project_id=grant_row.project_id AND membership.actor_id=grant_row.owner_actor_id
      WHERE grant_row.project_id=$1 AND grant_row.revoked_at IS NULL AND grant_row.expires_at>clock_timestamp()
        AND token.revoked_at IS NULL AND token.expires_at>clock_timestamp() AND identity.status='ACTIVE'
        AND membership.revoked_at IS NULL AND membership.role IN ('OWNER','STEWARD','REVIEWER')
        AND (SELECT count(*) FROM motive.community_coordination_turns used WHERE used.grant_id=grant_row.id)<grant_row.max_turns LIMIT 1`,[project.id]);
    const row=active.rows[0];return{format:'motive.community-coordination.public.v1',projectSlug:COMMUNITY_COORDINATION_PROJECT_SLUG,
      coordinatorAvailable:available.rowCount===1,currentSuggestions,
      activeTurn:row?{id:text(row,'id'),agentName:text(row,'agent_name'),publicDisplayName:row.public_display_name===null?null:text(row,'public_display_name'),
        createdAt:iso(row.created_at),expiresAt:iso(row.expires_at),lastSeenAt:row.last_seen_at?iso(row.last_seen_at):null}:null,history,retryAfterSeconds:60,
      notice:'Coordinator plans are public unreviewed advice from account-delegated volunteer capacity. They do not authorize work, spending, acceptance, review, or engine writes, and a declared model is not verified.'};});}
}

export function createCommunityCoordinationService(options:CommunityCoordinationServiceOptions){return new CommunityCoordinationService(options);}
