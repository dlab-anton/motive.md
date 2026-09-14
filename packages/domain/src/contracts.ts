import { createHash } from 'node:crypto';

/**
 * Monetary values cross the domain boundary as base-10 strings.  The accounting
 * package is the only place that parses them, using decimal.js; JavaScript
 * numbers are deliberately not accepted for authoritative amounts.
 */
export type DecimalAmount = string;
export type Digest = `sha256:${string}`;

export type WorkOrderState = 'DRAFT' | 'READY' | 'PAUSED' | 'CLOSED';
export type AttemptExecutionState =
  | 'READY'
  | 'RESERVED'
  | 'PROVISIONING'
  | 'RUNNING'
  | 'OUTPUT_SEALED'
  | 'EVALUATING'
  | 'WAITING_ACCEPTANCE'
  | 'CLOSED'
  | 'FAILED'
  | 'CANCEL_REQUESTED'
  | 'CANCELLED'
  | 'QUARANTINED';

export type ExternalSubmissionPolicy = {
  enabled: boolean;
  /** A claim coordinates a slot; it is never an authority to spend a grant. */
  claim_required: boolean;
  max_active_claims: number;
  max_lease_seconds: number;
  late_submission_policy: 'retain_as_unclaimed' | 'reject';
  review_admission: 'manual' | 'capacity_limited';
  artifact: {
    formats: readonly string[];
    max_bytes: number;
    license_acceptance_required: boolean;
  };
};

export type HostedWorkPolicy = {
  enabled: boolean;
  /** Frozen terms for a hosted attempt. External contributors never receive this capability. */
  inference: {
    currency: 'USD';
    ceiling: DecimalAmount;
    profile_digest: Digest;
  };
  maximum_runtime_seconds: number;
};

export type WorkOrderTerms = {
  format: 'motive.work-order/0.1';
  project_id: string;
  project_revision: number;
  agreement_id: string;
  objective: string;
  input_commit: string;
  allowed_effects: readonly string[];
  hosted: HostedWorkPolicy;
  external: ExternalSubmissionPolicy;
  evaluation: {
    profile_digest: Digest;
    human_acceptance_required: boolean;
  };
  public_novelty_claim?: string;
};

export type SubmissionOrigin = 'hosted' | 'external';

/**
 * Common sealed submission shape. The server derives the operator identity
 * from authentication and never accepts it in this payload.
 */
export type SubmissionContract = {
  format: 'motive.submission/0.1';
  origin: SubmissionOrigin;
  work_order_id: string;
  work_order_revision: number;
  claim_id?: string;
  lease_epoch?: number;
  base_commit: string;
  artifact_manifest_digest: Digest;
  provenance: {
    agent_name?: string;
    model_name?: string;
    usage_status: 'metered_motive' | 'unmetered_external';
    /** Kept as an unverified declaration for external work; it is not money. */
    declared_usage?: unknown;
  };
  license_acceptance_ref: string;
};

export class DomainValidationError extends Error {
  readonly code = 'DOMAIN_VALIDATION';

  constructor(message: string) {
    super(message);
    this.name = 'DomainValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new DomainValidationError(`${name} must be a plain JSON object.`);
  }
  return value;
}

function requireExactKeys(value: Record<string, unknown>, name: string, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new DomainValidationError(`${name}.${key} is not a supported property.`);
  }
}

function requireString(value: unknown, name: string, maximum = 16_384): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    throw new DomainValidationError(`${name} must be a non-empty string no longer than ${maximum} characters.`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || typeof value !== 'number' || value <= 0 || value > maximum) {
    throw new DomainValidationError(`${name} must be a positive integer.`);
  }
  return value;
}

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new DomainValidationError(`${name} must be a boolean.`);
  return value;
}

function requireStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || item.length === 0)) {
    throw new DomainValidationError(`${name} must be a non-empty array of strings.`);
  }
  return [...value];
}

export function assertDecimalString(value: unknown, name: string): DecimalAmount {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new DomainValidationError(`${name} must be a non-negative base-10 decimal string.`);
  }
  return value;
}

export function assertDigest(value: unknown, name: string): Digest {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(value)) {
    throw new DomainValidationError(`${name} must be a sha256 digest.`);
  }
  return value.toLowerCase() as Digest;
}

