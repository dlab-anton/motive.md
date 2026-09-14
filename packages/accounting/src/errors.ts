export type LedgerErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'IDEMPOTENCY_INCOMPLETE'
  | 'CONTROLLER_FROZEN'
  | 'SOURCE_UNAVAILABLE'
  | 'GRANT_UNAVAILABLE'
  | 'ATTEMPT_UNAVAILABLE'
  | 'LEASE_FENCED'
  | 'ADMISSION_CLOSED'
  | 'INSUFFICIENT_SOURCE_CAPACITY'
  | 'INSUFFICIENT_GRANT_CAPACITY'
  | 'INSUFFICIENT_ATTEMPT_CAPACITY'
  | 'OPERATION_IN_FLIGHT'
  | 'SUSPECTED_RETRANSMISSION'
  | 'OPERATION_ALREADY_RESOLVED'
  | 'OPERATION_NOT_SETTLED'
  | 'ATTEMPT_HAS_UNRESOLVED_OPERATIONS'
  | 'WORK_ORDER_UNAVAILABLE'
  | 'CLAIM_UNAVAILABLE'
  | 'LATE_SUBMISSION_REJECTED'
  | 'CAPABILITY_UNAVAILABLE'
  | 'CAPABILITY_FORBIDDEN'
  | 'CAPABILITY_ISSUANCE_REPLAY'
  | 'PROVIDER_IDENTITY_CONFLICT';

export class LedgerKernelError extends Error {
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
    readonly details: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = 'LedgerKernelError';
  }
}

export function fail(code: LedgerErrorCode, message: string, details?: Readonly<Record<string, string>>): never {
  throw new LedgerKernelError(code, message, details);
}
