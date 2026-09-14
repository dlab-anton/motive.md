import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { digestCanonicalJson } from '../../packages/domain/src/contracts.ts';
import { applyPostgresMigrations, getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { createParticipationService, type ParticipationService } from '../../server/participation/index.ts';

const baseUrl = process.env.MOTIVE_TEST_DATABASE_URL;
const pgDescribe = baseUrl ? describe : describe.skip;
const digest = (bytes: Buffer | string) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const scale = 10n ** 18n;
type Circle = { x: string; y: string; r: string };
type Witness = { format: string; n: number; circles: Circle[] };
function units(value: string) {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * scale + BigInt(fraction.padEnd(18, '0'));
}
function decimal(value: bigint) {
  return `${value / scale}.${(value % scale).toString().padStart(18, '0')}`;
}
function variant(source: string, change: (circles: Circle[]) => Circle[]) {
  const parsed = JSON.parse(source) as Witness;
  return JSON.stringify({ ...parsed, circles: change(parsed.circles.map(circle => ({ ...circle }))) });
}

pgDescribe('public geometry comparison on isolated PostgreSQL', () => {
  const databaseName = `motive_geometry_comparison_${randomUUID().replaceAll('-', '')}`;
  const issuer = `operator:geometry-comparison-${randomUUID()}`;
  let admin: Pool; let pool: Pool; let service: ParticipationService; let assignmentId: string; let witness: string;

  beforeAll(async () => {
    const source = new URL(baseUrl!); expect(['localhost', '127.0.0.1']).toContain(source.hostname);
    const adminUrl = new URL(source); adminUrl.pathname = '/postgres';
    admin = new Pool({ connectionString: adminUrl.toString(), max: 1 }); await admin.query(`CREATE DATABASE ${databaseName}`);
    const isolated = new URL(source); isolated.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: isolated.toString(), max: 6 }); await applyPostgresMigrations(pool);
    expect((await getPostgresSchemaStatus(pool)).exact).toBe(true);
    await new LedgerKernel(pool).createProject({ actorId: issuer, idempotencyKey: randomUUID(), slug: 'circle-packing',
      visibility: 'PUBLIC', revisionContent: { title: 'Geometry comparison fixture' } });
    service = createParticipationService(pool, { tokenSecret: 'geometry-comparison-test-secret-longer-than-32-bytes', issuerActorId: issuer });
    assignmentId = (await service.ensureCircleWorkOrder()).id;
    witness = await readFile('public/projects/circle-packing/reference-witness.json', 'utf8');
  }, 30_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`); await admin.end();
    }
  });

  async function submit(source = witness) {
    const owner = `account:${randomUUID()}`;
    await pool.query(`INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at)
      VALUES($1,'supabase',$2,'ACTIVE',clock_timestamp())`, [owner, randomUUID()]);
    const joined = await service.join(owner, 'Public geometry contributor', { projectSlug: 'circle-packing',
      publishDisplayName: true, acceptReferenceTerms: true }, `join-${randomUUID()}`);
    const context = await service.authenticateBearer(joined.token);
    const claim = await service.claimAssignment(context, assignmentId, `claim-${randomUUID()}`);
    return service.submitWitness(context, assignmentId, { leaseEpoch: claim.leaseEpoch!, witness: source }, `submit-${randomUUID()}`);
  }

  async function replaceImmutableArtifact(id: string, bytes: Buffer, witnessDigest = digest(bytes)) {
    const client = await pool.connect();
    try {
      await client.query(`SET session_replication_role='replica'`);
      await client.query(`UPDATE motive.participation_submission_artifacts SET witness_bytes=$2,witness_digest=$3 WHERE submission_id=$1`,
        [id, bytes, witnessDigest]);
    } finally {
      await client.query(`SET session_replication_role='origin'`).catch(() => undefined); client.release();
    }
  }

  async function scopedArtifact(visibility: 'PUBLIC' | 'PRIVATE') {
    const ledger = new LedgerKernel(pool);
    const project = await ledger.createProject({ actorId: issuer, idempotencyKey: randomUUID(), slug: `scoped-${randomUUID()}`,
      visibility, revisionContent: { title: `${visibility} comparison fixture` } });
    const sourceWork = (await pool.query('SELECT terms FROM motive.work_orders WHERE id=$1', [assignmentId])).rows[0]!;
    const terms = { ...(sourceWork.terms as Record<string, unknown>), project_id: project.id,
      agreement_id: `geometry-comparison-${randomUUID()}` };
    const work = await ledger.createWorkOrder({ actorId: issuer, idempotencyKey: randomUUID(), projectId: project.id,
      workOrderKey: 'geometry-comparison', revision: 1, state: 'READY', terms });
    const tokenId = randomUUID(); const claimId = randomUUID(); const submissionId = randomUUID();
    await pool.query(`INSERT INTO motive.participation_agent_tokens
      (id,project_id,owner_actor_id,agent_name,public_display_name,token_digest,token_hint,license_acceptance_ref,expires_at)
      VALUES($1,$2,$3,'Scoped geometry agent','Scoped contributor',$4,$5,'geometry-test',clock_timestamp()+interval '1 day')`,
    [tokenId, project.id, `account:${randomUUID()}`, digest(randomUUID()), randomUUID().replaceAll('-', '').slice(0, 12)]);
    await pool.query(`INSERT INTO motive.work_claims
      (id,project_id,work_order_id,operator_actor_id,origin,slot,lease_epoch,terms_digest,status,expires_at)
      VALUES($1,$2,$3,$4,'EXTERNAL',1,1,$5,'ACTIVE',clock_timestamp()+interval '1 hour')`,
    [claimId, project.id, work.id, `agent:${tokenId}`, work.termsDigest]);
    await pool.query(`INSERT INTO motive.submissions
      (id,project_id,work_order_id,work_order_revision,origin,operator_actor_id,claim_id,lease_epoch,format,base_commit,
       artifact_manifest_digest,provenance,usage_status,license_acceptance_ref,status)
      VALUES($1,$2,$3,1,'EXTERNAL',$4,$5,1,'motive.submission/0.1',$6,$7,'{}'::jsonb,'unmetered_external',
        'geometry-test','PENDING_EVALUATION')`,
    [submissionId, project.id, work.id, `agent:${tokenId}`, claimId, 'f'.repeat(40), digestCanonicalJson({ submissionId })]);
    const bytes = Buffer.from(witness); const reportBody = { format: 'geometry-comparison-fixture' };
    await pool.query(`INSERT INTO motive.participation_submission_artifacts
      (submission_id,project_id,agent_token_id,witness_format,witness_bytes,witness_digest,report,report_body,report_digest,
       exact_score,exceeds_reference,contributor_display_name)
      VALUES($1,$2,$3,'motive.csqv.witness.v1',$4,$5,'VALID',$6::jsonb,$7,'5.29109518547430697',false,'Scoped contributor')`,
    [submissionId, project.id, tokenId, bytes, digest(bytes), JSON.stringify(reportBody), digestCanonicalJson(reportBody)]);
    return submissionId;
  }

  it('compares retained reordered, square-symmetric, and distinct valid geometry with one bounded SQL read each', async () => {
    const reorderedWitness = variant(witness, circles => circles.reverse());
    const mirroredWitness = variant(witness, circles => circles.map(circle => ({ ...circle, x: decimal(scale - units(circle.x)) })));
    const distinctWitness = variant(witness, circles => circles.map(circle => ({ ...circle, r: decimal(units(circle.r) - 1n) })));
    const left = await submit(); const reordered = await submit(reorderedWitness);
    const mirrored = await submit(mirroredWitness); const distinct = await submit(distinctWitness);
    for (const submission of [left, reordered, mirrored, distinct]) expect(submission.reportStatus).toBe('VALID');
    const query = vi.spyOn(pool, 'query');
    const same = await service.publicGeometryComparison(left.id, reordered.id);
    const symmetric = await service.publicGeometryComparison(left.id, mirrored.id);
    const different = await service.publicGeometryComparison(left.id, distinct.id);
    const reads = query.mock.calls.filter(call => typeof call[0] === 'string' && call[0].includes('artifact.witness_bytes'));
    query.mockRestore();
    expect(reads).toHaveLength(3);
    expect(reads.map(call => call[1])).toEqual([
      [[left.id, reordered.id], 'circle-packing'],
      [[left.id, mirrored.id], 'circle-packing'],
      [[left.id, distinct.id], 'circle-packing'],
    ]);
    expect(same).toEqual({ format: 'motive.csqv.geometry-comparison.v1',
      left: { submissionId: left.id, artifactSha256: left.artifactSha256 },
      right: { submissionId: reordered.id, artifactSha256: reordered.artifactSha256 }, relation: 'SAME_GEOMETRY' });
    expect(symmetric).toEqual({ format: 'motive.csqv.geometry-comparison.v1',
      left: { submissionId: left.id, artifactSha256: left.artifactSha256 },
      right: { submissionId: mirrored.id, artifactSha256: mirrored.artifactSha256 }, relation: 'SQUARE_SYMMETRY' });
    expect(different).toEqual({ format: 'motive.csqv.geometry-comparison.v1',
      left: { submissionId: left.id, artifactSha256: left.artifactSha256 },
      right: { submissionId: distinct.id, artifactSha256: distinct.artifactSha256 }, relation: 'DIFFERENT_GEOMETRY' });
    await expect(service.publicGeometryComparison(left.id, left.id)).resolves.toMatchObject({
      left: { submissionId: left.id }, right: { submissionId: left.id }, relation: 'SAME_GEOMETRY' });
  }, 20_000);

  it('returns no relation for unavailable, non-valid, digest-tampered, BOM, or malformed UTF-8 evidence', async () => {
    const valid = await submit(); const rejected = await submit('{}');
    await expect(service.publicGeometryComparison(valid.id, randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service.publicGeometryComparison(valid.id.toUpperCase(), valid.id)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(service.publicGeometryComparison(valid.id, rejected.id)).rejects.toMatchObject({ code: 'CONFLICT' });

    const tampered = await submit(); await replaceImmutableArtifact(tampered.id, Buffer.from(witness), `sha256:${'0'.repeat(64)}`);
    await expect(service.publicGeometryComparison(valid.id, tampered.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    const bom = await submit(); await replaceImmutableArtifact(bom.id,
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(witness)]));
    await expect(service.publicGeometryComparison(valid.id, bom.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    const malformed = await submit(); await replaceImmutableArtifact(malformed.id, Buffer.from([0xc3, 0x28]));
    await expect(service.publicGeometryComparison(valid.id, malformed.id)).rejects.toMatchObject({ code: 'CONFLICT' });
  }, 20_000);

  it('does not compare artifacts from another project or a private project', async () => {
    const valid = await submit(); const foreign = await scopedArtifact('PUBLIC'); const privateId = await scopedArtifact('PRIVATE');
    await expect(service.publicGeometryComparison(valid.id, foreign)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service.publicGeometryComparison(valid.id, privateId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  }, 20_000);
});
