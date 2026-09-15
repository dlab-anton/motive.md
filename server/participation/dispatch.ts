/**
 * Route one shared entry point to the participation service of the project a
 * request belongs to. Agent routes are project-scoped by the bearer credential;
 * the join route is scoped by the projectSlug in its body. Everything else is
 * mounted per project, so the default project keeps its historical paths.
 */
import { json, Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type { Pool } from 'pg';
import { ADDITIONAL_PARTICIPATION_PROFILES, type ParticipationProjectProfile } from './profile.ts';
import { createParticipationRouters } from './router.ts';
import { createParticipationService, ParticipationError, type ParticipationService } from './service.ts';

export type ParticipationRouters = ReturnType<typeof createParticipationRouters>;
export type AdmittedParticipation = { profile: ParticipationProjectProfile; service: ParticipationService; routers: ParticipationRouters };

type ServiceOptions = Parameters<typeof createParticipationService>[1];
type RouterDependencies = Omit<Parameters<typeof createParticipationRouters>[0], 'service'>;

/**
 * Create a service and routers for every additional profile whose project row
 * exists. A profile without a public project row is skipped, not fatal: the
 * default project must start even while a later project is still being seeded.
 */
export async function createAdditionalParticipation(pool: Pool, options: ServiceOptions, dependencies: RouterDependencies,
  log: (message: string) => void = message => console.info(message)): Promise<AdmittedParticipation[]> {
  const admitted: AdmittedParticipation[] = [];
  for (const profile of ADDITIONAL_PARTICIPATION_PROFILES) {
    const service = createParticipationService(pool, { ...options, profile });
    try { await service.ensureWorkOrder(); }
    catch (error) {
      if (error instanceof ParticipationError && error.code === 'NOT_FOUND') {
        log(JSON.stringify({ event: 'participation.project_not_admitted', project: profile.slug, reason: error.message }));
        continue;
      }
      throw error;
    }
    admitted.push({ profile, service, routers: createParticipationRouters({ service, ...dependencies }) });
  }
  return admitted;
}

const TOKEN = /^motive_agent_([a-f0-9]{32})_[A-Za-z0-9_-]{43}$/;

function tokenIdFromBearer(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ') || header.length > 512) return null;
  const match = TOKEN.exec(header.slice(7));
  if (!match) return null;
  const hex = match[1];
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * `/api/agent` for every admitted project. The credential's project decides
 * which service answers; anything unrecognised goes to the default router,
 * which produces the same 401 it always did.
 */
export function createAgentDispatchRouter(input: { pool: Pool; defaultRouter: RequestHandler; additional: readonly AdmittedParticipation[] }): Router {
  const router = Router();
  const bySlug = new Map(input.additional.map(item => [item.profile.slug, item.routers.agentRouter]));
  router.use(async (req: Request, res: Response, next: NextFunction) => {
    if (!bySlug.size) { input.defaultRouter(req, res, next); return; }
    const tokenId = tokenIdFromBearer(req.get('Authorization'));
    if (!tokenId) { input.defaultRouter(req, res, next); return; }
    try {
      const result = await input.pool.query(`SELECT project.slug FROM motive.participation_agent_tokens token
        JOIN motive.projects project ON project.id=token.project_id WHERE token.id=$1`, [tokenId]);
      const slug = result.rowCount === 1 ? String(result.rows[0].slug) : null;
      (slug && bySlug.get(slug)) ? bySlug.get(slug)!(req, res, next) : input.defaultRouter(req, res, next);
    } catch (error) { next(error); }
  });
  return router;
}

/**
 * `/api/participation/join` for every admitted project, decided by the body's
 * projectSlug. Other account routes for additional projects live under
 * `/api/participation/projects/:slug`; the default project keeps its paths.
 */
export function createJoinDispatchRouter(input: { additional: readonly AdmittedParticipation[] }): Router {
  const router = Router();
  const bySlug = new Map(input.additional.map(item => [item.profile.slug, item.routers.accountRouter]));
  router.post('/join', json({ limit: '16kb', strict: true }), (req: Request, res: Response, next: NextFunction) => {
    const body: unknown = req.body;
    const slug = body && typeof body === 'object' && !Array.isArray(body) ? (body as { projectSlug?: unknown }).projectSlug : undefined;
    const target = typeof slug === 'string' ? bySlug.get(slug) : undefined;
    if (!target) { next(); return; }
    // Re-enter the project's account router at its own /join path.
    target(req, res, next);
  });
  return router;
}
