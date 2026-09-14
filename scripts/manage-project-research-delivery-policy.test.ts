import {randomUUID} from 'node:crypto';import {describe,expect,it} from 'vitest';
import {parseResearchDeliveryPolicyArguments} from './manage-project-research-delivery-policy.ts';
describe('research delivery policy CLI',()=>{it('is dry by default and requires one explicit approval or revocation operation',()=>{
  const accountId=randomUUID(),scopeId=randomUUID(),workOrderId=randomUUID();const base=['--account-id',accountId,'--approve','--project','circle-packing',
    '--scope-id',scopeId,'--work-order-id',workOrderId,'--approved-api-base','https://engine.example/api/v1','--contract-file','contract.json',
    '--contract-digest',`sha256:${'a'.repeat(64)}`,'--idempotency-key','policy-approval-1'];
  expect(parseResearchDeliveryPolicyArguments(base)).toMatchObject({mode:'APPROVE',apply:false,selector:{accountId},scopeId,workOrderId});
  expect(parseResearchDeliveryPolicyArguments(base)).not.toHaveProperty('deliveryMode');
  expect(parseResearchDeliveryPolicyArguments([...base,'--delivery-mode','APPEND_EXISTING']))
    .toMatchObject({deliveryMode:'APPEND_EXISTING',apply:false});
  expect(()=>parseResearchDeliveryPolicyArguments([...base,'--delivery-mode','ALL'])).toThrow();
  expect(()=>parseResearchDeliveryPolicyArguments(['--account-id',accountId,'--revoke-policy',randomUUID(),
    '--idempotency-key','revoke','--delivery-mode','APPEND_EXISTING'])).toThrow();
  expect(parseResearchDeliveryPolicyArguments([...base,'--apply']).apply).toBe(true);
  expect(parseResearchDeliveryPolicyArguments(['--account-id',accountId,'--revoke-policy',randomUUID(),'--idempotency-key','policy-revoke-1']))
    .toMatchObject({mode:'REVOKE',apply:false});
  expect(()=>parseResearchDeliveryPolicyArguments([...base,'--revoke-policy',randomUUID()])).toThrow();
});});
