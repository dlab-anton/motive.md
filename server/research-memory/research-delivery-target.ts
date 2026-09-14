import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { digestCanonicalJson } from '../../packages/domain/src/contracts.ts';
import type {
  ResearchDeliveryTargetBinding,
  ResearchDeliveryTargetSelection,
} from '../../src/lib/research-delivery-target.ts';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST=/^sha256:[a-f0-9]{64}$/;

export class ResearchDeliveryTargetError extends Error {
  constructor(message:string){super(message);this.name='ResearchDeliveryTargetError';}
}

function invalid():never{throw new ResearchDeliveryTargetError('Research delivery target does not match a retained project observation.');}

/** Resolves caller-selected identity only from Motive's immutable retained snapshot. */
export async function resolveResearchDeliveryTarget(
  projectId:string,
  selection:ResearchDeliveryTargetSelection,
  client:PoolClient,
):Promise<ResearchDeliveryTargetBinding>{
  if(!UUID.test(projectId)||!selection||selection.mode!=='APPEND_EXISTING'
    ||!UUID.test(selection.scopeId)||!UUID.test(selection.snapshotId)||!DIGEST.test(selection.snapshotDigest)
    ||!UUID.test(selection.hypothesisId)||!Number.isFinite(Date.parse(selection.observedUpdatedAt))
    ||new Date(selection.observedUpdatedAt).toISOString()!==selection.observedUpdatedAt)invalid();
  const result=await client.query(`SELECT snapshot.payload,snapshot.snapshot_digest,
      scope.channel_id,scope.configuration_digest
    FROM motive.research_context_snapshots snapshot
    JOIN motive.project_research_scopes scope ON scope.id=snapshot.scope_id
      AND scope.project_id=snapshot.project_id
    WHERE snapshot.id=$1 AND snapshot.scope_id=$2 AND snapshot.project_id=$3`,
  [selection.snapshotId,selection.scopeId,projectId]);
  const row=result.rows[0],payload=row?.payload as Record<string,unknown>|undefined;
  if(result.rowCount!==1||row.snapshot_digest!==selection.snapshotDigest||!payload
    ||!['motive.research-context.v1','motive.research-hypothesis-context.v1'].includes(String(payload.format))
    ||digestCanonicalJson(payload)!==selection.snapshotDigest||!Array.isArray(payload.hypotheses))invalid();
  const target=payload.hypotheses.find(item=>item&&typeof item==='object'&&!Array.isArray(item)
    &&(item as Record<string,unknown>).id===selection.hypothesisId) as Record<string,unknown>|undefined;
  if(!target||target.updatedAt!==selection.observedUpdatedAt||typeof target.statement!=='string'||!target.statement
    ||typeof target.contentDigest!=='string'||!DIGEST.test(target.contentDigest))invalid();
  const channelId=String(row.channel_id),scopeConfigurationDigest=String(row.configuration_digest);
  if(!UUID.test(channelId)||!DIGEST.test(scopeConfigurationDigest))invalid();
  return{format:'motive.research-delivery-target/0.1',selection,channelId,
    scopeConfigurationDigest:scopeConfigurationDigest as `sha256:${string}`,
    hypothesisContentDigest:target.contentDigest as `sha256:${string}`,
    statementDigest:`sha256:${createHash('sha256').update(target.statement,'utf8').digest('hex')}`};
}
