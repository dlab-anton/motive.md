import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type { ResearchDeliveryMode } from '../../src/lib/research-delivery-policy.ts';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export type PolicyAuthorityExpectation = Readonly<{
  projectSlug?: string;
  projectId?: string;
  scopeId: string;
  submissionId: string;
  apiBaseUrl?: string;
  configurationDigest?: string;
  apiVersion?: string;
  contractDigest?: string;
  contractVersion?: string;
  contractSurfaceDigest?: string;
  implementationDigest?: string;
  deliveryMode?: ResearchDeliveryMode;
}>;

export type PolicyAuthority = Readonly<{
  policyId: string;
  approvedByActorId: string;
  projectId: string;
  projectSlug: string;
  projectRevision: number;
  workOrderId: string;
  workOrderRevision: number;
  workOrderTermsDigest: string;
  scopeId: string;
  apiBaseUrl: string;
  configurationDigest: string;
  apiVersion: string;
  contractDigest: string;
  contractVersion: string;
  contractSurfaceDigest: string;
  implementationDigest: string;
  encryptedApiKey: Buffer;
  deliveryMode: ResearchDeliveryMode;
  targetSelectionRule: 'PRETEST_RETAINED_SAME_CHANNEL' | null;
}>;

function storedText(row: QueryResultRow, name: string): string {
  const value = row[name];
  if (typeof value !== 'string' || !value) throw new Error(`Invalid policy authority ${name}.`);
  return value;
}

export function policyIdFromPrincipal(principal: string): string | null {
  const id = principal.startsWith('policy:') ? principal.slice(7) : '';
  return UUID.test(id) ? id : null;
}

export async function currentPolicyApprover(pool:Pool,policyId:string):Promise<string|null>{
  if(!UUID.test(policyId))return null;const result=await pool.query(`SELECT policy.approved_by_actor_id
    FROM motive.project_research_delivery_policies policy
    LEFT JOIN motive.project_research_delivery_policy_revocations revocation ON revocation.policy_id=policy.id
    WHERE policy.id=$1 AND revocation.policy_id IS NULL`,[policyId]);
  return result.rowCount===1?storedText(result.rows[0],'approved_by_actor_id'):null;
}

/**
 * Resolves a policy only while every frozen binding and both the approving
 * account and original contributor credential remain current. Callers still
 * have to verify the approver against their configured account authority.
 */