/** A stable JSON representation used for sealed terms and idempotency bodies. */
export function canonicalJson(value: unknown): string {
  const ancestors = new WeakSet<object>();

  const visit = (item: unknown): string => {
    if (item === null) return 'null';
    switch (typeof item) {
      case 'string': return JSON.stringify(item);
      case 'boolean': return item ? 'true' : 'false';
      case 'number':
        if (!Number.isFinite(item)) throw new DomainValidationError('Canonical JSON cannot contain a non-finite number.');
        return JSON.stringify(item);
      case 'object': {
        if (ancestors.has(item)) throw new DomainValidationError('Canonical JSON cannot contain a cycle.');
        ancestors.add(item);
        try {
          if (Array.isArray(item)) {
            for (let index = 0; index < item.length; index += 1) {
              if (!(index in item)) throw new DomainValidationError('Canonical JSON cannot contain a sparse array.');
            }
            if (Object.keys(item).some(key => !/^(?:0|[1-9]\d*)$/.test(key))) {
              throw new DomainValidationError('Canonical JSON arrays cannot have non-index properties.');
            }
            return `[${item.map(visit).join(',')}]`;
          }
          if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
            throw new DomainValidationError('Canonical JSON cannot contain a non-plain object.');
          }
          const record = item as Record<string, unknown>;
          const keys = Object.keys(record).sort();
          return `{${keys.map(key => `${JSON.stringify(key)}:${visit(record[key])}`).join(',')}}`;
        } finally {
          ancestors.delete(item);
        }
      }
      default:
        throw new DomainValidationError('Canonical JSON only accepts JSON values.');
    }
  };

  return visit(value);
}

export function digestCanonicalJson(value: unknown): Digest {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export function validateWorkOrderTerms(input: unknown): WorkOrderTerms {
  const value = requireRecord(input, 'work order terms');
  requireExactKeys(value, 'work order terms', [
    'format', 'project_id', 'project_revision', 'agreement_id', 'objective', 'input_commit', 'allowed_effects',
    'hosted', 'external', 'evaluation', 'public_novelty_claim',
  ]);
  if (value.format !== 'motive.work-order/0.1') {
    throw new DomainValidationError('work order terms.format must be motive.work-order/0.1.');
  }
  const hosted = requireRecord(value.hosted, 'hosted');
  const hostedInference = requireRecord(hosted.inference, 'hosted.inference');
  const external = requireRecord(value.external, 'external');
  const artifact = requireRecord(external.artifact, 'external.artifact');
  const evaluation = requireRecord(value.evaluation, 'evaluation');
  requireExactKeys(hosted, 'hosted', ['enabled', 'inference', 'maximum_runtime_seconds']);
  requireExactKeys(hostedInference, 'hosted.inference', ['currency', 'ceiling', 'profile_digest']);
  requireExactKeys(external, 'external', [
    'enabled', 'claim_required', 'max_active_claims', 'max_lease_seconds', 'late_submission_policy', 'review_admission', 'artifact',
  ]);
  requireExactKeys(artifact, 'external.artifact', ['formats', 'max_bytes', 'license_acceptance_required']);
  requireExactKeys(evaluation, 'evaluation', ['profile_digest', 'human_acceptance_required']);

  const terms: WorkOrderTerms = {
    format: 'motive.work-order/0.1',
    project_id: requireString(value.project_id, 'project_id', 256),
    project_revision: requirePositiveInteger(value.project_revision, 'project_revision', 2_147_483_647),
    agreement_id: requireString(value.agreement_id, 'agreement_id', 256),
    objective: requireString(value.objective, 'objective'),
    input_commit: (() => {
      const commit = requireString(value.input_commit, 'input_commit', 64);
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) {
        throw new DomainValidationError('input_commit must be a full 40- or 64-character lowercase commit identifier.');
      }
      return commit;
    })(),
    allowed_effects: requireStringArray(value.allowed_effects, 'allowed_effects'),
    hosted: {
      enabled: requireBoolean(hosted.enabled, 'hosted.enabled'),
      inference: {
        currency: hostedInference.currency === 'USD' ? 'USD' : (() => { throw new DomainValidationError('hosted.inference.currency must be USD.'); })(),
        ceiling: assertDecimalString(hostedInference.ceiling, 'hosted.inference.ceiling'),
        profile_digest: assertDigest(hostedInference.profile_digest, 'hosted.inference.profile_digest'),
      },
      maximum_runtime_seconds: requirePositiveInteger(hosted.maximum_runtime_seconds, 'hosted.maximum_runtime_seconds', 86_400),
    },
    external: {
      enabled: requireBoolean(external.enabled, 'external.enabled'),
      claim_required: requireBoolean(external.claim_required, 'external.claim_required'),
      max_active_claims: requirePositiveInteger(external.max_active_claims, 'external.max_active_claims', 10_000),
      max_lease_seconds: requirePositiveInteger(external.max_lease_seconds, 'external.max_lease_seconds', 31 * 24 * 60 * 60),
      late_submission_policy: external.late_submission_policy === 'retain_as_unclaimed' || external.late_submission_policy === 'reject'
        ? external.late_submission_policy
        : (() => { throw new DomainValidationError('external.late_submission_policy is invalid.'); })(),
      review_admission: external.review_admission === 'manual' || external.review_admission === 'capacity_limited'
        ? external.review_admission
        : (() => { throw new DomainValidationError('external.review_admission is invalid.'); })(),
      artifact: {
        formats: requireStringArray(artifact.formats, 'external.artifact.formats'),
        max_bytes: requirePositiveInteger(artifact.max_bytes, 'external.artifact.max_bytes', 2_147_483_647),
        license_acceptance_required: requireBoolean(artifact.license_acceptance_required, 'external.artifact.license_acceptance_required'),
      },
    },
    evaluation: {
      profile_digest: assertDigest(evaluation.profile_digest, 'evaluation.profile_digest'),
      human_acceptance_required: requireBoolean(evaluation.human_acceptance_required, 'evaluation.human_acceptance_required'),
    },
  };
  if (value.public_novelty_claim !== undefined) terms.public_novelty_claim = requireString(value.public_novelty_claim, 'public_novelty_claim');
  if (!terms.hosted.enabled && !terms.external.enabled) {
    throw new DomainValidationError('A work order must enable hosted work, external work, or both.');
  }
  return terms;
}

