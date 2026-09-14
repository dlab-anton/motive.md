import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import express from 'express';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { applyPostgresMigrations, getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { createParticipationRouters, createParticipationService, type ParticipationService } from '../../server/participation/index.ts';

const baseUrl = process.env.MOTIVE_TEST_DATABASE_URL;
const pgDescribe = baseUrl ? describe : describe.skip;

pgDescribe('participation agent sessions on isolated PostgreSQL', () => {
  const databaseName = `motive_agent_session_${randomUUID().replaceAll('-', '')}`;
  const issuer = `operator:agent-session-${randomUUID()}`;
  let admin: Pool;
  let pool: Pool;
  let service: ParticipationService;
  let now = new Date();
  let owner: string;
  let token: string;
  let tokenId: string;
  let server: Server;
  let httpOrigin: string;

  beforeAll(async () => {
    const source = new URL(baseUrl!);
    const adminUrl = new URL(source); adminUrl.pathname = '/postgres';
    admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const testUrl = new URL(source); testUrl.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: testUrl.toString(), max: 4 });
    await applyPostgresMigrations(pool);
    expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    await new LedgerKernel(pool).createProject({ actorId: issuer, idempotencyKey: randomUUID(), slug: 'circle-packing',
      visibility: 'PUBLIC', revisionContent: { title: 'Agent session test' } });
    service = createParticipationService(pool, {
      tokenSecret: 'agent-session-test-secret-longer-than-thirty-two-bytes', issuerActorId: issuer, now: () => now,
    });
    await service.ensureCircleWorkOrder();
    owner = `account:${randomUUID()}`;
    await activate(owner);
    const joined = await service.join(owner, 'Session agent', { projectSlug: 'circle-packing', publishDisplayName: false,
      acceptReferenceTerms: true }, `join-${randomUUID()}`);
    token = joined.token; tokenId = joined.credential.id;

    const app = express();
    app.use(express.json());
    const routers = createParticipationRouters({ service, isActorActive: async actorId => {
      const result = await pool.query(`SELECT 1 FROM motive.account_identities WHERE actor_id=$1 AND status='ACTIVE'`, [actorId]);
      return result.rowCount === 1;
    } });
    app.use('/api/account', (_req, res, next) => {
      res.locals.actorId = owner; res.locals.accountName = 'Session owner'; next();
    }, routers.accountRouter);
    app.use('/api/agent', routers.agentRouter);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test HTTP server did not bind a TCP port.');
    httpOrigin = `http://127.0.0.1:${address.port}`;
  }, 30_000);

  afterAll(async () => {
    if (server) { server.close(); await once(server, 'close'); }
    await pool?.end();
    if (admin) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
      await admin.end();
    }
  });

  async function activate(actorId: string) {
    await pool.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at)
      VALUES($1,'supabase',$2,'ACTIVE',clock_timestamp())`, [actorId, randomUUID()]);
  }

  async function session(body: unknown, key = randomUUID()) {
    const response = await fetch(`${httpOrigin}/api/agent/session`, { method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key,
    }, body: JSON.stringify(body) });
    return { response, payload: await response.json() as Record<string, unknown> };
  }

  async function sessionEventCount() {
    return Number((await pool.query(`SELECT count(*)::integer AS count FROM motive.events
      WHERE aggregate_id=$1 AND event_type='external.agent_session_updated'`, [tokenId])).rows[0].count);
  }

  it('derives truthful presence while keeping heartbeats and owner queue reads free of session events', async () => {
    const initial = await service.getMe(owner);
    expect(initial.sessions).toEqual([expect.objectContaining({ credentialId: tokenId,
      status: null, runMode: null, declaredAt: null, stopReason: null, presence: 'UNKNOWN',
      presenceReason: 'NO_DECLARATION', lastContactAt: null, accessStatus: 'AVAILABLE' })]);
    expect(initial.loopProgress).toEqual([expect.objectContaining({ credentialId: tokenId,
      completedCycles: 0, acceptedDistinctFindings: 0, xp: 0 })]);

    for (const body of [
      { status: 'RUNNING', runMode: 'ONE_TASK', stopReason: 'not allowed' },
      { status: 'PAUSED', runMode: 'ONE_TASK', stopReason: ' padded ' },
      { status: 'PAUSED', runMode: 'ONE_TASK', stopReason: 'line\nbreak' },
      { status: 'PAUSED', runMode: 'ONE_TASK', unexpected: true },
    ]) {
      const invalid = await session(body);
      expect(invalid.response.status, JSON.stringify(invalid.payload)).toBe(400);
    }
    expect(await sessionEventCount()).toBe(0);

    const idempotencyKey = randomUUID();
    const running = await session({ status: 'RUNNING', runMode: 'ONE_TASK' }, idempotencyKey);
    expect(running.response.status).toBe(201);
    expect(running.payload).toMatchObject({ credentialId: tokenId, status: 'RUNNING', runMode: 'ONE_TASK',
      stopReason: null, presence: 'ACTIVE', presenceReason: 'FRESH_CONTACT', accessStatus: 'AVAILABLE' });
    const replay = await session({ status: 'RUNNING', runMode: 'ONE_TASK' }, idempotencyKey);
    expect(replay.response.status).toBe(201);
    expect(replay.payload).toEqual(running.payload);
    expect(await sessionEventCount()).toBe(1);

    const beforeHeartbeat = await sessionEventCount();
    for (let index = 0; index < 2; index += 1) {
      const response = await fetch(`${httpOrigin}/api/agent/assignment`, { headers: { Authorization: `Bearer ${token}` } });
      expect(response.status).toBe(200);
    }
    expect(await sessionEventCount()).toBe(beforeHeartbeat);

    const lastContact = new Date(String((await pool.query(`SELECT last_used_at FROM motive.participation_agent_tokens
      WHERE id=$1`, [tokenId])).rows[0].last_used_at));
    now = new Date(lastContact.getTime() + 2 * 60 * 1000 + 1000);
    expect((await service.getMe(owner)).sessions?.[0]).toMatchObject({ status: 'RUNNING', presence: 'UNKNOWN',
      presenceReason: 'STALE_CONTACT', accessStatus: 'AVAILABLE' });

    now = new Date();
    const timed = await session({ status: 'RUNNING', runMode: 'THIRTY_MINUTES' });
    expect(timed.response.status).toBe(201);
    now = new Date(new Date(String(timed.payload.declaredAt)).getTime() + 30 * 60 * 1000);
    expect((await service.getMe(owner)).sessions?.[0]).toMatchObject({ status: 'RUNNING', runMode: 'THIRTY_MINUTES',
      presence: 'UNKNOWN', presenceReason: 'RUN_LIMIT_REACHED', accessStatus: 'AVAILABLE' });

    now = new Date();
    const paused = await session({ status: 'PAUSED', runMode: 'UNTIL_STOPPED', stopReason: 'Saved work after one bounded run.' });
    expect(paused.payload).toMatchObject({ status: 'PAUSED', runMode: 'UNTIL_STOPPED',
      stopReason: 'Saved work after one bounded run.', presence: 'PAUSED', presenceReason: 'EXPLICITLY_PAUSED' });
    now = new Date(new Date(String(paused.payload.declaredAt)).getTime() + 60 * 60 * 1000);
    expect((await service.getMe(owner)).sessions?.[0]).toMatchObject({ presence: 'PAUSED', presenceReason: 'EXPLICITLY_PAUSED' });

    now = new Date();
    const contactBeforeOwnerRead = (await pool.query(`SELECT last_used_at FROM motive.participation_agent_tokens WHERE id=$1`, [tokenId])).rows[0].last_used_at;
    const queue = await fetch(`${httpOrigin}/api/account/tokens/${tokenId}/work-queue`);
    expect(queue.status).toBe(200);
    expect(queue.headers.get('cache-control')).toBe('no-store');
    expect(await queue.json()).toMatchObject({ format: 'motive.agent-work-queue.v1' });
    const contactAfterOwnerRead = (await pool.query(`SELECT last_used_at FROM motive.participation_agent_tokens WHERE id=$1`, [tokenId])).rows[0].last_used_at;
    expect(contactAfterOwnerRead).toEqual(contactBeforeOwnerRead);
    expect(await sessionEventCount()).toBe(3);

    const foreignOwner = `account:${randomUUID()}`; await activate(foreignOwner);
    const foreign = await service.join(foreignOwner, 'Foreign owner agent', { projectSlug: 'circle-packing', publishDisplayName: false,
      acceptReferenceTerms: true }, `join-${randomUUID()}`);
    const wrongOwner = await fetch(`${httpOrigin}/api/account/tokens/${foreign.credential.id}/work-queue`);
    expect(wrongOwner.status).toBe(404);

    await service.revokeToken(owner, tokenId, `revoke-${randomUUID()}`);
    expect((await service.getMe(owner)).sessions?.[0]).toMatchObject({ status: 'PAUSED', presence: 'UNKNOWN',
      presenceReason: 'ACCESS_REVOKED', accessStatus: 'REVOKED' });
    expect((await fetch(`${httpOrigin}/api/account/tokens/${tokenId}/work-queue`)).status).toBe(401);

    now = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);
    const expired = (await service.getMe(foreignOwner)).sessions?.find(item => item.credentialId === foreign.credential.id);
    expect(expired).toMatchObject({ status: null, presence: 'UNKNOWN', presenceReason: 'ACCESS_EXPIRED', accessStatus: 'EXPIRED' });
  }, 30_000);
});
