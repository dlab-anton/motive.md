import type { DecimalAmount, Digest } from '../../domain/src/contracts.ts';

export class GatewayProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    // The HTTP adapter recognizes this stable public category while `code`
    // retains the precise internal reason.
    this.name = 'GatewayValidationError';
    this.code = code;
  }
}

export { GatewayProtocolError as GatewayValidationError };

export type RequestNormalization = Readonly<{
  field: 'max_output_tokens';
  from: 'omitted';
  to: number;
}> | Readonly<{
  field: 'client_metadata';
  from: 'pinned-codex-0.153.4';
  to: 'omitted';
  valueDigest: Digest;
}>;

export type ValidatedGatewayRequest = Readonly<{
  body: Readonly<Record<string, unknown>>;
  /** SHA-256 of the exact inbound UTF-8 bytes when supplied by the HTTP adapter. */
  rawBodyDigest: Digest;
  /** Canonical digest of the reviewed body sent to the provider. */
  normalizedBodyDigest: Digest;
  maximumExposure: DecimalAmount;
  normalizations: readonly RequestNormalization[];
}>;

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).filter(key => !allowedSet.has(key));
  if (unexpected.length > 0) {
    throw new GatewayProtocolError('UNSUPPORTED_FIELD', `${path} contains unsupported field ${unexpected[0]}.`);
  }
}

export function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value as Readonly<T>;
}
