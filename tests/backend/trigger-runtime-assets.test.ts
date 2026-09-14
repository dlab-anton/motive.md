import { createHash } from 'node:crypto';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveTriggerRuntimeAsset } from '../../scripts/lib/trigger-runtime-assets.ts';
import { defineProtectedRuntime } from '../../packages/sandbox-vercel/src/protected-runtime.ts';
import { defineProviderUntrustedDataRuntime } from '../../packages/sandbox-vercel/src/index.ts';

const sha = (character: string) => `sha256:${character.repeat(64)}` as const;
const gatewayUrl = 'https://gateway.motive.example/api/inference/v1/responses';
const acceptedRuntime = {
  format: 'motive.circle-project-run-runtime/0.1', gatewayUrl,
  inferenceProfileDigest: sha('1'), infrastructureAuthorizationId: '00000000-0000-4000-8000-000000000001',
  maximumCostUsd: '0.001', capabilityTtlSeconds: 120,
  sandbox: {
    format: 'motive.sandbox-profile/0.1', profileDigest: sha('2'), protectedRuntime: defineProtectedRuntime(sha('3')),
    trustedSource: { kind: 'snapshot', snapshotId: 'snap_MotiveCircle01', sourceSnapshotDigest: sha('4'),
      materialDigest: sha('5'), buildRecipeDigest: sha('6') },
    timeoutMs: 120_000, commandTimeoutMs: 90_000, vcpus: 1, allowedExecutables: ['/usr/local/bin/codex'],
    egress: { gateway: [{ url: gatewayUrl, methods: ['POST'], pathMatch: 'exact' }],
      artifacts: [{ url: 'https://artifacts.motive.example/attempts/', methods: ['PUT'], pathMatch: 'prefix' }] },
    artifacts: { maxFiles: 2, maxFileBytes: 32 * 1024, maxTotalBytes: 48 * 1024 },
  },
  nativeCollection: { collectorRuntimeDigest: 'sha256:94752a6e677741a93bebfe13fe97d8525bfbe1d13582e55d39d03837f9300415', maximumFileBytes: 32 * 1024,
    maximumTotalBytes: 48 * 1024, approvedPaths: [
      { relativePath: 'candidate.json', mediaType: 'application/json', availability: 'REQUIRED', maximumBytes: 32 * 1024 },
      { relativePath: 'investigation.json', mediaType: 'application/json', availability: 'OPTIONAL_ON_FAILURE', maximumBytes: 16 * 1024 },
    ] },
} as const;
const accepted = JSON.stringify({ format: 'motive.circle-project-run-deployment/0.1', runtime: acceptedRuntime });

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function fixture(name: string): string {
  const root = join(tmpdir(), `motive-trigger-runtime-${process.pid}-${Date.now()}-${name}`);
  mkdirSync(join(root, '.local'), { recursive: true });
  writeFileSync(join(root, '.local', 'accepted-runtime.json'), accepted);
  return root;
}

