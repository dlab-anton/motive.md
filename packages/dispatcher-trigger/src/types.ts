export const ATTEMPT_RECONCILE_TASK_ID = 'motive-attempt-reconcile' as const;
export const ORPHAN_RECONCILE_TASK_ID = 'motive-orphan-reconcile' as const;
export const OUTBOX_DELIVERY_TASK_ID = 'motive-circle-outbox-delivery' as const;

export const ATTEMPT_WAKE_TOPICS = [
  'attempt.reserved',
  'attempt.cancel-requested',
] as const;

export type AttemptWakeTopic = (typeof ATTEMPT_WAKE_TOPICS)[number];

export type AttemptReconcilePayload = {
  attemptId: string;
};

export type AttemptReconcileResult = {
  attemptId: string;
  status: string;
  passes: number;
};

export type AttemptReconciliation = {
  attemptId: string;
  status: string;
};

export interface WorkerCoordinator {
  reconcileAttempt(attemptId: string): Promise<AttemptReconciliation>;
  reconcileOrphans(): Promise<unknown>;
}

export type OutboxMessage = {
  id: string;
  eventId: string;
  aggregateType: string;
  aggregateId: string;
  topic: string;
  dedupeKey: string;
  payload: unknown;
  deliveryAttempts: number;
};

export type FencedOutboxClaim = {
  outboxId: string;
  claimToken: string;
  message: OutboxMessage;
};

export interface FencedOutboxStore {
  claimDeliveryBatch(input: {
    consumerId: string;
    limit: number;
    leaseMs: number;
    topics: readonly AttemptWakeTopic[];
    attemptScope?: {
      kind: 'PROJECT_LEAD_ACTIVATION';
      projectSlug: string;
      beneficiaryActorId: string;
    };
  }): Promise<readonly FencedOutboxClaim[]>;

  acknowledgeDelivery(input: {
    outboxId: string;
    claimToken: string;
    triggerRunId: string;
  }): Promise<boolean>;

  deferDelivery(input: {
    outboxId: string;
    claimToken: string;
    retryAt: string;
    errorCode: string;
  }): Promise<boolean>;
}

export type AttemptTriggerOptions = {
  idempotencyKey: string;
  idempotencyKeyTTL: string;
  maxAttempts: number;
  ttl: string;
  tags: string[];
};

export interface AttemptTaskTrigger {
  triggerAttempt(
    payload: AttemptReconcilePayload,
    options: AttemptTriggerOptions,
  ): Promise<{ id: string }>;
}

export type DispatchBatchResult = {
  claimed: number;
  accepted: number;
  deferred: number;
  leaseLost: number;
};
