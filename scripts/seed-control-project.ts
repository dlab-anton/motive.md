import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { loadControlConfig } from '../server/control/config.ts';
import { digestCanonicalJson } from '../packages/domain/src/contracts.ts';
import { circlePackingProfile, getProject } from '../src/lib/projects.ts';

// Curated discovery metadata only. This command creates no agreement, grant,
// worker, proof, or acceptance and never enables the controller.
const actorId = 'operator:seed';
const projectSlug = 'circle-packing';
const correctedRevisionPreviousDigest = 'sha256:a03b22cada227de3816382dd6c2ccce09edd515b42f54924446fe292b69fc42b';
const correctedRevisionDigest = 'sha256:c1fceddadef50b71b873f04bf666e2f91c6ff598dceb5dd3dc081b2e3e710246';
const correctedRevisionReason = 'Correct reference distribution metadata: attributed coordinate witness is now bundled; upstream license undocumented';
const publicProject = getProject(projectSlug);
if (!publicProject) throw new Error(`Missing public project profile for ${projectSlug}.`);

const content = {
  title: publicProject.title,
  purpose: publicProject.goal,
  next_step: publicProject.next,
  stage: 'preparation',
  description: publicProject.description,
  story: publicProject.story,
  beneficiaries: publicProject.beneficiaries,
  scope: publicProject.scope,
  acceptance: publicProject.acceptance,
  output: publicProject.output,
  challenge: circlePackingProfile,
  spending_authorized: false,
  execution_authorized: false,
};
const contentDigest = digestCanonicalJson(content);

const config = loadControlConfig();
const pool = new Pool({ connectionString: config.database.url, ssl: config.database.ssl, max: 1 });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtext('motive.seed.circle-packing'))");

  // Retire only the historical row owned by this seed. Other projects, including
  // a project that happens to use the old slug, are outside this command's scope.
  const retired = await client.query(`UPDATE motive.projects
    SET visibility = 'PRIVATE', updated_at = clock_timestamp()
    WHERE slug = 'math' AND created_by = $1 AND visibility = 'PUBLIC'
    RETURNING id`, [actorId]);
  if (retired.rowCount === 1) {
    const retiredProjectId = retired.rows[0].id as string;
    await client.query(`INSERT INTO motive.events
      (id,project_id,aggregate_type,aggregate_id,event_type,payload,actor_id)
      VALUES ($1,$2,'project',$2,'project.visibility_changed',$3,$4)`, [
      randomUUID(),
      retiredProjectId,
      { from: 'PUBLIC', to: 'PRIVATE', reason: 'replaced_by_circle-packing' },
      actorId,
    ]);
  }

  const existing = await client.query(
    `SELECT p.id, p.current_revision, p.created_by, p.visibility::text, r.content_digest
      FROM motive.projects p LEFT JOIN motive.project_revisions r
        ON r.project_id = p.id AND r.revision = p.current_revision
      WHERE p.slug = $1 FOR UPDATE OF p`,
    [projectSlug],
  );
  let projectId: string;
  let revision: number;
  let status: 'preparation_registered' | 'revision_registered' | 'unchanged';
  if (!existing.rowCount) {
    projectId = randomUUID();
    revision = 1;
    status = 'preparation_registered';
    await client.query(`INSERT INTO motive.projects (id,slug,visibility,current_revision,created_by)
      VALUES ($1,$2,'PUBLIC',$3,$4)`, [projectId, projectSlug, revision, actorId]);
    await client.query(`INSERT INTO motive.project_revisions (id,project_id,revision,format,content,content_digest,created_by)
      VALUES ($1,$2,$3,'motive.project/0.1',$4,$5,$6)`, [randomUUID(), projectId, revision, content, contentDigest, actorId]);
    await client.query(`INSERT INTO motive.events (id,project_id,aggregate_type,aggregate_id,event_type,payload,actor_id)
      VALUES ($1,$2,'project',$2,'project.preparation_registered',$3,$4)`,
    [randomUUID(), projectId, { revision, content_digest: contentDigest }, actorId]);
  } else {
    const row = existing.rows[0] as {
      id: string;
      current_revision: number;
      created_by: string;
      visibility: 'PUBLIC' | 'PRIVATE';
      content_digest: string | null;
    };
    if (row.created_by !== actorId) {
      throw new Error(`Refusing to alter existing non-seed project ${projectSlug}.`);
    }
    if (row.visibility !== 'PUBLIC') {
      throw new Error(`Seed project ${projectSlug} is PRIVATE; refusing to override its visibility.`);
    }
    projectId = row.id;
    if (row.content_digest === contentDigest) {
      revision = row.current_revision;
      status = 'unchanged';
    } else if (
      row.current_revision === 1
      && row.content_digest === correctedRevisionPreviousDigest
      && contentDigest === correctedRevisionDigest
    ) {
      revision = 2;
      status = 'revision_registered';
      await client.query(`INSERT INTO motive.project_revisions
        (id,project_id,revision,format,content,content_digest,created_by)
        VALUES ($1,$2,$3,'motive.project/0.1',$4,$5,$6)`, [
        randomUUID(), projectId, revision, content, contentDigest, actorId,
      ]);
      const advanced = await client.query(`UPDATE motive.projects
        SET current_revision = $2, updated_at = clock_timestamp()
        WHERE id = $1 AND current_revision = 1`, [projectId, revision]);
      if (advanced.rowCount !== 1) throw new Error(`Could not advance ${projectSlug} to revision ${revision}.`);
      await client.query(`INSERT INTO motive.events
        (id,project_id,aggregate_type,aggregate_id,event_type,payload,actor_id)
        VALUES ($1,$2,'project',$2,'project.revision_registered',$3,$4)`, [
        randomUUID(),
        projectId,
        {
          revision,
          previous_revision: 1,
          content_digest: contentDigest,
          previous_content_digest: correctedRevisionPreviousDigest,
          reason: correctedRevisionReason,
        },
        actorId,
      ]);
    } else {
      throw new Error(`Seed content for ${projectSlug} changed; register a reviewed new project revision explicitly.`);
    }
  }
  await client.query('COMMIT');
  console.log(JSON.stringify({
    project: projectSlug,
    projectId,
    revision,
    status,
    retiredSeedMath: retired.rowCount === 1,
    executionEnabled: false,
  }));
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally { client.release(); await pool.end(); }
