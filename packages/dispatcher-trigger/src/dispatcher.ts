import {
  ATTEMPT_WAKE_TOPICS,
  type AttemptTaskTrigger,
  type DispatchBatchResult,
  type FencedOutboxClaim,
  type FencedOutboxStore,
} from './types.ts';
import { attemptPayloadFromClaim, requireUuid } from './validation.ts';

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_RETRY_MS = 30_000;

export type TriggerOutboxDispatcherOptions = {
  consumerId: string;
  limit?: number;
  leaseMs?: number;
  retryMs?: number;
  now?: () => Date;
  attemptScope?: {
    kind: 'PROJECT_LEAD_ACTIVATION';
    projectSlug: string;
    beneficiaryActorId: string;
  };
};

function requireBoundedInteger(value: number, field: string, maximum: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${field} must be an integer from 1 to ${maximum}.`);
  }
  return value;
}

function requireConsumerId(value: string): string {
  const consumerId = value.trim();
  if (consumerId.length === 0 || consumerId.length > 200) {
    throw new TypeError('consumerId must contain 1 to 200 characters.');
  }
  return consumerId;
}

function classifyError(error: unknown): string {
  if (error instanceof Error && error.name === 'TriggerDispatchValidationError') {
    return 'INVALID_OUTBOX_MESSAGE';
  }
  return 'TRIGGER_ACCEPTANCE_UNKNOWN';
}

export class TriggerOutboxDispatcher {
  readonly #consumerId: string;
  readonly #limit: number;
  readonly #leaseMs: number;
  readonly #retryMs: number;
  readonly #now: () => Date;
  readonly #attemptScope: TriggerOutboxDispatcherOptions['attemptScope'];

  constructor(
    readonly store: FencedOutboxStore,
    readonly trigger: AttemptTaskTrigger,
    options: TriggerOutboxDispatcherOptions,
  ) {
    this.#consumerId = requireConsumerId(options.consumerId);
    this.#limit = requireBoundedInteger(options.limit ?? 20, 'limit', 100);
    this.#leaseMs = requireBoundedInteger(options.leaseMs ?? DEFAULT_LEASE_MS, 'leaseMs', 15 * 60_000);
    this.#retryMs = requireBoundedInteger(options.retryMs ?? DEFAULT_RETRY_MS, 'retryMs', 24 * 60 * 60_000);
    this.#now = options.now ?? (() => new Date());
    this.#attemptScope = options.attemptScope;
  }

  async dispatchBatch(): Promise<DispatchBatchResult> {
    const claims = await this.store.claimDeliveryBatch({
      consumerId: this.#consumerId,
      limit: this.#limit,
      leaseMs: this.#leaseMs,
      topics: ATTEMPT_WAKE_TOPICS,
      ...(this.#attemptScope ? { attemptScope: this.#attemptScope } : {}),
    });
    const result: DispatchBatchResult = {
      claimed: claims.length,
      accepted: 0,
      deferred: 0,
      leaseLost: 0,
    };

    for (const claim of claims) {
      await this.#dispatchClaim(claim, result);
    }
    return result;
  }

  async #dispatchClaim(claim: FencedOutboxClaim, result: DispatchBatchResult): Promise<void> {
    try {
      const { payload, topic } = attemptPayloadFromClaim(claim);
      const outboxId = requireUuid(claim.outboxId, 'claim.outboxId');
      const handle = await this.trigger.triggerAttempt(payload, {
        idempotencyKey: `motive-outbox:${outboxId}`,
        idempotencyKeyTTL: '30d',
        maxAttempts: 3,
        ttl: '10m',
        tags: [`attempt:${payload.attemptId}`, `wake:${topic}`],
      });
      if (typeof handle.id !== 'string' || handle.id.trim().length === 0 || handle.id.length > 512) {
        throw new Error('Trigger.dev returned no bounded run identity.');
      }
      const acknowledged = await this.store.acknowledgeDelivery({
        outboxId,
        claimToken: claim.claimToken,
        triggerRunId: handle.id,
      });
      if (acknowledged) result.accepted += 1;
      else result.leaseLost += 1;
    } catch (error) {
      const deferred = await this.store.deferDelivery({
        outboxId: claim.outboxId,
        claimToken: claim.claimToken,
        retryAt: new Date(this.#now().getTime() + this.#retryMs).toISOString(),
        errorCode: classifyError(error),
      });
      if (deferred) result.deferred += 1;
      else result.leaseLost += 1;
    }
  }
}
