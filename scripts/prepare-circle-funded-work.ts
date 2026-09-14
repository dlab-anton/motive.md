import { pathToFileURL } from 'node:url';
import Decimal from 'decimal.js';
import { Pool } from 'pg';
import { LedgerKernel } from '../packages/accounting/src/kernel.ts';
import { digestCanonicalJson, type WorkOrderTerms } from '../packages/domain/src/contracts.ts';
import { getPostgresSchemaStatus, postgresPoolConfigFromEnvironment } from '../packages/accounting/src/migrations.ts';
import { estimateMaximumExposure, profileDigest } from '../packages/inference-gateway/src/profile.ts';
import { loadApplicationGatewayProfiles } from '../server/app-profiles.ts';
import { OPENROUTER_GATEWAY_CREDENTIAL_REF } from '../server/funding/service.ts';
import {
  CIRCLE_FUNDED_MODEL,
  CIRCLE_FUNDED_ALLOWED_EFFECTS,
  CIRCLE_FUNDED_WORK_OBJECTIVE,
  CIRCLE_FUNDED_WORK_ORDER_KEY,
  CIRCLE_FUNDED_WORK_ORDER_REVISION,
  CIRCLE_PROJECT_SLUG,
  CIRCLE_REFERENCE_SCORE,
  isApprovedCircleRevisionBinding,
  positiveProjectRevision,
} from '../server/funding/circle-work-authority.ts';

const PROJECT = CIRCLE_PROJECT_SLUG;
const REFERENCE = CIRCLE_REFERENCE_SCORE;
const MODEL = CIRCLE_FUNDED_MODEL;
const WORK_ORDER_KEY = CIRCLE_FUNDED_WORK_ORDER_KEY;

export type PrepareCircleFundedWorkInputs = {
  actorId: string;
  idempotencyKey: string;
  profileDigest: string;
  ceilingUsd: string;
  maxRuntimeSeconds: number;
  agreementId: string;
  evaluationProfileDigest: string;
  inputCommit: string;
  projectRevision: number;
};

export function parsePrepareCircleFundedWorkArguments(argv: readonly string[]): PrepareCircleFundedWorkInputs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]; const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined || value.startsWith('--')) throw new Error('Every preparation option must have one explicit value.');
    if (values.has(name)) throw new Error(`Duplicate option ${name}.`);
    values.set(name, value);
  }
  const take = (name: string) => { const value = values.get(name); if (!value) throw new Error(`${name} is required.`); return value; };
  const known = new Set(['--actor', '--idempotency-key', '--profile-digest', '--ceiling-usd', '--max-runtime-seconds',
    '--agreement-id', '--evaluation-profile-digest', '--input-commit', '--project-revision']);
  for (const name of values.keys()) if (!known.has(name)) throw new Error(`Unknown option ${name}.`);
  const actorId = take('--actor'); const idempotencyKey = take('--idempotency-key');
  const selectedProfileDigest = take('--profile-digest'); const ceiling = take('--ceiling-usd');
  const runtimeText = take('--max-runtime-seconds'); const agreementId = take('--agreement-id');
  const evaluationProfileDigest = take('--evaluation-profile-digest'); const inputCommit = take('--input-commit');
  const revisionText = take('--project-revision');
  if (!/^operator:[A-Za-z0-9._~-]{1,480}$/.test(actorId)) throw new Error('--actor must identify an explicit operator.');
  if (!/^[\x21-\x7e]{1,128}$/.test(idempotencyKey)) throw new Error('--idempotency-key must contain 1 to 128 visible ASCII characters.');
  if (!/^sha256:[a-f0-9]{64}$/.test(selectedProfileDigest) || !/^sha256:[a-f0-9]{64}$/.test(evaluationProfileDigest)) throw new Error('Profile digests must be complete SHA-256 digests.');
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,12})?$/.test(ceiling)) throw new Error('--ceiling-usd must be an exact USD decimal with at most 12 fractional digits.');
  const ceilingAmount = new Decimal(ceiling);
  if (!ceilingAmount.isPositive() || ceilingAmount.greaterThan(100)) throw new Error('--ceiling-usd must be greater than zero and no more than 100 USD.');
  if (!/^\d+$/.test(runtimeText)) throw new Error('--max-runtime-seconds must be a whole number.');
  const maxRuntimeSeconds = Number(runtimeText);
  if (!Number.isSafeInteger(maxRuntimeSeconds) || maxRuntimeSeconds < 60 || maxRuntimeSeconds > 3600) throw new Error('--max-runtime-seconds must be between 60 and 3600.');
  if (agreementId.length < 8 || agreementId.length > 512 || /placeholder|unresolved|todo/i.test(agreementId)) throw new Error('--agreement-id must name the approved evaluation agreement.');
  if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(inputCommit)) throw new Error('--input-commit must be a complete 40- or 64-character lowercase commit digest.');
  const projectRevision = positiveProjectRevision(revisionText);
  if (projectRevision === null) throw new Error('--project-revision must be an explicit positive integer.');
  return { actorId, idempotencyKey, profileDigest: selectedProfileDigest,
    ceilingUsd: ceilingAmount.toFixed(12).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1'), maxRuntimeSeconds,
    agreementId, evaluationProfileDigest, inputCommit, projectRevision };
}

