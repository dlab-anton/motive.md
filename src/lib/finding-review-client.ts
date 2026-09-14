import type {
  FindingDeclaredReferences,
  FindingReviewDecisionResponse,
  FindingReviewEligibility,
  FindingReviewEvidenceReference,
  FindingReviewPackage,
  FindingReviewPreview,
  FindingReviewPrivateDecision,
  FindingReviewPublicDecision,
  FindingReviewPublicProjection,
} from './finding-assessment';
import { isPublicResearchSummary } from './research-summary';
import { isExperimentProtocol } from './experiment-protocol';
import { validateResearchDeliveryTargetBinding } from './research-delivery-target';

type JsonRecord = Record<string, unknown>;

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ACCOUNT = /^account:[A-Za-z0-9._~-]{1,480}$/;
const PUBLIC_ERROR = 'The finding review response could not be read. Please try again.';
const ELIGIBILITY_ERROR = 'Finding review eligibility could not be read. Please try again.';
const PREVIEW_ERROR = 'The finding review preview could not be read. Please try again.';
const DECISION_ERROR = 'The finding review decision could not be read. Please try again.';

function isRecord(value: unknown): value is JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exact(value: unknown, keys: readonly string[]): value is JsonRecord {
  return isRecord(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function isCanonicalExperimentProtocol(value: unknown): boolean {
  return isExperimentProtocol(value)
    && value.inputs.every((item, index) => index === 0 || value.inputs[index - 1]!.name < item.name);
}

function isDate(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function isText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximum && value.trim() === value;
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximum;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isJsonObject(value: unknown): value is JsonRecord {
  if (!isRecord(value)) return false;
  const seen = new WeakSet<object>();
  const visit = (item: unknown, depth: number): boolean => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return true;
    if (typeof item === 'number') return Number.isFinite(item);
    if (!item || typeof item !== 'object' || depth > 24 || seen.has(item)) return false;
    seen.add(item);
    try {
      if (Array.isArray(item)) {
        return item.length <= 10_000 && Object.keys(item).every(key => /^(?:0|[1-9]\d*)$/.test(key))
          && item.every(entry => visit(entry, depth + 1));
      }
      if (!isRecord(item) || Object.keys(item).length > 10_000) return false;
      return Object.values(item).every(entry => visit(entry, depth + 1));
    } finally {
      seen.delete(item);
    }
  };
  return visit(value, 0);
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((item, index) => sameJson(item, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index]
    && sameJson(left[key], right[key]));
}

function parse<T>(value: unknown, validator: (input: unknown) => boolean, message: string): T {
  try {
    if (validator(value)) return value as T;
  } catch {
    // A response object with hostile accessors is malformed too. Never expose its thrown value.
  }
  throw new Error(message);
}

function validResearchContext(value: unknown): boolean {
  return exact(value, ['scopeId', 'snapshotId', 'snapshotDigest'])
    && isUuid(value.scopeId) && isUuid(value.snapshotId) && isDigest(value.snapshotDigest);
}

function validResearchReference(value: unknown): boolean {
  return exact(value, ['scopeId', 'snapshotId', 'snapshotDigest', 'hypothesisId', 'observedUpdatedAt', 'evidenceIds'])
    && isUuid(value.scopeId) && isUuid(value.snapshotId) && isDigest(value.snapshotDigest)
    && isUuid(value.hypothesisId) && isDate(value.observedUpdatedAt)
    && Array.isArray(value.evidenceIds) && value.evidenceIds.length <= 20
    && new Set(value.evidenceIds).size === value.evidenceIds.length && value.evidenceIds.every(isUuid);
}

function validMotiveReference(value: unknown): boolean {
  return exact(value, ['submissionId', 'reportDigest', 'artifactDigest'])
    && isUuid(value.submissionId) && isDigest(value.reportDigest) && isDigest(value.artifactDigest);
}

function validTimed(value: unknown, kind: 'context' | 'research' | 'motive'): boolean {
  if (value === null) return true;
  if (!exact(value, ['timing', 'value'])
    || !['PRE_TEST_INTENT', 'SUBMISSION_NOTES'].includes(String(value.timing))) return false;
  if (kind === 'context') return validResearchContext(value.value);
  if (!Array.isArray(value.value) || value.value.length < 1 || value.value.length > 10) return false;
  return kind === 'research' ? value.value.every(validResearchReference) : value.value.every(validMotiveReference);
}

function validDeclared(value: unknown): value is FindingDeclaredReferences {
  return exact(value, ['researchContext', 'researchReferences', 'motiveReferences'])
    && validTimed(value.researchContext, 'context')
    && validTimed(value.researchReferences, 'research')
    && validTimed(value.motiveReferences, 'motive');
}

function validReproducibility(value: unknown): boolean {
  return value === null || exact(value, ['requestDigest', 'solverSourceDigest', 'trialResultsDigest'])
    && isDigest(value.requestDigest) && isDigest(value.solverSourceDigest) && isDigest(value.trialResultsDigest);
}

function validEvidence(value: unknown): value is FindingReviewEvidenceReference {
  if (!exact(value, ['artifactDigest', 'reportDigest', 'investigationDigest', 'postCheckRequestDigest',
    'reproducibility', 'declaredIntent', 'declared', 'engineEvidence'])) return false;
  return isDigest(value.artifactDigest) && isDigest(value.reportDigest) && isDigest(value.investigationDigest)
    && isDigest(value.postCheckRequestDigest) && validReproducibility(value.reproducibility)
    && validDeclaredIntent(value.declaredIntent) && validDeclared(value.declared)
    && (value.engineEvidence === null || exact(value.engineEvidence, ['id', 'responseDigest'])
      && isUuid(value.engineEvidence.id) && isDigest(value.engineEvidence.responseDigest));
}

function validHypothesisReference(value: unknown): boolean {
  return value === null || exact(value, ['id', 'statement', 'responseDigest'])
    && isUuid(value.id) && isText(value.statement, 2_000) && isDigest(value.responseDigest);
}

const PUBLIC_DECISION_KEYS = ['id', 'decision', 'outcome', 'finding', 'limitations', 'novelty',
  'duplicateOfSubmissionId', 'rationale', 'reviewedAt', 'packageDigest', 'evidence', 'hypothesis'] as const;
const PRIVATE_DECISION_KEYS = [...PUBLIC_DECISION_KEYS, 'reviewerActorId', 'previousDecisionId',
  'duplicateOfDecisionId'] as const;

function validDecision(
  value: unknown,
  submissionId: string,
  privateDecision: boolean,
  expectedKeys: readonly string[] = privateDecision ? PRIVATE_DECISION_KEYS : PUBLIC_DECISION_KEYS,
): boolean {
  const attributedKeys = [...expectedKeys, 'reviewerAgentTokenId', 'reviewSubmissionId'];
  if (!(exact(value, expectedKeys) || exact(value, attributedKeys))
    || (Object.hasOwn(value, 'reviewerAgentTokenId')
      && (!isUuid(value.reviewerAgentTokenId) || !isUuid(value.reviewSubmissionId) || value.reviewSubmissionId === submissionId))
    || !isUuid(value.id) || !['ACCEPT', 'DECLINE'].includes(String(value.decision))
    || !isText(value.rationale, 2_000) || !isDate(value.reviewedAt) || !isDigest(value.packageDigest)
    || !validEvidence(value.evidence)
    || !validHypothesisReference(value.hypothesis)
    || (value.evidence.engineEvidence === null) !== (value.hypothesis === null)) return false;

  if (privateDecision) {
    if (typeof value.reviewerActorId !== 'string' || !ACCOUNT.test(value.reviewerActorId)
      || !(value.previousDecisionId === null || isUuid(value.previousDecisionId))
      || value.previousDecisionId === value.id
      || !(value.duplicateOfDecisionId === null || isUuid(value.duplicateOfDecisionId))) return false;
  }

  if (value.decision === 'DECLINE') {
    return value.outcome === null && value.finding === null && value.limitations === null && value.novelty === null
      && value.duplicateOfSubmissionId === null && (!privateDecision || value.duplicateOfDecisionId === null);
  }
  if (!['SUPPORTED', 'CONTRADICTED', 'INCONCLUSIVE'].includes(String(value.outcome))
    || !isText(value.finding, 2_000) || !isText(value.limitations, 2_000)
    || !['DISTINCT', 'DUPLICATE'].includes(String(value.novelty))) return false;
  if (value.novelty === 'DISTINCT') {
    return value.duplicateOfSubmissionId === null && (!privateDecision || value.duplicateOfDecisionId === null);
  }
  return isUuid(value.duplicateOfSubmissionId) && value.duplicateOfSubmissionId !== submissionId
    && (!privateDecision || isUuid(value.duplicateOfDecisionId));
}

export function validFindingReviewPublicDecision(
  value: unknown,
  submissionId: string,
  expectedKeys: readonly string[] = PUBLIC_DECISION_KEYS,
): value is FindingReviewPublicDecision {
  return validDecision(value, submissionId, false, expectedKeys);
}

function validPublic(value: unknown, submissionId: string): boolean {
  if (!isUuid(submissionId) || !exact(value, ['format', 'submissionId', 'available', 'reason', 'latestDecision'])
    || value.format !== 'motive.finding-review.public/0.1' || value.submissionId !== submissionId
    || typeof value.available !== 'boolean') return false;
  if (value.available ? value.reason !== null : !isText(value.reason, 200)) return false;
  return value.latestDecision === null || validFindingReviewPublicDecision(value.latestDecision, submissionId);
}

const ELIGIBILITY_REASONS = ['ELIGIBLE', 'NOT_FOUND', 'ACCOUNT_INACTIVE', 'MEMBERSHIP_REQUIRED',
  'ORIGINAL_CONTRIBUTOR', 'NOT_COMPLETED', 'POST_CHECK_REQUIRED', 'COMPLETE_DELIVERY_REQUIRED'] as const;

function validEligibility(value: unknown, submissionId: string): boolean {
  return isUuid(submissionId) && exact(value, ['format', 'submissionId', 'canReview', 'reason'])
    && value.format === 'motive.finding-review.eligibility/0.1' && value.submissionId === submissionId
    && typeof value.canReview === 'boolean' && ELIGIBILITY_REASONS.includes(value.reason as never)
    && value.canReview === (value.reason === 'ELIGIBLE');
}

function validInvestigation(value: unknown): boolean {
  return exact(value, ['proposal', 'expectation', 'conditions', 'observations', 'assessment', 'nextAction', 'digest'])
    && isText(value.proposal, 2_000) && isText(value.expectation, 1_000)
    && Array.isArray(value.conditions) && value.conditions.length >= 1 && value.conditions.length <= 12
    && value.conditions.every(item => isText(item, 500))
    && Array.isArray(value.observations) && value.observations.length >= 1 && value.observations.length <= 20
    && value.observations.every(item => isText(item, 1_000))
    && isText(value.assessment, 2_000) && isText(value.nextAction, 1_000) && isDigest(value.digest);
}

function validDeclaredIntent(value: unknown): boolean {
  if (value === null) return true;
  const base = ['proposal', 'expectation', 'conditions', 'declaredAt', 'requestDigest',
    'researchContext', 'researchReferences', 'motiveReferences'];
  return (exact(value, base) || exact(value, [...base, 'experimentProtocol']))
    && isText(value.proposal, 2_000) && isText(value.expectation, 1_000)
    && Array.isArray(value.conditions) && value.conditions.length >= 1 && value.conditions.length <= 12
    && value.conditions.every(item => isText(item, 500))
    && isDate(value.declaredAt) && isDigest(value.requestDigest)
    && (value.researchContext === null || validResearchContext(value.researchContext))
    && (value.researchReferences === null || Array.isArray(value.researchReferences)
      && value.researchReferences.length >= 1 && value.researchReferences.length <= 10
      && value.researchReferences.every(validResearchReference))
    && (value.motiveReferences === null || Array.isArray(value.motiveReferences)
      && value.motiveReferences.length >= 1 && value.motiveReferences.length <= 10
      && value.motiveReferences.every(validMotiveReference))
    && (!Object.hasOwn(value, 'experimentProtocol') || isCanonicalExperimentProtocol(value.experimentProtocol));
}

function validSourceIntentPayload(value: unknown, packageValue: JsonRecord, submissionId: string): boolean {
  if (!isJsonObject(value) || value.format !== 'motive.hypothesis-writeback-preparation/0.1'
    || !isRecord(value.source) || !isRecord(value.source.submission) || value.source.submission.id !== submissionId
    || !isRecord(value.scope) || !isRecord(packageValue.project) || !isRecord(packageValue.delivery)
    || value.scope.projectId !== packageValue.project.id || value.scope.scopeId !== packageValue.delivery.scopeId
    || !isRecord(value.attribution) || value.attribution.engineActor !== packageValue.delivery.engineActor) return false;
  return true;
}

function validEngine(value: unknown): boolean {
  if (!exact(value, ['hypothesis', 'evidence'])
    || !exact(value.hypothesis, ['requestBody', 'requestBodyDigest', 'requestDigest', 'id', 'responseBody', 'responseDigest'])
    || !exact(value.evidence, ['requestBody', 'requestBodyDigest', 'requestDigest', 'id', 'responseBody', 'responseDigest'])) return false;
  const hypothesis = value.hypothesis; const evidence = value.evidence;
  const hypothesisRequest = hypothesis.requestBody; const hypothesisResponse = hypothesis.responseBody;
  const evidenceRequest = evidence.requestBody; const evidenceResponse = evidence.responseBody;
  if (!isJsonObject(hypothesisRequest) || !isJsonObject(hypothesisResponse)
    || !isJsonObject(evidenceRequest) || !isJsonObject(evidenceResponse)
    || !isDigest(hypothesis.requestBodyDigest) || !isDigest(hypothesis.requestDigest) || !isUuid(hypothesis.id)
    || !isDigest(hypothesis.responseDigest) || !isDigest(evidence.requestBodyDigest)
    || !isDigest(evidence.requestDigest) || !isUuid(evidence.id) || !isDigest(evidence.responseDigest)) return false;
  if (hypothesisResponse.id !== hypothesis.id || hypothesisResponse.statement !== hypothesisRequest.statement
    || !isRecord(evidenceResponse.evidence) || evidenceResponse.evidence.id !== evidence.id
    || evidenceResponse.evidence.hypothesis_id !== hypothesis.id
    || !isRecord(evidenceResponse.hypothesis) || evidenceResponse.hypothesis.id !== hypothesis.id) return false;
  return true;
}

const POST_CHECK_KEYS = ['requestDigest', 'reportDigest', 'assessment', 'nextAction', 'createdAt'] as const;
const POST_CHECK_SUMMARY_KEYS = [...POST_CHECK_KEYS, 'publicSummary'] as const;

function validPostCheck(value: unknown, reportDigest: unknown): boolean {
  if (!(exact(value, POST_CHECK_KEYS) || exact(value, POST_CHECK_SUMMARY_KEYS))) return false;
  return isDigest(value.requestDigest) && value.reportDigest === reportDigest
    && isText(value.assessment, 2_000) && isText(value.nextAction, 1_000)
    && isDate(value.createdAt)
    && (!Object.hasOwn(value, 'publicSummary') || isPublicResearchSummary(value.publicSummary));
}

function validTargetSource(value: JsonRecord): boolean {
  const target = validateResearchDeliveryTargetBinding(value.target);
  if (!isRecord(value.declaredIntent) || !isRecord(value.references)
    || !isRecord(value.references.researchReferences)
    || value.references.researchReferences.timing !== 'PRE_TEST_INTENT'
    || !Array.isArray(value.references.researchReferences.value)
    || !Array.isArray(value.declaredIntent.researchReferences)) return false;
  const selected = target.selection;
  const matches = (reference: unknown) => isRecord(reference)
    && reference.scopeId === selected.scopeId && reference.snapshotId === selected.snapshotId
    && reference.snapshotDigest === selected.snapshotDigest && reference.hypothesisId === selected.hypothesisId
    && reference.observedUpdatedAt === selected.observedUpdatedAt;
  return value.references.researchReferences.value.some(matches)
    && value.declaredIntent.researchReferences.some(matches);
}

function validPackage(value: unknown, submissionId: string): value is FindingReviewPackage {
  if (!isRecord(value) || !['motive.finding-review-package/0.1', 'motive.finding-review-package/0.2', 'motive.finding-review-package/0.3'].includes(String(value.format))) {
    return false;
  }
  const targetAware = value.format === 'motive.finding-review-package/0.3';
  const sourceOnly = value.format !== 'motive.finding-review-package/0.1';
  const sourceKeys = ['submission', 'attribution', 'declaredIntent', 'investigation', 'references', 'artifact', 'report', 'postCheck', 'reproducibility'];
  if (targetAware) sourceKeys.push('target');
  const rootKeys = sourceOnly
    ? ['format', 'findingId', 'project', 'workOrder', 'claim', 'source', 'assessment']
    : ['format', 'findingId', 'project', 'workOrder', 'claim', 'source', 'delivery', 'engine', 'assessment'];
  const submissionKeys = sourceOnly
    ? ['id', 'format', 'createdAt', 'baseCommit', 'artifactManifestDigest', 'licenseAcceptanceRef']
    : ['id', 'format', 'createdAt', 'baseCommit', 'artifactManifestDigest', 'licenseAcceptanceRef',
      'sourceIntentId', 'sourceIntentPayloadDigest', 'sourceIntentPayload'];
  if (!exact(value, rootKeys) || value.findingId !== submissionId
    || !exact(value.project, ['id', 'slug', 'revision']) || !isUuid(value.project.id)
    || value.project.slug !== 'circle-packing' || !isPositiveInteger(value.project.revision)
    || !exact(value.workOrder, ['id', 'revision', 'projectRevision', 'termsDigest', 'terms'])
    || !isUuid(value.workOrder.id) || !isPositiveInteger(value.workOrder.revision)
    || !isPositiveInteger(value.workOrder.projectRevision) || !isDigest(value.workOrder.termsDigest)
    || !isJsonObject(value.workOrder.terms)
    || !exact(value.claim, ['id', 'leaseEpoch', 'termsDigest', 'completedAt']) || !isUuid(value.claim.id)
    || !isPositiveInteger(value.claim.leaseEpoch) || value.claim.termsDigest !== value.workOrder.termsDigest
    || !isDate(value.claim.completedAt)
    || !exact(value.source, sourceKeys)
    || !exact(value.source.submission, submissionKeys)
    || value.source.submission.id !== submissionId || value.source.submission.format !== 'motive.submission/0.1'
    || !isDate(value.source.submission.createdAt) || !isBoundedString(value.source.submission.baseCommit, 256)
    || !isDigest(value.source.submission.artifactManifestDigest)
    || !isBoundedString(value.source.submission.licenseAcceptanceRef, 512)
    || !exact(value.source.attribution, ['contributorActorId', 'agentTokenId', 'agentName'])
    || typeof value.source.attribution.contributorActorId !== 'string' || !ACCOUNT.test(value.source.attribution.contributorActorId)
    || !isUuid(value.source.attribution.agentTokenId) || !isText(value.source.attribution.agentName, 512)
    || !validDeclaredIntent(value.source.declaredIntent) || !validInvestigation(value.source.investigation)
    || !validDeclared(value.source.references)
    || !exact(value.source.artifact, ['format', 'witness', 'digest'])
    || value.source.artifact.format !== 'motive.csqv.witness.v1' || !isBoundedString(value.source.artifact.witness, 524_288)
    || !isDigest(value.source.artifact.digest)
    || !exact(value.source.report, ['status', 'body', 'digest'])
    || !['VALID', 'REJECTED', 'INCONCLUSIVE'].includes(String(value.source.report.status))
    || !isJsonObject(value.source.report.body) || !isDigest(value.source.report.digest)
    || !validPostCheck(value.source.postCheck, value.source.report.digest)
    || !validReproducibility(value.source.reproducibility)
    || !exact(value.assessment, ['engineHypothesisSupport', 'engineConclusionApproval'])
    || value.assessment.engineHypothesisSupport !== 'UNASSESSED'
    || value.assessment.engineConclusionApproval !== 'UNASSESSED') return false;
  if (sourceOnly) return !targetAware || validTargetSource(value.source);
  return isUuid(value.source.submission.sourceIntentId)
    && isDigest(value.source.submission.sourceIntentPayloadDigest)
    && exact(value.delivery, ['id', 'scopeId', 'engineActor', 'createdAt']) && isUuid(value.delivery.id)
    && isUuid(value.delivery.scopeId) && value.delivery.engineActor === `motive:project:${value.project.id}`
    && isDate(value.delivery.createdAt) && validEngine(value.engine)
    && validSourceIntentPayload(value.source.submission.sourceIntentPayload, value, submissionId);
}

function evidenceMatchesPackage(evidence: FindingReviewEvidenceReference, pkg: FindingReviewPackage): boolean {
  const sourceMatches = evidence.artifactDigest === pkg.source.artifact.digest && evidence.reportDigest === pkg.source.report.digest
    && evidence.investigationDigest === pkg.source.investigation.digest
    && evidence.postCheckRequestDigest === pkg.source.postCheck.requestDigest
    && sameJson(evidence.reproducibility, pkg.source.reproducibility)
    && sameJson(evidence.declaredIntent, pkg.source.declaredIntent)
    && sameJson(evidence.declared, pkg.source.references);
  if (!sourceMatches) return false;
  if (pkg.format !== 'motive.finding-review-package/0.1') return evidence.engineEvidence === null;
  return evidence.engineEvidence !== null
    && evidence.engineEvidence.id === pkg.engine.evidence.id
    && evidence.engineEvidence.responseDigest === pkg.engine.evidence.responseDigest;
}

function validPreview(value: unknown, submissionId: string): boolean {
  if (!isUuid(submissionId) || !exact(value, ['format', 'submissionId', 'package', 'packageDigest', 'latestDecision'])
    || value.format !== 'motive.finding-review.preview/0.1' || value.submissionId !== submissionId
    || !validPackage(value.package, submissionId) || !isDigest(value.packageDigest)) return false;
  if (value.latestDecision === null) return true;
  if (!validDecision(value.latestDecision, submissionId, true)) return false;
  const decision = value.latestDecision as unknown as FindingReviewPrivateDecision;
  if (decision.packageDigest !== value.packageDigest) return true;
  if (value.package.format !== 'motive.finding-review-package/0.1') {
    return evidenceMatchesPackage(decision.evidence, value.package) && decision.hypothesis === null;
  }
  const hypothesisResponse = value.package.engine.hypothesis.responseBody;
  return evidenceMatchesPackage(decision.evidence, value.package)
    && decision.hypothesis !== null && decision.hypothesis.id === value.package.engine.hypothesis.id
    && decision.hypothesis.responseDigest === value.package.engine.hypothesis.responseDigest
    && isRecord(hypothesisResponse) && decision.hypothesis.statement === hypothesisResponse.statement;
}

function validDecisionResponse(value: unknown, submissionId: string): boolean {
  const keys = ['format', 'submissionId', ...PRIVATE_DECISION_KEYS, 'replayed'] as const;
  return isUuid(submissionId) && exact(value, keys)
    && value.format === 'motive.finding-review.decision/0.1' && value.submissionId === submissionId
    && typeof value.replayed === 'boolean' && validDecision(value, submissionId, true, keys);
}

export function parseFindingPublic(value: unknown, submissionId: string): FindingReviewPublicProjection {
  return parse(value, input => validPublic(input, submissionId), PUBLIC_ERROR);
}

export function parseFindingEligibility(value: unknown, submissionId: string): FindingReviewEligibility {
  return parse(value, input => validEligibility(input, submissionId), ELIGIBILITY_ERROR);
}

export function parseFindingPreview(value: unknown, submissionId: string): FindingReviewPreview {
  return parse(value, input => validPreview(input, submissionId), PREVIEW_ERROR);
}

export function parseFindingDecision(value: unknown, submissionId: string): FindingReviewDecisionResponse {
  return parse(value, input => validDecisionResponse(input, submissionId), DECISION_ERROR);
}
