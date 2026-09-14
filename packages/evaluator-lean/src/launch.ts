import { assertDigest, canonicalJson, digestCanonicalJson, type Digest } from '../../domain/src/contracts.ts';
import {
  INPUT_PREFLIGHT_CHECKS,
  RUNTIME_PREFLIGHT_CHECKS,
  type InputPreflight,
  type RuntimePreflight,
} from './runtime-report.ts';
import { requireFrozenRuntimeBoundProfile, type RuntimeBoundComparatorProfile } from './runtime-profile.ts';

/**
 * These bindings are supplied by the trusted controller to both the one-shot
 * launcher and the later report capture. They deliberately contain no worker
 * stdout, exit status, candidate path, or human-decision field.
 *
 * `declared_preflight` is a controller assertion boundary: this module checks
 * its shape and preserves its values, but cannot establish that an observation
 * occurred. Callers that have not independently observed a check must leave it
 * false (the default).
 */
export const TRUSTED_EVALUATOR_REPORT_BINDINGS_FORMAT = 'motive.trusted-evaluator-report-bindings/0.1' as const;
export const FIXED_PROTECTED_FACTS_PATH = '/work/trusted-reports/report.json' as const;
export const TRUSTED_EVALUATOR_COMMAND_FORMAT = 'motive.trusted-evaluator-command/0.1' as const;

export type DeclaredEvaluatorPreflight = {
  runtime_preflight: RuntimePreflight;
  input_preflight: InputPreflight;
};

export type TrustedEvaluatorReportBindings = {
  format: typeof TRUSTED_EVALUATOR_REPORT_BINDINGS_FORMAT;
  evaluator_profile: RuntimeBoundComparatorProfile;
  frozen_evaluator_profile_digest: Digest;
  solution_artifact_manifest_digest: Digest;
  declared_preflight: DeclaredEvaluatorPreflight;
  /** Fixed native reporter facts location; never a candidate-selected path. */
  protected_facts_path: typeof FIXED_PROTECTED_FACTS_PATH;
};

export type PrepareTrustedEvaluatorReportBindingsInput = {
  evaluator_profile: unknown;
  frozen_evaluator_profile_digest: Digest;
  solution_artifact_manifest_digest: Digest;
  /** Omitted observations are deliberately all false. */
  declared_preflight?: unknown;
};

export type TrustedEvaluatorCommand = {
  format: typeof TRUSTED_EVALUATOR_COMMAND_FORMAT;
  /** Resolved from a reviewed launcher registry, never candidate stdout. */
  executable: string;
  args: readonly string[];
  timeout_ms: number;
  /** Expected bytes of the reviewed launcher entry point. */
  launcher_entrypoint_digest: Digest;
  report_bindings: TrustedEvaluatorReportBindings;
};

export type PrepareTrustedEvaluatorCommandInput = {
  executable: unknown;
  args: unknown;
  timeout_ms: unknown;
  launcher_entrypoint_digest: unknown;
  report_bindings: unknown;
};

export type TrustedEvaluatorCommandReceipt = { provider_command_id: string };

/** The implementation must issue one provider command for one invocation.
 * Reconciliation persists this receipt before it ever asks a capture port to
 * read the protected facts file. */
export interface OneCommandTrustedEvaluatorTransport {
  start(input: { command: TrustedEvaluatorCommand; signal: AbortSignal }): Promise<unknown>;
}

function fail(message: string): never { throw new Error(`Trusted evaluator launch rejected: ${message}`); }

