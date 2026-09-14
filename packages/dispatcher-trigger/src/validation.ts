import type {
  AttemptReconcilePayload,
  AttemptWakeTopic,
  FencedOutboxClaim,
} from './types.ts';
import { ATTEMPT_WAKE_TOPICS } from './types.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ATTEMPT_WAKE_TOPIC_SET = new Set<string>(ATTEMPT_WAKE_TOPICS);

export class TriggerDispatchValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TriggerDispatchValidationError';
  }
}

export function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new TriggerDispatchValidationError(`${field} must be a canonical UUID.`);
  }
  return value.toLowerCase();
}

export function requireAttemptPayload(value: unknown): AttemptReconcilePayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TriggerDispatchValidationError('Task payload must be an object containing only attemptId.');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Object.hasOwn(record, 'attemptId')) {
    throw new TriggerDispatchValidationError('Task payload must contain only attemptId.');
  }
  return { attemptId: requireUuid(record.attemptId, 'attemptId') };
}

export function attemptPayloadFromClaim(claim: FencedOutboxClaim): {
  payload: AttemptReconcilePayload;
  topic: AttemptWakeTopic;
} {
  const { message } = claim;
  if (!ATTEMPT_WAKE_TOPIC_SET.has(message.topic)) {
    throw new TriggerDispatchValidationError('Outbox topic is not supported by this dispatcher.');
  }
  if (message.aggregateType !== 'attempt') {
    throw new TriggerDispatchValidationError('Attempt wake events must have the attempt aggregate type.');
  }
  if (typeof message.payload !== 'object' || message.payload === null || Array.isArray(message.payload)) {
    throw new TriggerDispatchValidationError('Outbox payload must be an object.');
  }
  const eventPayload = message.payload as Record<string, unknown>;
  const attemptId = requireUuid(eventPayload.attempt_id, 'payload.attempt_id');
  const aggregateId = requireUuid(message.aggregateId, 'message.aggregateId');
  if (attemptId !== aggregateId) {
    throw new TriggerDispatchValidationError('Outbox payload attempt_id must match the aggregate ID.');
  }
  return {
    payload: { attemptId },
    topic: message.topic as AttemptWakeTopic,
  };
}

