import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it } from 'vitest';
import { createPublicRepository } from '../../server/control/public-repository.ts';
import { digestCanonicalJson } from '../../packages/domain/src/contracts.ts';
import { getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';

const url = process.env.MOTIVE_TEST_DATABASE_URL;
describe.skipIf(!url)('PostgreSQL control projections (real database)', () => {
  let pool: Pool; let client: PoolClient;
  beforeAll(async () => { pool = new Pool({ connectionString: url, max: 2 }); await pool.query('SELECT id FROM motive.projects LIMIT 0'); });
  afterAll(async () => { await pool?.end(); });
  beforeEach(async () => { client = await pool.connect(); await client.query('BEGIN'); });
  afterEach(async () => { if (client) { await client.query('ROLLBACK'); client.release(); } });
  async function addProject(visibility: 'PUBLIC' | 'PRIVATE') {
    const id = randomUUID(), slug = `control-${randomUUID()}`;
    const content = { title: 'Test project', purpose: 'Public purpose', next_step: 'Awaiting approval', secret: 'never-return-this' };
    await client.query(`INSERT INTO motive.projects (id,slug,visibility,current_revision,created_by) VALUES ($1,$2,$3,1,'test')`, [id,slug,visibility]);
    await client.query(`INSERT INTO motive.project_revisions (id,project_id,revision,format,content,content_digest,created_by)
      VALUES ($1,$2,1,'motive.project/0.1',$3,$4,'test')`, [randomUUID(),id,content,digestCanonicalJson(content)]);
    return { id, slug };
  }
  it('public catalogue omits private records and non-projected content', async () => {
    const visible = await addProject('PUBLIC'); const hidden = await addProject('PRIVATE');
    const repository = createPublicRepository(client);
    const projects = await repository.listPublicProjects();
    expect(projects.some(item => item.id === visible.id)).toBe(true);
    expect(projects.some(item => item.id === hidden.id)).toBe(false);
    expect(JSON.stringify(projects)).not.toContain('never-return-this');
    expect(await repository.getProject(hidden.slug, null)).toBeNull();
  });
  it('checks membership revocation on each private read', async () => {
    const hidden = await addProject('PRIVATE'); const actor = randomUUID();
    const repository = createPublicRepository(client);
    await client.query(`INSERT INTO motive.memberships (id,project_id,actor_id,role,granted_by) VALUES ($1,$2,$3,'CONTRIBUTOR','test')`, [randomUUID(), hidden.id, actor]);
    expect((await repository.getProject(hidden.slug, actor))?.id).toBe(hidden.id);
    expect(await repository.getProject(hidden.slug, 'different-actor')).toBeNull();
    await client.query('UPDATE motive.memberships SET revoked_at = clock_timestamp() WHERE actor_id = $1', [actor]);
    expect(await repository.getProject(hidden.slug, actor)).toBeNull();
  });
  it('returns only the authenticated issuer’s monetary values as strings', async () => {
    const project = await addProject('PRIVATE'); const actor = randomUUID(); const source = randomUUID();
    await client.query(`INSERT INTO motive.funding_sources (id,owner_actor_id,controller_actor_id,authorized_amount) VALUES ($1,$2,$2,5)`, [source, actor]);
    await client.query(`INSERT INTO motive.grants (id,source_id,project_id,issuer_actor_id,limit_amount) VALUES ($1,$2,$3,$4,2)`, [randomUUID(),source,project.id,actor]);
    const repository = createPublicRepository(client);
    const own = await repository.getSupport(actor);
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ limit_amount: '2.000000000000', consumed_amount: '0.000000000000', held_amount: '0.000000000000' });
    expect(await repository.getSupport('different-actor')).toEqual([]);
    expect(JSON.stringify(own)).not.toContain('owner_actor_id');
  });
  it('checks schema compatibility in a database-enforced read-only transaction', async () => {
    await client.query('SET TRANSACTION READ ONLY');
    expect((await getPostgresSchemaStatus(client)).exact).toBe(true);
  });
  it('rejects a database schema newer than this control build', async () => {
    await client.query(`INSERT INTO motive.schema_migrations (name,checksum) VALUES ('999_future_test.sql',$1)`, [digestCanonicalJson('future')]);
    const status = await getPostgresSchemaStatus(client);
    expect(status.exact).toBe(false);
    expect(status.problems).toContain('Unsupported applied migration 999_future_test.sql.');
  });
});
