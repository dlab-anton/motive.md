import type { ProjectRunDonorReceipt } from './project-runs.ts';

export const OPENROUTER_PROVIDER = 'openrouter' as const;

export type FundingReadinessCode =
  | 'READY'
  | 'AWAITING_DISPATCH'
  | 'CONNECTION_REQUIRED'
  | 'ASSIGNMENT_REQUIRED'
  | 'CONTROLLER_CLOSED'
  | 'PROFILE_REQUIRED'
  | 'WORK_ORDER_REQUIRED'
  | 'GRANT_REVOKED';

export type OpenRouterConnection = {
  id: string;
  provider: typeof OPENROUTER_PROVIDER;
  status: 'CONNECTED' | 'DISCONNECTED';
  label: string | null;
  connectedAt: string;
  expiresAt: string | null;
  limitUsd: string | null;
  limitRemainingUsd: string | null;
  isFreeTier: boolean | null;
};

export type FundingModel = {
  id: string;
  name: string;
  contextLength: number | null;
  inputUsdPerToken: string | null;
  outputUsdPerToken: string | null;
  /** A reviewed gateway profile, separate from catalog presence, is required to activate spending. */
  activationProfileReady: boolean;
};

export type ProjectFundingBudget = {
  id: string;
  provider: typeof OPENROUTER_PROVIDER;
  project: string;
  projectId: string;
  sourceId: string;
  grantId: string | null;
  workOrderId: string | null;
  assignedAgentId: string | null;
  beneficiaryActorId: string | null;
  model: string;
  limitUsd: string;
  expiresAt: string | null;
  status: 'PENDING_CONNECTION' | 'WAITING_TO_ACTIVATE' | 'ACTIVE' | 'REVOKED';
  readiness: FundingReadinessCode;
  createdAt: string;
  /** Durable run facts owned by this donor; null before activation. */
  run: ProjectRunDonorReceipt | null;
};

export type FundingStatusResponse = {
  provider: typeof OPENROUTER_PROVIDER;
  currency: 'USD';
  connection: OpenRouterConnection | null;
  budgets: ProjectFundingBudget[];
  availableModels: FundingModel[];
  executionEnabled: boolean;
  message: string;
};

export type FundedWorkOrder = {
  id: string;
  project: 'circle-packing';
  projectRevision: number;
  model: string;
  profileDigest: string;
  ceilingUsd: string;
  maxRuntimeSeconds: number;
  objective: string;
  /** Exact trusted circle project-lead path; contains no actor identity. */
  projectLeadEligible: boolean;
};

export type FundedRunReadinessBlocker =
  | 'CONNECTION_REQUIRED'
  | 'BUDGET_REQUIRED'
  | 'PROFILE_REQUIRED'
  | 'WORK_ORDER_REQUIRED'
  | 'CONTROLLER_CLOSED';

export type FundedRunReadinessResponse = {
  project: 'circle-packing';
  projectRevision: number;
  controllerSpendingEnabled: boolean;
  workOrders: FundedWorkOrder[];
  blockers: FundedRunReadinessBlocker[];
};

export type StartOpenRouterConnectResponse = {
  flowId: string;
  authorizationUrl: string;
  expiresAt: string;
};

export type CompleteOpenRouterConnectInput = { flowId: string; code: string };
export type CompleteOpenRouterConnectResponse = { connection: OpenRouterConnection };

export type CreateProjectFundingBudgetInput = {
  project: string;
  limitUsd: string;
  model: string;
  expiresAt?: string;
};

export type CreateProjectFundingBudgetResponse = { budget: ProjectFundingBudget; replayed: boolean };

export type ActivateDonorAgentBudgetInput = {
  mode?: 'DONOR_AGENT';
  agentId: string;
  workOrderId: string;
};

export type ActivateProjectLeadBudgetInput = {
  mode: 'PROJECT_LEAD';
  workOrderId: string;
};

export type ActivateProjectFundingBudgetInput = ActivateDonorAgentBudgetInput | ActivateProjectLeadBudgetInput;

export type FundingCapabilityReceipt = {
  capability: string;
  gatewayUrl: string;
  expiresAt: string;
  attemptId: string;
  model: string;
};

export type ActivateDonorAgentBudgetResponse = {
  budget: ProjectFundingBudget;
  activation: { kind: 'DONOR_AGENT'; beneficiaryActorId: string; attemptId: string };
  capability: FundingCapabilityReceipt;
};

export type ActivateProjectLeadBudgetResponse = {
  budget: ProjectFundingBudget;
  activation: { kind: 'PROJECT_LEAD'; beneficiaryActorId: string; attemptId: string; status: 'AWAITING_DISPATCH' };
};

export type ActivateProjectFundingBudgetResponse = ActivateDonorAgentBudgetResponse | ActivateProjectLeadBudgetResponse;

export type FundingApiErrorCode =
  | 'AUTHENTICATION_REQUIRED'
  | 'INVALID_REQUEST'
  | 'IDEMPOTENCY_REQUIRED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'CONNECTION_REQUIRED'
  | 'CONNECT_FLOW_EXPIRED'
  | 'CONNECT_FLOW_USED'
  | 'PROVIDER_REJECTED'
  | 'PROJECT_NOT_FOUND'
  | 'MODEL_UNAVAILABLE'
  | 'BUDGET_UNAVAILABLE'
  | 'ASSIGNMENT_REQUIRED'
  | 'WORK_ORDER_REQUIRED'
  | 'PROFILE_REQUIRED'
  | 'CONTROLLER_CLOSED';

export type FundingApiError = { error: { code: FundingApiErrorCode; message: string } };