export function validateSubmissionContract(input: unknown): SubmissionContract {
  const value = requireRecord(input, 'submission');
  requireExactKeys(value, 'submission', [
    'format', 'origin', 'work_order_id', 'work_order_revision', 'claim_id', 'lease_epoch', 'base_commit',
    'artifact_manifest_digest', 'provenance', 'license_acceptance_ref',
  ]);
  if (value.format !== 'motive.submission/0.1') {
    throw new DomainValidationError('submission.format must be motive.submission/0.1.');
  }
  if (value.origin !== 'hosted' && value.origin !== 'external') {
    throw new DomainValidationError('submission.origin must be hosted or external.');
  }
  const provenance = requireRecord(value.provenance, 'submission.provenance');
  requireExactKeys(provenance, 'submission.provenance', ['agent_name', 'model_name', 'usage_status', 'declared_usage']);
  const usageStatus = provenance.usage_status;
  if (usageStatus !== 'metered_motive' && usageStatus !== 'unmetered_external') {
    throw new DomainValidationError('submission.provenance.usage_status is invalid.');
  }
  if (value.origin === 'external' && usageStatus !== 'unmetered_external') {
    throw new DomainValidationError('External submissions must declare unmetered_external usage.');
  }
  if (value.origin === 'hosted' && usageStatus !== 'metered_motive') {
    throw new DomainValidationError('Hosted submissions must declare metered_motive usage.');
  }
  const submission: SubmissionContract = {
    format: 'motive.submission/0.1',
    origin: value.origin,
    work_order_id: requireString(value.work_order_id, 'work_order_id', 256),
    work_order_revision: requirePositiveInteger(value.work_order_revision, 'work_order_revision', 2_147_483_647),
    base_commit: requireString(value.base_commit, 'base_commit', 256),
    artifact_manifest_digest: assertDigest(value.artifact_manifest_digest, 'artifact_manifest_digest'),
    provenance: {
      usage_status: usageStatus,
      ...(provenance.agent_name === undefined ? {} : { agent_name: requireString(provenance.agent_name, 'provenance.agent_name', 512) }),
      ...(provenance.model_name === undefined ? {} : { model_name: requireString(provenance.model_name, 'provenance.model_name', 512) }),
      ...(provenance.declared_usage === undefined ? {} : { declared_usage: (() => { canonicalJson(provenance.declared_usage); return provenance.declared_usage; })() }),
    },
    license_acceptance_ref: requireString(value.license_acceptance_ref, 'license_acceptance_ref', 512),
  };
  if (value.claim_id !== undefined) submission.claim_id = requireString(value.claim_id, 'claim_id', 256);
  if (value.lease_epoch !== undefined) submission.lease_epoch = requirePositiveInteger(value.lease_epoch, 'lease_epoch', 2_147_483_647);
  return submission;
}
