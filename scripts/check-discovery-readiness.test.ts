import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { GatewayProfile } from '../packages/inference-gateway/src/profile.ts';
import type { CircleProjectRunConfig } from '../server/project-runs/config.ts';
import type { FundedRunReadinessResponse } from '../src/lib/funding.ts';
import {
  inspectCircleDiscoveryReadiness,
  parseCircleDiscoveryReadinessArguments,
} from './check-discovery-readiness.ts';

const emptyConfig: CircleProjectRunConfig = {
  databaseConfigured: true, runtimeBundle: null, runtimeFile: null, vercel: null, objectStore: null,
  accountDatabasePath: null, accountProvider: 'supabase', accountSupabase: null,
  readinessReasons: ['RUNTIME_BUNDLE_REQUIRED'],
};

const funding: FundedRunReadinessResponse = {
  project: 'circle-packing', projectRevision: 1, controllerSpendingEnabled: false,
  workOrders: [], blockers: ['CONNECTION_REQUIRED', 'BUDGET_REQUIRED', 'PROFILE_REQUIRED',
    'WORK_ORDER_REQUIRED', 'CONTROLLER_CLOSED'],
};

describe('circle discovery readiness', () => {
  it('accepts only an optional explicit Supabase account UUID', () => {
    const accountId = randomUUID();
    expect(parseCircleDiscoveryReadinessArguments([])).toEqual({});
    expect(parseCircleDiscoveryReadinessArguments(['--account-id', accountId])).toEqual({ accountId });
    expect(() => parseCircleDiscoveryReadinessArguments(['--account-id', 'account:caller'])).toThrow('Usage:');
  });

  it('reports known authority and process gaps separately from external verification', async () => {
    const report = await inspectCircleDiscoveryReadiness({
      pool: { query: vi.fn() } as never,
      env: {}, now: () => new Date('2026-09-08T06:00:00Z'),
      dependencies: {
        schemaStatus: async () => ({ exact: true }), loadProfiles: () => [], loadRunConfig: () => emptyConfig,
        funding: async () => funding, researchScope: async () => false,
        infrastructure: async () => false, runtimeAsset: vi.fn(),
      },
    });
    expect(report).toMatchObject({ account: 'SELECTION_REQUIRED', schema: 'EXACT', researchScope: 'REQUIRED',
      processConfiguration: { trigger: 'REQUIRED', acceptedRuntimeAsset: 'REQUIRED',
        runtimeProfile: 'REQUIRED', infrastructureRecord: 'REQUIRED' }, configurationChecksPassed: false });
    expect(report.knownBlockers).toEqual(expect.arrayContaining([
      'ACCOUNT_SELECTION_REQUIRED', 'CONNECTION_REQUIRED', 'BUDGET_REQUIRED', 'PROFILE_REQUIRED',
      'WORK_ORDER_REQUIRED', 'CONTROLLER_CLOSED', 'RESEARCH_SCOPE_REQUIRED',
      'TRIGGER_PROCESS_CONFIGURATION_REQUIRED', 'ACCEPTED_RUNTIME_ASSET_REQUIRED',
    ]));
    expect(report.externalVerification).toEqual(expect.arrayContaining(['TRIGGER_DEPLOYMENT_AND_SCHEDULE', 'HYPOTHESIS_HEALTH', 'ATTEMPT_FINANCIAL_BINDINGS']));
  });

  it('blocks an accepted bundle whose inference profile does not match the loaded route', async () => {
    const accountId = randomUUID(); const authorizationId = randomUUID();
    const profile = { profileId: 'reviewed', status: 'reviewed-live', evidence: { kind: 'gate-a-reviewed' } } as unknown as GatewayProfile;
    const digest = `sha256:${'a'.repeat(64)}`;
    const config = { ...emptyConfig, runtimeBundle: { format: 'motive.circle-project-run-deployment/0.1' as const,
      runtime: { inferenceProfileDigest: digest, infrastructureAuthorizationId: authorizationId,
        maximumCostUsd: '0.01' } as never }, runtimeFile: 'runtime.json', readinessReasons: [] };
    const report = await inspectCircleDiscoveryReadiness({
      pool: { query: vi.fn() } as never, accountId,
      env: { TRIGGER_SECRET_KEY: 'tr_prod_example', TRIGGER_PROJECT_REF: 'proj_example',
        MOTIVE_CIRCLE_RUN_RUNTIME_FILE: 'runtime.json', MOTIVE_CIRCLE_RUN_RUNTIME_SHA256: digest },
      dependencies: {
        schemaStatus: async () => ({ exact: true }), loadProfiles: () => [profile], loadRunConfig: () => config,
        funding: async () => ({ ...funding, controllerSpendingEnabled: true, blockers: [] }),
        account: async () => true, researchScope: async () => true, runtimeAsset: vi.fn(),
        infrastructure: async () => true,
      },
    });
    // Accepting the asset alone must not hide a mismatched inference route.
    expect(report.processConfiguration.acceptedRuntimeAsset).toBe('VALID');
    expect(report.externalVerification).toContain('LIVE_INFERENCE_COMPATIBILITY');
    expect(report.knownBlockers).toContain('RUNTIME_PROFILE_MISMATCH');
    expect(report.configurationChecksPassed).toBe(false);
  });

  it('sanitizes an invalid accepted-runtime asset to a closed status', async () => {
    const report = await inspectCircleDiscoveryReadiness({
      pool: { query: vi.fn() } as never,
      env: { MOTIVE_CIRCLE_RUN_RUNTIME_FILE: 'candidate.json' },
      dependencies: {
        schemaStatus: async () => ({ exact: false }), loadProfiles: () => [], loadRunConfig: () => emptyConfig,
        runtimeAsset: () => { throw new Error('raw path and credential-like material'); },
      },
    });
    expect(report.processConfiguration.acceptedRuntimeAsset).toBe('INVALID');
    expect(report.knownBlockers).toContain('ACCEPTED_RUNTIME_ASSET_INVALID');
    expect(JSON.stringify(report)).not.toContain('credential-like');
  });
});
