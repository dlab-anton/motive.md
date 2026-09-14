import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { canonicalJson, digestCanonicalJson } from '../../packages/domain/src/contracts.ts';
import { decryptSecret } from '../funding/vault.ts';
import { createHypothesisDeliveryIntentService, type PreparedDeliveryIntent } from './delivery-intents.ts';
import { currentPolicyApprover, currentPolicyAuthority, policyIdFromPrincipal } from './delivery-policy-authority.ts';
import type { ResearchDeliveryReviewPackage } from './submission-admission.ts';
import { registeredReviewedWritebackContract, reviewedWritebackContractForDigest,
  type ReviewedWritebackContract } from './pinned-writeback-contract.ts';
import type { ResearchDeliveryMode } from '../../src/lib/research-delivery-policy.ts';
import type { ResearchDeliveryTargetBinding } from '../../src/lib/research-delivery-target.ts';
import type { ResearchEvidenceMotiveContribution } from '../../src/lib/research-memory.ts';
export type { ReviewedWritebackContract } from './pinned-writeback-contract.ts';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const HEX = /^[a-f0-9]{64}$/;
const ACCOUNT = /^account:[A-Za-z0-9._~-]{1,480}$/;
const MAX_REQUEST_BYTES = 32 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const PUBLIC_ORIGIN='https://motive-md.vercel.app';

export type JsonObject = Record<string, unknown>;
export type OperationName = 'DRAFT_HYPOTHESIS' | 'NEUTRAL_EVIDENCE';

export type SyncSubmissionResearchInput = Readonly<{
  projectSlug: string;
  scopeId: string;
  submissionId: string;
  idempotencyKey: string;
  approvedApiBaseUrl: string;
  contract: ReviewedWritebackContract;
  execute: boolean;
}>;

export type SubmissionResearchDeliveryResult = Readonly<{
  format: 'motive.hypothesis-submission-delivery/0.1';
  status: 'UNAVAILABLE' | 'PENDING' | 'DRAFT_RECORDED' | 'EVIDENCE_RECORDED';
  deliveryId: string | null;
  sourceIntentId: string;
  sourceIntentPayloadDigest: string;
  draftRequestDigest: string | null;
  hypothesisId: string | null;
  evidenceRequestDigest: string | null;
  evidenceId: string | null;
  pendingOperation: OperationName | null;
  reason: 'INVESTIGATION_REQUIRED' | 'EXECUTION_NOT_REQUESTED' | 'ENGINE_ATTEMPT_UNCONFIRMED'
    | 'NEXT_OPERATION_REQUIRES_RETRY' | 'TARGET_PRECONDITION_CONFLICT' | null;
  notice: 'A draft and neutral observation do not establish support, conclusion, acceptance, or review.';
}>;

export type SubmissionDeliveryOptions = Readonly<{
  pool: Pool;
  vaultKey: Uint8Array;
  isActorActive(actorId: string): boolean | Promise<boolean>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}>;

export type Delivery = Readonly<{
  id: string; projectId: string; scopeId: string; submissionId: string; sourceIntentId: string;
  sourceIntentPayloadDigest: string; engineActor: string; apiBaseUrl: string; configurationDigest: string;
  apiVersion: string; contractDigest: string; contractVersion: string; contractSurfaceDigest: string;
  implementationDigest: string; payload: JsonObject; mode:ResearchDeliveryMode;
  target:ResearchDeliveryTargetBinding|null;targetBindingDigest:string|null;
}>;
export type StoredOperation = Readonly<{
  deliveryId: string; operation: OperationName; targetHypothesisId: string | null; requestPath: string;
  idempotencyKey: string; body: JsonObject; bodyDigest: string; requestDigest: string;
}>;
type StoredResult = Readonly<{ resourceId: string; response: JsonObject; responseDigest: string }>;
export type DeliverySource = Readonly<{
  notes: { proposal: string; expectation: string; conditions: string[] };
  attribution: JsonObject; source: JsonObject; report: JsonObject; reportBody: JsonObject; reportBinding: JsonObject;
}>;
type StoredObservationManifest=Readonly<{body:JsonObject;bytes:Buffer;digest:string;href:string}>;

export class SubmissionDeliveryError extends Error {
  constructor(readonly code: 'VALIDATION' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'UNVERIFIED_CONTRACT', message: string) {
    super(message); this.name = 'SubmissionDeliveryError';
  }
}
class ReceiverTargetConflict extends SubmissionDeliveryError {
  constructor(){super('CONFLICT','Hypothesis rejected the immutable operation or its target precondition.');}
}

function fail(code: SubmissionDeliveryError['code'], message: string): never { throw new SubmissionDeliveryError(code, message); }
function object(value: unknown, message = 'Stored delivery material is invalid.'): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('CONFLICT', message);
  return value as JsonObject;
}
function text(value: unknown, message = 'Stored delivery text is invalid.'): string {
  if (typeof value !== 'string' || !value) fail('CONFLICT', message); return value;
}
function rowText(row: QueryResultRow, name: string): string { return text(row[name], `Stored ${name} is invalid.`); }
function dateText(value: unknown): string { return (value instanceof Date ? value : new Date(String(value))).toISOString(); }
function sha256Bytes(bytes: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
function equal(left: unknown, right: unknown): boolean {
  try { return canonicalJson(left) === canonicalJson(right); } catch { return false; }
}
function normalizedApiBase(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { fail('VALIDATION', 'Approved Hypothesis API base URL is invalid.'); }
  if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol)) {
    fail('VALIDATION', 'Approved Hypothesis API base URL is invalid.');
  }
  if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    fail('VALIDATION', 'Plain HTTP is allowed only for a loopback Hypothesis API.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

export function verifyReviewedWritebackContract(bytes: Uint8Array, claimedDigest: string): ReviewedWritebackContract {
  if (!DIGEST.test(claimedDigest) || sha256Bytes(bytes) !== claimedDigest || bytes.byteLength < 1 || bytes.byteLength > 2 * 1024 * 1024) {
    fail('UNVERIFIED_CONTRACT', 'Reviewed Hypothesis writeback contract digest does not match the supplied file.');
  }
  const contractObject = (value: unknown, message: string): JsonObject => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('UNVERIFIED_CONTRACT', message);
    return value as JsonObject;
  };
  let parsed: JsonObject;
  try { parsed = contractObject(JSON.parse(Buffer.from(bytes).toString('utf8')), 'Reviewed Hypothesis writeback contract is invalid.'); }
  catch (error) { if (error instanceof SubmissionDeliveryError) throw error; fail('UNVERIFIED_CONTRACT', 'Reviewed Hypothesis writeback contract is invalid.'); }
  const registered=reviewedWritebackContractForDigest(claimedDigest);
  if(!registered)fail('UNVERIFIED_CONTRACT','Reviewed Hypothesis writeback contract is not in the exact local registry.');
  const idempotency = contractObject(parsed.idempotency, 'Reviewed Hypothesis idempotency contract is invalid.');
  const paths = contractObject(parsed.paths, 'Reviewed Hypothesis path contract is invalid.');
  const hypothesisPost = contractObject(contractObject(paths['/api/v1/hypotheses'], 'Reviewed hypothesis path is missing.').post,
    'Reviewed hypothesis create operation is missing.');
  const evidencePost = contractObject(contractObject(paths['/api/v1/hypotheses/{hypothesis_id}/evidence'], 'Reviewed evidence path is missing.').post,
    'Reviewed evidence create operation is missing.');
  const operations = idempotency.operations;
  const validHeader = (post: JsonObject) => Array.isArray(post.parameters) && post.parameters.some(value => {
    const parameter = value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
    return parameter?.name === 'Idempotency-Key' && parameter.in === 'header';
  });
  const cap3=registered.contractVersion==='hypothesis-http-writeback-capabilities/3';
  const evidenceSchema=contractObject(contractObject(parsed.components,'Reviewed Hypothesis components are missing.').schemas,
    'Reviewed Hypothesis schemas are missing.').EvidenceCreate;
  const evidenceCreate=contractObject(evidenceSchema,'Reviewed evidence create schema is missing.');
  const evidenceProperties=contractObject(evidenceCreate.properties,'Reviewed evidence create properties are missing.');
  const expectedChannel=evidenceProperties.expected_channel_id;
  const required=Array.isArray(evidenceCreate.required)?evidenceCreate.required:[];
  const evidenceResponses=contractObject(evidencePost.responses,'Reviewed evidence responses are missing.');
  const expectedPayload=cap3
    ?'SHA-256 of sorted UTF-8 JSON of the validated model including defaults; implicit initial_confidence resolved; evidence target UUID included in digest; expected_channel_id included only when provided'
    :'SHA-256 of sorted UTF-8 JSON of the validated model including defaults; implicit initial_confidence resolved; evidence target UUID included in digest';
  if (parsed.contract_version !== registered.contractVersion || parsed.api_version !== registered.apiVersion
    || parsed.schema_revision !== '017_write_idempotency' || parsed.automatic_writeback_ready !== false
    || idempotency.changed_payload_status !== 409 || idempotency.success_status !== 201
    || idempotency.payload !== expectedPayload
    || !Array.isArray(operations) || !operations.includes('hypotheses:create') || !operations.includes('evidence:create')
    || !validHeader(hypothesisPost) || !validHeader(evidencePost)
    || parsed.surface_sha256 !== registered.surfaceDigest || parsed.implementation_sha256 !== registered.implementationDigest
    || (cap3?(expectedChannel===null||typeof expectedChannel!=='object'||Array.isArray(expectedChannel)
      ||(expectedChannel as JsonObject).type!=='string'||(expectedChannel as JsonObject).format!=='uuid'
      ||required.includes('expected_channel_id')||!Object.hasOwn(evidenceResponses,'409')):expectedChannel!==undefined)) {
    fail('UNVERIFIED_CONTRACT', 'Reviewed Hypothesis writeback contract does not pin the required atomic create behavior.');
  }
  return registered;
}

function normalizedInput(input: SyncSubmissionResearchInput): SyncSubmissionResearchInput {
  if (!input || typeof input !== 'object'
    || JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(['approvedApiBaseUrl', 'contract', 'execute', 'idempotencyKey', 'projectSlug', 'scopeId', 'submissionId'])
    || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(input.projectSlug) || !UUID.test(input.scopeId)
    || !UUID.test(input.submissionId) || !/^[A-Za-z0-9._~-]{8,200}$/.test(input.idempotencyKey)
    || typeof input.execute !== 'boolean' || !registeredReviewedWritebackContract(input.contract))
    fail('VALIDATION', 'Submission research delivery input is invalid.');
  return { ...input, approvedApiBaseUrl: normalizedApiBase(input.approvedApiBaseUrl) };
}

