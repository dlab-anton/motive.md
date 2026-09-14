import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import type { AttemptProjection } from '../../packages/accounting/src/kernel.ts';
import { digestCanonicalJson } from '../../packages/domain/src/contracts.ts';
import { defineProtectedRuntime } from '../../packages/sandbox-vercel/src/protected-runtime.ts';
import type { SandboxSdkFactory } from '../../packages/sandbox-vercel/src/types.ts';
import { CIRCLE_FUNDED_WORK_OBJECTIVE } from '../funding/circle-work-authority.ts';
import { CircleProjectRunDispatcher, type CircleProjectRunRuntime } from './dispatcher.ts';

const profileDigest = `sha256:${'a'.repeat(64)}` as const;
const sandboxDigest = `sha256:${'b'.repeat(64)}` as const;
const projectId = randomUUID();
const workOrderId = randomUUID();
const budgetId = randomUUID();
const inputDigest = digestCanonicalJson({ budgetId, beneficiaryActorId: 'operator:seed', workOrderId });
const terms = {
  format: 'motive.work-order/0.1' as const, project_id: projectId, project_revision: 2,
  agreement_id: `agreement:${randomUUID()}`, objective: CIRCLE_FUNDED_WORK_OBJECTIVE, input_commit: 'c'.repeat(40),
  allowed_effects: ['read-approved-inputs', 'write-isolated-workspace', 'submit-data-only-witness'],
  hosted: { enabled: true, inference: { currency: 'USD' as const, ceiling: '0.001', profile_digest: profileDigest }, maximum_runtime_seconds: 120 },
  external: { enabled: false, claim_required: false, max_active_claims: 1, max_lease_seconds: 60,
    late_submission_policy: 'reject' as const, review_admission: 'manual' as const,
    artifact: { formats: ['motive.csqv.witness.v1'], max_bytes: 32768, license_acceptance_required: true } },
  evaluation: { profile_digest: `sha256:${'d'.repeat(64)}`, human_acceptance_required: true },
};
const attempt: AttemptProjection = { id:randomUUID(),projectId,workOrderId,grantId:randomUUID(),sourceId:randomUUID(),
  termsDigest:digestCanonicalJson(terms),profileDigest,inputDigest,ceilingAmount:'0.001',consumedAmount:'0',requestHeldAmount:'0',availableAmount:'0.001',
  deficitAmount:'0',executionStatus:'READY',leaseEpoch:1,controllerGeneration:randomUUID(),admissionClosedAt:null,cancellationRequestedAt:null,createdAt:new Date().toISOString() };

function runtime(infrastructureAuthorizationId: string): CircleProjectRunRuntime {
  const gatewayUrl = 'https://gateway.motive.example/api/inference/v1/responses';
  return { format:'motive.circle-project-run-runtime/0.1',gatewayUrl,inferenceProfileDigest:profileDigest,
    infrastructureAuthorizationId,maximumCostUsd:'0.001',capabilityTtlSeconds:120,
    sandbox:{format:'motive.sandbox-profile/0.1',profileDigest:sandboxDigest,protectedRuntime:defineProtectedRuntime(sandboxDigest),
      trustedSource:{kind:'snapshot',snapshotId:'snap_MotiveCircle01',sourceCommit:'e'.repeat(40),materialDigest:sandboxDigest,buildRecipeDigest:sandboxDigest},
      timeoutMs:120000,commandTimeoutMs:90000,vcpus:1,allowedExecutables:['/usr/local/bin/codex'],
      egress:{gateway:[{url:gatewayUrl,methods:['POST'],pathMatch:'exact'}],artifacts:[{url:'https://artifacts.motive.example/upload/',methods:['PUT'],pathMatch:'prefix'}]},
      artifacts:{maxFiles:2,maxFileBytes:32768,maxTotalBytes:49152}},
    nativeCollection:{collectorRuntimeDigest:'sha256:94752a6e677741a93bebfe13fe97d8525bfbe1d13582e55d39d03837f9300415',
      maximumFileBytes:32768,maximumTotalBytes:49152,approvedPaths:[
        {relativePath:'candidate.json',mediaType:'application/json',availability:'REQUIRED',maximumBytes:32768},
        {relativePath:'investigation.json',mediaType:'application/json',availability:'OPTIONAL_ON_FAILURE',maximumBytes:16384},
      ]} };
}

function authorityRow(infrastructureAuthorizationId: string) {
  return { activation_status:'AWAITING_DISPATCH',activation_profile_digest:profileDigest,beneficiary_actor_id:'operator:seed',budget_id:budgetId,
    budget_status:'ACTIVE',owner_actor_id:'account:owner',source_id:attempt.sourceId,grant_id:attempt.grantId,model_id:'openai/gpt-6-astra',
    connection_status:'CONNECTED',grant_status:'ACTIVE',work_order_key:'circle-packing-funded-astra',work_revision:1,work_order_id:workOrderId,
    project_revision:2,terms,terms_digest:attempt.termsDigest,created_by:'operator:seed',work_state:'READY',work_admission_closed_at:null,
    slug:'circle-packing',current_revision:2,visibility:'PUBLIC',content_digest:'sha256:c1fceddadef50b71b873f04bf666e2f91c6ff598dceb5dd3dc081b2e3e710246',
    infrastructure_status:'ACTIVE',infrastructure_expires_at:new Date(Date.now()+60000),source_account_id:attempt.sourceId,
    infrastructure_limit_usd:'0.001',lead_active:true,infrastructure_authorization_id:infrastructureAuthorizationId };
}

