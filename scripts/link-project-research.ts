import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import { openApplicationDatabase } from '../server/app-database.ts';
import { loadAccountConfiguration } from '../server/accounts/config.ts';
import { parseFundingVaultKey } from '../server/funding/vault.ts';
import { createResearchMemoryService } from '../server/research-memory/index.ts';
import {
  guardOperatorTransactions,
  resolveOperatorAccount,
  type OperatorAccountSelector,
} from './lib/operator-account.ts';

const USAGE = 'Usage: node --import tsx scripts/link-project-research.ts (--account-email EMAIL | --account-id CONFIRMED_SUPABASE_USER_UUID) --project SLUG --api-base URL --channel-id UUID --channel-name NAME [--replace]';
const VALUE_OPTIONS = new Set(['--account-email', '--account-id', '--project', '--api-base', '--channel-id', '--channel-name']);

export type LinkProjectResearchArguments = {
  selector: OperatorAccountSelector;
  project: string;
  apiBaseUrl: string;
  channelId: string;
  channelName: string;
  replace: boolean;
};

export function parseLinkProjectResearchArguments(args: readonly string[]): LinkProjectResearchArguments {
  const values = new Map<string, string>(); let replace = false;
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index]!;
    if (name === '--replace') {
      if (replace) throw new Error(USAGE);
      replace = true; continue;
    }
    if (!VALUE_OPTIONS.has(name) || values.has(name)) throw new Error(USAGE);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(USAGE);
    values.set(name, value); index += 1;
  }
  const accountEmail = values.get('--account-email'); const accountId = values.get('--account-id');
  if (Boolean(accountEmail) === Boolean(accountId)) throw new Error(USAGE);
  const project = values.get('--project'); const apiBaseUrl = values.get('--api-base');
  const channelId = values.get('--channel-id'); const channelName = values.get('--channel-name');
  if (!project || !apiBaseUrl || !channelId || !channelName) throw new Error(USAGE);
  return { selector: accountEmail ? { accountEmail } : { accountId: accountId! },
    project, apiBaseUrl, channelId, channelName, replace };
}

export async function linkProjectResearch(input: {
  pool: Pool;
  arguments: LinkProjectResearchArguments;
  env?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof fetch;
}) {
  const env = input.env ?? process.env;
  const configuration = loadAccountConfiguration(env);
  const account = await resolveOperatorAccount({ pool: input.pool, selector: input.arguments.selector,
    env, configuration });
  const apiKey = env.MOTIVE_HYPOTHESIS_API_KEY?.trim();
  if (!apiKey) throw new Error('MOTIVE_HYPOTHESIS_API_KEY is required and must be provided through the environment.');
  const tenantId = env.MOTIVE_HYPOTHESIS_TENANT_ID?.trim();
  if (!tenantId) throw new Error('MOTIVE_HYPOTHESIS_TENANT_ID is required and must be provided through the environment.');
  const directory = resolve(env.MOTIVE_DATA_DIR?.trim() || '.local');
  const vaultPath = resolve(directory, 'funding-vault-key');
  const encodedVault = env.MOTIVE_FUNDING_VAULT_KEY?.trim()
    || (configuration.provider === 'local-better-auth' && existsSync(vaultPath) ? readFileSync(vaultPath, 'utf8').trim() : '');
  if (!encodedVault) throw new Error(configuration.provider === 'supabase'
    ? 'MOTIVE_FUNDING_VAULT_KEY is required for the Supabase operator path.'
    : 'MOTIVE_FUNDING_VAULT_KEY or the local vault-key file is required.');
  const guardedPool = guardOperatorTransactions(input.pool, account);
  const service = createResearchMemoryService({ pool: guardedPool, vaultKey: parseFundingVaultKey(encodedVault),
    ...(input.fetch ? { fetch: input.fetch } : {}) });
  return service.linkScope(account.actorId, input.arguments.project, {
    apiBaseUrl: input.arguments.apiBaseUrl, tenantId, channelId: input.arguments.channelId,
    channelName: input.arguments.channelName, apiKey, replace: input.arguments.replace,
  });
}

export async function main(
  args: readonly string[] = process.argv.slice(2),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const parsed = parseLinkProjectResearchArguments(args);
  const pool = await openApplicationDatabase();
  if (!pool) throw new Error('MOTIVE_DATABASE_URL is required.');
  try {
    const linked = await linkProjectResearch({ pool, arguments: parsed, env });
    process.stdout.write(`Connected project ${linked.projectSlug} to research scope ${linked.scopeId} (${linked.channelName}).\n`);
  } finally { await pool.end(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