export function preparedDeliverySource(intent: PreparedDeliveryIntent): DeliverySource | null {
  if (digestCanonicalJson(intent.payload) !== intent.payloadDigest) fail('CONFLICT', 'Prepared source payload digest is invalid.');
  const payload = object(intent.payload); const attribution = object(payload.attribution); const source = object(payload.source);
  const report = object(source.report); const reportBody = object(report.body); const reportBinding = object(reportBody.binding);
  if (!DIGEST.test(text(report.digest)) || digestCanonicalJson(reportBody) !== report.digest) fail('CONFLICT', 'Protected report digest is invalid.');
  const artifact = object(source.artifact); const witness = text(artifact.witness);
  if (!DIGEST.test(text(artifact.witnessDigest)) || sha256Bytes(witness) !== artifact.witnessDigest) fail('CONFLICT', 'Witness digest is invalid.');
  const investigationEnvelope = source.investigation;
  if (investigationEnvelope === null) return null;
  const envelope = object(investigationEnvelope); const notes = object(envelope.investigation);
  const conditions = notes.conditions;
  if (notes.format !== 'motive.investigation.v1' || typeof notes.proposal !== 'string' || !notes.proposal
    || notes.proposal.length > 2000 || typeof notes.expectation !== 'string' || !notes.expectation || notes.expectation.length > 1000
    || !Array.isArray(conditions) || conditions.length < 1 || conditions.length > 12
    || conditions.some(item => typeof item !== 'string' || !item || item.length > 500)) {
    fail('CONFLICT', 'Prepared investigation notes are invalid.');
  }
  if (!equal(reportBody.agentInvestigation, envelope)) fail('CONFLICT', 'Prepared investigation and protected report attribution differ.');
  const submission = object(source.submission); const workOrder = object(source.workOrder); const claim = object(source.claim);
  const checker = object(reportBinding.checker);
  const exactBindings = reportBinding.projectId === object(payload.scope).projectId
    && reportBinding.workOrderId === workOrder.id && reportBinding.workOrderRevision === workOrder.revision
    && reportBinding.termsDigest === workOrder.termsDigest && reportBinding.claimId === claim.id
    && reportBinding.leaseEpoch === claim.leaseEpoch && reportBinding.submissionId === submission.id
    && reportBinding.artifactDigest === artifact.witnessDigest && reportBinding.artifactManifestDigest === submission.artifactManifestDigest
    && typeof reportBinding.agreementId === 'string' && reportBinding.agreementId.length > 0
    && typeof checker.format === 'string' && typeof checker.version === 'number' && DIGEST.test(text(checker.sourceDigest))
    && DIGEST.test(text(checker.evaluationProfileDigest));
  if (!exactBindings) fail('CONFLICT', 'Prepared report bindings do not match the immutable submission source.');
  return { notes: { proposal: notes.proposal, expectation: notes.expectation, conditions: [...conditions] as string[] },
    attribution, source, report, reportBody, reportBinding };
}

function sourcePaths(projectSlug: string, submissionId: string) {
  const root = `/api/public/projects/${projectSlug}/submissions/${submissionId}`;
  return { artifact: `${root}/artifact`, report: `${root}/report`, investigation: `${root}/investigation` };
}

export function buildDraftBody(delivery: Delivery, sourceMaterial: DeliverySource, projectSlug: string): JsonObject {
  const paths = sourcePaths(projectSlug, delivery.submissionId); const source = sourceMaterial.source;
  const submission = object(source.submission); const workOrder = object(source.workOrder); const claim = object(source.claim);
  const artifact = object(source.artifact); const report = sourceMaterial.report; const binding = sourceMaterial.reportBinding;
  const scope = object(delivery.payload.scope);
  const body: JsonObject = {
    statement: sourceMaterial.notes.proposal,
    context: sourceMaterial.notes.expectation,
    experimental_design: { conditions: sourceMaterial.notes.conditions },
    status: 'draft', channel: text(scope.channelName),
    created_by: delivery.engineActor,
    metadata: { motive: {
      format: 'motive.hypothesis-submission-source/0.1', disposition: 'PROPOSED_UNREVIEWED', deliveryId: delivery.id,
      sourceIntent: { id: delivery.sourceIntentId, payloadDigest: delivery.sourceIntentPayloadDigest },
      originalContributor: text(sourceMaterial.attribution.originalContributor),
      contributorNotes: { proposal: sourceMaterial.notes.proposal, expectation: sourceMaterial.notes.expectation,
        conditions: sourceMaterial.notes.conditions },
      bindings: { project: { id: delivery.projectId, slug: projectSlug }, agreementId: binding.agreementId,
        workOrder: { id: workOrder.id, revision: workOrder.revision, projectRevision: workOrder.projectRevision, termsDigest: workOrder.termsDigest },
        claim: { id: claim.id, leaseEpoch: claim.leaseEpoch }, submission: { id: submission.id, format: submission.format,
          createdAt: submission.createdAt, baseCommit: submission.baseCommit, artifactManifestDigest: submission.artifactManifestDigest,
          licenseAcceptanceRef: submission.licenseAcceptanceRef }, artifact: { format: artifact.format, witnessDigest: artifact.witnessDigest },
        report: { status: report.status, digest: report.digest, exactScore: report.exactScore, exceedsReference: report.exceedsReference },
        checker: binding.checker }, sourceURLs: paths,
    } },
  };
  if (Buffer.byteLength(canonicalJson(body), 'utf8') > MAX_REQUEST_BYTES) fail('CONFLICT', 'Draft request exceeds the fixed delivery bound.');
  return body;
}

export function buildNeutralEvidenceBody(delivery: Delivery, sourceMaterial: DeliverySource, projectSlug: string): JsonObject {
  if(delivery.mode==='APPEND_EXISTING')fail('CONFLICT','Append evidence requires its immutable observation manifest.');
  const paths = sourcePaths(projectSlug, delivery.submissionId);
  const content = canonicalJson({ format: 'motive.protected-checker-observation/0.1', deliveryId: delivery.id,
    sourceIntent: { id: delivery.sourceIntentId, payloadDigest: delivery.sourceIntentPayloadDigest },
    binding: sourceMaterial.reportBinding,
    report: { status: sourceMaterial.report.status, digest: sourceMaterial.report.digest,
      exactScore: sourceMaterial.report.exactScore, exceedsReference: sourceMaterial.report.exceedsReference,
      result: sourceMaterial.reportBody.result }, sourceURLs: paths });
  if (content.length > 5000 || paths.report.length > 500) fail('CONFLICT', 'Neutral evidence cannot preserve the protected report within the engine bounds.');
  const body:JsonObject = { content, evidence_type: 'neutral', source: paths.report, created_by: delivery.engineActor };
  if(delivery.contractVersion==='hypothesis-http-writeback-capabilities/3'){
    const channelId=object(delivery.payload.scope).channelId;
    if(typeof channelId!=='string'||!UUID.test(channelId))fail('CONFLICT','Prepared source channel identity is invalid.');
    body.expected_channel_id=channelId;
  }else if(delivery.contractVersion!=='hypothesis-http-writeback-capabilities/2'){
    fail('CONFLICT','Stored delivery contract version is invalid.');
  }
  if (Buffer.byteLength(canonicalJson(body), 'utf8') > MAX_REQUEST_BYTES) fail('CONFLICT', 'Evidence request exceeds the fixed delivery bound.');
  return body;
}

export function buildAppendEvidenceBody(delivery:Delivery,manifest:StoredObservationManifest):JsonObject{
  if(delivery.mode!=='APPEND_EXISTING'||!delivery.target||!delivery.targetBindingDigest
    ||delivery.contractVersion!=='hypothesis-http-writeback-capabilities/3')fail('CONFLICT','Append delivery binding is invalid.');
  const summary=object(manifest.body.summary,'Stored observation summary is invalid.');
  const content=canonicalJson({format:'motive.thread-experiment-observation/0.1',deliveryId:delivery.id,
    target:{hypothesisId:delivery.target.selection.hypothesisId,observedUpdatedAt:delivery.target.selection.observedUpdatedAt,
      hypothesisContentDigest:delivery.target.hypothesisContentDigest,statementDigest:delivery.target.statementDigest},
    source:{submissionId:delivery.submissionId,sourceIntentPayloadDigest:delivery.sourceIntentPayloadDigest},
    observationManifest:{url:manifest.href,digest:manifest.digest},summary,
    labels:{evidence:'NEUTRAL',context:'HISTORICAL_TESTED_CONTEXT',hypothesisSupport:'UNASSESSED',conclusionApproval:'UNASSESSED'}});
  if(content.length>5000||manifest.href.length>500)fail('CONFLICT','Append evidence exceeds the fixed receiver bounds.');
  const body:JsonObject={content,evidence_type:'neutral',source:manifest.href,created_by:delivery.engineActor,
    expected_channel_id:delivery.target.channelId};
  if(Buffer.byteLength(canonicalJson(body),'utf8')>MAX_REQUEST_BYTES)fail('CONFLICT','Evidence request exceeds the fixed delivery bound.');
  return body;
}

function deliveryProjection(row: QueryResultRow): Delivery {
  return { id: rowText(row, 'id'), projectId: rowText(row, 'project_id'), scopeId: rowText(row, 'scope_id'),
    submissionId: rowText(row, 'source_submission_id'), sourceIntentId: rowText(row, 'source_intent_id'),
    sourceIntentPayloadDigest: rowText(row, 'source_intent_payload_digest'), engineActor: rowText(row, 'engine_actor'),
    apiBaseUrl: rowText(row, 'engine_api_base_url'), configurationDigest: rowText(row, 'scope_configuration_digest'),
    apiVersion: rowText(row, 'engine_api_version'), contractDigest: rowText(row, 'reviewed_contract_digest'),
    contractVersion: rowText(row, 'reviewed_contract_version'),
    contractSurfaceDigest: rowText(row, 'reviewed_contract_surface_digest'),
    implementationDigest: rowText(row, 'reviewed_implementation_digest'), payload: object(row.payload),
    mode:(row.delivery_mode??'NEW_DRAFT') as ResearchDeliveryMode,
    target:row.target_binding===null||row.target_binding===undefined?null:object(row.target_binding) as ResearchDeliveryTargetBinding,
    targetBindingDigest:row.target_binding_digest===null||row.target_binding_digest===undefined?null:rowText(row,'target_binding_digest') };
}

function operationProjection(row: QueryResultRow): StoredOperation {
  return { deliveryId: rowText(row, 'delivery_id'), operation: rowText(row, 'operation') as OperationName,
    targetHypothesisId: row.target_hypothesis_id === null ? null : rowText(row, 'target_hypothesis_id'),
    requestPath: rowText(row, 'request_path'), idempotencyKey: rowText(row, 'idempotency_key'), body: object(row.request_body),
    bodyDigest: rowText(row, 'request_body_digest'), requestDigest: rowText(row, 'request_digest') };
}