describe('Trigger runtime asset selection', () => {
  it.each(['valid', 'both', 'extra-field', 'artifact-egress', 'changed-collector'] as const)(
    'checks the distinct provider-untrusted boundary: %s', variant => {
      const runtime = JSON.parse(JSON.stringify(acceptedRuntime));
      delete runtime.sandbox.protectedRuntime;
      runtime.sandbox.providerUntrustedDataRuntime = defineProviderUntrustedDataRuntime();
      runtime.sandbox.egress.artifacts = [];
      runtime.sandbox.egress.gatewayProxy = { format: 'motive.vercel-gateway-proxy/0.1',
        url: 'https://gateway.motive.example/api/sandbox-egress' };
      if (variant === 'both') runtime.sandbox.protectedRuntime = acceptedRuntime.sandbox.protectedRuntime;
      if (variant === 'extra-field') runtime.sandbox.providerUntrustedDataRuntime.secret = 'not-allowed';
      if (variant === 'artifact-egress') runtime.sandbox.egress.artifacts = acceptedRuntime.sandbox.egress.artifacts;
      if (variant === 'changed-collector') runtime.nativeCollection.collectorRuntimeDigest = sha('7');
      const bytes = JSON.stringify({ format: 'motive.circle-project-run-deployment/0.1', runtime });
      const root = fixture(`provider-${variant}`);
      writeFileSync(join(root, '.local', 'accepted-runtime.json'), bytes);
      const select = () => resolveTriggerRuntimeAsset({ MOTIVE_CIRCLE_RUN_RUNTIME_FILE: '.local/accepted-runtime.json',
        MOTIVE_CIRCLE_RUN_RUNTIME_SHA256: digest(bytes) }, root);
      if (variant === 'valid') expect(select().digest).toBe(digest(bytes));
      else expect(select).toThrow('ACCEPTED_WRAPPER_REQUIRED');
    });
  it('selects one exact digest-pinned accepted runtime file', () => {
    const root = fixture('accepted');
    expect(resolveTriggerRuntimeAsset({
      MOTIVE_CIRCLE_RUN_RUNTIME_FILE: '.local/accepted-runtime.json',
      MOTIVE_CIRCLE_RUN_RUNTIME_SHA256: digest(accepted),
    }, root)).toEqual({
      relativePath: '.local/accepted-runtime.json',
      matcher: './.local/accepted-runtime.json',
      digest: digest(accepted),
    });
  });

  it.each([
    [{}, 'MOTIVE_CIRCLE_RUN_RUNTIME_FILE_REQUIRED'],
    [{ MOTIVE_CIRCLE_RUN_RUNTIME_FILE: '.local/accepted-runtime.json' }, 'MOTIVE_CIRCLE_RUN_RUNTIME_SHA256_REQUIRED'],
    [{ MOTIVE_CIRCLE_RUN_RUNTIME_FILE: '.local/*.json', MOTIVE_CIRCLE_RUN_RUNTIME_SHA256: digest(accepted) }, 'PATH_MUST_BE_ONE_RELATIVE_FILE'],
    [{ MOTIVE_CIRCLE_RUN_RUNTIME_FILE: '.local/(accepted).json', MOTIVE_CIRCLE_RUN_RUNTIME_SHA256: digest(accepted) }, 'PATH_MUST_BE_ONE_RELATIVE_FILE'],
    [{ MOTIVE_CIRCLE_RUN_RUNTIME_FILE: '.local/accepted:runtime.json', MOTIVE_CIRCLE_RUN_RUNTIME_SHA256: digest(accepted) }, 'PATH_MUST_BE_ONE_RELATIVE_FILE'],
    [{ MOTIVE_CIRCLE_RUN_RUNTIME_FILE: '../accepted-runtime.json', MOTIVE_CIRCLE_RUN_RUNTIME_SHA256: digest(accepted) }, 'PATH_MUST_BE_ONE_RELATIVE_FILE'],
    [{ MOTIVE_CIRCLE_RUN_RUNTIME_FILE: '.env.json', MOTIVE_CIRCLE_RUN_RUNTIME_SHA256: digest(accepted) }, 'PATH_NOT_ALLOWED'],
    [{ MOTIVE_CIRCLE_RUN_RUNTIME_FILE: '.local/runtime-secret.json', MOTIVE_CIRCLE_RUN_RUNTIME_SHA256: digest(accepted) }, 'PATH_NOT_ALLOWED'],
    [{ MOTIVE_CIRCLE_RUN_RUNTIME_FILE: '.local/accepted-runtime.json', MOTIVE_CIRCLE_RUN_RUNTIME_SHA256: `sha256:${'0'.repeat(64)}` }, 'DIGEST_MISMATCH'],
  ] as const)('rejects unsafe or unpinned selection %#', (env, reason) => {
    expect(() => resolveTriggerRuntimeAsset(env, fixture(reason))).toThrow(reason);
  });

  it('rejects candidate wrappers even when their bytes are pinned', () => {
    const root = fixture('candidate');
    const candidate = JSON.stringify({ format: 'motive.circle-project-run-deployment-candidate/0.1', runtime: {} });
    writeFileSync(join(root, '.local', 'candidate.json'), candidate);
    expect(() => resolveTriggerRuntimeAsset({
      MOTIVE_CIRCLE_RUN_RUNTIME_FILE: '.local/candidate.json',
      MOTIVE_CIRCLE_RUN_RUNTIME_SHA256: digest(candidate),
    }, root)).toThrow('ACCEPTED_WRAPPER_REQUIRED');
  });

  it('rejects unknown credential-bearing runtime fields', () => {
    const root = fixture('secret-field');
    const unsafe = JSON.stringify({ format: 'motive.circle-project-run-deployment/0.1',
      runtime: { ...acceptedRuntime, secret: 'must-not-be-packaged' } });
    writeFileSync(join(root, '.local', 'unsafe.json'), unsafe);
    expect(() => resolveTriggerRuntimeAsset({
      MOTIVE_CIRCLE_RUN_RUNTIME_FILE: '.local/unsafe.json',
      MOTIVE_CIRCLE_RUN_RUNTIME_SHA256: digest(unsafe),
    }, root)).toThrow('ACCEPTED_WRAPPER_REQUIRED');
  });

  it('rejects a symlink even when it resolves inside the project', () => {
    const root = join(tmpdir(), `motive-trigger-runtime-${process.pid}-${Date.now()}-symlink`);
    const target = join(root, 'target');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'accepted-runtime.json'), accepted);
    symlinkSync(target, join(root, 'linked'), 'junction');
    expect(() => resolveTriggerRuntimeAsset({
      MOTIVE_CIRCLE_RUN_RUNTIME_FILE: 'linked/accepted-runtime.json',
      MOTIVE_CIRCLE_RUN_RUNTIME_SHA256: digest(accepted),
    }, root)).toThrow('SYMLINK_NOT_ALLOWED');
  });
});