function object(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${name} must be a plain object.`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || !keys.every(key => Object.hasOwn(record, key))) {
    fail(`${name} has unexpected or missing fields.`);
  }
  return record;
}

function booleanRecord<K extends string>(value: unknown, keys: readonly K[], name: string): Record<K, boolean> {
  const record = object(value, keys, name);
  for (const key of keys) if (typeof record[key] !== 'boolean') fail(`${name}.${key} must be boolean.`);
  return Object.fromEntries(keys.map(key => [key, record[key]])) as Record<K, boolean>;
}

function freeze<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  return Object.freeze(value);
}

function defaultPreflight(): DeclaredEvaluatorPreflight {
  return {
    runtime_preflight: Object.fromEntries(RUNTIME_PREFLIGHT_CHECKS.map(key => [key, false])) as RuntimePreflight,
    input_preflight: Object.fromEntries(INPUT_PREFLIGHT_CHECKS.map(key => [key, false])) as InputPreflight,
  };
}

/** Returns a fresh all-false observation set. It is safe only as an
 * inconclusive default, never as evidence that a check passed. */
export function unresolvedEvaluatorPreflight(): DeclaredEvaluatorPreflight {
  return structuredClone(defaultPreflight());
}

function normalizePreflight(value: unknown | undefined): DeclaredEvaluatorPreflight {
  if (value === undefined) return defaultPreflight();
  const record = object(value, ['runtime_preflight', 'input_preflight'], 'declared_preflight');
  return {
    runtime_preflight: booleanRecord(record.runtime_preflight, RUNTIME_PREFLIGHT_CHECKS, 'declared_preflight.runtime_preflight') as RuntimePreflight,
    input_preflight: booleanRecord(record.input_preflight, INPUT_PREFLIGHT_CHECKS, 'declared_preflight.input_preflight') as InputPreflight,
  };
}

/**
 * Binds the exact reviewed 0.2 profile and sealed candidate-manifest receipt
 * before a command is issued. This is intentionally separate from dispatch:
 * a durable coordinator may persist/observe the single command and invoke
 * capture repeatedly without causing another evaluation command.
 */
export function prepareTrustedEvaluatorReportBindings(
  input: PrepareTrustedEvaluatorReportBindingsInput,
): TrustedEvaluatorReportBindings {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail('report bindings input must be a plain object.');
  const record = input as Record<string, unknown>;
  const allowed = ['evaluator_profile', 'frozen_evaluator_profile_digest', 'solution_artifact_manifest_digest', 'declared_preflight'];
  if (Object.keys(record).some(key => !allowed.includes(key))
    || !['evaluator_profile', 'frozen_evaluator_profile_digest', 'solution_artifact_manifest_digest'].every(key => Object.hasOwn(record, key))) {
    fail('report bindings input has unexpected or missing fields.');
  }
  const frozen = assertDigest(record.frozen_evaluator_profile_digest, 'frozen evaluator profile');
  const profile = requireFrozenRuntimeBoundProfile(record.evaluator_profile, frozen);
  const manifest = assertDigest(record.solution_artifact_manifest_digest, 'sealed solution artifact manifest');
  if (profile.runtime.report_path !== FIXED_PROTECTED_FACTS_PATH) fail('runtime report path differs from the fixed protected facts path.');
  return freeze({
    format: TRUSTED_EVALUATOR_REPORT_BINDINGS_FORMAT,
    evaluator_profile: structuredClone(profile),
    frozen_evaluator_profile_digest: frozen,
    solution_artifact_manifest_digest: manifest,
    declared_preflight: normalizePreflight(record.declared_preflight),
    protected_facts_path: FIXED_PROTECTED_FACTS_PATH,
  });
}

/** Re-validates an untrusted/deserialized binding record and returns an owned,
 * immutable copy. */
export function validateTrustedEvaluatorReportBindings(value: unknown): TrustedEvaluatorReportBindings {
  const record = object(value, ['format', 'evaluator_profile', 'frozen_evaluator_profile_digest', 'solution_artifact_manifest_digest', 'declared_preflight', 'protected_facts_path'], 'report bindings');
  if (record.format !== TRUSTED_EVALUATOR_REPORT_BINDINGS_FORMAT || record.protected_facts_path !== FIXED_PROTECTED_FACTS_PATH) {
    fail('report bindings format or protected facts path is invalid.');
  }
  return prepareTrustedEvaluatorReportBindings({
    evaluator_profile: record.evaluator_profile,
    frozen_evaluator_profile_digest: assertDigest(record.frozen_evaluator_profile_digest, 'frozen evaluator profile'),
    solution_artifact_manifest_digest: assertDigest(record.solution_artifact_manifest_digest, 'sealed solution artifact manifest'),
    declared_preflight: record.declared_preflight,
  });
}

function executable(value: unknown): string {
  if (typeof value !== 'string' || value.length < 2 || value.length > 1024 || value.includes('\0')
    || !/^\/[A-Za-z0-9/._+-]+$/u.test(value) || value.includes('//') || value.includes('/../') || value.endsWith('/..')) {
    fail('launcher executable is not an absolute normalized path.');
  }
  return value;
}

function args(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 128 || value.some(arg => typeof arg !== 'string' || arg.length > 4096 || /[\u0000-\u001f\u007f]/u.test(arg))) {
    fail('launcher arguments are invalid.');
  }
  return [...value] as string[];
}

/** Creates a bounded, serializable one-command request. The transport must
 * verify the selected executable against its reviewed runtime registry before
 * starting it; this module binds its expected digest to the frozen profile. */
export function prepareTrustedEvaluatorCommand(input: PrepareTrustedEvaluatorCommandInput): TrustedEvaluatorCommand {
  const record = object(input, ['executable', 'args', 'timeout_ms', 'launcher_entrypoint_digest', 'report_bindings'], 'command input');
  const bindings = validateTrustedEvaluatorReportBindings(record.report_bindings);
  const entrypointDigest = assertDigest(record.launcher_entrypoint_digest, 'launcher entrypoint');
  if (entrypointDigest !== bindings.evaluator_profile.runtime.launcher.entrypoint_digest) {
    fail('launcher entrypoint digest differs from the frozen runtime profile.');
  }
  const timeout = record.timeout_ms;
  if (typeof timeout !== 'number' || !Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 3_600_000) {
    fail('command timeout is outside the bounded range.');
  }
  return freeze({
    format: TRUSTED_EVALUATOR_COMMAND_FORMAT,
    executable: executable(record.executable),
    args: args(record.args),
    timeout_ms: timeout,
    launcher_entrypoint_digest: entrypointDigest,
    report_bindings: bindings,
  });
}

export function validateTrustedEvaluatorCommand(value: unknown): TrustedEvaluatorCommand {
  const record = object(value, ['format', 'executable', 'args', 'timeout_ms', 'launcher_entrypoint_digest', 'report_bindings'], 'command');
  if (record.format !== TRUSTED_EVALUATOR_COMMAND_FORMAT) fail('command format is invalid.');
  return prepareTrustedEvaluatorCommand({
    executable: record.executable, args: record.args, timeout_ms: record.timeout_ms,
    launcher_entrypoint_digest: record.launcher_entrypoint_digest, report_bindings: record.report_bindings,
  });
}

/** Stable identity suitable for the durable COMMAND effect. */
export function trustedEvaluatorCommandDigest(value: unknown): Digest {
  return digestCanonicalJson(validateTrustedEvaluatorCommand(value));
}

function receipt(value: unknown): TrustedEvaluatorCommandReceipt {
  const record = object(value, ['provider_command_id'], 'command receipt');
  if (typeof record.provider_command_id !== 'string' || record.provider_command_id.length < 1 || record.provider_command_id.length > 512
    || /[\u0000-\u001f\u007f]/u.test(record.provider_command_id)) fail('provider command id is invalid.');
  return Object.freeze({ provider_command_id: record.provider_command_id });
}

/**
 * Dispatches exactly one transport request. It neither waits for completion
 * nor reads stdout/stderr nor invokes a capture function. A failed/ambiguous
 * transport call deliberately has no retry path here; the durable coordinator
 * owns the resulting command-state transition.
 */
export class BoundedTrustedEvaluatorLauncher {
  constructor(private readonly transport: OneCommandTrustedEvaluatorTransport) {}

  async dispatch(input: { command: unknown; signal: AbortSignal }): Promise<TrustedEvaluatorCommandReceipt> {
    if (!input || typeof input !== 'object' || !(input.signal instanceof AbortSignal)) fail('dispatch input is invalid.');
    if (input.signal.aborted) fail('dispatch was aborted before command start.');
    const command = validateTrustedEvaluatorCommand(input.command);
    const result = await this.transport.start({ command, signal: input.signal });
    if (input.signal.aborted) fail('dispatch was aborted after command start.');
    return receipt(result);
  }
}

/** Avoid importing this helper merely to make a success claim. It proves only
 * canonical representation of a supplied trusted command. */
export function canonicalTrustedEvaluatorCommand(value: unknown): string {
  return canonicalJson(validateTrustedEvaluatorCommand(value));
}