function resultProjection(row: QueryResultRow): StoredResult {
  const response = object(row.response_body); const responseDigest = rowText(row, 'response_digest');
  if (digestCanonicalJson(response) !== responseDigest) fail('CONFLICT', 'Stored engine response digest is invalid.');
  return { resourceId: rowText(row, 'resource_id'), response, responseDigest };
}

function output(status: SubmissionResearchDeliveryResult['status'], intent: PreparedDeliveryIntent, values: Partial<SubmissionResearchDeliveryResult> = {}): SubmissionResearchDeliveryResult {
  return { format: 'motive.hypothesis-submission-delivery/0.1', status, deliveryId: null, sourceIntentId: intent.id,
    sourceIntentPayloadDigest: intent.payloadDigest, draftRequestDigest: null, hypothesisId: null, evidenceRequestDigest: null,
    evidenceId: null, pendingOperation: null, reason: null,
    notice: 'A draft and neutral observation do not establish support, conclusion, acceptance, or review.', ...values };
}

export class HypothesisSubmissionDeliveryService {
  private readonly intent;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  constructor(private readonly options: SubmissionDeliveryOptions) {
    if (options.vaultKey.byteLength !== 32) throw new Error('Submission delivery vault key must contain 32 bytes.');
    this.intent = createHypothesisDeliveryIntentService({ pool: options.pool, isActorActive: options.isActorActive });
    this.fetcher = options.fetch ?? fetch; this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  private async ensureObservationManifest(delivery:Delivery,sourceMaterial:DeliverySource,projectSlug:string,
    client:PoolClient):Promise<StoredObservationManifest>{
    if(delivery.mode!=='APPEND_EXISTING'||!delivery.target||!delivery.targetBindingDigest)
      fail('CONFLICT','Append observation target is invalid.');
    const existing=await client.query(`SELECT manifest,manifest_bytes,manifest_digest
      FROM motive.research_delivery_observation_manifests WHERE delivery_id=$1 FOR SHARE`,[delivery.id]);
    const href=`${PUBLIC_ORIGIN}/api/public/projects/${projectSlug}/research-deliveries/${delivery.id}/observation`;
    if(existing.rowCount===1){const body=object(existing.rows[0].manifest),bytes=existing.rows[0].manifest_bytes as Buffer;
      const digest=rowText(existing.rows[0],'manifest_digest');
      if(Buffer.compare(Buffer.from(canonicalJson(body),'utf8'),bytes)!==0||sha256Bytes(bytes)!==digest)
        fail('CONFLICT','Retained observation manifest bytes are invalid.');
      return{body,bytes,digest,href};}
    const source=sourceMaterial.source,submission=object(source.submission),artifact=object(source.artifact);
    const detail=await client.query(`SELECT assessment.request_digest,assessment.report_digest,assessment.assessment,
        assessment.next_action,assessment.public_question,assessment.public_finding,assessment.created_at,
        repro.request_digest AS repro_request_digest,repro.solver_source_digest,repro.trial_results_digest,
        finding.id AS finding_id,finding.review_package_digest AS finding_package_digest,finding.outcome,
        finding.finding,finding.limitations,finding.novelty,finding.duplicate_of_submission_id,
        finding.rationale,finding.reviewer_agent_token_id,finding.review_submission_id,
        finding.created_at AS finding_created_at,clock_timestamp() AS manifest_observed_at
      FROM motive.participation_submission_artifacts artifact
      JOIN motive.participation_post_check_assessments assessment ON assessment.submission_id=artifact.submission_id
        AND assessment.project_id=artifact.project_id AND assessment.agent_token_id=artifact.agent_token_id
        AND assessment.report_digest=artifact.report_digest
      LEFT JOIN motive.participation_submission_reproducibility repro ON repro.submission_id=artifact.submission_id
        AND repro.project_id=artifact.project_id AND repro.agent_token_id=artifact.agent_token_id
        AND repro.report_digest=artifact.report_digest
      LEFT JOIN LATERAL (SELECT item.* FROM motive.finding_review_decisions item
        WHERE item.source_submission_id=artifact.submission_id AND item.decision='ACCEPT'
          AND NOT EXISTS(SELECT 1 FROM motive.finding_review_decisions successor WHERE successor.previous_decision_id=item.id)
        LIMIT 1) finding ON TRUE
      WHERE artifact.submission_id=$1 AND artifact.project_id=$2 FOR SHARE OF artifact,assessment`,
    [delivery.submissionId,delivery.projectId]);
    if(detail.rowCount!==1)fail('NOT_FOUND','Append observation requires an exact post-check assessment.');
    const row=detail.rows[0],root=`${PUBLIC_ORIGIN}/api/public/projects/${projectSlug}/submissions/${delivery.submissionId}`;
    const summary={question:row.public_question===null?'What did this completed experiment observe?':rowText(row,'public_question'),
      finding:row.public_finding===null?'See the retained post-check assessment and source bundle.':rowText(row,'public_finding')};
    const observedFinding=row.finding_id===null?null:{decisionId:rowText(row,'finding_id'),packageDigest:rowText(row,'finding_package_digest'),
      outcome:rowText(row,'outcome'),finding:rowText(row,'finding'),limitations:rowText(row,'limitations'),novelty:rowText(row,'novelty'),
      duplicateOfSubmissionId:row.duplicate_of_submission_id===null?null:rowText(row,'duplicate_of_submission_id'),
      rationale:rowText(row,'rationale'),reviewerKind:row.reviewer_agent_token_id===null?'ACCOUNT':'AGENT',
      reviewerAgentTokenId:row.reviewer_agent_token_id===null?null:rowText(row,'reviewer_agent_token_id'),
      reviewSubmissionId:row.review_submission_id===null?null:rowText(row,'review_submission_id'),reviewedAt:dateText(row.finding_created_at),
      observedAt:dateText(row.manifest_observed_at),disposition:'HISTORICAL_MOTIVE_DECISION'};
    const body:JsonObject={format:'motive.thread-experiment-observation-manifest/0.1',
      delivery:{id:delivery.id,mode:'APPEND_EXISTING',target:delivery.target,targetBindingDigest:delivery.targetBindingDigest},
      source:{submission:{id:delivery.submissionId,format:submission.format,createdAt:submission.createdAt,
          baseCommit:submission.baseCommit,artifactManifestDigest:submission.artifactManifestDigest,
          licenseAcceptanceRef:submission.licenseAcceptanceRef},
        sourceIntent:{id:delivery.sourceIntentId,payloadDigest:delivery.sourceIntentPayloadDigest},
        artifact:{format:artifact.format,digest:artifact.witnessDigest},report:{status:sourceMaterial.report.status,
          digest:sourceMaterial.report.digest,body:sourceMaterial.reportBody},investigation:source.investigation,
        postCheck:{requestDigest:rowText(row,'request_digest'),reportDigest:rowText(row,'report_digest'),
          assessment:rowText(row,'assessment'),nextAction:rowText(row,'next_action'),summary,createdAt:dateText(row.created_at)},
        reproducibility:row.repro_request_digest===null?null:{requestDigest:rowText(row,'repro_request_digest'),
          solverSourceDigest:rowText(row,'solver_source_digest'),trialResultsDigest:rowText(row,'trial_results_digest')},
        links:{artifact:`${root}/artifact`,report:`${root}/report`,investigation:`${root}/investigation`,
          postCheckAssessment:`${root}/post-check-assessment`,reproducibility:row.repro_request_digest===null?null:`${root}/reproducibility`,
          solverSource:row.repro_request_digest===null?null:`${root}/reproducibility/solver-source.txt`,
          trialResults:row.repro_request_digest===null?null:`${root}/reproducibility/trial-results.txt`},
        originalContributor:{agentTokenId:text(sourceMaterial.attribution.agentTokenId),agentName:text(sourceMaterial.attribution.agentName)}},
      summary,observedFinding,labels:{evidence:'NEUTRAL',context:'HISTORICAL_TESTED_CONTEXT',
        hypothesisSupport:'UNASSESSED',conclusionApproval:'UNASSESSED'}};
    const bytes=Buffer.from(canonicalJson(body),'utf8');if(bytes.byteLength>131072)fail('CONFLICT','Observation manifest exceeds the retained size limit.');
    const digest=sha256Bytes(bytes);
    await client.query(`INSERT INTO motive.research_delivery_observation_manifests
      (delivery_id,project_id,source_submission_id,manifest,manifest_bytes,manifest_digest)
      VALUES($1,$2,$3,$4::jsonb,$5,$6) ON CONFLICT(delivery_id) DO NOTHING`,
    [delivery.id,delivery.projectId,delivery.submissionId,JSON.stringify(body),bytes,digest]);
    const saved=await client.query(`SELECT manifest,manifest_bytes,manifest_digest FROM motive.research_delivery_observation_manifests
      WHERE delivery_id=$1 FOR SHARE`,[delivery.id]);
    if(saved.rowCount!==1||rowText(saved.rows[0],'manifest_digest')!==digest
      ||!equal(saved.rows[0].manifest,body)||Buffer.compare(saved.rows[0].manifest_bytes as Buffer,bytes)!==0)
      fail('CONFLICT','Existing observation manifest differs from the immutable delivery.');
    return{body,bytes,digest,href};
  }

  async reviewPackage(deliveryId: string, client: Pool|PoolClient = this.options.pool): Promise<ResearchDeliveryReviewPackage> {
    if (!UUID.test(deliveryId)) fail('VALIDATION', 'Research delivery id is invalid.');
    const result = await client.query(`SELECT delivery.*,intent.payload,project.slug AS project_slug,
        artifact.report AS report_status,artifact.report_digest,artifact.exact_score,artifact.exceeds_reference,
        assessment.request_digest AS assessment_request_digest,assessment.report_digest AS assessment_report_digest,
        assessment.assessment AS assessment_text,assessment.next_action,
        assessment.public_question,assessment.public_finding,assessment.created_at AS assessment_created_at,
        reproducibility.request_digest AS reproducibility_request_digest,
        reproducibility.solver_source_digest,reproducibility.trial_results_digest,
        operation.delivery_id,operation.operation,operation.target_hypothesis_id,operation.request_path,operation.idempotency_key,
        operation.request_body,operation.request_body_digest,operation.request_digest,
        manifest.manifest,manifest.manifest_bytes,manifest.manifest_digest
      FROM motive.hypothesis_submission_deliveries delivery
      JOIN motive.hypothesis_writeback_intents intent ON intent.id=delivery.source_intent_id
      JOIN motive.projects project ON project.id=delivery.project_id
      JOIN motive.project_research_scopes current_scope ON current_scope.id=delivery.scope_id
        AND current_scope.project_id=delivery.project_id AND current_scope.status='CONNECTED'
        AND current_scope.configuration_digest=delivery.scope_configuration_digest
        AND current_scope.api_base_url=delivery.engine_api_base_url AND current_scope.api_version=delivery.engine_api_version
      JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=delivery.source_submission_id
        AND artifact.project_id=delivery.project_id
      JOIN motive.participation_post_check_assessments assessment ON assessment.submission_id=delivery.source_submission_id
        AND assessment.project_id=delivery.project_id AND assessment.agent_token_id=artifact.agent_token_id
        AND assessment.report_digest=artifact.report_digest
      LEFT JOIN motive.participation_submission_reproducibility reproducibility
        ON reproducibility.submission_id=delivery.source_submission_id AND reproducibility.project_id=delivery.project_id
        AND reproducibility.agent_token_id=artifact.agent_token_id AND reproducibility.report_digest=artifact.report_digest
      JOIN motive.hypothesis_submission_delivery_operations operation ON operation.delivery_id=delivery.id
        AND operation.operation=CASE WHEN delivery.delivery_mode='APPEND_EXISTING' THEN 'NEUTRAL_EVIDENCE' ELSE 'DRAFT_HYPOTHESIS' END
      LEFT JOIN motive.research_delivery_observation_manifests manifest ON manifest.delivery_id=delivery.id
      WHERE delivery.id=$1`, [deliveryId]);
    if (result.rowCount !== 1) fail('NOT_FOUND', 'A prepared research delivery with an exact post-check assessment was not found.');
    const row = result.rows[0]; const delivery = deliveryProjection(row);
    if(!registeredReviewedWritebackContract({fileDigest:delivery.contractDigest,contractVersion:delivery.contractVersion,
      apiVersion:delivery.apiVersion,schemaRevision:'017_write_idempotency',surfaceDigest:delivery.contractSurfaceDigest,
      implementationDigest:delivery.implementationDigest}))
      fail('CONFLICT','Research admission requires the bundled reviewed Hypothesis contract.');
    if (digestCanonicalJson(delivery.payload) !== delivery.sourceIntentPayloadDigest) fail('CONFLICT', 'Prepared source payload digest is invalid.');
    const sourceMaterial = preparedDeliverySource({ id: delivery.sourceIntentId,
      disposition: 'PROPOSED_UNREVIEWED', state: 'ENGINE_WRITE_UNAVAILABLE', requestDigest: '',
      payloadDigest: delivery.sourceIntentPayloadDigest, payload: delivery.payload, createdAt: '', replayed: false });
    if (!sourceMaterial) fail('NOT_FOUND', 'Research admission requires immutable investigation notes.');
    if(delivery.mode==='APPEND_EXISTING'){
      const operation=operationProjection(row);
      if(!delivery.target||!delivery.targetBindingDigest||row.manifest===null||row.manifest===undefined)
        fail('CONFLICT','Append delivery is missing its immutable target or observation manifest.');
      const manifestBody=object(row.manifest),manifestBytes=row.manifest_bytes as Buffer,manifestDigest=rowText(row,'manifest_digest');
      const manifest:StoredObservationManifest={body:manifestBody,bytes:manifestBytes,digest:manifestDigest,
        href:`${PUBLIC_ORIGIN}/api/public/projects/${rowText(row,'project_slug')}/research-deliveries/${delivery.id}/observation`};
      if(Buffer.compare(Buffer.from(canonicalJson(manifestBody),'utf8'),manifestBytes)!==0||sha256Bytes(manifestBytes)!==manifestDigest)
        fail('CONFLICT','Append observation manifest bytes are invalid.');
      const expectedBody=buildAppendEvidenceBody(delivery,manifest),path=`/api/v1/hypotheses/${delivery.target.selection.hypothesisId}/evidence`;
      const expectedDigest=digestCanonicalJson({method:'POST',path,body:expectedBody});
      if(operation.operation!=='NEUTRAL_EVIDENCE'||operation.targetHypothesisId!==delivery.target.selection.hypothesisId
        ||operation.requestPath!==path||operation.bodyDigest!==digestCanonicalJson(expectedBody)
        ||operation.requestDigest!==expectedDigest||!equal(operation.body,expectedBody))
        fail('CONFLICT','Prepared append operation differs from its immutable source.');
      const reportStatus=rowText(row,'report_status');
      if(!['VALID','REJECTED','INCONCLUSIVE'].includes(reportStatus)||rowText(row,'report_digest')!==sourceMaterial.report.digest
        ||rowText(row,'assessment_report_digest')!==row.report_digest)fail('CONFLICT','Research admission report binding is invalid.');
      const reviewPackage:ResearchDeliveryReviewPackage={format:'motive.research-delivery-review-package/0.2',
        delivery:{id:delivery.id,projectId:delivery.projectId,scopeId:delivery.scopeId,sourceSubmissionId:delivery.submissionId,
          sourceIntentId:delivery.sourceIntentId,sourceIntentPayloadDigest:delivery.sourceIntentPayloadDigest,
          mode:'APPEND_EXISTING',target:delivery.target,targetBindingDigest:delivery.targetBindingDigest},
        scope:{configurationDigest:delivery.configurationDigest,apiBaseUrl:delivery.apiBaseUrl,apiVersion:delivery.apiVersion,engineActor:delivery.engineActor},
        report:{status:reportStatus as 'VALID'|'REJECTED'|'INCONCLUSIVE',digest:rowText(row,'report_digest'),
          exactScore:row.exact_score===null?null:String(row.exact_score),exceedsReference:row.exceeds_reference===null?null:row.exceeds_reference===true},
        postCheck:{requestDigest:rowText(row,'assessment_request_digest'),reportDigest:rowText(row,'assessment_report_digest'),
          assessment:rowText(row,'assessment_text'),nextAction:rowText(row,'next_action'),
          ...(row.public_question===null?{}:{publicSummary:{question:rowText(row,'public_question'),finding:rowText(row,'public_finding')}}),
          createdAt:dateText(row.assessment_created_at)},
        reproducibility:row.reproducibility_request_digest===null?null:{requestDigest:rowText(row,'reproducibility_request_digest'),
          solverSourceDigest:rowText(row,'solver_source_digest'),trialResultsDigest:rowText(row,'trial_results_digest')},
        contract:{fileDigest:delivery.contractDigest,contractVersion:delivery.contractVersion as ReviewedWritebackContract['contractVersion'],
          apiVersion:delivery.apiVersion as ReviewedWritebackContract['apiVersion'],schemaRevision:'017_write_idempotency',
          surfaceDigest:delivery.contractSurfaceDigest,implementationDigest:delivery.implementationDigest},
        assessment:{hypothesisSupport:'UNASSESSED',conclusionApproval:'UNASSESSED'},
        observationManifest:{href:manifest.href,digest:manifest.digest,body:manifest.body},
        operations:{neutralEvidence:{method:'POST',path,body:operation.body,bodyDigest:operation.bodyDigest,requestDigest:operation.requestDigest}}};
      if(Buffer.byteLength(canonicalJson(reviewPackage),'utf8')>131072)fail('CONFLICT','Research delivery review package exceeds the retained size limit.');
      return reviewPackage;
    }
    const draft = operationProjection(row); const expectedDraftBody = buildDraftBody(delivery,sourceMaterial,rowText(row,'project_slug'));
    const expectedDraftRequestDigest = digestCanonicalJson({method:'POST',path:'/api/v1/hypotheses',body:expectedDraftBody});
    if (draft.operation!=='DRAFT_HYPOTHESIS'||draft.targetHypothesisId!==null||draft.requestPath!=='/api/v1/hypotheses'
      ||draft.bodyDigest!==digestCanonicalJson(expectedDraftBody)||draft.requestDigest!==expectedDraftRequestDigest
      ||!equal(draft.body,expectedDraftBody)) fail('CONFLICT','Prepared draft operation differs from its immutable source.');
    const neutralBody = buildNeutralEvidenceBody(delivery,sourceMaterial,rowText(row,'project_slug'));
    const reportStatus=rowText(row,'report_status');
    if(!['VALID','REJECTED','INCONCLUSIVE'].includes(reportStatus)||rowText(row,'report_digest')!==sourceMaterial.report.digest
      ||rowText(row,'assessment_report_digest')!==row.report_digest) fail('CONFLICT','Research admission report binding is invalid.');
    const reviewPackage: ResearchDeliveryReviewPackage = {
      format:'motive.research-delivery-review-package/0.1',
      delivery:{id:delivery.id,projectId:delivery.projectId,scopeId:delivery.scopeId,sourceSubmissionId:delivery.submissionId,
        sourceIntentId:delivery.sourceIntentId,sourceIntentPayloadDigest:delivery.sourceIntentPayloadDigest},
      scope:{configurationDigest:delivery.configurationDigest,apiBaseUrl:delivery.apiBaseUrl,apiVersion:delivery.apiVersion,engineActor:delivery.engineActor},
      report:{status:reportStatus as ResearchDeliveryReviewPackage['report']['status'],digest:rowText(row,'report_digest'),
        exactScore:row.exact_score===null?null:String(row.exact_score),exceedsReference:row.exceeds_reference===null?null:row.exceeds_reference===true},
      postCheck:{requestDigest:rowText(row,'assessment_request_digest'),reportDigest:rowText(row,'assessment_report_digest'),
        assessment:rowText(row,'assessment_text'),nextAction:rowText(row,'next_action'),
        ...(row.public_question===null?{}:{publicSummary:{question:rowText(row,'public_question'),finding:rowText(row,'public_finding')}}),
        createdAt:dateText(row.assessment_created_at)},
      reproducibility:row.reproducibility_request_digest===null?null:{requestDigest:rowText(row,'reproducibility_request_digest'),
        solverSourceDigest:rowText(row,'solver_source_digest'),trialResultsDigest:rowText(row,'trial_results_digest')},
      contract:{fileDigest:delivery.contractDigest,contractVersion:delivery.contractVersion as ReviewedWritebackContract['contractVersion'],
        apiVersion:delivery.apiVersion as ReviewedWritebackContract['apiVersion'],schemaRevision:'017_write_idempotency',
        surfaceDigest:delivery.contractSurfaceDigest,implementationDigest:delivery.implementationDigest},
      assessment:{hypothesisSupport:'UNASSESSED',conclusionApproval:'UNASSESSED'},
      operations:{draft:{method:'POST',path:'/api/v1/hypotheses',body:draft.body,bodyDigest:draft.bodyDigest,requestDigest:draft.requestDigest},
        neutralEvidence:{method:'POST',pathTemplate:'/api/v1/hypotheses/{createdHypothesisId}/evidence',body:neutralBody,
          bodyDigest:digestCanonicalJson(neutralBody),requestTemplateDigest:digestCanonicalJson({method:'POST',
            pathTemplate:'/api/v1/hypotheses/{createdHypothesisId}/evidence',body:neutralBody})}},
    };
    if(Buffer.byteLength(canonicalJson(reviewPackage),'utf8')>131072)fail('CONFLICT','Research delivery review package exceeds the retained size limit.');
    return reviewPackage;
  }

  async publicObservationManifest(projectSlug:string,deliveryId:string):Promise<{digest:string;bytes:Buffer}>{
    if(!/^[a-z0-9][a-z0-9-]{0,127}$/.test(projectSlug)||!UUID.test(deliveryId))fail('NOT_FOUND','Observation manifest was not found.');
    const result=await this.options.pool.query(`SELECT manifest.manifest,manifest.manifest_bytes,manifest.manifest_digest
      FROM motive.research_delivery_observation_manifests manifest
      JOIN motive.hypothesis_submission_deliveries delivery ON delivery.id=manifest.delivery_id
        AND delivery.project_id=manifest.project_id AND delivery.source_submission_id=manifest.source_submission_id
      JOIN motive.projects project ON project.id=manifest.project_id AND project.visibility='PUBLIC'
      WHERE project.slug=$1 AND delivery.id=$2`,[projectSlug,deliveryId]);
    if(result.rowCount!==1)fail('NOT_FOUND','Observation manifest was not found.');
    const body=object(result.rows[0].manifest),bytes=result.rows[0].manifest_bytes as Buffer,digest=rowText(result.rows[0],'manifest_digest');
    if(Buffer.compare(Buffer.from(canonicalJson(body),'utf8'),bytes)!==0||sha256Bytes(bytes)!==digest)
      fail('CONFLICT','Observation manifest bytes are invalid.');
    return{digest,bytes:Buffer.from(bytes)};
  }

  async confirmedEvidenceContributions(projectId:string,scopeId:string,
    targets:readonly {hypothesisId:string;evidenceId:string}[]):Promise<Map<string,ResearchEvidenceMotiveContribution>>{
    const output=new Map<string,ResearchEvidenceMotiveContribution>();
    if(!UUID.test(projectId)||!UUID.test(scopeId)||!Array.isArray(targets)||targets.length>96
      ||targets.some(item=>!item||!UUID.test(item.hypothesisId)||!UUID.test(item.evidenceId)))return output;
    const requested=new Map(targets.map(item=>[item.evidenceId,item.hypothesisId]));
    if(requested.size!==targets.length)return output;
    const result=await this.options.pool.query(`SELECT delivery.*,intent.payload,project.slug AS project_slug,operation.request_body,
        operation.target_hypothesis_id,result.resource_id,result.response_body,result.response_digest,
        manifest.manifest,manifest.manifest_digest,artifact.report_digest,token.id AS agent_token_id,token.agent_name
      FROM motive.hypothesis_submission_delivery_results result
      JOIN motive.hypothesis_submission_delivery_operations operation ON operation.delivery_id=result.delivery_id
        AND operation.operation=result.operation AND operation.operation='NEUTRAL_EVIDENCE'
      JOIN motive.hypothesis_submission_deliveries delivery ON delivery.id=result.delivery_id
        AND delivery.delivery_mode='APPEND_EXISTING'
      JOIN motive.hypothesis_writeback_intents intent ON intent.id=delivery.source_intent_id
        AND intent.payload_digest=delivery.source_intent_payload_digest
      JOIN motive.research_delivery_observation_manifests manifest ON manifest.delivery_id=delivery.id
      JOIN motive.projects project ON project.id=delivery.project_id AND project.visibility='PUBLIC'
      JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=delivery.source_submission_id
        AND artifact.project_id=delivery.project_id
      JOIN motive.participation_agent_tokens token ON token.id=artifact.agent_token_id AND token.project_id=delivery.project_id
      WHERE delivery.project_id=$1 AND delivery.scope_id=$2 AND result.resource_id=ANY($3::uuid[])`,
    [projectId,scopeId,[...requested.keys()]]);
    for(const row of result.rows){try{const delivery=deliveryProjection({...row,payload:row.payload}),body=object(row.request_body),
        response=object(row.response_body),evidence=object(response.evidence),manifest=object(row.manifest);
      const hypothesis=object(response.hypothesis),evidenceId=rowText(row,'resource_id'),hypothesisId=rowText(row,'target_hypothesis_id');
      if(requested.get(evidenceId)!==hypothesisId||!delivery.target||delivery.target.selection.hypothesisId!==hypothesisId
        ||evidence.id!==evidenceId||evidence.hypothesis_id!==hypothesisId||evidence.content!==body.content
        ||evidence.source!==body.source||evidence.created_by!==body.created_by||evidence.evidence_type!=='neutral'
        ||hypothesis.id!==hypothesisId
        ||rowText(row,'response_digest')!==digestCanonicalJson(response)||rowText(row,'manifest_digest')!==digestCanonicalJson(manifest))continue;
      const source=object(manifest.source),links=object(source.links),contributor=object(source.originalContributor),
        observed=manifest.observedFinding===null?null:object(manifest.observedFinding),labels=object(manifest.labels);
      const item:ResearchEvidenceMotiveContribution={format:'motive.research-evidence-contribution/0.1',deliveryId:delivery.id,
        mode:'APPEND_EXISTING',sourceSubmissionId:delivery.submissionId,reportDigest:rowText(row,'report_digest'),
        reportHref:text(links.report),investigationHref:text(links.investigation),postCheckAssessmentHref:text(links.postCheckAssessment),
        reproducibilityHref:links.reproducibility===null?null:text(links.reproducibility),
        observationManifestHref:`${PUBLIC_ORIGIN}/api/public/projects/${rowText(row,'project_slug')}/research-deliveries/${delivery.id}/observation`,
        observationManifestDigest:rowText(row,'manifest_digest'),originalContributor:{
          agentTokenId:text(contributor.agentTokenId),agentName:text(contributor.agentName)},target:delivery.target,
        observedFinding:observed===null?null:{decisionId:text(observed.decisionId),packageDigest:text(observed.packageDigest),
          outcome:text(observed.outcome) as 'SUPPORTED'|'CONTRADICTED'|'INCONCLUSIVE',finding:text(observed.finding),
          limitations:text(observed.limitations),novelty:text(observed.novelty) as 'DISTINCT'|'DUPLICATE',
          duplicateOfSubmissionId:observed.duplicateOfSubmissionId===null?null:text(observed.duplicateOfSubmissionId),
          rationale:text(observed.rationale),reviewerKind:observed.reviewerKind as 'ACCOUNT'|'AGENT',
          reviewerAgentTokenId:observed.reviewerAgentTokenId===null?null:text(observed.reviewerAgentTokenId),
          reviewSubmissionId:observed.reviewSubmissionId===null?null:text(observed.reviewSubmissionId),reviewedAt:text(observed.reviewedAt),
          observedAt:text(observed.observedAt),disposition:'HISTORICAL_MOTIVE_DECISION'},
        evidenceBinding:{hypothesisId,evidenceId,contentDigest:sha256Bytes(text(body.content)),source:text(body.source),
          createdBy:text(body.created_by),evidenceType:'neutral',responseDigest:rowText(row,'response_digest')},
        labels:{evidence:labels.evidence as 'NEUTRAL',context:labels.context as 'HISTORICAL_TESTED_CONTEXT',
          hypothesisSupport:labels.hypothesisSupport as 'UNASSESSED',conclusionApproval:labels.conclusionApproval as 'UNASSESSED'}};
      output.set(evidenceId,item);}catch{continue;}}
    return output;
  }

  async sync(actorId: string, raw: SyncSubmissionResearchInput): Promise<SubmissionResearchDeliveryResult> {
    if (!ACCOUNT.test(actorId)) fail('UNAUTHORIZED', 'A current active account is required.');
    return this.syncPrincipal(actorId, raw, false, false);
  }

  async syncWithPolicyPrincipal(policyId: string, raw: SyncSubmissionResearchInput): Promise<SubmissionResearchDeliveryResult> {
    if (!UUID.test(policyId)) fail('VALIDATION', 'Research delivery policy id is invalid.');
    return this.syncPrincipal(`policy:${policyId}`, raw, true, false);
  }

  /** Internal admission-preview preparation. This path cannot decrypt credentials or dispatch engine requests. */
  async prepareForReview(actorId: string, raw: SyncSubmissionResearchInput): Promise<SubmissionResearchDeliveryResult> {
    const input = normalizedInput(raw);
    if (input.execute) fail('VALIDATION', 'Review preparation cannot execute an engine operation.');
    return this.syncPrincipal(actorId, input, false, true);
  }

  private async syncPrincipal(actorId: string, raw: SyncSubmissionResearchInput, oneEngineOperation: boolean,
    reviewPreparation: boolean): Promise<SubmissionResearchDeliveryResult> {
    const input = normalizedInput(raw);
    const intentInput = { projectSlug: input.projectSlug, scopeId: input.scopeId,
      submissionId: input.submissionId, idempotencyKey: input.idempotencyKey };
    const intent = reviewPreparation
      ? await this.intent.prepareForReview(actorId, intentInput)
      : await this.intent.prepare(actorId, intentInput);
    const firstSource = preparedDeliverySource(intent);
    if (!firstSource) return output('UNAVAILABLE', intent, { reason: 'INVESTIGATION_REQUIRED' });
    const delivery = await this.ensureDelivery(actorId, input, intent, reviewPreparation);
    const sourceMaterial = preparedDeliverySource({ ...intent, id: delivery.sourceIntentId, payloadDigest: delivery.sourceIntentPayloadDigest,
      payload: delivery.payload });
    if (!sourceMaterial) fail('CONFLICT', 'Winning delivery source does not contain investigation notes.');
    if(delivery.mode==='APPEND_EXISTING'){
      if(!delivery.target)fail('CONFLICT','Append delivery target is missing.');
      const client=await this.options.pool.connect();let manifest!:StoredObservationManifest;
      try{await client.query('BEGIN');manifest=await this.ensureObservationManifest(delivery,sourceMaterial,input.projectSlug,client);
        await client.query('COMMIT');}catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}finally{client.release();}
      const hypothesisId=delivery.target.selection.hypothesisId,evidencePath=`/api/v1/hypotheses/${hypothesisId}/evidence`;
      const evidence=await this.ensureOperation(actorId,delivery,'NEUTRAL_EVIDENCE',hypothesisId,evidencePath,
        buildAppendEvidenceBody(delivery,manifest),reviewPreparation);
      let evidenceResult=await this.result(delivery.id,'NEUTRAL_EVIDENCE');
      if(!evidenceResult){
        if(!input.execute)return output('PENDING',intent,{deliveryId:delivery.id,sourceIntentId:delivery.sourceIntentId,
          sourceIntentPayloadDigest:delivery.sourceIntentPayloadDigest,hypothesisId,evidenceRequestDigest:evidence.requestDigest,
          pendingOperation:'NEUTRAL_EVIDENCE',reason:'EXECUTION_NOT_REQUESTED'});
        let attempt:JsonObject|null;
        try{attempt=await this.post(actorId,delivery,evidence);}catch(error){
          if(!(error instanceof ReceiverTargetConflict))throw error;
          await this.recordTargetConflict(delivery,evidence);
          return output('PENDING',intent,{deliveryId:delivery.id,sourceIntentId:delivery.sourceIntentId,
            sourceIntentPayloadDigest:delivery.sourceIntentPayloadDigest,hypothesisId,evidenceRequestDigest:evidence.requestDigest,
            pendingOperation:'NEUTRAL_EVIDENCE',reason:'TARGET_PRECONDITION_CONFLICT'});
        }
        if(!attempt)return output('PENDING',intent,{deliveryId:delivery.id,sourceIntentId:delivery.sourceIntentId,
          sourceIntentPayloadDigest:delivery.sourceIntentPayloadDigest,hypothesisId,evidenceRequestDigest:evidence.requestDigest,
          pendingOperation:'NEUTRAL_EVIDENCE',reason:'ENGINE_ATTEMPT_UNCONFIRMED'});
        const evidenceId=this.validateEvidenceResponse(delivery,evidence,null,attempt);
        evidenceResult=await this.persistResult(actorId,delivery,evidence,evidenceId,attempt);
      }else this.validateEvidenceResponse(delivery,evidence,null,evidenceResult.response);
      return output('EVIDENCE_RECORDED',intent,{deliveryId:delivery.id,sourceIntentId:delivery.sourceIntentId,
        sourceIntentPayloadDigest:delivery.sourceIntentPayloadDigest,hypothesisId,evidenceRequestDigest:evidence.requestDigest,
        evidenceId:evidenceResult.resourceId});
    }
    const draft = await this.ensureOperation(actorId, delivery, 'DRAFT_HYPOTHESIS', null,
      '/api/v1/hypotheses', buildDraftBody(delivery, sourceMaterial, input.projectSlug), reviewPreparation);
    let draftResult = await this.result(delivery.id, 'DRAFT_HYPOTHESIS');
    if (!draftResult) {
      if (!input.execute) return output('PENDING', intent, { deliveryId: delivery.id, sourceIntentId: delivery.sourceIntentId,
        sourceIntentPayloadDigest: delivery.sourceIntentPayloadDigest, draftRequestDigest: draft.requestDigest,
        pendingOperation: 'DRAFT_HYPOTHESIS', reason: 'EXECUTION_NOT_REQUESTED' });
      const attempt = await this.post(actorId, delivery, draft);
      if (!attempt) return output('PENDING', intent, { deliveryId: delivery.id, sourceIntentId: delivery.sourceIntentId,
        sourceIntentPayloadDigest: delivery.sourceIntentPayloadDigest, draftRequestDigest: draft.requestDigest,
        pendingOperation: 'DRAFT_HYPOTHESIS', reason: 'ENGINE_ATTEMPT_UNCONFIRMED' });
      const hypothesisId = this.validateDraftResponse(delivery, draft, attempt);
      draftResult = await this.persistResult(actorId, delivery, draft, hypothesisId, attempt);
      if (oneEngineOperation) return output('DRAFT_RECORDED', intent, { deliveryId: delivery.id,
        sourceIntentId: delivery.sourceIntentId, sourceIntentPayloadDigest: delivery.sourceIntentPayloadDigest,
        draftRequestDigest: draft.requestDigest, hypothesisId, pendingOperation: 'NEUTRAL_EVIDENCE',
        reason: 'NEXT_OPERATION_REQUIRES_RETRY' });
    } else {
      this.validateDraftResponse(delivery, draft, draftResult.response);
    }
    const hypothesisId = draftResult.resourceId;
    const evidencePath = `/api/v1/hypotheses/${hypothesisId}/evidence`;
    const evidence = await this.ensureOperation(actorId, delivery, 'NEUTRAL_EVIDENCE', hypothesisId, evidencePath,
      buildNeutralEvidenceBody(delivery, sourceMaterial, input.projectSlug), reviewPreparation);
    let evidenceResult = await this.result(delivery.id, 'NEUTRAL_EVIDENCE');
    if (!evidenceResult) {
      if (!input.execute) return output('DRAFT_RECORDED', intent, { deliveryId: delivery.id, sourceIntentId: delivery.sourceIntentId,
        sourceIntentPayloadDigest: delivery.sourceIntentPayloadDigest, draftRequestDigest: draft.requestDigest, hypothesisId,
        evidenceRequestDigest: evidence.requestDigest, pendingOperation: 'NEUTRAL_EVIDENCE', reason: 'EXECUTION_NOT_REQUESTED' });
      const attempt = await this.post(actorId, delivery, evidence);
      if (!attempt) return output('DRAFT_RECORDED', intent, { deliveryId: delivery.id, sourceIntentId: delivery.sourceIntentId,
        sourceIntentPayloadDigest: delivery.sourceIntentPayloadDigest, draftRequestDigest: draft.requestDigest, hypothesisId,
        evidenceRequestDigest: evidence.requestDigest, pendingOperation: 'NEUTRAL_EVIDENCE', reason: 'ENGINE_ATTEMPT_UNCONFIRMED' });
      const evidenceId = this.validateEvidenceResponse(delivery, evidence, draftResult.response, attempt);
      evidenceResult = await this.persistResult(actorId, delivery, evidence, evidenceId, attempt);
    } else {
      this.validateEvidenceResponse(delivery, evidence, draftResult.response, evidenceResult.response);
    }
    return output('EVIDENCE_RECORDED', intent, { deliveryId: delivery.id, sourceIntentId: delivery.sourceIntentId,
      sourceIntentPayloadDigest: delivery.sourceIntentPayloadDigest, draftRequestDigest: draft.requestDigest, hypothesisId,
      evidenceRequestDigest: evidence.requestDigest, evidenceId: evidenceResult.resourceId });
  }

