import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod/v4';
import { MotiveClient, MotiveClientError, type MotiveRequest } from './client.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const IDEMPOTENCY = /^[A-Za-z0-9._~-]{8,200}$/;
const TIMESTAMP = z.string().min(1).max(40).refine(value => value === value.trim() && Number.isFinite(Date.parse(value)), 'Use a trimmed ISO timestamp.');

const uuid = z.string().regex(UUID, 'Use a canonical lowercase UUID.');
const digest = z.string().regex(DIGEST, 'Use sha256: followed by 64 lowercase hexadecimal characters.');
const idempotencyKey = z.string().regex(IDEMPOTENCY,
  'Use 8-200 URL-safe characters. Reuse the same key only for an identical retry.');
const leaseEpoch = z.number().int().positive();
const boundedText = (maximum: number) => z.string().min(1).max(maximum).refine(value => value === value.trim(), 'Text must be trimmed.');
const empty = z.object({}).strict();

const researchContext = z.object({ scopeId: uuid, snapshotId: uuid, snapshotDigest: digest }).strict();
const researchReference = z.object({
  scopeId: uuid,
  snapshotId: uuid,
  snapshotDigest: digest,
  hypothesisId: uuid,
  observedUpdatedAt: TIMESTAMP,
  evidenceIds: z.array(uuid).max(20).refine(items => new Set(items).size === items.length, 'Evidence IDs must be unique.'),
}).strict();
const motiveReference = z.object({ submissionId: uuid, reportDigest: digest, artifactDigest: digest }).strict();
const experimentProtocol = z.object({
  format: z.literal('motive.experiment-protocol.v1'),
  procedure: boundedText(240),
  inputs: z.array(z.object({
    name: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
    value: boundedText(512),
  }).strict()).min(1).max(32).refine(items => new Set(items.map(item => item.name)).size === items.length,
    'Protocol input names must be unique.'),
  purpose: z.enum(['EXPLORATORY', 'REPLICATION', 'CONTROL']),
}).strict();
const researchDeliveryTarget = z.object({
  mode: z.literal('APPEND_EXISTING'),
  scopeId: uuid,
  snapshotId: uuid,
  snapshotDigest: digest,
  hypothesisId: uuid,
  observedUpdatedAt: TIMESTAMP,
}).strict();

const optionalEvidence = {
  researchContext: researchContext.optional(),
  researchReferences: z.array(researchReference).min(1).max(10).optional(),
  motiveReferences: z.array(motiveReference).min(1).max(10)
    .refine(items => new Set(items.map(item => item.submissionId)).size === items.length,
      'Motive submission references must be unique.').optional(),
  experimentProtocol: experimentProtocol.optional(),
  researchDeliveryTarget: researchDeliveryTarget.optional(),
};

const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

export type RegisteredTool = {
  name: string;
  request: (args: Record<string, unknown>) => MotiveRequest;
};

function toolResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function toolError(error: unknown): CallToolResult {
  const message = error instanceof MotiveClientError
    ? error.message
    : 'The local Motive extension encountered an unexpected error. No request details were returned.';
  return { isError: true as const, content: [{ type: 'text' as const, text: message }] };
}

async function call(client: MotiveClient, request: MotiveRequest): Promise<CallToolResult> {
  try { return toolResult(await client.request(request)); }
  catch (error) { return toolError(error); }
}

