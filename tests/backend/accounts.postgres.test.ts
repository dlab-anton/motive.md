import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { applyPostgresMigrations, getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { AccountError, type AccountPrincipal } from '../../server/accounts/types.ts';
import { PostgresAccountStore } from '../../server/accounts/store.ts';

const baseUrl = process.env.MOTIVE_TEST_DATABASE_URL;
const pgDescribe = baseUrl ? describe : describe.skip;

pgDescribe('PostgreSQL account store on an isolated database', () => {
  const databaseName = `motive_accounts_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool;
  let pool: Pool;
  let store: PostgresAccountStore;

  const principal = (name: string): AccountPrincipal => {
    const subjectId = randomUUID();
    return {
      provider: 'supabase',
      subjectId,
      actorId: `account:${subjectId}`,
      name,
      email: `${subjectId}@test.invalid`,
      createdAt: new Date('2026-09-07T00:00:00.000Z'),
      emailVerified: true,
    };
  };

  beforeAll(async () => {
    const source = new URL(baseUrl!);
    const adminUrl = new URL(source);
    adminUrl.pathname = '/postgres';
    admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const testUrl = new URL(source);
    testUrl.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: testUrl.toString(), max: 12 });
    await applyPostgresMigrations(pool);
    expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    await new LedgerKernel(pool).createProject({
      actorId: `operator:account-test-${randomUUID()}`,
      idempotencyKey: randomUUID(),
      slug: 'circle-packing',
      visibility: 'PUBLIC',
      revisionContent: { title: 'Isolated account-store project' },
    });
    store = new PostgresAccountStore(pool);
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
      await admin.end();
    }
  });

  it('establishes an account and its welcome grant exactly once under concurrency', async () => {
    const account = principal('Concurrent account');
    await Promise.all(Array.from({ length: 8 }, () => store.establish(account)));
    const wallets = await Promise.all(Array.from({ length: 8 }, () => store.ensureWelcome(account.actorId)));

    expect(wallets).toEqual(Array.from({ length: 8 }, () => ({
      unit: 'motive_credit', issued: 10, available: 10, allocated: 0, allocations: [], executionEnabled: false,
    })));
    const rows = await pool.query(`SELECT
      (SELECT count(*)::int FROM motive.account_identities WHERE actor_id=$1) AS identities,
      (SELECT count(*)::int FROM motive.account_profiles WHERE actor_id=$1) AS profiles,
      (SELECT count(*)::int FROM motive.account_credit_wallets WHERE actor_id=$1) AS wallets,
      (SELECT count(*)::int FROM motive.account_credit_ledger_entries WHERE actor_id=$1 AND kind='WELCOME_ISSUED') AS welcomes`,
    [account.actorId]);
    expect(rows.rows[0]).toEqual({ identities: 1, profiles: 1, wallets: 1, welcomes: 1 });
  });

  it('replays the same allocation, rejects a changed body, and serializes concurrent overspend', async () => {
    const idempotent = principal('Idempotent allocator');
    await store.establish(idempotent);
    const key = `allocation-${randomUUID()}`;
    const results = await Promise.all([
      store.allocate(idempotent.actorId, key, { project: 'circle-packing', amount: 4 }),
      store.allocate(idempotent.actorId, key, { project: 'circle-packing', amount: 4 }),
    ]);
    expect(results.map(result => result.replayed).sort()).toEqual([false, true]);
    expect(new Set(results.map(result => result.receipt.id)).size).toBe(1);
    expect(results[0].wallet).toMatchObject({ issued: 10, allocated: 4, available: 6 });
    await expect(store.allocate(idempotent.actorId, key, { project: 'circle-packing', amount: 5 }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    const contested = principal('Concurrent allocator');
    await store.establish(contested);
    const attempts = await Promise.allSettled([
      store.allocate(contested.actorId, `allocation-${randomUUID()}`, { project: 'circle-packing', amount: 6 }),
      store.allocate(contested.actorId, `allocation-${randomUUID()}`, { project: 'circle-packing', amount: 6 }),
    ]);
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.find(result => result.status === 'rejected');
    expect(rejected).toMatchObject({ status: 'rejected', reason: { code: 'INSUFFICIENT_CREDITS' } });
    expect(await store.readWallet(contested.actorId)).toMatchObject({ issued: 10, allocated: 6, available: 4 });
    const durable = await pool.query(`SELECT
      (SELECT count(*)::int FROM motive.account_credit_allocations WHERE actor_id=$1) AS allocations,
      (SELECT count(*)::int FROM motive.account_credit_ledger_entries WHERE actor_id=$1 AND kind='PROJECT_ALLOCATED') AS ledger_entries`,
    [contested.actorId]);
    expect(durable.rows[0]).toEqual({ allocations: 1, ledger_entries: 1 });
  });

  it('never reactivates a deleted identity and deletes only its mutable profile and follows', async () => {
    const account = principal('Account to delete');
    await store.establish(account);
    await store.setBio(account.actorId, 'This profile must be removed.');
    await store.follow(account.actorId, { type: 'follow', goal: 'circle-packing', following: true });
    const receipt = await store.allocate(account.actorId, `allocation-${randomUUID()}`, { project: 'circle-packing', amount: 3 });
    expect(receipt.replayed).toBe(false);

    expect(await store.beginDeletion(account.actorId)).toBe('STARTED');
    expect(await store.beginDeletion(account.actorId)).toBe('PENDING');
    await store.finalizeDeletion(account.actorId);
    expect(await store.status(account.actorId)).toBe('DELETED');
    await expect(store.workspace(account.actorId)).rejects.toMatchObject({ code: 'INACTIVE' });
    await expect(store.establish(account)).rejects.toBeInstanceOf(AccountError);
    await expect(store.establish(account)).rejects.toMatchObject({ code: 'INACTIVE' });
    expect(await store.status(account.actorId)).toBe('DELETED');

    const retained = await pool.query(`SELECT
      (SELECT count(*)::int FROM motive.account_identities WHERE actor_id=$1 AND status='DELETED') AS identities,
      (SELECT count(*)::int FROM motive.account_profiles WHERE actor_id=$1) AS profiles,
      (SELECT count(*)::int FROM motive.account_project_follows WHERE actor_id=$1) AS follows,
      (SELECT count(*)::int FROM motive.account_credit_wallets WHERE actor_id=$1) AS wallets,
      (SELECT count(*)::int FROM motive.account_credit_allocations WHERE actor_id=$1) AS allocations,
      (SELECT count(*)::int FROM motive.account_credit_ledger_entries WHERE actor_id=$1) AS ledger_entries`,
    [account.actorId]);
    expect(retained.rows[0]).toEqual({ identities: 1, profiles: 0, follows: 0, wallets: 1, allocations: 1, ledger_entries: 2 });
    expect(JSON.stringify(retained.rows[0])).not.toContain(account.email);
  });
});
