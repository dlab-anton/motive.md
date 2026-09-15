import type { SubmissionResearchDeliveryResult } from '../../server/research-memory/submission-delivery.ts';
import type { ResearchDeliveryTargetBinding } from './research-delivery-target.ts';

export type ResearchDeliveryPolicyStatus = 'DRY_RUN' | 'ACTIVE' | 'REVOKED';
export type ResearchDeliveryMode = 'NEW_DRAFT' | 'APPEND_EXISTING';
export type ResearchDeliveryPolicyProjection = {
  format: 'motive.project-research-delivery-policy/0.1';
  id: string;
  status: ResearchDeliveryPolicyStatus;
  projectSlug: string;
  projectRevision: number;
  workOrderId: string;
  workOrderRevision: number;
  workOrderTermsDigest: string;
  scopeId: string;
  scopeConfigurationDigest: string;
  engineApiBaseUrl: string;
  engineApiVersion: string;
  reviewedContractDigest: string;
  deliveryMode: ResearchDeliveryMode;
  targetSelectionRule: 'PRETEST_RETAINED_SAME_CHANNEL' | null;
  permittedOperations: readonly ['DRAFT_HYPOTHESIS', 'NEUTRAL_EVIDENCE'] | readonly ['NEUTRAL_EVIDENCE'];
  approvedByActorId: string;
  createdAt: string | null;
  revokedAt: string | null;
};

export type ResearchSyncCapability = {
  format: 'motive.agent-research-sync-capability/0.1';
  status: 'AVAILABLE' | 'OWNER_APPROVAL_REQUIRED' | 'UNAVAILABLE';
  reason: 'CURRENT_POLICY_AVAILABLE' | 'OWNER_APPROVAL_REQUIRED' | 'RESEARCH_SCOPE_UNAVAILABLE';
  policyId: string | null;
  syncPath: '/api/agent/submissions/{submissionId}/research-sync' | null;
  permittedOperations: readonly ['DRAFT_HYPOTHESIS', 'NEUTRAL_EVIDENCE'] | readonly ['NEUTRAL_EVIDENCE'] | readonly [];
  trigger: 'EXPLICIT_AGENT_REQUEST';
  notice: string;
};

export type AgentResearchSyncInput = { policyId: string; reportDigest: string };
export type AgentResearchSyncResult = SubmissionResearchDeliveryResult;

export type AgentResearchDeliveryCheckpoint = {
  format: 'motive.agent-research-delivery-checkpoint/0.1';
  status: 'READY' | 'PENDING';
  submissionId: string;
  deliveryId: string | null;
  policyId: string | null;
  mode: ResearchDeliveryMode;
  target: ResearchDeliveryTargetBinding | null;
  reportDigest: string;
  syncPath: '/api/agent/submissions/{submissionId}/research-sync' | null;
  reason: 'READY_FOR_SYNC' | 'ADMISSION_REQUIRED' | 'OWNER_APPROVAL_REQUIRED'
    | 'CONTRACT_UNAVAILABLE' | 'DELIVERY_UNAVAILABLE';
};

export type RecoveredFindingCheckpoint = {
  format: 'motive.agent-memory-recovery-checkpoint/0.1';
  status: 'READY';
  submissionId: string;
  findingDecisionId: string;
  deliveryId: string;
  policyId: string;
  reportDigest: string;
  syncPath: '/api/agent/submissions/{submissionId}/research-sync';
};

export type AgentResearchSyncCheckpoint = AgentResearchDeliveryCheckpoint | RecoveredFindingCheckpoint;