  private async ensureDelivery(actorId: string, input: SyncSubmissionResearchInput, intent: PreparedDeliveryIntent,
    reviewPreparation = false): Promise<Delivery> {
    const policyId = policyIdFromPrincipal(actorId);
    if ((!ACCOUNT.test(actorId) && !policyId) || (ACCOUNT.test(actorId) && !await this.options.isActorActive(actorId))) {
      fail('UNAUTHORIZED', 'A current active account is required.');
    }
    if(policyId){const approver=await currentPolicyApprover(this.options.pool,policyId);
      if(!approver||!await this.options.isActorActive(approver))fail('FORBIDDEN','Current research delivery policy authority is unavailable.');}
    const payload = object(intent.payload); const scope = object(payload.scope); const engineActor = text(object(payload.attribution).engineActor);
    const target=payload.researchDeliveryTarget===undefined?null:object(payload.researchDeliveryTarget) as ResearchDeliveryTargetBinding;
    const mode:ResearchDeliveryMode=target?'APPEND_EXISTING':'NEW_DRAFT';
    const targetBindingDigest=target?digestCanonicalJson(target):null;
    if (scope.scopeId !== input.scopeId || scope.configurationDigest === undefined || scope.apiVersion !== input.contract.apiVersion
      || scope.projectId === undefined || engineActor !== `motive:project:${scope.projectId}`) fail('CONFLICT', 'Prepared source scope binding is invalid.');
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      let projectId: string;
      if (policyId) {
        const authority = await currentPolicyAuthority(client, policyId, { projectSlug: input.projectSlug,
          scopeId: input.scopeId, submissionId: input.submissionId, apiBaseUrl: input.approvedApiBaseUrl,
          configurationDigest: String(scope.configurationDigest), apiVersion: input.contract.apiVersion,
          contractDigest: input.contract.fileDigest, contractVersion: input.contract.contractVersion,
          contractSurfaceDigest: input.contract.surfaceDigest, implementationDigest: input.contract.implementationDigest,
          deliveryMode:mode });
        if (!authority) {
          fail('FORBIDDEN', 'Current research delivery policy authority is unavailable.');
        }
        projectId = authority.projectId;
      } else {
        const roles = reviewPreparation ? "('OWNER','STEWARD','REVIEWER')" : "('OWNER','STEWARD')";
        const current = await client.query(`SELECT project.id,scope.api_base_url,scope.configuration_digest,scope.api_version
          FROM motive.projects project JOIN motive.memberships membership ON membership.project_id=project.id
          JOIN motive.project_research_scopes scope ON scope.project_id=project.id
          WHERE project.slug=$1 AND membership.actor_id=$2 AND membership.revoked_at IS NULL
            AND membership.role IN ${roles} AND scope.id=$3 AND scope.status='CONNECTED'
          FOR KEY SHARE OF project,membership,scope`, [input.projectSlug, actorId, input.scopeId]);
        if (current.rowCount !== 1) fail('FORBIDDEN', 'A current project owner or steward and connected scope are required.');
        const row = current.rows[0]; projectId = rowText(row, 'id');
        if (projectId !== scope.projectId || normalizedApiBase(rowText(row, 'api_base_url')) !== input.approvedApiBaseUrl
          || rowText(row, 'configuration_digest') !== scope.configurationDigest || rowText(row, 'api_version') !== input.contract.apiVersion) {
          fail('CONFLICT', 'Current research scope differs from the frozen source or reviewed API approval.');
        }
      }
      if (projectId !== scope.projectId) fail('CONFLICT', 'Prepared source project binding is invalid.');
      const id = randomUUID();
      const inserted = await client.query(`INSERT INTO motive.hypothesis_submission_deliveries
        (id,project_id,scope_id,source_submission_id,source_intent_id,source_intent_payload_digest,engine_actor,
         engine_api_base_url,scope_configuration_digest,engine_api_version,reviewed_contract_digest,
         reviewed_contract_version,reviewed_contract_surface_digest,reviewed_implementation_digest,created_by_actor_id,
         delivery_mode,target_binding,target_binding_digest)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18)
        ON CONFLICT(scope_id,source_submission_id) DO NOTHING RETURNING id`,
      [id,projectId,input.scopeId,input.submissionId,intent.id,intent.payloadDigest,engineActor,input.approvedApiBaseUrl,
        scope.configurationDigest,input.contract.apiVersion,input.contract.fileDigest,input.contract.contractVersion,
        input.contract.surfaceDigest,input.contract.implementationDigest,actorId,mode,target?JSON.stringify(target):null,targetBindingDigest]);
      const saved = await client.query(`SELECT delivery.*,intent.payload FROM motive.hypothesis_submission_deliveries delivery
        JOIN motive.hypothesis_writeback_intents intent ON intent.id=delivery.source_intent_id
        WHERE delivery.scope_id=$1 AND delivery.source_submission_id=$2 FOR UPDATE OF delivery`, [input.scopeId,input.submissionId]);
      if (saved.rowCount !== 1) fail('CONFLICT', 'Durable delivery identity could not be retained.');
      const delivery = deliveryProjection(saved.rows[0]);
      if (delivery.projectId !== projectId || delivery.apiBaseUrl !== input.approvedApiBaseUrl
        || delivery.configurationDigest !== scope.configurationDigest || delivery.apiVersion !== input.contract.apiVersion
        || rowText(saved.rows[0], 'reviewed_contract_digest') !== input.contract.fileDigest
        || rowText(saved.rows[0], 'reviewed_contract_version') !== input.contract.contractVersion
        || rowText(saved.rows[0], 'reviewed_contract_surface_digest') !== input.contract.surfaceDigest
        || rowText(saved.rows[0], 'reviewed_implementation_digest') !== input.contract.implementationDigest
        || delivery.mode!==mode||delivery.targetBindingDigest!==targetBindingDigest||!equal(delivery.target,target)
        || digestCanonicalJson(delivery.payload) !== delivery.sourceIntentPayloadDigest) {
        fail('CONFLICT', 'Existing delivery is bound to different immutable source or reviewed contract data.');
      }
      await client.query('COMMIT'); return delivery;
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  private async ensureOperation(actorId: string, delivery: Delivery, operation: OperationName, targetHypothesisId: string | null,
    requestPath: string, body: JsonObject, reviewPreparation = false): Promise<StoredOperation> {
    await this.authorize(actorId, delivery, false, reviewPreparation);
    const bodyDigest = digestCanonicalJson(body); const requestDigest = digestCanonicalJson({ method: 'POST', path: requestPath, body });
    const idempotencyKey = `motive-delivery:${delivery.id}:${operation === 'DRAFT_HYPOTHESIS' ? 'draft' : 'evidence'}`;
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO motive.hypothesis_submission_delivery_operations
        (delivery_id,operation,target_hypothesis_id,request_path,idempotency_key,request_body,request_body_digest,request_digest)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) ON CONFLICT DO NOTHING`,
      [delivery.id,operation,targetHypothesisId,requestPath,idempotencyKey,JSON.stringify(body),bodyDigest,requestDigest]);
      const saved = await client.query(`SELECT * FROM motive.hypothesis_submission_delivery_operations
        WHERE delivery_id=$1 AND operation=$2 FOR UPDATE`, [delivery.id,operation]);
      if (saved.rowCount !== 1) fail('CONFLICT', 'Durable engine operation could not be retained.');
      const retained = operationProjection(saved.rows[0]);
      if (retained.targetHypothesisId !== targetHypothesisId || retained.requestPath !== requestPath
        || retained.idempotencyKey !== idempotencyKey || retained.bodyDigest !== bodyDigest || retained.requestDigest !== requestDigest
        || !equal(retained.body, body)) fail('CONFLICT', 'Existing engine operation is bound to a changed request.');
      await client.query('COMMIT'); return retained;
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  private async result(deliveryId: string, operation: OperationName): Promise<StoredResult | null> {
    const result = await this.options.pool.query(`SELECT * FROM motive.hypothesis_submission_delivery_results
      WHERE delivery_id=$1 AND operation=$2`, [deliveryId,operation]);
    return result.rowCount === 1 ? resultProjection(result.rows[0]) : null;
  }

  private async recordTargetConflict(delivery:Delivery,operation:StoredOperation):Promise<void>{
    await this.options.pool.query(`INSERT INTO motive.research_delivery_operation_blocks
      (delivery_id,operation,request_digest,reason,http_status)
      VALUES($1,$2,$3,'TARGET_PRECONDITION_CONFLICT',409) ON CONFLICT(delivery_id,operation) DO NOTHING`,
    [delivery.id,operation.operation,operation.requestDigest]);
  }

  private async authorize(actorId: string, delivery: Delivery, includeSecret: boolean, reviewPreparation = false): Promise<string | null> {
    if (reviewPreparation && includeSecret) fail('FORBIDDEN', 'Review preparation cannot access an engine credential.');
    const policyId = policyIdFromPrincipal(actorId);
    if ((!ACCOUNT.test(actorId) && !policyId) || (ACCOUNT.test(actorId) && !await this.options.isActorActive(actorId))) {
      fail('UNAUTHORIZED', 'A current active account is required.');
    }
    if(policyId){const approver=await currentPolicyApprover(this.options.pool,policyId);
      if(!approver||!await this.options.isActorActive(approver))fail('FORBIDDEN','Current research delivery policy authority is unavailable.');}
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      let encryptedApiKey: Buffer;
      if (policyId) {
        const authority = await currentPolicyAuthority(client, policyId, { projectId: delivery.projectId,
          scopeId: delivery.scopeId, submissionId: delivery.submissionId, apiBaseUrl: delivery.apiBaseUrl,
          configurationDigest: delivery.configurationDigest, apiVersion: delivery.apiVersion,
          contractDigest: delivery.contractDigest, contractVersion: delivery.contractVersion,
          contractSurfaceDigest: delivery.contractSurfaceDigest, implementationDigest: delivery.implementationDigest,
          deliveryMode:delivery.mode });
        if (!authority) {
          fail('FORBIDDEN', 'Current research delivery policy authority is unavailable.');
        }
        encryptedApiKey = authority.encryptedApiKey;
      } else {
        const roles = reviewPreparation ? "('OWNER','STEWARD','REVIEWER')" : "('OWNER','STEWARD')";
        const current = await client.query(`SELECT scope.encrypted_api_key FROM motive.hypothesis_submission_deliveries delivery
          JOIN motive.projects project ON project.id=delivery.project_id
          JOIN motive.memberships membership ON membership.project_id=project.id
          JOIN motive.project_research_scopes scope ON scope.id=delivery.scope_id AND scope.project_id=delivery.project_id
          WHERE delivery.id=$1 AND membership.actor_id=$2 AND membership.revoked_at IS NULL
            AND membership.role IN ${roles} AND scope.status='CONNECTED'
            AND scope.configuration_digest=delivery.scope_configuration_digest
            AND scope.api_version=delivery.engine_api_version AND scope.api_base_url=delivery.engine_api_base_url
          FOR SHARE OF delivery,project,membership,scope`, [delivery.id,actorId]);
        if (current.rowCount !== 1) fail('FORBIDDEN', 'Current delivery authority or research scope is unavailable.');
        encryptedApiKey = current.rows[0].encrypted_api_key as Buffer;
      }
      const secret = includeSecret ? decryptSecret(this.options.vaultKey, encryptedApiKey,
        `research-scope:v1:${delivery.scopeId}:${delivery.projectId}`) : null;
      if (includeSecret && (!secret || secret.length > 16_384)) fail('CONFLICT', 'Connected research credential is invalid.');
      await client.query('COMMIT'); return secret;
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  private async post(actorId: string, delivery: Delivery, operation: StoredOperation): Promise<JsonObject | null> {
    const policyId=policyIdFromPrincipal(actorId);
    const externalPrincipal=policyId?await currentPolicyApprover(this.options.pool,policyId):actorId;
    if(!externalPrincipal||!await this.options.isActorActive(externalPrincipal))fail('FORBIDDEN','Current delivery authority is unavailable.');
    const preAdmission=await this.options.pool.query(`SELECT item.reviewer_actor_id,item.finding_decision_id,token.owner_actor_id
      FROM motive.hypothesis_submission_delivery_admission_decisions item
      JOIN motive.hypothesis_submission_deliveries delivery ON delivery.id=item.delivery_id
      JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=delivery.source_submission_id
      JOIN motive.participation_agent_tokens token ON token.id=artifact.agent_token_id
      WHERE item.delivery_id=$1 AND NOT EXISTS(SELECT 1 FROM motive.hypothesis_submission_delivery_admission_decisions successor
        WHERE successor.previous_decision_id=item.id)`,[delivery.id]);
    if(preAdmission.rowCount!==1||!await this.options.isActorActive(String(preAdmission.rows[0].reviewer_actor_id))
      ||!await this.options.isActorActive(String(preAdmission.rows[0].owner_actor_id)))
      fail('FORBIDDEN','A current independent admission is required before engine delivery.');
    const externallyCurrentReviewer=String(preAdmission.rows[0].reviewer_actor_id);
    const externallyCurrentContributor=String(preAdmission.rows[0].owner_actor_id);
    const client=await this.options.pool.connect();
    let transaction=true;
    try {await client.query('BEGIN');await client.query(`SET LOCAL lock_timeout='5s'`);
      // Token is first: reproducibility append takes this row FOR UPDATE before inserting.
      const source=await client.query(`SELECT token.owner_actor_id FROM motive.hypothesis_submission_deliveries delivery
        JOIN motive.participation_submission_artifacts artifact ON artifact.submission_id=delivery.source_submission_id
          AND artifact.project_id=delivery.project_id
        JOIN motive.participation_agent_tokens token ON token.id=artifact.agent_token_id AND token.project_id=delivery.project_id
        JOIN motive.memberships contributor_membership ON contributor_membership.project_id=delivery.project_id
          AND contributor_membership.actor_id=token.owner_actor_id AND contributor_membership.revoked_at IS NULL
        JOIN motive.account_identities contributor ON contributor.actor_id=token.owner_actor_id AND contributor.status='ACTIVE'
        WHERE delivery.id=$1 AND token.revoked_at IS NULL AND token.expires_at>clock_timestamp()
        FOR SHARE OF token,contributor_membership,contributor`,[delivery.id]);
      if(source.rowCount!==1||source.rows[0].owner_actor_id!==externallyCurrentContributor)fail('FORBIDDEN','Current original contributor authority is unavailable.');
      const locked=await client.query(`SELECT * FROM motive.hypothesis_submission_deliveries WHERE id=$1 FOR UPDATE`,[delivery.id]);
      if(locked.rowCount!==1)fail('NOT_FOUND','Research delivery was not found.');
      let encryptedApiKey:Buffer;
      if(policyId){
        // Lock the immutable policy first, then take a fresh snapshot of append-only revocations.
        const policyLock=await client.query(`SELECT id FROM motive.project_research_delivery_policies WHERE id=$1 FOR SHARE`,[policyId]);
        if(policyLock.rowCount!==1)fail('FORBIDDEN','Current research delivery policy authority is unavailable.');
        const authority=await currentPolicyAuthority(client,policyId,{projectId:delivery.projectId,scopeId:delivery.scopeId,
          submissionId:delivery.submissionId,apiBaseUrl:delivery.apiBaseUrl,configurationDigest:delivery.configurationDigest,
          apiVersion:delivery.apiVersion,contractDigest:delivery.contractDigest,contractVersion:delivery.contractVersion,
          contractSurfaceDigest:delivery.contractSurfaceDigest,implementationDigest:delivery.implementationDigest,
          deliveryMode:delivery.mode});
        if(!authority||authority.approvedByActorId!==externalPrincipal)fail('FORBIDDEN','Current research delivery policy authority is unavailable.');
        encryptedApiKey=authority.encryptedApiKey;
      }else{
        if(!ACCOUNT.test(actorId))fail('UNAUTHORIZED','A current active account is required.');
        const current=await client.query(`SELECT scope.encrypted_api_key FROM motive.memberships membership
          JOIN motive.account_identities identity ON identity.actor_id=membership.actor_id
          JOIN motive.project_research_scopes scope ON scope.project_id=membership.project_id
          WHERE membership.project_id=$1 AND membership.actor_id=$2 AND membership.revoked_at IS NULL
            AND membership.role IN ('OWNER','STEWARD') AND identity.status='ACTIVE' AND scope.id=$3 AND scope.status='CONNECTED'
            AND scope.configuration_digest=$4 AND scope.api_version=$5 AND scope.api_base_url=$6
          FOR SHARE OF membership,identity,scope`,[delivery.projectId,actorId,delivery.scopeId,delivery.configurationDigest,delivery.apiVersion,delivery.apiBaseUrl]);
        if(current.rowCount!==1)fail('FORBIDDEN','Current delivery authority or research scope is unavailable.');encryptedApiKey=current.rows[0].encrypted_api_key as Buffer;
      }
      const tail=await client.query(`SELECT item.* FROM motive.hypothesis_submission_delivery_admission_decisions item
        WHERE item.delivery_id=$1 AND NOT EXISTS(SELECT 1 FROM motive.hypothesis_submission_delivery_admission_decisions successor
          WHERE successor.previous_decision_id=item.id)`,[delivery.id]);
      if(tail.rowCount!==1||tail.rows[0].decision!=='ADMIT'||tail.rows[0].reviewer_actor_id!==externallyCurrentReviewer)fail('FORBIDDEN','A current independent admission is required before engine delivery.');
      const reviewPackage=await this.reviewPackage(delivery.id,client);
      if(digestCanonicalJson(reviewPackage)!==tail.rows[0].review_package_digest)fail('FORBIDDEN','The independent admission is stale.');
      let reviewerCurrent=false;
      if(tail.rows[0].finding_decision_id===null){
        const reviewer=await client.query(`SELECT membership.actor_id FROM motive.memberships membership
          JOIN motive.account_identities identity ON identity.actor_id=membership.actor_id
          WHERE membership.project_id=$1 AND membership.actor_id=$2 AND membership.revoked_at IS NULL
            AND membership.role IN ('OWNER','STEWARD','REVIEWER') AND identity.status='ACTIVE' FOR SHARE OF membership,identity`,
          [delivery.projectId,tail.rows[0].reviewer_actor_id]);
        reviewerCurrent=reviewer.rowCount===1;
      }else{
        const lockedReviewer=await client.query(`SELECT finding.id
          FROM motive.finding_review_decisions finding
          JOIN motive.participation_agent_tokens review_token ON review_token.id=finding.reviewer_agent_token_id
          JOIN motive.memberships membership ON membership.project_id=finding.project_id
            AND membership.actor_id=finding.reviewer_actor_id AND membership.revoked_at IS NULL
          JOIN motive.account_identities identity ON identity.actor_id=finding.reviewer_actor_id AND identity.status='ACTIVE'
          JOIN motive.participation_claim_completions source_completion ON source_completion.submission_id=finding.source_submission_id
          JOIN motive.participation_claim_completions review_completion ON review_completion.submission_id=finding.review_submission_id
          WHERE finding.id=$2 AND finding.reviewer_actor_id=$1
          FOR SHARE OF finding,review_token,membership,identity,source_completion,review_completion`,
        [tail.rows[0].reviewer_actor_id,tail.rows[0].finding_decision_id]);
        if(lockedReviewer.rowCount===1){
          const fresh=await client.query(`SELECT motive.valid_agent_memory_admission_proof($1,$2,$3) AS valid`,
            [tail.rows[0].reviewer_actor_id,tail.rows[0].finding_decision_id,delivery.id]);
          reviewerCurrent=fresh.rows[0]?.valid===true;
        }
      }
      if(!reviewerCurrent||tail.rows[0].reviewer_actor_id===source.rows[0].owner_actor_id)fail('FORBIDDEN','Current independent reviewer authority is unavailable.');
      const reviewed=operation.operation==='DRAFT_HYPOTHESIS'
        ?reviewPackage.format==='motive.research-delivery-review-package/0.1'?reviewPackage.operations.draft
          :fail('FORBIDDEN','Append admission cannot authorize a draft operation.')
        :reviewPackage.operations.neutralEvidence;
      if(operation.bodyDigest!==reviewed.bodyDigest||!equal(operation.body,reviewed.body)
        ||(operation.operation==='DRAFT_HYPOTHESIS'&&(reviewPackage.format!=='motive.research-delivery-review-package/0.1'
          ||operation.requestPath!==reviewPackage.operations.draft.path||operation.requestDigest!==reviewPackage.operations.draft.requestDigest))
        ||(operation.operation==='NEUTRAL_EVIDENCE'&&(reviewPackage.format==='motive.research-delivery-review-package/0.2'
          ?operation.requestPath!==reviewPackage.operations.neutralEvidence.path||operation.requestDigest!==reviewPackage.operations.neutralEvidence.requestDigest
          :operation.requestPath!==reviewPackage.operations.neutralEvidence.pathTemplate.replace('{createdHypothesisId}',operation.targetHypothesisId??''))))
        fail('FORBIDDEN','Engine operation differs from the independently reviewed package.');
      if(operation.operation==='NEUTRAL_EVIDENCE'){
        if(delivery.mode==='APPEND_EXISTING'){
          if(!delivery.target||operation.targetHypothesisId!==delivery.target.selection.hypothesisId)
            fail('FORBIDDEN','Neutral evidence target differs from the retained pre-test target.');
        }else{const draftResult=await client.query(`SELECT resource_id FROM motive.hypothesis_submission_delivery_results
            WHERE delivery_id=$1 AND operation='DRAFT_HYPOTHESIS'`,[delivery.id]);
          if(draftResult.rowCount!==1||String(draftResult.rows[0].resource_id)!==operation.targetHypothesisId)
            fail('FORBIDDEN','Neutral evidence target differs from the retained draft result.');}
      }
      const apiKey=decryptSecret(this.options.vaultKey,encryptedApiKey,`research-scope:v1:${delivery.scopeId}:${delivery.projectId}`);
      if(!apiKey||apiKey.length>16384)fail('CONFLICT','Connected research credential is invalid.');
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
      const response = await this.fetcher(`${delivery.apiBaseUrl}${operation.requestPath.replace(/^\/api\/v1/, '')}`, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-API-Key': apiKey,
          'Idempotency-Key': operation.idempotencyKey }, body: canonicalJson(operation.body),
      });
      if (response.status !== 201) {
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 409) throw new ReceiverTargetConflict();
        return null;
      }
      const bytes = await this.readBounded(response);
      try {const parsed=object(JSON.parse(bytes.toString('utf8')), 'Hypothesis returned an invalid create response.');await client.query('COMMIT');transaction=false;return parsed;}
      catch { return null; }
      } catch (error) { if (error instanceof SubmissionDeliveryError) throw error; return null; }
      finally { clearTimeout(timer); }
    } finally {if(transaction)await client.query('ROLLBACK').catch(()=>undefined);client.release();}
  }

  private async readBounded(response: Response): Promise<Buffer> {
    const contentLength = response.headers.get('content-length');
    if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > this.maxResponseBytes)) {
      await response.body?.cancel().catch(() => undefined); throw new Error('response bound');
    }
    if (!response.body) throw new Error('response body');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0; let complete = false;
    try {
      while (true) { const next = await reader.read(); if (next.done) { complete = true; break; } if (!next.value) continue;
        total += next.value.byteLength; if (total > this.maxResponseBytes) throw new Error('response bound'); chunks.push(next.value); }
    } finally { if (!complete) await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    return Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), total);
  }

  private validateDraftResponse(delivery: Delivery, operation: StoredOperation, response: JsonObject): string {
    const id = response.id; const body = operation.body;
    if (typeof id !== 'string' || !UUID.test(id) || response.statement !== body.statement || response.context !== body.context
      || response.status !== 'draft' || response.created_by !== delivery.engineActor || response.channel !== body.channel
      || !equal(response.experimental_design, body.experimental_design) || !equal(response.metadata, body.metadata)
      || response.confidence !== null || response.initial_confidence !== null
      || response.outcome !== null || response.is_archived !== false) fail('CONFLICT', 'Hypothesis draft response does not match the immutable request.');
    return id;
  }

  private validateEvidenceResponse(delivery: Delivery, operation: StoredOperation, draftResponse: JsonObject|null, response: JsonObject): string {
    const evidence = object(response.evidence, 'Hypothesis returned an invalid evidence response.');
    const hypothesis = object(response.hypothesis, 'Hypothesis returned an invalid evidence hypothesis response.');
    const evidenceId = evidence.id; const body = operation.body;
    if (typeof evidenceId !== 'string' || !UUID.test(evidenceId) || evidence.hypothesis_id !== operation.targetHypothesisId
      || evidence.content !== body.content || evidence.source !== body.source || evidence.evidence_type !== 'neutral'
      || evidence.created_by !== delivery.engineActor || hypothesis.id !== operation.targetHypothesisId
      || (delivery.mode==='NEW_DRAFT'&&(draftResponse===null||hypothesis.status !== 'draft'
        || hypothesis.confidence !== draftResponse.confidence
        || hypothesis.initial_confidence !== draftResponse.initial_confidence || hypothesis.outcome !== null))) {
      fail('CONFLICT', 'Neutral evidence response does not match the immutable request or preserve draft belief state.');
    }
    return evidenceId;
  }

  private async persistResult(actorId: string, delivery: Delivery, operation: StoredOperation,
    resourceId: string, response: JsonObject): Promise<StoredResult> {
    const responseDigest = digestCanonicalJson(response); const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO motive.hypothesis_submission_delivery_results
        (delivery_id,operation,resource_id,response_body,response_digest) VALUES($1,$2,$3,$4::jsonb,$5)
        ON CONFLICT(delivery_id,operation) DO NOTHING`, [delivery.id,operation.operation,resourceId,JSON.stringify(response),responseDigest]);
      const saved = await client.query(`SELECT * FROM motive.hypothesis_submission_delivery_results
        WHERE delivery_id=$1 AND operation=$2 FOR UPDATE`, [delivery.id,operation.operation]);
      if (saved.rowCount !== 1) fail('CONFLICT', 'Durable engine result could not be retained.');
      const retained = resultProjection(saved.rows[0]);
      if (retained.resourceId !== resourceId || retained.responseDigest !== responseDigest || !equal(retained.response,response)) {
        fail('CONFLICT', 'Engine replay returned a changed response for the immutable operation.');
      }
      await client.query('COMMIT'); return retained;
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }
}

export function createHypothesisSubmissionDeliveryService(options: SubmissionDeliveryOptions) {
  return new HypothesisSubmissionDeliveryService(options);
}