export async function currentPolicyAuthority(
  client: PoolClient,
  policyId: string,
  expected: PolicyAuthorityExpectation,
): Promise<PolicyAuthority | null> {
  if (!UUID.test(policyId)) return null;
  // Mutable authority and frozen-binding rows must remain stable through dispatch;
  // KEY SHARE would still allow status, role, revision, and configuration updates.
  const result = await client.query(`SELECT policy.id AS policy_id,policy.approved_by_actor_id,
      project.id AS project_id,project.slug AS project_slug,project.current_revision AS project_revision,
      work.id AS work_order_id,work.revision AS work_order_revision,work.terms_digest AS work_order_terms_digest,
      scope.id AS scope_id,scope.api_base_url,scope.configuration_digest,scope.api_version,scope.encrypted_api_key,
      policy.reviewed_contract_digest,policy.reviewed_contract_version,
      policy.reviewed_contract_surface_digest,policy.reviewed_implementation_digest,
      policy.delivery_mode,policy.target_selection_rule
    FROM motive.project_research_delivery_policies policy
    LEFT JOIN motive.project_research_delivery_policy_revocations revocation ON revocation.policy_id=policy.id
    JOIN motive.projects project ON project.id=policy.project_id AND project.current_revision=policy.project_revision
    JOIN motive.work_orders work ON work.id=policy.work_order_id AND work.project_id=project.id
      AND work.project_revision=policy.project_revision AND work.revision=policy.work_order_revision
      AND work.terms_digest=policy.work_order_terms_digest
    JOIN motive.project_research_scopes scope ON scope.id=policy.scope_id AND scope.project_id=project.id
      AND scope.status='CONNECTED' AND scope.configuration_digest=policy.scope_configuration_digest
      AND scope.api_base_url=policy.engine_api_base_url AND scope.api_version=policy.engine_api_version
    JOIN motive.memberships approver_membership ON approver_membership.project_id=project.id
      AND approver_membership.actor_id=policy.approved_by_actor_id AND approver_membership.revoked_at IS NULL
      AND approver_membership.role IN ('OWNER','STEWARD')
    JOIN motive.account_identities approver ON approver.actor_id=policy.approved_by_actor_id AND approver.status='ACTIVE'
    JOIN motive.submissions submission ON submission.id=$2 AND submission.project_id=project.id
      AND submission.work_order_id=work.id AND submission.work_order_revision=work.revision
      AND submission.origin='EXTERNAL' AND submission.attempt_id IS NULL
    JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=submission.id
      AND artifact.project_id=project.id
    JOIN motive.participation_agent_tokens token ON token.id=artifact.agent_token_id AND token.project_id=project.id
      AND token.revoked_at IS NULL AND token.expires_at>clock_timestamp()
    JOIN motive.memberships contributor_membership ON contributor_membership.project_id=project.id
      AND contributor_membership.actor_id=token.owner_actor_id AND contributor_membership.revoked_at IS NULL
    JOIN motive.account_identities contributor ON contributor.actor_id=token.owner_actor_id AND contributor.status='ACTIVE'
    JOIN motive.participation_post_check_assessments assessment ON assessment.submission_id=submission.id
      AND assessment.project_id=project.id AND assessment.agent_token_id=token.id
      AND assessment.report_digest=artifact.report_digest
    WHERE policy.id=$1 AND revocation.policy_id IS NULL
      AND ((policy.delivery_mode='NEW_DRAFT'
          AND policy.permitted_operations=ARRAY['DRAFT_HYPOTHESIS','NEUTRAL_EVIDENCE']::TEXT[]
          AND policy.target_selection_rule IS NULL)
        OR (policy.delivery_mode='APPEND_EXISTING'
          AND policy.permitted_operations=ARRAY['NEUTRAL_EVIDENCE']::TEXT[]
          AND policy.target_selection_rule='PRETEST_RETAINED_SAME_CHANNEL'))
    FOR SHARE OF policy,project,work,scope,approver_membership,approver,submission,artifact,token,
      contributor_membership,contributor,assessment`, [policyId, expected.submissionId]);
  if (result.rowCount !== 1) return null;
  const row = result.rows[0];
  const authority: PolicyAuthority = {
    policyId: storedText(row, 'policy_id'), approvedByActorId: storedText(row, 'approved_by_actor_id'),
    projectId: storedText(row, 'project_id'), projectSlug: storedText(row, 'project_slug'),
    projectRevision: Number(row.project_revision), workOrderId: storedText(row, 'work_order_id'),
    workOrderRevision: Number(row.work_order_revision), workOrderTermsDigest: storedText(row, 'work_order_terms_digest'),
    scopeId: storedText(row, 'scope_id'), apiBaseUrl: storedText(row, 'api_base_url'),
    configurationDigest: storedText(row, 'configuration_digest'), apiVersion: storedText(row, 'api_version'),
    contractDigest: storedText(row, 'reviewed_contract_digest'), contractVersion: storedText(row, 'reviewed_contract_version'),
    contractSurfaceDigest: storedText(row, 'reviewed_contract_surface_digest'),
    implementationDigest: storedText(row, 'reviewed_implementation_digest'),
    encryptedApiKey: row.encrypted_api_key as Buffer,
    deliveryMode: storedText(row,'delivery_mode') as ResearchDeliveryMode,
    targetSelectionRule: row.target_selection_rule === null ? null
      : storedText(row,'target_selection_rule') as 'PRETEST_RETAINED_SAME_CHANNEL',
  };
  const matches = (expected.projectSlug === undefined || expected.projectSlug === authority.projectSlug)
    && (expected.projectId === undefined || expected.projectId === authority.projectId)
    && expected.scopeId === authority.scopeId
    && (expected.apiBaseUrl === undefined || expected.apiBaseUrl === authority.apiBaseUrl)
    && (expected.configurationDigest === undefined || expected.configurationDigest === authority.configurationDigest)
    && (expected.apiVersion === undefined || expected.apiVersion === authority.apiVersion)
    && (expected.contractDigest === undefined || expected.contractDigest === authority.contractDigest)
    && (expected.contractVersion === undefined || expected.contractVersion === authority.contractVersion)
    && (expected.contractSurfaceDigest === undefined || expected.contractSurfaceDigest === authority.contractSurfaceDigest)
    && (expected.implementationDigest === undefined || expected.implementationDigest === authority.implementationDigest);
  if(expected.deliveryMode!==undefined&&expected.deliveryMode!==authority.deliveryMode)return null;
  return matches ? authority : null;
}

/** Resolve the newest locally-current owner policy that covers one submission. */
export async function currentPolicyForSubmission(
  client: PoolClient,
  projectId: string,
  submissionId: string,
): Promise<PolicyAuthority | null> {
  if (!UUID.test(projectId) || !UUID.test(submissionId)) return null;
  const candidates = await client.query(`SELECT policy.id,policy.scope_id
    FROM motive.project_research_delivery_policies policy
    LEFT JOIN motive.project_research_delivery_policy_revocations revocation ON revocation.policy_id=policy.id
    JOIN motive.projects project ON project.id=policy.project_id AND project.current_revision=policy.project_revision
    JOIN motive.work_orders work ON work.id=policy.work_order_id AND work.project_id=project.id
      AND work.project_revision=policy.project_revision AND work.revision=policy.work_order_revision
      AND work.terms_digest=policy.work_order_terms_digest
    JOIN motive.submissions submission ON submission.id=$2 AND submission.project_id=project.id
      AND submission.work_order_id=work.id AND submission.work_order_revision=work.revision
    WHERE policy.project_id=$1 AND revocation.policy_id IS NULL
    ORDER BY policy.created_at DESC,policy.id DESC LIMIT 20`, [projectId, submissionId]);
  for (const row of candidates.rows) {
    const authority = await currentPolicyAuthority(client, storedText(row, 'id'), {
      projectId, scopeId: storedText(row, 'scope_id'), submissionId,
    });
    if (authority) return authority;
  }
  return null;
}
