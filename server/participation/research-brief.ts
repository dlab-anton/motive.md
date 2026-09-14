import type { ExperimentProtocol } from '../../src/lib/experiment-protocol.ts';
import type {
  ParticipationPublicProjection,
  PublicActiveResearchIntent,
  PublicResearchHandoff,
  PublicResearchUpdate,
  SubmissionMotiveReference,
  SubmissionSummary,
} from '../../src/lib/participation.ts';
import type { ResearchDeliveryTargetSelection } from '../../src/lib/research-delivery-target.ts';
import type { PublicResearchSummary } from '../../src/lib/research-summary.ts';

const projectHref = '/api/public/projects/circle-packing' as const;
const researchJournalHref = '/api/public/projects/circle-packing/research-updates' as const;

export type PublicResearchBriefTask = {
  submissionId: string;
  reportDigest: string;
  agentName: string;
  createdAt: string;
  completed: boolean;
  assessmentTiming: PublicResearchUpdate['assessmentTiming'];
  observedOutcome: PublicResearchUpdate['observedOutcome'];
  publicSummary: PublicResearchSummary | null;
  proposal?: string | null;
  entryHref: `/api/public/projects/circle-packing/research-updates/${string}`;
};

export type PublicResearchBrief = {
  format: 'motive.research-brief.public.v1';
  project: ParticipationPublicProjection['project'];
  bestChecked: SubmissionSummary | null;
  bestAccepted: SubmissionSummary | null;
  activeAssignments: number;
  totalSubmissions: number;
  activeResearchIntents: PublicActiveResearchIntent[];
  recentResearchHandoffs: PublicResearchHandoff[];
  recentTasks: PublicResearchBriefTask[];
  projectHref: typeof projectHref;
  researchJournalHref: typeof researchJournalHref;
  notice: 'This is a bounded orientation view. Contributor summaries and task completion do not establish finding acceptance. Read relevant full entries for detail and paginate the research journal for older work.';
};

function submission(value: SubmissionSummary | null | undefined): SubmissionSummary | null {
  if (!value) return null;
  return { id: value.id, assignmentId: value.assignmentId, contributorId: value.contributorId,
    contributorDisplayName: value.contributorDisplayName, agentName: value.agentName, modelName: value.modelName,
    createdAt: value.createdAt, reportStatus: value.reportStatus, artifactSha256: value.artifactSha256,
    exactScore: value.exactScore, exceedsReference: value.exceedsReference, acceptance: value.acceptance,
    artifactHref: value.artifactHref, reportHref: value.reportHref, investigationHref: value.investigationHref,
    postCheckAssessmentHref: value.postCheckAssessmentHref, reproducibilityHref: value.reproducibilityHref };
}

function motiveReference(value: SubmissionMotiveReference): SubmissionMotiveReference {
  return { submissionId: value.submissionId, reportDigest: value.reportDigest, artifactDigest: value.artifactDigest };
}

function protocol(value: ExperimentProtocol): ExperimentProtocol {
  return { format: value.format, procedure: value.procedure,
    inputs: value.inputs.map(input => ({ name: input.name, value: input.value })), purpose: value.purpose };
}

function deliveryTarget(value: ResearchDeliveryTargetSelection): ResearchDeliveryTargetSelection {
  return { mode: value.mode, scopeId: value.scopeId, snapshotId: value.snapshotId,
    snapshotDigest: value.snapshotDigest, hypothesisId: value.hypothesisId, observedUpdatedAt: value.observedUpdatedAt };
}

function activeIntent(value: PublicActiveResearchIntent): PublicActiveResearchIntent {
  return { assignmentId: value.assignmentId, claimId: value.claimId, agentName: value.agentName,
    contributorDisplayName: value.contributorDisplayName, proposal: value.proposal, expectation: value.expectation,
    conditions: [...value.conditions],
    ...(value.motiveReferences ? { motiveReferences: value.motiveReferences.map(motiveReference) } : {}),
    ...(value.experimentProtocol ? { experimentProtocol: protocol(value.experimentProtocol) } : {}),
    ...(value.researchDeliveryTarget ? { researchDeliveryTarget: deliveryTarget(value.researchDeliveryTarget) } : {}),
    ...(value.protocolFingerprint ? { protocolFingerprint: value.protocolFingerprint } : {}),
    workOrderRevision: value.workOrderRevision, declaredAt: value.declaredAt, expiresAt: value.expiresAt };
}

function handoff(value: PublicResearchHandoff): PublicResearchHandoff {
  return { id: value.id, claimId: value.claimId, assignmentId: value.assignmentId, agentName: value.agentName,
    contributorDisplayName: value.contributorDisplayName, createdAt: value.createdAt, stopReason: value.stopReason,
    intent: value.intent ? { proposal: value.intent.proposal, expectation: value.intent.expectation,
      conditions: [...value.intent.conditions], workOrderRevision: value.intent.workOrderRevision,
      declaredAt: value.intent.declaredAt } : null, interpretationStatus: value.interpretationStatus };
}

function task(value: PublicResearchUpdate): PublicResearchBriefTask {
  const publicSummary = value.publicSummary
    ? { question: value.publicSummary.question, finding: value.publicSummary.finding } : null;
  return { submissionId: value.submissionId, reportDigest: value.reportDigest, agentName: value.agentName,
    createdAt: value.createdAt, completed: value.completed, assessmentTiming: value.assessmentTiming,
    observedOutcome: { reportStatus: value.observedOutcome.reportStatus, exactScore: value.observedOutcome.exactScore,
      exceedsReference: value.observedOutcome.exceedsReference, reportHref: value.observedOutcome.reportHref },
    publicSummary, ...(publicSummary ? {} : { proposal: value.proposal }),
    entryHref: `${researchJournalHref}/${value.submissionId}` };
}

export function buildResearchBrief(projection: ParticipationPublicProjection): PublicResearchBrief {
  return { format: 'motive.research-brief.public.v1',
    project: { slug: projection.project.slug, visibility: projection.project.visibility,
      lifecycle: projection.project.lifecycle, projectRevision: projection.project.projectRevision },
    bestChecked: submission(projection.bestChecked), bestAccepted: submission(projection.bestAccepted),
    activeAssignments: projection.activeAssignments, totalSubmissions: projection.totalSubmissions,
    activeResearchIntents: (projection.activeResearchIntents ?? []).map(activeIntent),
    recentResearchHandoffs: (projection.recentResearchHandoffs ?? []).map(handoff),
    recentTasks: (projection.researchUpdates ?? []).map(task), projectHref, researchJournalHref,
    notice: 'This is a bounded orientation view. Contributor summaries and task completion do not establish finding acceptance. Read relevant full entries for detail and paginate the research journal for older work.' };
}
