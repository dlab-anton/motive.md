import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import { getPostgresSchemaStatus } from '../packages/accounting/src/migrations.ts';
import { loadAccountConfiguration } from '../server/accounts/config.ts';
import { openApplicationDatabase } from '../server/app-database.ts';
import { parseFundingVaultKey } from '../server/funding/vault.ts';
import {
  createHypothesisSubmissionDeliveryService,
  verifyReviewedWritebackContract,
} from '../server/research-memory/index.ts';
import {
  createCommandAccountActivityResolver,
  guardOperatorTransactions,
  resolveOperatorAccount,
  type OperatorAccountSelector,
} from './lib/operator-account.ts';
import type { AccountRemoteAuthority } from '../server/accounts/types.ts';

const USAGE = 'Usage: node --import tsx scripts/sync-project-research.ts (--account-email EMAIL | --account-id CONFIRMED_SUPABASE_USER_UUID) --project SLUG --scope-id UUID --submission-id UUID --idempotency-key KEY --approved-api-base URL --contract-file PATH --contract-digest sha256:HEX [--execute]';
const VALUE_OPTIONS = new Set(['--account-email','--account-id','--project','--scope-id','--submission-id','--idempotency-key',
  '--approved-api-base','--contract-file','--contract-digest']);

export type SyncProjectResearchArguments = Readonly<{
  selector: OperatorAccountSelector;
  project: string;
  scopeId: string;
  submissionId: string;
  idempotencyKey: string;
  approvedApiBaseUrl: string;
  contractFile: string;
  contractDigest: string;
  execute: boolean;
}>;

export function parseSyncProjectResearchArguments(args: readonly string[]): SyncProjectResearchArguments {
  const values = new Map<string,string>(); let execute = false;
  for (let index=0; index<args.length; index+=1) {
    const name=args[index]!;
    if (name==='--execute') { if (execute) throw new Error(USAGE); execute=true; continue; }
    if (!VALUE_OPTIONS.has(name) || values.has(name)) throw new Error(USAGE);
    const value=args[index+1]; if (!value || value.startsWith('--')) throw new Error(USAGE);
    values.set(name,value); index+=1;
  }
  const accountEmail=values.get('--account-email'); const accountId=values.get('--account-id');
  if (Boolean(accountEmail)===Boolean(accountId)) throw new Error(USAGE);
  const required=(name:string)=>{const value=values.get(name);if(!value)throw new Error(USAGE);return value;};
  return { selector:accountEmail?{accountEmail}:{accountId:accountId!},project:required('--project'),scopeId:required('--scope-id'),
    submissionId:required('--submission-id'),idempotencyKey:required('--idempotency-key'),
    approvedApiBaseUrl:required('--approved-api-base'),contractFile:required('--contract-file'),
    contractDigest:required('--contract-digest'),execute };
}

function vaultKey(env: Readonly<Record<string,string|undefined>>, provider: 'local-better-auth'|'supabase') {
  const path=resolve(env.MOTIVE_DATA_DIR?.trim()||'.local','funding-vault-key');
  const encoded=env.MOTIVE_FUNDING_VAULT_KEY?.trim()
    ||(provider==='local-better-auth'&&existsSync(path)?readFileSync(path,'utf8').trim():'');
  if(!encoded)throw new Error(provider==='supabase'?'MOTIVE_FUNDING_VAULT_KEY is required for the Supabase operator path.'
    :'MOTIVE_FUNDING_VAULT_KEY or the local vault-key file is required.');
  return parseFundingVaultKey(encoded);
}

export async function syncProjectResearch(input:{
  pool:Pool; arguments:SyncProjectResearchArguments; env?:Readonly<Record<string,string|undefined>>; fetch?:typeof fetch;
  remote?:Pick<AccountRemoteAuthority,'isActive'>;
}) {
  const env=input.env??process.env; const configuration=loadAccountConfiguration(env);
  const account=await resolveOperatorAccount({pool:input.pool,selector:input.arguments.selector,env,configuration,
    ...(input.remote?{remote:input.remote}:{})});
  const contractBytes=await readFile(resolve(input.arguments.contractFile));
  const contract=verifyReviewedWritebackContract(contractBytes,input.arguments.contractDigest);
  const guardedPool=guardOperatorTransactions(input.pool,account);
  if(!(await getPostgresSchemaStatus(guardedPool)).exact)throw new Error('PostgreSQL migrations must be exact before research delivery.');
  const activity=await createCommandAccountActivityResolver({pool:input.pool,configuration,env,
    ...(account.remote?{remote:account.remote}:{})});
  try {
    const service=createHypothesisSubmissionDeliveryService({pool:guardedPool,vaultKey:vaultKey(env,account.provider),
      isActorActive:activity.isActorActive,...(input.fetch?{fetch:input.fetch}:{})});
    return await service.sync(account.actorId,{projectSlug:input.arguments.project,scopeId:input.arguments.scopeId,
      submissionId:input.arguments.submissionId,idempotencyKey:input.arguments.idempotencyKey,
      approvedApiBaseUrl:input.arguments.approvedApiBaseUrl,contract,execute:input.arguments.execute});
  } finally { activity.close(); }
}

export async function main(args:readonly string[]=process.argv.slice(2),env:Readonly<Record<string,string|undefined>>=process.env){
  const parsed=parseSyncProjectResearchArguments(args);const pool=await openApplicationDatabase();
  if(!pool)throw new Error('MOTIVE_DATABASE_URL is required.');
  try{process.stdout.write(`${JSON.stringify(await syncProjectResearch({pool,arguments:parsed,env}),null,2)}\n`);}
  finally{await pool.end();}
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await main();
