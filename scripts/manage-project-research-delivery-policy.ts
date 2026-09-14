import { existsSync,readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import { getPostgresSchemaStatus } from '../packages/accounting/src/migrations.ts';
import { loadAccountConfiguration } from '../server/accounts/config.ts';
import { openApplicationDatabase } from '../server/app-database.ts';
import { parseFundingVaultKey } from '../server/funding/vault.ts';
import { createProjectResearchDeliveryPolicyService,verifyReviewedWritebackContract } from '../server/research-memory/index.ts';
import { guardOperatorTransactions,resolveOperatorAccount,type OperatorAccountSelector } from './lib/operator-account.ts';

const USAGE='Usage: node --import tsx scripts/manage-project-research-delivery-policy.ts (--account-email EMAIL | --account-id UUID) (--approve --project SLUG --scope-id UUID --work-order-id UUID --approved-api-base URL --contract-file PATH --contract-digest sha256:HEX [--delivery-mode NEW_DRAFT|APPEND_EXISTING] | --revoke-policy UUID) --idempotency-key KEY [--apply]';
const VALUES=new Set(['--account-email','--account-id','--project','--scope-id','--work-order-id','--approved-api-base','--contract-file','--contract-digest','--delivery-mode','--revoke-policy','--idempotency-key']);
export type ResearchDeliveryPolicyArguments=Readonly<{selector:OperatorAccountSelector;mode:'APPROVE'|'REVOKE';apply:boolean;
  idempotencyKey:string;project?:string;scopeId?:string;workOrderId?:string;approvedApiBaseUrl?:string;contractFile?:string;contractDigest?:string;policyId?:string;
  deliveryMode?:'NEW_DRAFT'|'APPEND_EXISTING'}>;

export function parseResearchDeliveryPolicyArguments(args:readonly string[]):ResearchDeliveryPolicyArguments{
  const values=new Map<string,string>();let approve=false,apply=false;
  for(let i=0;i<args.length;i+=1){const name=args[i]!;if(name==='--approve'){if(approve)throw new Error(USAGE);approve=true;continue;}
    if(name==='--apply'){if(apply)throw new Error(USAGE);apply=true;continue;}if(!VALUES.has(name)||values.has(name))throw new Error(USAGE);
    const value=args[++i];if(!value||value.startsWith('--'))throw new Error(USAGE);values.set(name,value);}
  const email=values.get('--account-email'),id=values.get('--account-id'),revoke=values.get('--revoke-policy');
  if(Boolean(email)===Boolean(id)||approve===Boolean(revoke))throw new Error(USAGE);const required=(name:string)=>{const v=values.get(name);if(!v)throw new Error(USAGE);return v;};
  const common={selector:email?{accountEmail:email}:{accountId:id!},apply,idempotencyKey:required('--idempotency-key')};
  if(revoke){if([...values.keys()].some(k=>['--project','--scope-id','--work-order-id','--approved-api-base','--contract-file','--contract-digest','--delivery-mode'].includes(k)))throw new Error(USAGE);
    return{...common,mode:'REVOKE',policyId:revoke};}
  const deliveryMode=values.get('--delivery-mode');
  if(deliveryMode!==undefined&&deliveryMode!=='NEW_DRAFT'&&deliveryMode!=='APPEND_EXISTING')throw new Error(USAGE);
  return{...common,mode:'APPROVE',project:required('--project'),scopeId:required('--scope-id'),workOrderId:required('--work-order-id'),
    ...(deliveryMode?{deliveryMode}:{}),
    approvedApiBaseUrl:required('--approved-api-base'),contractFile:required('--contract-file'),contractDigest:required('--contract-digest')};
}
function vaultKey(env:Readonly<Record<string,string|undefined>>,provider:'local-better-auth'|'supabase'){
  const path=resolve(env.MOTIVE_DATA_DIR?.trim()||'.local','funding-vault-key');const encoded=env.MOTIVE_FUNDING_VAULT_KEY?.trim()
    ||(provider==='local-better-auth'&&existsSync(path)?readFileSync(path,'utf8').trim():'');if(!encoded)throw new Error('A Motive vault key is required.');return parseFundingVaultKey(encoded);}
export async function manageResearchDeliveryPolicy(input:{pool:Pool;arguments:ResearchDeliveryPolicyArguments;env?:Readonly<Record<string,string|undefined>>}){
  const env=input.env??process.env,configuration=loadAccountConfiguration(env);const account=await resolveOperatorAccount({pool:input.pool,selector:input.arguments.selector,env,configuration});
  const guarded=guardOperatorTransactions(input.pool,account);if(!(await getPostgresSchemaStatus(guarded)).exact)throw new Error('PostgreSQL migrations must be exact before policy management.');
  const isActorActive=async(actorId:string)=>actorId===account.actorId&&(account.provider==='local-better-auth'||Boolean(account.remote&&await account.remote.isActive(account.subjectId)));
  const service=createProjectResearchDeliveryPolicyService({pool:guarded,vaultKey:vaultKey(env,account.provider),isActorActive});
  if(input.arguments.mode==='REVOKE')return service.revoke(account.actorId,{policyId:input.arguments.policyId!,idempotencyKey:input.arguments.idempotencyKey},input.arguments.apply);
  const bytes=await readFile(resolve(input.arguments.contractFile!));const contract=verifyReviewedWritebackContract(bytes,input.arguments.contractDigest!);
  return service.approve(account.actorId,{projectSlug:input.arguments.project!,scopeId:input.arguments.scopeId!,workOrderId:input.arguments.workOrderId!,
    idempotencyKey:input.arguments.idempotencyKey,approvedApiBaseUrl:input.arguments.approvedApiBaseUrl!,contract,
    ...(input.arguments.deliveryMode?{deliveryMode:input.arguments.deliveryMode}:{})},input.arguments.apply);
}
export async function main(args=process.argv.slice(2),env:Readonly<Record<string,string|undefined>>=process.env){const parsed=parseResearchDeliveryPolicyArguments(args),pool=await openApplicationDatabase();if(!pool)throw new Error('MOTIVE_DATABASE_URL is required.');
  try{process.stdout.write(`${JSON.stringify(await manageResearchDeliveryPolicy({pool,arguments:parsed,env}),null,2)}\n`);}finally{await pool.end();}}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await main();
