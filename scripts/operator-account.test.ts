import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { AccountConfiguration } from '../server/accounts/config.ts';
import {
  assertOperatorAccountActive,
  createCommandAccountActivityResolver,
  guardOperatorTransactions,
  resolveOperatorAccount,
  type ResolvedOperatorAccount,
} from './lib/operator-account.ts';
import { parseLinkProjectResearchArguments } from './link-project-research.ts';
import { parseProjectReviewerArguments, setProjectReviewer } from './set-project-reviewer.ts';

const localConfiguration: AccountConfiguration = {
  provider: 'local-better-auth', public: { provider: 'local-better-auth' }, supabase: null, agentTokenSecret: null,
};
const supabaseConfiguration: AccountConfiguration = {
  provider: 'supabase', public: { provider: 'supabase', supabaseUrl: 'https://accounts.example.test',
    supabasePublishableKey: 'sb_publishable_test' },
  supabase: { url: 'https://accounts.example.test', publishableKey: 'sb_publishable_test', secretKey: 'sb_secret_test' },
  agentTokenSecret: 'x'.repeat(32),
};

const result = (rows: Record<string, unknown>[] = []) => ({ rows, rowCount: rows.length }) as never;

describe('operator account selection', () => {
  it('requires native and durable activity for local command callbacks', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'motive-operator-account-'));
    const path = join(directory, 'motive.sqlite');
    const { default: BetterSqliteDatabase } = await import('better-sqlite3');
    const database = new BetterSqliteDatabase(path);
    database.exec('CREATE TABLE user (id TEXT PRIMARY KEY)');
    database.prepare('INSERT INTO user(id) VALUES(?)').run('local-user');
    database.close();
    const query = vi.fn(async () => result([{ provider: 'local-better-auth', subject_id: 'local-user', status: 'ACTIVE' }]));
    const activity = await createCommandAccountActivityResolver({ pool: { query } as never,
      configuration: localConfiguration, env: { MOTIVE_DATA_DIR: directory } });
    try {
      expect(await activity.isActorActive('account:local-user')).toBe(true);
      query.mockResolvedValueOnce(result([{ provider: 'local-better-auth', subject_id: 'local-user', status: 'DELETED' }]));
      expect(await activity.isActorActive('account:local-user')).toBe(false);
      expect(await activity.isActorActive('account:missing')).toBe(false);
    } finally {
      activity.close();
      await rm(path); await rmdir(directory);
    }
  });

  it('requires both the local read-only lookup and durable local identity', async () => {
    const lookup = vi.fn(async () => 'local-user');
    const query = vi.fn(async () => result([{ provider: 'local-better-auth', subject_id: 'local-user', status: 'ACTIVE' }]));
    const account = await resolveOperatorAccount({ selector: { accountEmail: 'member@example.test' },
      pool: { query } as never, configuration: localConfiguration, localLookup: lookup });
    expect(account).toMatchObject({ provider: 'local-better-auth', subjectId: 'local-user', actorId: 'account:local-user' });
    expect(lookup).toHaveBeenCalledOnce(); expect(query).toHaveBeenCalledWith(expect.stringContaining('account_identities'),
      ['account:local-user']);
  });

  it('requires the existing durable Supabase identity and current remote account', async () => {
    const subjectId = randomUUID(); const actorId = `account:${subjectId}` as const;
    const query = vi.fn(async () => result([{ provider: 'supabase', subject_id: subjectId, status: 'ACTIVE' }]));
    const isActive = vi.fn(async () => true);
    const account = await resolveOperatorAccount({ selector: { accountId: subjectId }, pool: { query } as never,
      configuration: supabaseConfiguration, remote: { isActive } });
    expect(account).toMatchObject({ provider: 'supabase', subjectId, actorId });
    expect(isActive).toHaveBeenCalledWith(subjectId);

    query.mockResolvedValueOnce(result([{ provider: 'supabase', subject_id: subjectId, status: 'DELETED' }]));
    await expect(resolveOperatorAccount({ selector: { accountId: subjectId }, pool: { query } as never,
      configuration: supabaseConfiguration, remote: { isActive } })).rejects.toThrow('SUPABASE_OPERATOR_ACCOUNT_NOT_ACTIVE');
  });

  it.each([
    ['missing', []],
    ['wrong provider', [{ provider: 'local-better-auth', subject_id: 'subject', status: 'ACTIVE' }]],
    ['wrong subject', [{ provider: 'supabase', subject_id: randomUUID(), status: 'ACTIVE' }]],
    ['deletion pending', [{ provider: 'supabase', subject_id: 'subject', status: 'DELETION_PENDING' }]],
  ])('rejects a %s durable Supabase identity without opening SQLite', async (_label, template) => {
    const subjectId = randomUUID(); const localLookup = vi.fn(async () => 'must-not-run');
    const rows = template.map(row => ({ ...row, ...(row.subject_id === 'subject' ? { subject_id: subjectId } : {}) }));
    const isActive = vi.fn(async () => true);
    await expect(resolveOperatorAccount({ selector: { accountId: subjectId },
      pool: { query: vi.fn(async () => result(rows)) } as never, configuration: supabaseConfiguration,
      remote: { isActive }, localLookup })).rejects.toThrow('SUPABASE_OPERATOR_ACCOUNT_NOT_ACTIVE');
    expect(localLookup).not.toHaveBeenCalled(); expect(isActive).not.toHaveBeenCalled();
  });

  it('rejects a remotely inactive Supabase identity without opening SQLite', async () => {
    const subjectId = randomUUID(); const localLookup = vi.fn(async () => 'must-not-run');
    await expect(resolveOperatorAccount({ selector: { accountId: subjectId },
      pool: { query: vi.fn(async () => result([{ provider: 'supabase', subject_id: subjectId, status: 'ACTIVE' }])) } as never,
      configuration: supabaseConfiguration, remote: { isActive: vi.fn(async () => false) }, localLookup,
    })).rejects.toThrow('SUPABASE_OPERATOR_ACCOUNT_NOT_ACTIVE');
    expect(localLookup).not.toHaveBeenCalled();
  });

  it('locks and remotely rechecks a Supabase identity immediately after BEGIN', async () => {
    const subjectId = randomUUID(); const calls: string[] = [];
    const isActive = vi.fn(async () => true);
    const account: ResolvedOperatorAccount = { provider: 'supabase', subjectId,
      actorId: `account:${subjectId}`, remote: { isActive } };
    const client = {
      query: vi.fn(async (sql: string) => {
        calls.push(sql.trim());
        return sql.includes('account_identities')
          ? result([{ provider: 'supabase', subject_id: subjectId, status: 'ACTIVE' }]) : result();
      }),
      release: vi.fn(),
    } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const guarded = guardOperatorTransactions(pool, account);
    const guardedClient = await guarded.connect();
    await guardedClient.query('BEGIN');
    await guardedClient.query('SELECT membership');
    expect(calls).toEqual(['BEGIN', expect.stringContaining('FOR UPDATE'), 'SELECT membership']);
    expect(isActive).toHaveBeenCalledOnce();
  });

  it('fails the transaction guard when durable or remote identity is inactive', async () => {
    const subjectId = randomUUID();
    const account: ResolvedOperatorAccount = { provider: 'supabase', subjectId,
      actorId: `account:${subjectId}`, remote: { isActive: vi.fn(async () => false) } };
    const client = { query: vi.fn(async () => result([{ provider: 'supabase', subject_id: subjectId, status: 'ACTIVE' }])) };
    await expect(assertOperatorAccountActive(client as never, account)).rejects.toThrow('SUPABASE_OPERATOR_ACCOUNT_NOT_ACTIVE');
  });

  it('lets a service transaction roll back and release when the guarded remote recheck fails', async () => {
    const subjectId = randomUUID(); const calls: string[] = [];
    const account: ResolvedOperatorAccount = { provider: 'supabase', subjectId,
      actorId: `account:${subjectId}`, remote: { isActive: vi.fn(async () => false) } };
    const client = {
      query: vi.fn(async (sql: string) => {
        calls.push(sql.trim());
        return sql.includes('account_identities')
          ? result([{ provider: 'supabase', subject_id: subjectId, status: 'ACTIVE' }]) : result();
      }), release: vi.fn(),
    } as unknown as PoolClient;
    const guarded = guardOperatorTransactions({ connect: vi.fn(async () => client) } as unknown as Pool, account);
    const serviceClient = await guarded.connect();
    try { await serviceClient.query('BEGIN'); await serviceClient.query('SELECT membership'); }
    catch { await serviceClient.query('ROLLBACK'); }
    finally { serviceClient.release(); }
    expect(calls).toEqual(['BEGIN', expect.stringContaining('FOR UPDATE'), 'ROLLBACK']);
    expect(client.release).toHaveBeenCalledOnce();
  });
});

