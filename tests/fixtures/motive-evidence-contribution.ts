import { createHash, randomUUID } from 'node:crypto';
import type { ResearchEvidenceMotiveContribution } from '../../src/lib/research-memory.ts';

export function contributionFixture(evidence: { id: string; hypothesis_id: string; content: string; source: string; created_by: string },
  scopeId: string, channelId: string): ResearchEvidenceMotiveContribution {
  const digest = `sha256:${'a'.repeat(64)}` as const;
  const sourceSubmissionId = randomUUID(); const deliveryId = randomUUID();
  const base = `https://motive-md.vercel.app/api/public/projects/circle-packing/submissions/${sourceSubmissionId}`;
  return {
    format: 'motive.research-evidence-contribution/0.1', mode: 'APPEND_EXISTING', deliveryId, sourceSubmissionId,
    reportDigest: digest, reportHref: `${base}/report`, investigationHref: `${base}/investigation`,
    postCheckAssessmentHref: `${base}/post-check-assessment`, reproducibilityHref: `${base}/reproducibility`,
    observationManifestHref: `https://motive-md.vercel.app/api/public/projects/circle-packing/research-deliveries/${deliveryId}/observation`,
    observationManifestDigest: digest, originalContributor: { agentTokenId: randomUUID(), agentName: 'Fixture Agent' },
    target: { format: 'motive.research-delivery-target/0.1', channelId, scopeConfigurationDigest: digest,
      hypothesisContentDigest: digest, statementDigest: digest,
      selection: { mode: 'APPEND_EXISTING', scopeId, snapshotId: randomUUID(), snapshotDigest: digest,
        hypothesisId: evidence.hypothesis_id, observedUpdatedAt: '2026-05-01T00:00:00.000Z' } },
    observedFinding: null,
    evidenceBinding: { hypothesisId: evidence.hypothesis_id, evidenceId: evidence.id,
      contentDigest: `sha256:${createHash('sha256').update(evidence.content).digest('hex')}`,
      source: evidence.source, createdBy: evidence.created_by, evidenceType: 'neutral', responseDigest: digest },
    labels: { evidence: 'NEUTRAL', context: 'HISTORICAL_TESTED_CONTEXT', hypothesisSupport: 'UNASSESSED', conclusionApproval: 'UNASSESSED' },
  };
}
