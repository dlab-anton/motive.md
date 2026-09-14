export type ExperimentProtocolPurpose = 'EXPLORATORY' | 'REPLICATION' | 'CONTROL';

export type ExperimentProtocolInput = {
  name: string;
  value: string;
};

export type ExperimentProtocol = {
  format: 'motive.experiment-protocol.v1';
  procedure: string;
  inputs: ExperimentProtocolInput[];
  purpose: ExperimentProtocolPurpose;
};

export type CanonicalExperimentProtocol = ExperimentProtocol;

export type ExperimentProtocolFingerprintBinding = {
  projectId: string;
  workOrderId: string;
  workOrderRevision: number;
  workOrderTermsDigest: string;
};

export class ExperimentProtocolValidationError extends Error {
  constructor(readonly path: string, readonly reason: string) {
    super(`Invalid experiment protocol. ${path} ${reason}.`);
    this.name = 'ExperimentProtocolValidationError';
  }
}

const INVALID_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\uD800-\uDFFF]/u;
const INPUT_NAME = /^[a-z][a-z0-9_.-]{0,63}$/;
const PURPOSES = new Set<ExperimentProtocolPurpose>(['EXPLORATORY', 'REPLICATION', 'CONTROL']);
const exact = (value: object, keys: string[]) => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const codePoints = (value: string) => [...value].length;

function validText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
    && codePoints(value) <= maximum && !INVALID_TEXT.test(value);
}

function invalid(path: string, reason: string): never {
  throw new ExperimentProtocolValidationError(path, reason);
}

export function validateExperimentProtocol(value: unknown): ExperimentProtocol {
  if (!object(value)) invalid('experimentProtocol', 'must be an object');
  if (!exact(value, ['format', 'procedure', 'inputs', 'purpose']))
    invalid('experimentProtocol', 'must contain exactly format, procedure, inputs, and purpose');
  if (value.format !== 'motive.experiment-protocol.v1')
    invalid('experimentProtocol.format', 'must be motive.experiment-protocol.v1');
  if (!validText(value.procedure, 240))
    invalid('experimentProtocol.procedure', 'must be a nonempty trimmed string of at most 240 characters without control characters');
  if (typeof value.purpose !== 'string' || !PURPOSES.has(value.purpose as ExperimentProtocolPurpose))
    invalid('experimentProtocol.purpose', 'must be EXPLORATORY, REPLICATION, or CONTROL');
  if (!Array.isArray(value.inputs) || value.inputs.length < 1 || value.inputs.length > 32)
    invalid('experimentProtocol.inputs', 'must contain between 1 and 32 items');
  const inputs: ExperimentProtocolInput[] = [];
  const names = new Set<string>();
  for (const [index,item] of value.inputs.entries()) {
    const itemPath=`experimentProtocol.inputs[${index}]`;
    if (!object(item) || !exact(item, ['name', 'value'])) invalid(itemPath, 'must contain exactly name and value');
    if (typeof item.name !== 'string' || !INPUT_NAME.test(item.name))
      invalid(`${itemPath}.name`, 'must start with a lowercase letter and contain only lowercase letters, digits, underscore, dot, or hyphen, with at most 64 characters');
    if (!validText(item.value, 512))
      invalid(`${itemPath}.value`, 'must be a nonempty trimmed string of at most 512 characters without control characters');
    if (names.has(item.name)) invalid(`${itemPath}.name`, 'must be unique');
    names.add(item.name);
    inputs.push({ name: item.name, value: item.value });
  }
  const canonical: ExperimentProtocol = { format: 'motive.experiment-protocol.v1', procedure: value.procedure,
    inputs: inputs.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
    purpose: value.purpose as ExperimentProtocolPurpose };
  if (new TextEncoder().encode(JSON.stringify(canonical)).byteLength > 4096)
    invalid('experimentProtocol', 'must encode to at most 4096 UTF-8 bytes');
  return canonical;
}

export function canonicalizeExperimentProtocol(value: unknown): CanonicalExperimentProtocol {
  return validateExperimentProtocol(value);
}

export function isExperimentProtocol(value: unknown): value is ExperimentProtocol {
  try { validateExperimentProtocol(value); return true; } catch { return false; }
}

export function experimentProtocolFingerprintPreimage(binding: ExperimentProtocolFingerprintBinding,
  protocol: unknown): Record<string, unknown> {
  if (!binding || typeof binding.projectId !== 'string' || typeof binding.workOrderId !== 'string'
    || !Number.isSafeInteger(binding.workOrderRevision) || binding.workOrderRevision < 1
    || typeof binding.workOrderTermsDigest !== 'string') throw new Error('Invalid experiment protocol binding.');
  const canonical = validateExperimentProtocol(protocol);
  return { format: 'motive.experiment-protocol-fingerprint.v1', projectId: binding.projectId,
    workOrderId: binding.workOrderId, workOrderRevision: binding.workOrderRevision,
    workOrderTermsDigest: binding.workOrderTermsDigest, protocol: {
      format: canonical.format, procedure: canonical.procedure, inputs: canonical.inputs } };
}