describe('cloud operator command parsing', () => {
  it('accepts one explicit Supabase account ID for both commands', () => {
    const accountId = randomUUID();
    expect(parseProjectReviewerArguments(['--account-id', accountId])).toEqual({ selector: { accountId }, role: 'REVIEWER', apply: false });
    expect(parseProjectReviewerArguments(['--account-id', accountId, '--role', 'owner', '--apply']))
      .toEqual({ selector: { accountId }, role: 'OWNER', apply: true });
    expect(parseLinkProjectResearchArguments(['--account-id', accountId, '--project', 'circle-packing',
      '--api-base', 'https://research.example.test/api/v1', '--channel-id', randomUUID(), '--channel-name', 'circle'])).toMatchObject({
      selector: { accountId }, project: 'circle-packing', replace: false,
    });
  });

  it('rejects ambiguous account selectors', () => {
    expect(() => parseLinkProjectResearchArguments(['--account-id', randomUUID(), '--account-email', 'member@example.test',
      '--project', 'circle-packing', '--api-base', 'https://research.example.test/api/v1',
      '--channel-id', randomUUID(), '--channel-name', 'circle'])).toThrow('Usage:');
    expect(() => parseProjectReviewerArguments(['--account-id', randomUUID(), '--role', 'reviewer', '--role', 'owner']))
      .toThrow('Usage:');
    expect(() => parseProjectReviewerArguments(['--account-id', randomUUID(), '--apply'])).toThrow('Usage:');
  });

  it('applies an explicit least-privilege reviewer membership and event', async () => {
    const queries: Array<{ sql: string; values?: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        queries.push({ sql, values });
        if (sql.includes('account_identities')) return result([{ provider: 'local-better-auth', subject_id: 'local-user', status: 'ACTIVE' }]);
        if (sql.includes("slug = 'circle-packing'")) return result([{ id: randomUUID() }]);
        if (sql.includes('SELECT role, revoked_at')) return result([]);
        return result();
      }), release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const resolved: ResolvedOperatorAccount = { provider: 'local-better-auth', subjectId: 'local-user',
      actorId: 'account:local-user', remote: null };
    const output = await setProjectReviewer({ pool, selector: { accountEmail: 'member@example.test' },
      role: 'REVIEWER', apply: true,
      resolveAccount: vi.fn(async () => resolved) });
    expect(output).toEqual({ actorId: 'account:local-user', role: 'REVIEWER', status: 'ACTIVE', changed: true });
    expect(queries.some(query => query.sql.includes('project.reviewer-authorized'))).toBe(true);
    expect(queries.find(query => query.sql.includes('INSERT INTO motive.memberships'))?.values).toContain('REVIEWER');
  });

  it('bootstraps owner authority only when owner is explicit', async () => {
    const queries: Array<{ sql: string; values?: unknown[] }> = [];
    const client = { query: vi.fn(async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      if (sql.includes('account_identities')) return result([{ provider: 'local-better-auth', subject_id: 'new-owner', status: 'ACTIVE' }]);
      if (sql.includes("slug = 'circle-packing'")) return result([{ id: randomUUID() }]);
      if (sql.includes('SELECT role, revoked_at')) return result([]);
      return result();
    }), release: vi.fn() };
    const resolved: ResolvedOperatorAccount = { provider: 'local-better-auth', subjectId: 'new-owner',
      actorId: 'account:new-owner', remote: null };
    const output = await setProjectReviewer({ pool: { connect: vi.fn(async () => client) } as unknown as Pool,
      selector: { accountEmail: 'owner@example.test' }, role: 'OWNER', apply: true,
      resolveAccount: vi.fn(async () => resolved) });
    expect(output).toEqual({ actorId: 'account:new-owner', role: 'OWNER', status: 'ACTIVE', changed: true });
    expect(queries.find(query => query.sql.includes('INSERT INTO motive.memberships'))?.values).toContain('OWNER');
  });

  it('previews by default without writing and preserves active higher authority', async () => {
    const queries: Array<{ sql: string; values?: unknown[] }> = [];
    const client = { query: vi.fn(async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      if (sql.includes('account_identities')) return result([{ provider: 'local-better-auth', subject_id: 'owner', status: 'ACTIVE' }]);
      if (sql.includes("slug = 'circle-packing'")) return result([{ id: randomUUID() }]);
      if (sql.includes('SELECT role, revoked_at')) return result([{ role: 'OWNER', revoked_at: null }]);
      return result();
    }), release: vi.fn() };
    const resolved: ResolvedOperatorAccount = { provider: 'local-better-auth', subjectId: 'owner',
      actorId: 'account:owner', remote: null };
    const output = await setProjectReviewer({ pool: { connect: vi.fn(async () => client) } as unknown as Pool,
      selector: { accountEmail: 'owner@example.test' }, resolveAccount: vi.fn(async () => resolved) });
    expect(output).toEqual({ actorId: 'account:owner', role: 'OWNER', status: 'DRY_RUN', changed: false });
    expect(queries.some(query => query.sql.includes('INSERT INTO motive.memberships'))).toBe(false);
    expect(queries.at(-1)?.sql).toBe('ROLLBACK');
  });

  it('preserves an active steward and rejects a direct legacy apply without a role', async () => {
    const queries: string[] = [];
    const client = { query: vi.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.includes('account_identities')) return result([{ provider: 'local-better-auth', subject_id: 'steward', status: 'ACTIVE' }]);
      if (sql.includes("slug = 'circle-packing'")) return result([{ id: randomUUID() }]);
      if (sql.includes('SELECT role, revoked_at')) return result([{ role: 'STEWARD', revoked_at: null }]);
      return result();
    }), release: vi.fn() };
    const resolved: ResolvedOperatorAccount = { provider: 'local-better-auth', subjectId: 'steward',
      actorId: 'account:steward', remote: null };
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const output = await setProjectReviewer({ pool, selector: { accountEmail: 'steward@example.test' },
      role: 'REVIEWER', apply: true, resolveAccount: vi.fn(async () => resolved) });
    expect(output).toEqual({ actorId: 'account:steward', role: 'STEWARD', status: 'ACTIVE', changed: false });
    expect(queries.some(sql => sql.includes('INSERT INTO motive.memberships'))).toBe(false);
    const resolveAccount = vi.fn(async () => resolved);
    await expect(setProjectReviewer({ pool, selector: { accountEmail: 'steward@example.test' }, apply: true, resolveAccount }))
      .rejects.toThrow('Usage:');
    expect(resolveAccount).not.toHaveBeenCalled();
    await expect(setProjectReviewer({ pool, selector: { accountEmail: 'steward@example.test' },
      role: 'STEWARD' as never, resolveAccount })).rejects.toThrow('Usage:');
    expect(resolveAccount).not.toHaveBeenCalled();
  });

  it('refuses to restore revoked owner or steward authority through reviewer mode', async () => {
    for (const role of ['OWNER','STEWARD']) {
      const client = { query: vi.fn(async (sql: string) => {
        if (sql.includes('account_identities')) return result([{ provider: 'local-better-auth', subject_id: role.toLowerCase(), status: 'ACTIVE' }]);
        if (sql.includes("slug = 'circle-packing'")) return result([{ id: randomUUID() }]);
        if (sql.includes('SELECT role, revoked_at')) return result([{ role, revoked_at: new Date() }]);
        return result();
      }), release: vi.fn() };
      const resolved: ResolvedOperatorAccount = { provider: 'local-better-auth', subjectId: role.toLowerCase(),
        actorId: `account:${role.toLowerCase()}`, remote: null };
      await expect(setProjectReviewer({ pool: { connect: vi.fn(async () => client) } as unknown as Pool,
        selector: { accountEmail: `${role.toLowerCase()}@example.test` }, role: 'REVIEWER', apply: true,
        resolveAccount: vi.fn(async () => resolved) })).rejects.toThrow('REVOKED_HIGHER_AUTHORITY_REQUIRES_EXPLICIT_ADMIN_CHANGE');
      expect(client.query).toHaveBeenLastCalledWith('ROLLBACK');
    }
  });

  it('rolls back without granting review when a resolved identity enters deletion', async () => {
    const subjectId = randomUUID(); const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql.trim());
        if (sql.includes('account_identities')) {
          return result([{ provider: 'supabase', subject_id: subjectId, status: 'DELETION_PENDING' }]);
        }
        return result();
      }), release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const resolved: ResolvedOperatorAccount = { provider: 'supabase', subjectId,
      actorId: `account:${subjectId}`, remote: { isActive: vi.fn(async () => true) } };
    await expect(setProjectReviewer({ pool, selector: { accountId: subjectId },
      resolveAccount: vi.fn(async () => resolved) })).rejects.toThrow('SUPABASE_OPERATOR_ACCOUNT_NOT_ACTIVE');
    expect(queries).toEqual(['BEGIN', expect.stringContaining('FOR UPDATE'), 'ROLLBACK']);
    expect(queries.some(sql => sql.includes('memberships') || sql.includes('motive.events'))).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
  });
});