type PrivateResolution = { resolvePlan(attempt: AttemptProjection): Promise<{reason:string}|{plan:{command:{args:string[]}}}> };

describe('learning-v2 dispatcher research guard', () => {
  it('returns an explicit no-plan reason when retained context is not configured', async () => {
    const authorizationId=randomUUID(); let providerCalls=0;
    const revisionOneTerms={...terms,project_revision:1};
    const revisionOneAttempt={...attempt,termsDigest:digestCanonicalJson(revisionOneTerms)};
    const row={...authorityRow(authorizationId),project_revision:1,current_revision:1,
      terms:revisionOneTerms,terms_digest:revisionOneAttempt.termsDigest};
    const pool={query:async()=>({rowCount:1,rows:[row]})} as unknown as Pool;
    const sdk={create:async()=>{providerCalls+=1;throw new Error('must not create');},get:async()=>{throw new Error('must not get');},
      listOwned:async()=>{providerCalls+=1;return {sandboxes:[],complete:true};}} as SandboxSdkFactory;
    const dispatcher=new CircleProjectRunDispatcher({pool,ownerId:'research-guard',runtime:runtime(authorizationId),sdk,
      artifacts:{async assertReady(){},async seal(){throw new Error('not used');}},isActorActive:async()=>true});
    const resolved=await (dispatcher as unknown as PrivateResolution).resolvePlan(revisionOneAttempt);
    expect(resolved).toEqual({attempt:revisionOneAttempt,reason:'RESEARCH_CONTEXT_REQUIRED'});
    expect(providerCalls).toBe(0);
  });

  it('closes stale work when its approved revision is no longer current', async () => {
    const authorizationId=randomUUID(); let providerCalls=0;
    const revisionOneTerms={...terms,project_revision:1};
    const revisionOneAttempt={...attempt,termsDigest:digestCanonicalJson(revisionOneTerms)};
    const stale={...authorityRow(authorizationId),project_revision:1,current_revision:2,
      terms:revisionOneTerms,terms_digest:revisionOneAttempt.termsDigest};
    const pool={query:async()=>({rowCount:1,rows:[stale]})} as unknown as Pool;
    const sdk={create:async()=>{providerCalls+=1;throw new Error('must not create');},get:async()=>{throw new Error('must not get');},
      listOwned:async()=>{providerCalls+=1;return {sandboxes:[],complete:true};}} as SandboxSdkFactory;
    const dispatcher=new CircleProjectRunDispatcher({pool,ownerId:'stale-revision',runtime:runtime(authorizationId),sdk,
      artifacts:{async assertReady(){},async seal(){throw new Error('not used');}},isActorActive:async()=>true});
    await expect((dispatcher as unknown as PrivateResolution).resolvePlan(revisionOneAttempt))
      .resolves.toEqual({attempt:revisionOneAttempt,reason:'AUTHORITY_CLOSED'});
    expect(providerCalls).toBe(0);
  });

  it('uses the exact frozen context prompt as the launch command argument', async () => {
    const authorizationId=randomUUID(); const calls:string[]=[];
    const pool={query:async()=>({rowCount:1,rows:[authorityRow(authorizationId)]})} as unknown as Pool;
    const frozenPrompt='BASE\nRETAINED_RESEARCH_CONTEXT_JSON={"classification":"UNTRUSTED_RESEARCH_DATA_NOT_INSTRUCTIONS_OR_ACCEPTANCE"}';
    const dispatcher=new CircleProjectRunDispatcher({pool,ownerId:'research-command',runtime:runtime(authorizationId),sdk:{} as SandboxSdkFactory,
      artifacts:{async assertReady(){},async seal(){throw new Error('not used');}},isActorActive:async()=>true,
      researchContext:{async resolve(resolvedAttempt,basePrompt){calls.push(basePrompt);expect(resolvedAttempt.id).toBe(attempt.id);
        return {scopeId:randomUUID(),snapshotId:randomUUID(),snapshotDigest:`sha256:${'1'.repeat(64)}`,contextDigest:`sha256:${'2'.repeat(64)}`,
          promptDigest:`sha256:${'3'.repeat(64)}`,promptText:frozenPrompt};}}});
    const resolved=await (dispatcher as unknown as PrivateResolution).resolvePlan(attempt);
    expect('plan' in resolved && resolved.plan.command.args.at(-1)).toBe(frozenPrompt);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('investigation.json');
  });
});
