import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { applyPostgresMigrations, getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { createParticipationService, type ParticipationService } from '../../server/participation/index.ts';

const baseUrl = process.env.MOTIVE_TEST_DATABASE_URL;
const pgDescribe = baseUrl ? describe : describe.skip;

pgDescribe('participation bearer heartbeat on isolated PostgreSQL', () => {
  const databaseName = `motive_bearer_heartbeat_${randomUUID().replaceAll('-', '')}`;
  const issuer = `operator:bearer-heartbeat-${randomUUID()}`;
  const tokenSecret = `bearer-heartbeat-test-${'s'.repeat(48)}`;
  let admin: Pool;
  let pool: Pool;
  let authPool: Pool;
  let service: ParticipationService;
  let now = new Date();

  beforeAll(async () => {
    const source = new URL(baseUrl!);
    const adminUrl = new URL(source); adminUrl.pathname = '/postgres';
    admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const testUrl = new URL(source); testUrl.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: testUrl.toString(), max: 4 });
    authPool = new Pool({ connectionString: testUrl.toString(), max: 1, application_name: 'motive_bearer_heartbeat_race' });
    await applyPostgresMigrations(pool);
    expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    await new LedgerKernel(pool).createProject({ actorId: issuer, idempotencyKey: randomUUID(), slug: 'circle-packing',
      visibility: 'PUBLIC', revisionContent: { title: 'Bearer heartbeat test' } });
    service = createParticipationService(pool, { tokenSecret, issuerActorId: issuer, now: () => now });
    await service.ensureCircleWorkOrder();
  }, 30_000);

  afterAll(async () => {
    await authPool?.end();
    await pool?.end();
    if (admin) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
      await admin.end();
    }
  });

  async function token(label: string) {
    const owner = `account:${randomUUID()}`;
    const joined = await service.join(owner, label, { projectSlug: 'circle-packing', publishDisplayName: false,
      acceptReferenceTerms: true }, `join-${randomUUID()}`);
    return { owner, raw: joined.token, id: joined.credential.id };
  }

  async function heartbeat(id: string) {
    return (await pool.query('SELECT last_used_at FROM motive.participation_agent_tokens WHERE id=$1', [id])).rows[0].last_used_at;
  }

  it('atomically authenticates a valid token and rejects non-current tokens without a heartbeat', async () => {
    const valid = await token('Valid bearer');
    expect(await heartbeat(valid.id)).toBeNull();
    const context = await service.authenticateBearer(valid.raw);
    expect(context).toMatchObject({ tokenId: valid.id, actorId: `agent:${valid.id}`, ownerActorId: valid.owner });
    expect(context.projectId).toMatch(/^[a-f0-9-]{36}$/);
    expect(context.expiresAt).toBeTruthy();
    expect(await heartbeat(valid.id)).toBeInstanceOf(Date);

    await expect(service.authenticateBearer('not-a-token')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const unknown = `motive_agent_${'0'.repeat(32)}_${'A'.repeat(43)}`;
    await expect(service.authenticateBearer(unknown)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const revoked = await token('Revoked bearer');
    const revokedHeartbeat = new Date('2025-01-02T03:04:05.000Z');
    await pool.query(`UPDATE motive.participation_agent_tokens SET last_used_at=$2,revoked_at=$3 WHERE id=$1`,
      [revoked.id, revokedHeartbeat, new Date(now.getTime() - 1)]);
    await expect(service.authenticateBearer(revoked.raw)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await heartbeat(revoked.id)).toEqual(revokedHeartbeat);

    const expired = await token('Expired bearer');
    const expiredHeartbeat = new Date('2025-02-03T04:05:06.000Z');
    await pool.query('UPDATE motive.participation_agent_tokens SET last_used_at=$2 WHERE id=$1', [expired.id, expiredHeartbeat]);
    const issuedExpiry = new Date((await pool.query(
      'SELECT expires_at FROM motive.participation_agent_tokens WHERE id=$1', [expired.id])).rows[0].expires_at);
    const beforeExpiryCheck = now;
    try {
      now = new Date(issuedExpiry.getTime() + 1);
      await expect(service.authenticateBearer(expired.raw)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      expect(await heartbeat(expired.id)).toEqual(expiredHeartbeat);
    } finally { now = beforeExpiryCheck; }
  }, 30_000);

  it('cannot refresh or authorize after a concurrent revocation commits first', async () => {
    const raced = await token('Raced bearer');
    const priorHeartbeat = new Date('2025-03-04T05:06:07.000Z');
    await pool.query('UPDATE motive.participation_agent_tokens SET last_used_at=$2 WHERE id=$1', [raced.id, priorHeartbeat]);
    const revoker = await pool.connect();
    let transactionOpen = false;
    let authentication: Promise<{ context?: Awaited<ReturnType<ParticipationService['authenticateBearer']>>; error?: unknown }> | undefined;
    try {
      await revoker.query('BEGIN'); transactionOpen = true;
      await revoker.query('UPDATE motive.participation_agent_tokens SET revoked_at=clock_timestamp() WHERE id=$1', [raced.id]);
      const racingService = createParticipationService(authPool, { tokenSecret, issuerActorId: issuer, now: () => now });
      authentication = racingService.authenticateBearer(raced.raw).then(context => ({ context }), error => ({ error }));

      let blocked = false;
      for (let attempt = 0; attempt < 100 && !blocked; attempt += 1) {
        blocked = Boolean((await pool.query(`SELECT 1 FROM pg_stat_activity activity
          WHERE activity.datname=$1 AND activity.application_name='motive_bearer_heartbeat_race'
            AND cardinality(pg_blocking_pids(activity.pid))>0`, [databaseName])).rowCount);
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await revoker.query('COMMIT'); transactionOpen = false;
      const result = await authentication;
      expect(result.context).toBeUndefined();
      expect(result.error).toMatchObject({ code: 'UNAUTHORIZED' });
      expect(await heartbeat(raced.id)).toEqual(priorHeartbeat);
    } finally {
      if (transactionOpen) await revoker.query('ROLLBACK');
      if (authentication) await authentication;
      revoker.release();
    }
  }, 30_000);
});
