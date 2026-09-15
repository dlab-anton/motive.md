import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import { openApplicationDatabase } from '../server/app-database.ts';
import {
  assertOperatorAccountActive,
  resolveOperatorAccount,
  type OperatorAccountSelector,
} from './lib/operator-account.ts';

const USAGE = 'Usage: npm run project:reviewer -- (--account-email SIGNED_UP_EMAIL | --account-id CONFIRMED_SUPABASE_USER_UUID) [--role reviewer|owner] [--project circle-packing|matmul-4x4x4] [--apply]';

export type ProjectReviewerRole = 'REVIEWER' | 'OWNER';
export type ProjectReviewerArguments = Readonly<{ selector: OperatorAccountSelector; role: ProjectReviewerRole; apply: boolean; project: string }>;

export function parseProjectReviewerArguments(args: readonly string[]): ProjectReviewerArguments {
  let selector: OperatorAccountSelector | null = null; let role: ProjectReviewerRole = 'REVIEWER'; let roleSpecified = false; let apply = false; let project = 'circle-packing';
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if ((argument === '--account-email' || argument === '--account-id') && args[index + 1]) {
      if (selector) throw new Error(USAGE);
      selector = argument === '--account-email' ? { accountEmail: args[++index]! } : { accountId: args[++index]! };
    } else if (argument === '--role' && args[index + 1]) {
      if (roleSpecified) throw new Error(USAGE);
      const value = args[++index];
      if (value !== 'reviewer' && value !== 'owner') throw new Error(USAGE);
      role = value === 'reviewer' ? 'REVIEWER' : 'OWNER';
      roleSpecified = true;
    } else if (argument === '--project' && args[index + 1]) {
      const value = args[++index]!;
      if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(value)) throw new Error(USAGE);
      project = value;
    } else if (argument === '--apply' && !apply) apply = true;
    else throw new Error(USAGE);
  }
  if (!selector || apply && !roleSpecified) throw new Error(USAGE);
  return { selector, role, apply, project };
}

export async function setProjectReviewer(input: {
  pool: Pool;
  selector: OperatorAccountSelector;
  role?: ProjectReviewerRole;
  apply?: boolean;
  project?: string;
  env?: Readonly<Record<string, string | undefined>>;
  resolveAccount?: typeof resolveOperatorAccount;
}): Promise<{ actorId: string; role: 'REVIEWER' | 'STEWARD' | 'OWNER'; status: 'DRY_RUN' | 'ACTIVE'; changed: boolean }> {
  const requestedRole = input.role ?? 'REVIEWER'; const apply = input.apply ?? false;
  if (!['REVIEWER','OWNER'].includes(requestedRole) || typeof apply !== 'boolean' || apply && input.role === undefined) throw new Error(USAGE);
  const account = await (input.resolveAccount ?? resolveOperatorAccount)(
    { pool: input.pool, selector: input.selector, env: input.env },
  );
  const client = await input.pool.connect();
  try {
    await client.query('BEGIN');
    await assertOperatorAccountActive(client, account);
    const projectSlug = input.project ?? 'circle-packing';
    const project = await client.query(
      "SELECT id FROM motive.projects WHERE slug = $1 AND visibility = 'PUBLIC' FOR UPDATE", [projectSlug],
    );
    if (project.rowCount !== 1) throw new Error(`The public ${projectSlug} project has not been initialized.`);
    const projectId = project.rows[0].id as string;
    const prior = await client.query(
      'SELECT role, revoked_at FROM motive.memberships WHERE project_id = $1 AND actor_id = $2 FOR UPDATE',
      [projectId, account.actorId],
    );
    const priorRole = prior.rows[0]?.role as string | undefined; const revoked = prior.rows[0]?.revoked_at != null;
    if (requestedRole === 'REVIEWER' && revoked && (priorRole === 'OWNER' || priorRole === 'STEWARD')) {
      throw new Error('REVOKED_HIGHER_AUTHORITY_REQUIRES_EXPLICIT_ADMIN_CHANGE');
    }
    const effectiveRole: 'REVIEWER' | 'STEWARD' | 'OWNER' = requestedRole === 'OWNER' ? 'OWNER'
      : !revoked && (priorRole === 'OWNER' || priorRole === 'STEWARD') ? priorRole : 'REVIEWER';
    const changed = priorRole !== effectiveRole || revoked;
    if (!apply) {
      await client.query('ROLLBACK');
      return { actorId: account.actorId, role: effectiveRole, status: 'DRY_RUN', changed };
    }
    if (changed) {
      const operator = account.provider === 'supabase'
        ? 'operator:supabase-reviewer-bootstrap' : 'operator:local-reviewer-bootstrap';
      await client.query(`INSERT INTO motive.memberships (id, project_id, actor_id, role, granted_by)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (project_id, actor_id) DO UPDATE SET role = EXCLUDED.role, revoked_at = NULL, granted_by = EXCLUDED.granted_by`,
      [randomUUID(), projectId, account.actorId, effectiveRole, operator]);
      await client.query(`INSERT INTO motive.events (id, project_id, aggregate_type, aggregate_id, event_type, payload, actor_id)
        VALUES ($1, $2, 'project', $2, 'project.reviewer-authorized', $3, $4)`,
      [randomUUID(), projectId, JSON.stringify({ actor_id: account.actorId, role: effectiveRole,
        source: account.provider === 'supabase' ? 'explicit-supabase-operator-command' : 'explicit-local-operator-command' }), operator]);
    }
    await client.query('COMMIT');
    return { actorId: account.actorId, role: effectiveRole, status: 'ACTIVE', changed };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export async function main(
  args: readonly string[] = process.argv.slice(2),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const parsed = parseProjectReviewerArguments(args);
  const pool = await openApplicationDatabase();
  if (!pool) throw new Error('MOTIVE_DATABASE_URL is required.');
  try {
    const result = await setProjectReviewer({ pool, ...parsed, env });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.stdout.write(result.status === 'DRY_RUN'
      ? `Preview only. Repeat with --role ${parsed.role.toLowerCase()} and --apply to change project authority.\n`
      : `This account can now review ${parsed.project} submissions. Reload the project page. Self-review remains denied.\n`);
  } finally { await pool.end(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
