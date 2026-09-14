import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { applyPostgresMigrations, defaultMigrationDirectory, getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { createLocalAccountIdentityBridge, type LocalAccountIdentityBridge } from '../../server/accounts/local-identity.ts';
import { createParticipationService, type ParticipationService } from '../../server/participation/index.ts';
import type { AccountPrincipal } from '../../server/accounts/types.ts';

const baseUrl = process.env.MOTIVE_TEST_DATABASE_URL;
const pgDescribe = baseUrl ? describe : describe.skip;

pgDescribe('local Better Auth durable identity on isolated PostgreSQL', () => {
  const databaseName = `motive_local_identity_${randomUUID().replaceAll('-', '')}`;
  let admin: Pool; let pool: Pool; let bridge: LocalAccountIdentityBridge;
  let migrationSubset: string;
  const historicalSupabaseId = randomUUID();
  const historicalSupabaseActor = `account:historical-${randomUUID()}`;

  const principal = (subjectId = `local.${randomUUID()}`): AccountPrincipal => ({
    provider: 'local-better-auth',
    subjectId,
    actorId: `account:${subjectId}`,
    name: 'Local identity test',
    email: `${subjectId}@example.test`,
    createdAt: new Date('2026-09-09T00:00:00.000Z'),
    emailVerified: true,
  });

  beforeAll(async () => {
    const source = new URL(baseUrl!); const adminUrl = new URL(source); adminUrl.pathname = '/postgres';
    admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
    await admin.query(`CREATE DATABASE ${databaseName}`);
    console.info(JSON.stringify({ event: 'local_identity_test_database_created', databaseName }));
    const testUrl = new URL(source); testUrl.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: testUrl.toString(), max: 8 });
    migrationSubset = await mkdtemp(join(tmpdir(), 'motive-local-identity-migrations-'));
    for (const name of await readdir(defaultMigrationDirectory)) {
      if (/^\d{3}_[a-z0-9_]+\.sql$/i.test(name) && name < '035_') {
        await copyFile(join(defaultMigrationDirectory, name), join(migrationSubset, name));
      }
    }
    await applyPostgresMigrations(pool, migrationSubset);
    await pool.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at)
      VALUES($1,'supabase',$2,'ACTIVE',clock_timestamp())`, [historicalSupabaseActor, historicalSupabaseId]);
    await applyPostgresMigrations(pool);
    expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    bridge = createLocalAccountIdentityBridge(pool);
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
      expect((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [databaseName])).rowCount).toBe(0);
      console.info(JSON.stringify({ event: 'local_identity_test_database_removed', databaseName }));
      await admin.end();
    }
    if (migrationSubset) {
      const owned = await realpath(migrationSubset); const temporaryRoot = await realpath(tmpdir());
      const name = basename(owned);
      if (dirname(owned) !== resolve(temporaryRoot) || !/^motive-local-identity-migrations-[A-Za-z0-9_-]+$/.test(name)
          || name === 'motive-local-identity-migrations-') {
        throw new Error('Refusing to remove an unverified migration subset path.');
      }
      await rm(owned, { recursive: true, force: true });
    }
  });

  it('establishes only an exact local identity and preserves Supabase UUID identities', async () => {
    const local = principal();
    await expect(bridge.establish(local)).resolves.toMatchObject({ provider: 'local-better-auth',
      subjectId: local.subjectId, actorId: local.actorId });
    await expect(bridge.establish(local)).resolves.toMatchObject({ actorId: local.actorId });
    const rows = await pool.query(`SELECT provider,subject_id,status,created_at FROM motive.account_identities
      WHERE actor_id=$1`, [local.actorId]);
    expect(rows.rows).toEqual([{ provider: 'local-better-auth', subject_id: local.subjectId,
      status: 'ACTIVE', created_at: local.createdAt }]);
    for (const table of ['account_profiles','account_credit_wallets','memberships','participation_agent_tokens']) {
      expect((await pool.query(`SELECT 1 FROM motive.${table} WHERE ${table === 'participation_agent_tokens'
        ? 'owner_actor_id' : 'actor_id'}=$1`, [local.actorId])).rowCount).toBe(0);
    }

    expect((await pool.query('SELECT provider,subject_id,status FROM motive.account_identities WHERE actor_id=$1',
      [historicalSupabaseActor])).rows[0]).toEqual({ provider: 'supabase', subject_id: historicalSupabaseId, status: 'ACTIVE' });
    await expect(pool.query('UPDATE motive.account_identities SET subject_id=$2 WHERE actor_id=$1',
      [historicalSupabaseActor, randomUUID()])).rejects.toMatchObject({ code: '55000' });
    expect((await pool.query(`SELECT relrowsecurity FROM pg_class WHERE oid='motive.account_identities'::regclass`))
      .rows[0]?.relrowsecurity).toBe(true);
    await expect(pool.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at)
      VALUES($1,'supabase',$2,'ACTIVE',clock_timestamp())`, [`account:invalid-supabase-${randomUUID()}`, 'not-a-uuid']))
      .rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at)
      VALUES($1,'local-better-auth',$2,'ACTIVE',clock_timestamp())`, [`account:not-the-subject`, `different-${randomUUID()}`]))
      .rejects.toMatchObject({ code: '23514' });

    const collisionSubject = `collision.${randomUUID()}`;
    await pool.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at)
      VALUES($1,'supabase',$2,'ACTIVE',clock_timestamp())`, [`account:${collisionSubject}`, randomUUID()]);
    await expect(bridge.establish(principal(collisionSubject))).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('tombstones deletion before first establishment and cannot resurrect it', async () => {
    const local = principal();
    await bridge.retire({ subjectId: local.subjectId, createdAt: local.createdAt });
    expect((await pool.query(`SELECT provider,subject_id,status,deletion_requested_at,deleted_at
      FROM motive.account_identities WHERE actor_id=$1`, [local.actorId])).rows[0]).toMatchObject({
      provider: 'local-better-auth', subject_id: local.subjectId, status: 'DELETED',
      deletion_requested_at: expect.any(Date), deleted_at: expect.any(Date),
    });
    await expect(bridge.establish(local)).rejects.toMatchObject({ code: 'INACTIVE' });
    expect(await bridge.isActive(local.actorId)).toBe(false);
    expect((await pool.query('SELECT 1 FROM motive.memberships WHERE actor_id=$1', [local.actorId])).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM motive.participation_agent_tokens WHERE owner_actor_id=$1', [local.actorId])).rowCount).toBe(0);
  });

  it('leaves a fail-closed tombstone after revocation failure and completes on retry', async () => {
    const local = principal(); await bridge.establish(local);
    const issuer = `operator:local-identity-${randomUUID()}`;
    await new LedgerKernel(pool).createProject({ actorId: issuer, idempotencyKey: randomUUID(), slug: 'circle-packing',
      visibility: 'PUBLIC', revisionContent: { title: 'Local identity test' } });
    const service: ParticipationService = createParticipationService(pool, {
      tokenSecret: `test-only-${'l'.repeat(48)}`, issuerActorId: issuer,
      isActorActive: actorId => bridge.isActive(actorId),
    });
    await service.ensureCircleWorkOrder();
    await service.join(local.actorId, 'Local contributor', { projectSlug: 'circle-packing', publishDisplayName: false,
      acceptReferenceTerms: true }, `join-${randomUUID()}`);
    await pool.query(`CREATE FUNCTION motive.fail_local_identity_test_revoke() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'intentional local identity test failure'; END $$`);
    await pool.query(`CREATE TRIGGER fail_local_identity_test_revoke BEFORE UPDATE ON motive.memberships
      FOR EACH ROW WHEN (OLD.actor_id='${local.actorId}') EXECUTE FUNCTION motive.fail_local_identity_test_revoke()`);
    await expect(bridge.retire({ subjectId: local.subjectId, createdAt: local.createdAt })).rejects.toThrow(
      'intentional local identity test failure');
    expect((await pool.query('SELECT status FROM motive.account_identities WHERE actor_id=$1', [local.actorId])).rows[0]?.status)
      .toBe('DELETION_PENDING');
    expect(await bridge.isActive(local.actorId)).toBe(false);
    expect((await pool.query('SELECT revoked_at FROM motive.memberships WHERE actor_id=$1', [local.actorId])).rows[0]?.revoked_at)
      .toBeNull();
    await pool.query('DROP TRIGGER fail_local_identity_test_revoke ON motive.memberships');
    await pool.query('DROP FUNCTION motive.fail_local_identity_test_revoke()');
    await bridge.retire({ subjectId: local.subjectId, createdAt: local.createdAt });
    expect((await pool.query('SELECT status FROM motive.account_identities WHERE actor_id=$1', [local.actorId])).rows[0]?.status)
      .toBe('DELETED');
    expect((await pool.query('SELECT revoked_at FROM motive.memberships WHERE actor_id=$1', [local.actorId])).rows[0]?.revoked_at)
      .toBeInstanceOf(Date);
    expect((await pool.query('SELECT revoked_at FROM motive.participation_agent_tokens WHERE owner_actor_id=$1', [local.actorId])).rows[0]?.revoked_at)
      .toBeInstanceOf(Date);
  });

  it('serializes concurrent establishment and retirement to a final tombstone', async () => {
    const local = principal();
    const results = await Promise.allSettled([
      bridge.establish(local),
      bridge.retire({ subjectId: local.subjectId, createdAt: local.createdAt }),
    ]);
    expect(results.some(result => result.status === 'fulfilled')).toBe(true);
    expect((await pool.query('SELECT status FROM motive.account_identities WHERE actor_id=$1', [local.actorId])).rows[0]?.status)
      .toBe('DELETED');
    await expect(bridge.establish(local)).rejects.toMatchObject({ code: 'INACTIVE' });
  });
});
