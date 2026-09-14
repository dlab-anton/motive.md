import { Pool } from 'pg';
import { createControlApp } from './app.ts';
import { createAuthenticator } from './auth.ts';
import { loadControlConfig } from './config.ts';
import { createHealthController, registerHealthRoutes, startReadinessProbe } from './health.ts';
import { createPublicRepository } from './public-repository.ts';
import { getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { PostgresEvidenceStore } from '../../packages/evidence/src/index.ts';

const config = loadControlConfig();
const health = createHealthController(config.buildId);
const pool = new Pool({
  connectionString: config.database.url, ssl: config.database.ssl,
  max: config.database.maxConnections, connectionTimeoutMillis: config.database.connectionTimeoutMs,
  idleTimeoutMillis: config.database.idleTimeoutMs,
  query_timeout: config.healthProbeTimeoutMs, statement_timeout: config.healthProbeTimeoutMs,
  application_name: 'motive-control',
});
// Avoid credential-bearing error messages and raw request data in logs.
pool.on('error', () => { health.markUnhealthy(); console.error(JSON.stringify({ event: 'database_pool_error' })); });
const app = createControlApp({
  allowedOrigins: config.allowedOrigins,
  authenticate: createAuthenticator(config.supabase.url, config.supabase.publishableKey),
  repository: createPublicRepository(pool), isDraining: health.isDraining, isReady: health.isReady,
  evidence: { store: new PostgresEvidenceStore(pool) },
  reportError: requestId => console.error(JSON.stringify({ event: 'control_request_failed', requestId })),
});
registerHealthRoutes(app, health);
const stopProbe = startReadinessProbe({
  health, intervalMs: config.healthProbeIntervalMs, timeoutMs: config.healthProbeTimeoutMs,
  async probe(signal) {
    signal.throwIfAborted();
    const schema = await getPostgresSchemaStatus(pool);
    if (!schema.exact) throw new Error('Unsupported database schema');
    signal.throwIfAborted();
    // Parse the exact relations/columns used by this build, without requiring seeded records.
    await pool.query(`SELECT p.id, p.slug, p.current_revision, p.visibility, r.content, m.actor_id, m.revoked_at
      FROM motive.projects p LEFT JOIN motive.project_revisions r ON r.project_id = p.id
      LEFT JOIN motive.memberships m ON m.project_id = p.id LIMIT 0`);
    await pool.query(`SELECT a.id, a.work_order_id, a.project_id, a.terms_digest,
      s.environment_id, s.attempt_id, s.status, s.manifest_digest, s.created_at,
      e.id, e.project_id, e.work_order_id, e.attempt_id, e.artifact_environment_id,
      e.evaluator_environment_id, e.artifact_manifest_digest, e.terms_digest,
      e.evaluator_profile_digest, e.challenge_digest, e.dependency_lock_digest,
      e.trusted_build_config_digest, e.raw_report_digest, e.assessment_digest, e.outcome, e.created_at,
      d.id, d.evaluation_id, d.decision, d.created_at
      FROM motive.attempts a
      LEFT JOIN motive.orchestration_artifact_seals s ON s.attempt_id = a.id
      LEFT JOIN motive.evaluations e ON e.attempt_id = a.id
      LEFT JOIN motive.acceptance_decisions d ON d.evaluation_id = e.id LIMIT 0`);
    signal.throwIfAborted();
  },
});
const server = app.listen(config.port, config.host);
server.once('listening', () => {
  console.log(JSON.stringify({ event: 'control_listening', host: config.host, port: config.port, buildId: config.buildId, executionEnabled: false }));
});
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.on('error', () => { console.error(JSON.stringify({ event: 'control_listen_failed' })); stopProbe(); void pool.end().finally(() => { process.exitCode = 1; }); });

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  health.beginDrain(); stopProbe();
  const deadline = setTimeout(() => { server.closeAllConnections(); process.exit(1); }, config.shutdownGraceMs);
  deadline.unref();
  server.close(() => { void pool.end().finally(() => { clearTimeout(deadline); process.exitCode = 0; }); });
  server.closeIdleConnections();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
