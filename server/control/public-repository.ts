import type { Pool } from 'pg';
import type { ControlRepository, PublicProject } from './app.ts';

function project(row: { id: string; slug: string; current_revision: number; content: Record<string, unknown> }): PublicProject {
  const text = (name: string) => typeof row.content[name] === 'string' ? (row.content[name] as string).slice(0, 4000) : '';
  return {
    id: row.id, slug: row.slug, revision: row.current_revision, title: text('title'),
    purpose: text('purpose'), nextStep: text('next_step'), stage: 'preparation',
    executionEnabled: false, externalSubmissionsEnabled: false,
  };
}

export function createPublicRepository(pool: Pick<Pool, 'query'>): ControlRepository {
  const selection = `SELECT p.id, p.slug, p.current_revision, r.content
    FROM motive.projects p JOIN motive.project_revisions r
    ON r.project_id = p.id AND r.revision = p.current_revision`;
  return {
    async listPublicProjects() {
      const result = await pool.query(`${selection} WHERE p.visibility = 'PUBLIC' ORDER BY p.slug LIMIT 100`);
      return result.rows.map(project);
    },
    async getProject(slug, actorId) {
      const result = await pool.query(`${selection} WHERE p.slug = $1 AND (p.visibility = 'PUBLIC' OR EXISTS (
        SELECT 1 FROM motive.memberships m WHERE m.project_id = p.id AND m.actor_id = $2 AND m.revoked_at IS NULL
      ))`, [slug, actorId]);
      return result.rows.length ? project(result.rows[0]) : null;
    },
    async getSupport(actorId) {
      // Explicit fields only: source credentials and other supporters never enter a response.
      const result = await pool.query(`SELECT id, project_id, limit_amount::text, consumed_amount::text,
        attempt_held_amount::text AS held_amount, status, expires_at FROM motive.grants WHERE issuer_actor_id = $1 ORDER BY created_at DESC LIMIT 100`, [actorId]);
      return result.rows;
    },
  };
}