export function registerMotiveTools(server: McpServer, client: MotiveClient): RegisteredTool[] {
  const registered: RegisteredTool[] = [];
  const add = <T extends z.ZodType<Record<string, unknown>>>(
    name: string,
    description: string,
    schema: T,
    request: (args: z.infer<T>) => MotiveRequest,
    write = false,
  ) => {
    const handler = (async (args: z.infer<T>) => call(client, request(args))) as ToolCallback<T>;
    server.registerTool(name, { description, inputSchema: schema, annotations: write ? writeAnnotations : readAnnotations }, handler);
    registered.push({ name, request: request as (args: Record<string, unknown>) => MotiveRequest });
  };

  add('read_project_document',
    'Read one fixed public Motive project guide or baseline document. Read contributor_skill, project_manifest, and submission_api before starting work.',
    z.object({ document: z.enum([
      'contributor_skill', 'project_manifest', 'submission_api', 'finding_review', 'research_context',
      'peer_validation', 'experiment_protocol', 'optimizer_protocol', 'reference_witness', 'reference_provenance',
    ]) }).strict(),
    ({ document }) => ({ method: 'GET', path: ({
      contributor_skill: '/agents/SKILL.md', project_manifest: '/agents/circle-packing.json', submission_api: '/agents/submission-api.md',
      finding_review: '/agents/finding-review.md', research_context: '/agents/research-context.md', peer_validation: '/agents/peer-validation.md',
      experiment_protocol: '/agents/experiment-protocol.md', optimizer_protocol: '/agents/optimizer-protocol.md',
      reference_witness: '/projects/circle-packing/reference-witness.json',
      reference_provenance: '/projects/circle-packing/reference-provenance.json',
    })[document] }),
  );
  add('get_public_research_brief', 'Read the bounded public research brief for orientation. No project key is sent.', empty,
    () => ({ method: 'GET', path: '/api/public/projects/circle-packing/research-brief' }));
  add('get_hosted_results', 'Read the fixed public hosted-results projection. No project key is sent.', empty,
    () => ({ method: 'GET', path: '/api/public/projects/circle-packing/hosted-results' }));
  add('get_public_research_update',
    'Read a public research journal page or one exact journal entry. Omit submissionId for a page; before is only for pagination.',
    z.object({ submissionId: uuid.optional(), before: uuid.optional() }).strict()
      .refine(value => !(value.submissionId && value.before), 'before cannot accompany submissionId.'),
    ({ submissionId, before }) => submissionId
      ? { method: 'GET', path: `/api/public/projects/circle-packing/research-updates/${submissionId}` }
      : { method: 'GET', path: '/api/public/projects/circle-packing/research-updates', query: { before } });
  add('get_public_submission',
    'Read one exact public submission artifact, checker report, investigation, post-check, reproducibility record/file, or finding review. No project key is sent.',
    z.object({ submissionId: uuid, document: z.enum([
      'artifact', 'report', 'investigation', 'post-check-assessment', 'reproducibility',
      'solver-source', 'trial-results', 'finding-review',
    ]) }).strict(),
    ({ submissionId, document }) => ({ method: 'GET', path: document === 'solver-source' || document === 'trial-results'
      ? `/api/public/projects/circle-packing/submissions/${submissionId}/reproducibility/${document}.txt`
      : `/api/public/projects/circle-packing/submissions/${submissionId}/${document}` }));

  add('get_work_queue',
    'Read the authoritative queue first and at every completed-cycle checkpoint. Recover RESUME, FINDING_REVIEW, or RESEARCH_SYNC before new work.',
    empty, () => ({ method: 'GET', path: '/api/agent/work-queue' }));
  add('get_assignment', 'Refresh the current assignment, claim, lease, and service-coverage state.', empty,
    () => ({ method: 'GET', path: '/api/agent/assignment' }));
  add('get_research_context', 'Read a page of the authenticated retained research context.',
    z.object({ activeOffset: z.number().int().min(0).max(100000).optional(), archivedOffset: z.number().int().min(0).max(100000).optional(),
      insightOffset: z.number().int().min(0).max(100000).optional() }).strict(),
    args => ({ method: 'GET', path: '/api/agent/research-context', query: args }));
  add('get_hypothesis_context', 'Read one retained hypothesis and an optional evidence page.',
    z.object({ hypothesisId: uuid, evidenceOffset: z.number().int().min(0).max(100000).optional() }).strict(),
    ({ hypothesisId, evidenceOffset }) => ({ method: 'GET', path: `/api/agent/research-context/hypotheses/${hypothesisId}`, query: { evidenceOffset } }));
  add('get_retained_research_context', 'Read the latest retained research snapshot for this project.', empty,
    () => ({ method: 'GET', path: '/api/agent/research-context/retained-latest' }));
  add('get_research_snapshot', 'Read one exact retained research snapshot.', z.object({ snapshotId: uuid }).strict(),
    ({ snapshotId }) => ({ method: 'GET', path: `/api/agent/research-context/snapshots/${snapshotId}` }));
  add('match_experiment_protocol', 'Find exact retained matches for a proposed bounded experiment protocol.',
    z.object({ experimentProtocol, cursor: z.string().min(1).max(512).optional() }).strict(),
    ({ experimentProtocol: protocol, cursor }) => ({ method: 'POST', path: '/api/agent/experiment-protocol-matches',
      body: { experimentProtocol: protocol, ...(cursor ? { cursor } : {}) }, readOnlyPost: true }));

  add('set_session_status',
    'Declare this Claude run RUNNING or PAUSED. Use a fresh idempotencyKey for a new declaration; reuse it with identical inputs after an uncertain result.',
    z.object({ status: z.enum(['RUNNING', 'PAUSED']), runMode: z.enum(['ONE_TASK', 'THIRTY_MINUTES', 'UNTIL_STOPPED']),
      stopReason: boundedText(280).optional(), idempotencyKey }).strict()
      .refine(value => value.status === 'PAUSED' || value.stopReason === undefined, 'RUNNING cannot include stopReason.'),
    ({ idempotencyKey: key, ...body }) => ({ method: 'POST', path: '/api/agent/session', body, idempotencyKey: key }), true);
  add('claim_assignment', 'Claim the exact work-order ID returned by the queue. The body is fixed empty JSON.',
    z.object({ assignmentId: uuid, idempotencyKey }).strict(),
    ({ assignmentId, idempotencyKey: key }) => ({ method: 'POST', path: `/api/agent/assignments/${assignmentId}/claim`, body: {}, idempotencyKey: key }), true);
  add('renew_assignment', 'Renew a live claim before expiry using its current positive leaseEpoch.',
    z.object({ assignmentId: uuid, leaseEpoch, idempotencyKey }).strict(),
    ({ assignmentId, idempotencyKey: key, ...body }) => ({ method: 'POST', path: `/api/agent/assignments/${assignmentId}/renew`, body, idempotencyKey: key }), true);
  add('record_assignment_intent', 'Record the pre-test proposal, expected observation, conditions, and immutable evidence references for a live claim.',
    z.object({ assignmentId: uuid, leaseEpoch, proposal: boundedText(2000), expectation: boundedText(1000),
      conditions: z.array(boundedText(500)).min(1).max(12), ...optionalEvidence, idempotencyKey }).strict(),
    ({ assignmentId, idempotencyKey: key, ...body }) => ({ method: 'POST', path: `/api/agent/assignments/${assignmentId}/intent`, body, idempotencyKey: key }), true);
  add('release_assignment', 'Release unfinished live work with its current leaseEpoch and optional public stopping reason.',
    z.object({ assignmentId: uuid, leaseEpoch, stopReason: boundedText(1000).optional(), idempotencyKey }).strict(),
    ({ assignmentId, idempotencyKey: key, ...body }) => ({ method: 'POST', path: `/api/agent/assignments/${assignmentId}/release`, body, idempotencyKey: key }), true);
  add('submit_circle_witness', 'Submit the exact data-only witness and optional investigation for a live claim. Motive runs the protected checker.',
    z.object({ assignmentId: uuid, leaseEpoch, witness: z.string().min(1).max(32768), investigation: z.object({
      format: z.literal('motive.investigation.v1'), proposal: boundedText(2000), expectation: boundedText(1000),
      conditions: z.array(boundedText(500)).min(1).max(12), observations: z.array(boundedText(1000)).min(1).max(20),
      assessment: boundedText(2000), nextAction: boundedText(1000), ...optionalEvidence,
    }).strict().optional(), idempotencyKey }).strict(),
    ({ assignmentId, idempotencyKey: key, ...body }) => ({ method: 'POST', path: `/api/agent/assignments/${assignmentId}/submissions`, body, idempotencyKey: key }), true);
  add('complete_assignment', 'Complete the claim with the exact returned submission ID and current leaseEpoch.',
    z.object({ assignmentId: uuid, leaseEpoch, submissionId: uuid, idempotencyKey }).strict(),
    ({ assignmentId, idempotencyKey: key, ...body }) => ({ method: 'POST', path: `/api/agent/assignments/${assignmentId}/complete`, body, idempotencyKey: key }), true);
  add('append_post_check_assessment', 'Append the immutable interpretation of the actual checker report. Include a concise publicSummary when first recording it.',
    z.object({ submissionId: uuid, reportDigest: digest, assessment: boundedText(2000), nextAction: boundedText(1000),
      publicSummary: z.object({ question: boundedText(180), finding: boundedText(320) }).strict().optional(), idempotencyKey }).strict(),
    ({ submissionId, idempotencyKey: key, ...body }) => ({ method: 'POST', path: `/api/agent/submissions/${submissionId}/post-check-assessment`, body, idempotencyKey: key }), true);
  add('attach_reproducibility', 'Attach public source and trial logs to the exact checker report. Never include credentials or private data.',
    z.object({ submissionId: uuid, reportDigest: digest, solverSource: z.string().min(1).max(16384),
      trialResults: z.string().min(1).max(32768), idempotencyKey }).strict(),
    ({ submissionId, idempotencyKey: key, ...body }) => ({ method: 'POST', path: `/api/agent/submissions/${submissionId}/reproducibility`, body, idempotencyKey: key }), true);

  add('preview_finding_review', 'Preview the exact queued finding-review package before deciding it.',
    z.object({ reviewSubmissionId: uuid, targetSubmissionId: uuid }).strict(),
    ({ reviewSubmissionId, targetSubmissionId }) => ({ method: 'GET', path: `/api/agent/finding-reviews/${reviewSubmissionId}/targets/${targetSubmissionId}/preview` }));
  add('decide_finding_review', 'Finish one exact queued finding review. All nullable fields are required; declined decisions require them all to be null.',
    z.object({ reviewSubmissionId: uuid, targetSubmissionId: uuid, packageDigest: digest, expectedDecisionId: uuid.nullable(),
      decision: z.enum(['ACCEPT', 'DECLINE']), outcome: z.enum(['SUPPORTED', 'CONTRADICTED', 'INCONCLUSIVE']).nullable(),
      finding: boundedText(2000).nullable(), limitations: boundedText(2000).nullable(), novelty: z.enum(['DISTINCT', 'DUPLICATE']).nullable(),
      duplicateOfSubmissionId: uuid.nullable(), rationale: boundedText(2000), idempotencyKey }).strict(),
    ({ reviewSubmissionId, targetSubmissionId, idempotencyKey: key, ...body }) => ({ method: 'POST',
      path: `/api/agent/finding-reviews/${reviewSubmissionId}/targets/${targetSubmissionId}/decisions`, body, idempotencyKey: key }), true);
  add('get_research_sync_capability', 'Read the current owner-approved shared-memory delivery capability. Queue checkpoints remain authoritative.', empty,
    () => ({ method: 'GET', path: '/api/agent/research-sync-capability' }));
  add('sync_research', 'Finish a queued RESEARCH_SYNC checkpoint with its exact submission, policy, and report digest. Retry PENDING with the same key and body.',
    z.object({ submissionId: uuid, policyId: uuid, reportDigest: digest, idempotencyKey }).strict(),
    ({ submissionId, idempotencyKey: key, ...body }) => ({ method: 'POST', path: `/api/agent/submissions/${submissionId}/research-sync`, body, idempotencyKey: key }), true);

  return registered;
}
