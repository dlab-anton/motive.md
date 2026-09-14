export type Sha256Digest = `sha256:${string}`;

export type ResearchDeliveryTargetSelection = {
  mode: 'APPEND_EXISTING';
  scopeId: string;
  snapshotId: string;
  snapshotDigest: Sha256Digest;
  hypothesisId: string;
  observedUpdatedAt: string;
};

export type ResearchDeliveryTargetBinding = {
  format: 'motive.research-delivery-target/0.1';
  selection: ResearchDeliveryTargetSelection;
  channelId: string;
  scopeConfigurationDigest: Sha256Digest;
  hypothesisContentDigest: Sha256Digest;
  statementDigest: Sha256Digest;
};

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function timestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 40
    && value === value.trim() && Number.isFinite(Date.parse(value));
}

export function validateResearchDeliveryTargetSelection(value: unknown): ResearchDeliveryTargetSelection {
  const keys = ['hypothesisId', 'mode', 'observedUpdatedAt', 'scopeId', 'snapshotDigest', 'snapshotId'] as const;
  if (!record(value) || !exactKeys(value, keys) || value.mode !== 'APPEND_EXISTING'
    || typeof value.scopeId !== 'string' || !UUID.test(value.scopeId)
    || typeof value.snapshotId !== 'string' || !UUID.test(value.snapshotId)
    || typeof value.snapshotDigest !== 'string' || !DIGEST.test(value.snapshotDigest)
    || typeof value.hypothesisId !== 'string' || !UUID.test(value.hypothesisId)
    || !timestamp(value.observedUpdatedAt)) {
    throw new TypeError('researchDeliveryTarget must contain one canonical APPEND_EXISTING retained hypothesis selection.');
  }
  return { mode: 'APPEND_EXISTING', scopeId: value.scopeId, snapshotId: value.snapshotId,
    snapshotDigest: value.snapshotDigest as Sha256Digest, hypothesisId: value.hypothesisId,
    observedUpdatedAt: value.observedUpdatedAt };
}

export function validateResearchDeliveryTargetBinding(value: unknown): ResearchDeliveryTargetBinding {
  const keys = ['channelId', 'format', 'hypothesisContentDigest', 'scopeConfigurationDigest', 'selection', 'statementDigest'] as const;
  if (!record(value) || !exactKeys(value, keys) || value.format !== 'motive.research-delivery-target/0.1'
    || typeof value.channelId !== 'string' || !UUID.test(value.channelId)
    || typeof value.scopeConfigurationDigest !== 'string' || !DIGEST.test(value.scopeConfigurationDigest)
    || typeof value.hypothesisContentDigest !== 'string' || !DIGEST.test(value.hypothesisContentDigest)
    || typeof value.statementDigest !== 'string' || !DIGEST.test(value.statementDigest)) {
    throw new TypeError('Research delivery target binding is invalid.');
  }
  return { format: 'motive.research-delivery-target/0.1', selection: validateResearchDeliveryTargetSelection(value.selection),
    channelId: value.channelId, scopeConfigurationDigest: value.scopeConfigurationDigest as Sha256Digest,
    hypothesisContentDigest: value.hypothesisContentDigest as Sha256Digest,
    statementDigest: value.statementDigest as Sha256Digest };
}

export function researchDeliveryTargetSelectionsEqual(
  left: ResearchDeliveryTargetSelection,
  right: ResearchDeliveryTargetSelection,
): boolean {
  return left.mode === right.mode && left.scopeId === right.scopeId && left.snapshotId === right.snapshotId
    && left.snapshotDigest === right.snapshotDigest && left.hypothesisId === right.hypothesisId
    && left.observedUpdatedAt === right.observedUpdatedAt;
}

