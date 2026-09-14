import { describe, expect, it, vi } from 'vitest';
import { hash, profile } from './runtime-profile.fixture.ts';
import { digestRuntimeBoundComparatorProfile } from './runtime-profile.ts';
import {
  BoundedTrustedEvaluatorLauncher,
  prepareTrustedEvaluatorCommand,
  prepareTrustedEvaluatorReportBindings,
  trustedEvaluatorCommandDigest,
  unresolvedEvaluatorPreflight,
  type TrustedEvaluatorCommand,
} from './launch.ts';

const profileDigest = digestRuntimeBoundComparatorProfile(profile);

function bindings(overrides: Record<string, unknown> = {}) {
  return prepareTrustedEvaluatorReportBindings({
    evaluator_profile: profile,
    frozen_evaluator_profile_digest: profileDigest,
    solution_artifact_manifest_digest: hash,
    ...overrides,
  });
}

function command(overrides: Record<string, unknown> = {}) {
  const reportBindings = bindings();
  return prepareTrustedEvaluatorCommand({
    executable: '/opt/motive/bin/evaluator-launcher', args: ['--fixed-run'], timeout_ms: 120_000,
    launcher_entrypoint_digest: reportBindings.evaluator_profile.runtime.launcher.entrypoint_digest,
    report_bindings: reportBindings,
    ...overrides,
  });
}

describe('bounded trusted evaluator launcher', () => {
  it('binds the frozen profile and sealed manifest while leaving absent observations false', () => {
    const prepared = bindings();
    expect(prepared.protected_facts_path).toBe('/work/trusted-reports/report.json');
    expect(prepared.frozen_evaluator_profile_digest).toBe(profileDigest);
    expect(prepared.solution_artifact_manifest_digest).toBe(hash);
    expect(Object.values(prepared.declared_preflight.runtime_preflight)).toEqual([false, false, false, false, false]);
    expect(Object.values(prepared.declared_preflight.input_preflight)).toEqual([false, false, false]);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.evaluator_profile)).toBe(true);
  });

  it('preserves explicit controller observations exactly without manufacturing a pass', () => {
    const declared = unresolvedEvaluatorPreflight();
    declared.runtime_preflight.namespace_identity = true;
    declared.input_preflight.trusted_challenge = true;
    const prepared = bindings({ declared_preflight: declared });
    expect(prepared.declared_preflight).toEqual(declared);
    expect(prepared.declared_preflight.runtime_preflight.landlock_enforced).toBe(false);
    expect(prepared.declared_preflight.input_preflight.candidate_source_only).toBe(false);
  });

  it('rejects malformed bindings, extra candidate-like fields, and a substituted launcher', () => {
    expect(() => bindings({ frozen_evaluator_profile_digest: `sha256:${'b'.repeat(64)}` })).toThrow();
    expect(() => prepareTrustedEvaluatorReportBindings({
      evaluator_profile: profile, frozen_evaluator_profile_digest: profileDigest, solution_artifact_manifest_digest: hash,
      stdout: 'VERIFIED',
    } as never)).toThrow();
    expect(() => command({ launcher_entrypoint_digest: `sha256:${'c'.repeat(64)}` })).toThrow();
    expect(() => command({ args: ['normal', '\u0000bad'] })).toThrow();
  });

  it('makes one start call and returns only the durable provider command receipt', async () => {
    const start = vi.fn(async (_input: { command: TrustedEvaluatorCommand; signal: AbortSignal }) => ({ provider_command_id: 'provider-command-7' }));
    const launcher = new BoundedTrustedEvaluatorLauncher({ start });
    const receipt = await launcher.dispatch({ command: command(), signal: new AbortController().signal });
    expect(receipt).toEqual({ provider_command_id: 'provider-command-7' });
    expect(start).toHaveBeenCalledTimes(1);
    const supplied = start.mock.calls[0]![0]!.command;
    expect(supplied.format).toBe('motive.trusted-evaluator-command/0.1');
    expect(supplied.report_bindings.solution_artifact_manifest_digest).toBe(hash);
    expect(Object.keys(receipt)).toEqual(['provider_command_id']);
  });

  it('does not create a retry path when a provider receipt is malformed', async () => {
    const start = vi.fn(async (_input: { command: TrustedEvaluatorCommand; signal: AbortSignal }) => ({ provider_command_id: '' }));
    const launcher = new BoundedTrustedEvaluatorLauncher({ start });
    await expect(launcher.dispatch({ command: command(), signal: new AbortController().signal })).rejects.toThrow(/command id/i);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('uses the exact frozen command representation for a durable command digest', () => {
    const value = command();
    expect(trustedEvaluatorCommandDigest(value)).toBe(trustedEvaluatorCommandDigest(structuredClone(value)));
    expect(trustedEvaluatorCommandDigest({ ...value, args: ['--different'] })).not.toBe(trustedEvaluatorCommandDigest(value));
  });
});
