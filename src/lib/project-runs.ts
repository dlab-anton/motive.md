import type { HostedCircleResultStatus, HostedCircleReviewDecision } from './hosted-results.ts';

export type ProjectRunState =
  | 'queued' | 'running' | 'stopping' | 'checking' | 'awaiting-review' | 'finished'
  | 'cancelled' | 'failed' | 'unresolved';

export type ProjectRunResultLink = {
  id: string;
  status: HostedCircleResultStatus;
  exactScore: string | null;
  review: { id: string; decision: HostedCircleReviewDecision } | null;
};

export type PublicProjectRun = {
  attemptId: string;
  model: string;
  state: ProjectRunState;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  result: ProjectRunResultLink | null;
};

export type PublicProjectRuns = {
  project: 'circle-packing';
  totalRuns: number;
  stateCounts: Record<ProjectRunState, number>;
  runs: readonly PublicProjectRun[];
};

export type PublicCircleProjectUsage = {
  project: 'circle-packing';
  hostedGateway: {
    gatewayRequests: number;
    settledRequests: number;
    unresolvedRequests: number;
    requestsWithTokenCounts: number;
    requestsWithoutTokenCounts: number;
    recordedInputTokens: string;
    recordedOutputTokens: string;
    recordedTotalTokens: string;
    inputBreakdownComplete: boolean;
    outputBreakdownComplete: boolean;
    complete: boolean;
  };
  externalAgents: {
    submissions: number;
    tokenUsage: 'NOT_RECORDED_BY_MOTIVE';
  };
  projectTokenLimit: {
    status: 'NOT_CONFIGURED';
    totalTokens: null;
  };
};

export type ProjectRunDonorReceipt = PublicProjectRun & {
  inference: {
    consumedUsd: string;
    heldUsd: string;
    unresolvedExposureUsd: string;
    providerActualCostUsd: string | null;
  };
  compute: { actualCostUsd: string | null };
  attemptClosed: boolean;
};