export async function prepareCircleFundedWork(pool: Pool, profiles: ReturnType<typeof loadApplicationGatewayProfiles>, input: PrepareCircleFundedWorkInputs) {
  const schema = await getPostgresSchemaStatus(pool);
  if (!schema.exact) throw new Error('PostgreSQL migrations must be exact before preparing funded work.');
  const selected = profiles.find(profile => profileDigest(profile) === input.profileDigest);
  if (!selected) throw new Error('The requested profile digest is absent from MOTIVE_GATEWAY_PROFILES_FILE.');
  if (selected.status !== 'reviewed-live' || selected.evidence.kind !== 'gate-a-reviewed') throw new Error('The selected profile does not contain reviewed Gate A evidence.');
  if (selected.route.model !== MODEL) throw new Error(`The first funded run must pin the exact reviewed model ${MODEL}.`);
  if (selected.upstream.credentialRef !== OPENROUTER_GATEWAY_CREDENTIAL_REF) throw new Error('The reviewed profile is not bound to project funding credentials.');
  const exposure = new Decimal(estimateMaximumExposure(selected));
  if (new Decimal(input.ceilingUsd).lessThan(exposure)) throw new Error(`--ceiling-usd must cover the profile maximum exposure ${exposure.toFixed()}.`);
  const project = await pool.query(
    `SELECT project.id, project.current_revision, revision.content_digest, revision.content
     FROM motive.projects project JOIN motive.project_revisions revision
       ON revision.project_id=project.id AND revision.revision=project.current_revision
     WHERE project.slug=$1 AND project.visibility='PUBLIC'`, [PROJECT]);
  if (project.rowCount !== 1) throw new Error('The public circle-packing project is missing.');
  const row = project.rows[0]; const content = row.content as Record<string, unknown>;
  const challenge = content.challenge as Record<string, unknown> | undefined;
  const laterReference = challenge?.laterReference as Record<string, unknown> | undefined;
  if (!isApprovedCircleRevisionBinding({
        currentProjectRevision: row.current_revision,
        workProjectRevision: input.projectRevision,
        termsProjectRevision: input.projectRevision,
        contentDigest: row.content_digest,
      })
      || laterReference?.score !== REFERENCE || challenge?.n !== 101
      || content.spending_authorized !== false || content.execution_authorized !== false) {
    throw new Error('The current project revision does not match the reviewed N=101 reference and preparation-only record.');
  }
  const membership = await pool.query(
    `SELECT role FROM motive.memberships WHERE project_id=$1 AND actor_id=$2 AND revoked_at IS NULL AND role IN ('OWNER','STEWARD')`,
    [row.id, input.actorId]);
  if (membership.rowCount !== 1) throw new Error('The selected operator is not an active owner or steward of this project.');
  const terms: WorkOrderTerms = {
    format: 'motive.work-order/0.1', project_id: row.id, project_revision: input.projectRevision,
    agreement_id: input.agreementId,
    objective: CIRCLE_FUNDED_WORK_OBJECTIVE,
    input_commit: input.inputCommit,
    allowed_effects: [...CIRCLE_FUNDED_ALLOWED_EFFECTS],
    hosted: { enabled: true, inference: { currency: 'USD', ceiling: input.ceilingUsd, profile_digest: input.profileDigest as `sha256:${string}` },
      maximum_runtime_seconds: input.maxRuntimeSeconds },
    external: { enabled: false, claim_required: false, max_active_claims: 1, max_lease_seconds: input.maxRuntimeSeconds,
      late_submission_policy: 'reject', review_admission: 'manual',
      artifact: { formats: ['motive.csqv.witness.v1'], max_bytes: 32 * 1024, license_acceptance_required: true } },
    evaluation: { profile_digest: input.evaluationProfileDigest as `sha256:${string}`, human_acceptance_required: true },
  };
  const termsDigest = digestCanonicalJson(terms);
  const existing = await pool.query(
    `SELECT work.id, work.terms_digest, state.state FROM motive.work_orders work
     JOIN motive.work_order_states state ON state.work_order_id=work.id
     WHERE work.project_id=$1 AND work.work_order_key=$2 AND work.revision=$3`,
    [row.id, WORK_ORDER_KEY, CIRCLE_FUNDED_WORK_ORDER_REVISION]);
  const controllerBefore = await pool.query('SELECT spending_enabled FROM motive.controller_state WHERE singleton=TRUE');
  if (existing.rowCount === 1) {
    if (existing.rows[0].terms_digest !== termsDigest || existing.rows[0].state !== 'READY') throw new Error('An immutable funded work order already exists with different terms or state.');
    return { created: false, workOrderId: existing.rows[0].id as string, termsDigest, model: MODEL,
      profileDigest: input.profileDigest, projectRevision: input.projectRevision, reference: REFERENCE,
      controllerSpendingEnabled: controllerBefore.rows[0]?.spending_enabled === true };
  }
  const ledger = new LedgerKernel(pool);
  const created = await ledger.createWorkOrder({ actorId: input.actorId, idempotencyKey: input.idempotencyKey,
    projectId: row.id, workOrderKey: WORK_ORDER_KEY, revision: CIRCLE_FUNDED_WORK_ORDER_REVISION, terms, state: 'READY' });
  const controllerAfter = await pool.query('SELECT spending_enabled FROM motive.controller_state WHERE singleton=TRUE');
  if (controllerAfter.rows[0]?.spending_enabled !== controllerBefore.rows[0]?.spending_enabled) throw new Error('Controller state changed unexpectedly during work-order preparation.');
  return { created: true, workOrderId: created.id, termsDigest: created.termsDigest, model: MODEL,
    profileDigest: input.profileDigest, projectRevision: input.projectRevision, reference: REFERENCE,
    controllerSpendingEnabled: controllerAfter.rows[0]?.spending_enabled === true };
}

async function main() {
  const input = parsePrepareCircleFundedWorkArguments(process.argv.slice(2));
  const pool = new Pool(postgresPoolConfigFromEnvironment());
  try { console.log(JSON.stringify(await prepareCircleFundedWork(pool, loadApplicationGatewayProfiles(), input), null, 2)); }
  finally { await pool.end(); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
