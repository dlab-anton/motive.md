import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import { applyPostgresMigrations, defaultMigrationDirectory } from '../../packages/accounting/src/migrations.ts';
import { digestCanonicalJson, type Digest } from '../../packages/domain/src/contracts.ts';
import { CIRCLE_LEARNING_COLLECTOR } from '../../packages/orchestration/src/circle-data-boundary.ts';
import { PostgresOrchestrationStore } from '../../packages/orchestration/src/store.ts';
import type { ControllerLease, FreezeNativeCollectionPlanInput } from '../../packages/orchestration/src/store-types.ts';
import { defineProtectedRuntime, defineProviderUntrustedDataRuntime, sandboxName, type SandboxExecutionProfile } from '../../packages/sandbox-vercel/src/index.ts';
import { localGatewayProfile, seedGatewayAttempt } from '../../scripts/lib/gateway-fixture.ts';

const adminSource = process.env.MOTIVE_TEST_DATABASE_URL;
const pgDescribe = adminSource ? describe : describe.skip;
const digest = (character: string) => `sha256:${character.repeat(64)}` as Digest;
const controllerActor = 'worker-boundary-postgres-test';

function providerProfile(): SandboxExecutionProfile {
  return {
    format: 'motive.sandbox-profile/0.1', profileDigest: digest('1'),
    providerUntrustedDataRuntime: defineProviderUntrustedDataRuntime(),
    trustedSource: { kind: 'snapshot', snapshotId: 'snap_MotiveCircle01', sourceCommit: '2'.repeat(40),
      materialDigest: digest('3'), buildRecipeDigest: digest('4') },
    timeoutMs: 120_000, commandTimeoutMs: 60_000, vcpus: 2,
    allowedExecutables: ['/usr/local/bin/codex'],
    egress: { gateway: [{ url: 'https://gateway.motive.example/v1/responses', methods: ['POST'], pathMatch: 'exact' }], artifacts: [],
      gatewayProxy: { format: 'motive.vercel-gateway-proxy/0.1', url: 'https://gateway.motive.example/api/sandbox-egress' } },
    artifacts: { maxFiles: 2, maxFileBytes: 32_768, maxTotalBytes: 49_152 },
  };
}

function protectedProfile(): SandboxExecutionProfile {
  const value = providerProfile();
  delete value.providerUntrustedDataRuntime;
  value.protectedRuntime = defineProtectedRuntime(digest('5'));
  value.egress = { gateway: [{ url: 'https://gateway.motive.example/v1/responses', methods: ['POST'], pathMatch: 'exact' }],
    artifacts: [{ url: 'https://artifacts.motive.example/attempt/', methods: ['PUT'], pathMatch: 'prefix' }] };
  value.artifacts = { maxFiles: 1, maxFileBytes: 1_024, maxTotalBytes: 1_024 };
  return value;
}

const providerPlan: FreezeNativeCollectionPlanInput = {
  collectorRuntimeDigest: CIRCLE_LEARNING_COLLECTOR as Digest,
  maximumFileBytes: 32_768, maximumTotalBytes: 49_152,
  approvedPaths: [
    { relativePath: 'candidate.json', mediaType: 'application/json', availability: 'REQUIRED', maximumBytes: 32_768 },
    { relativePath: 'investigation.json', mediaType: 'application/json', availability: 'OPTIONAL_ON_FAILURE', maximumBytes: 16_384 },
  ],
};

type Database = { name: string; admin: Pool; pool: Pool };
const databases: Database[] = [];

async function createDatabase(): Promise<Database> {
  const source = new URL(adminSource!);
  const name = `motive_boundary_${randomUUID().replaceAll('-', '')}`;
  if (!/^motive_boundary_[a-f0-9]{32}$/.test(name)) throw new Error('Refusing an unsafe test database name.');
  const adminUrl = new URL(source); adminUrl.pathname = '/postgres';
  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(source); url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString(), max: 12 });
  const created = { name, admin, pool }; databases.push(created); return created;
}

async function seedReserved(pool: Pool, profile: SandboxExecutionProfile) {
  const ledger = new LedgerKernel(pool); const store = new PostgresOrchestrationStore(pool);
  await ledger.setControllerSpending({ actorId: controllerActor, idempotencyKey: randomUUID(), enabled: true, reason: 'isolated execution-boundary test' });
  const seed = await seedGatewayAttempt(ledger, localGatewayProfile('http://127.0.0.1:1/responses'));
  const authorizationId = randomUUID();
  await store.createInfrastructureAuthorization({ id: authorizationId, sourceAccountId: seed.source.id,
    sourceAccountRef: `synthetic:boundary:${seed.source.id}`, actorId: seed.actorId, limitUsd: '2.000000000000',
    expiresAt: new Date(Date.now() + 600_000).toISOString() });
  const lease = await store.acquireLease(seed.attempt.id, `boundary:${randomUUID()}`, 300);
  const reserved = await store.reserveEnvironment(lease, { kind: 'WORKER', profileDigest: profile.profileDigest,
    profileSnapshot: profile as unknown as Record<string, unknown>, launchPlanDigest: digest('8'),
    infrastructureAuthorizationId: authorizationId, maximumCostUsd: '1.000000000000' });
  return { ledger, store, seed, lease, reserved };
}

afterAll(async () => {
  for (const database of databases.splice(0)) {
    if (!/^motive_boundary_[a-f0-9]{32}$/.test(database.name)) throw new Error('Refusing to drop an unsafe test database name.');
    await database.pool.end();
    await database.admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [database.name]);
    await database.admin.query(`DROP DATABASE IF EXISTS ${database.name}`);
    await database.admin.end();
  }
});

pgDescribe('worker execution boundaries on isolated PostgreSQL databases', () => {
  it('freezes only the exact provider data plan and denies native helper boundaries in the store and SQL', async () => {
    const { pool } = await createDatabase(); await applyPostgresMigrations(pool);
    const fixture = await seedReserved(pool, providerProfile());
    const [left, right] = await Promise.all([
      fixture.store.freezeNativeCollectionPlan(fixture.lease, fixture.reserved.environment.id, providerPlan),
      fixture.store.freezeNativeCollectionPlan(fixture.lease, fixture.reserved.environment.id, structuredClone(providerPlan)),
    ]);
    expect(left.collectionPlanDigest).toBe(right.collectionPlanDigest);
    expect(left).toMatchObject({ executionBoundaryKind: 'PROVIDER_UNTRUSTED_CIRCLE_DATA',
      executionBoundaryDigest: defineProviderUntrustedDataRuntime().runtimeDigest, workerRuntimeDigest: null,
      maximumHelperCommands: 0, paths: [{ relativePath: 'candidate.json' }, { relativePath: 'investigation.json' }] });
    await expect(fixture.store.freezeNativeCollectionPlan(fixture.lease, fixture.reserved.environment.id,
      { ...providerPlan, approvedPaths: [{ ...providerPlan.approvedPaths[0]!, maximumBytes: 32_767 }, providerPlan.approvedPaths[1]!] }))
      .rejects.toMatchObject({ code: 'EFFECT_CONFLICT' });
    await expect(fixture.store.claimEffect(fixture.lease, fixture.reserved.effect.effectId)).resolves.toMatchObject({ claimed: true });
    const handle = { provider: 'vercel', externalId: sandboxName(fixture.seed.attempt.id, fixture.lease.epoch),
      sessionId: `session_${randomUUID().replaceAll('-', '')}` };
    await fixture.store.recordCreateResult(fixture.lease, fixture.reserved.effect.effectId, handle);
    await fixture.store.recordObservation(fixture.lease, fixture.reserved.environment.id,
      { providerStatus: 'running', state: 'ACTIVE', providerTerminal: false });
    await expect(fixture.store.planNativeBootstrap(fixture.lease, fixture.reserved.environment.id))
      .rejects.toMatchObject({ code: 'EFFECT_UNAVAILABLE' });
    await expect(fixture.store.getWorkerWorkspaceBinding(fixture.lease, fixture.reserved.environment.id))
      .rejects.toMatchObject({ code: 'SANDBOX_POLICY_INVALID' });

    const command = await fixture.store.planCommand(fixture.lease, fixture.reserved.environment.id, { commandDigest: digest('9') });
    await fixture.store.claimEffect(fixture.lease, command.effect.effectId);
    await fixture.store.recordCommandResult(fixture.lease, command.effect.effectId, { providerCommandId: `cmd-${randomUUID()}` });
    await expect(pool.query(`INSERT INTO motive.native_collection_effects
      (id,environment_id,attempt_id,worker_command_effect_id,kind,effect_key,provider,external_id,session_id,
       lease_epoch,controller_generation,profile_digest,worker_runtime_digest,collector_runtime_digest,collection_plan_digest)
      VALUES ($1,$2,$3,$4,'BOOTSTRAP',$5,'vercel',$6,$7,$8,$9,$10,$11,$12,$13)`, [
      randomUUID(), fixture.reserved.environment.id, fixture.seed.attempt.id, command.effect.effectId, randomUUID(),
      handle.externalId, handle.sessionId, fixture.lease.epoch, fixture.lease.controllerGeneration,
      providerProfile().profileDigest, digest('5'), left.collectorRuntimeDigest, left.collectionPlanDigest,
    ])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`INSERT INTO motive.native_workspace_bindings
      (environment_id,attempt_id,provider,external_id,session_id,lease_epoch,controller_generation,profile_digest,
       worker_runtime_digest,collector_runtime_digest,workspace_identity)
      VALUES ($1,$2,'vercel',$3,$4,$5,$6,$7,$8,$9,'1:2:3')`, [fixture.reserved.environment.id,
      fixture.seed.attempt.id, handle.externalId, handle.sessionId, fixture.lease.epoch,
      fixture.lease.controllerGeneration, providerProfile().profileDigest, digest('5'), left.collectorRuntimeDigest,
    ])).rejects.toMatchObject({ code: '23514' });
    await expect(fixture.store.recordArtifactSeal(fixture.lease, fixture.reserved.environment.id,
      { manifestDigest: digest('e'), receiptId: `provider-session-seal:${randomUUID()}` }))
      .resolves.toMatchObject({ status: 'SEALED', manifestDigest: digest('e') });
  }, 30_000);

  it('requires a complete provider plan before CREATE even through direct SQL', async () => {
    const { pool } = await createDatabase(); await applyPostgresMigrations(pool);
    const fixture = await seedReserved(pool, providerProfile());
    await expect(fixture.store.claimEffect(fixture.lease, fixture.reserved.effect.effectId))
      .rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`INSERT INTO motive.native_collection_plans
      (environment_id,attempt_id,lease_epoch,controller_generation,profile_digest,execution_boundary_kind,
       execution_boundary_digest,worker_runtime_digest,collector_runtime_digest,collection_plan_digest,
       maximum_file_bytes,maximum_total_bytes,maximum_files,path_count,maximum_helper_commands)
      VALUES ($1,$2,$3,$4,$5,'PROVIDER_UNTRUSTED_CIRCLE_DATA',$6,NULL,$7,$8,32768,49152,2,2,0)`, [
      fixture.reserved.environment.id, fixture.seed.attempt.id, fixture.lease.epoch,
      fixture.lease.controllerGeneration, providerProfile().profileDigest,
      defineProviderUntrustedDataRuntime().runtimeDigest, digest('d'), digest('a'),
    ])).rejects.toMatchObject({ code: '23514' });
  }, 30_000);

  it('backfills an old protected plan without changing its canonical digest or replay', async () => {
    const { pool } = await createDatabase();
    const subset = await mkdtemp(join(tmpdir(), 'motive-boundary-migrations-'));
    try {
      for (const name of await readdir(defaultMigrationDirectory)) {
        if (/^\d{3}_.+\.sql$/.test(name) && name < '023_') await cp(resolve(defaultMigrationDirectory, name), resolve(subset, name));
      }
      await applyPostgresMigrations(pool, subset);
      const profile = protectedProfile(); const fixture = await seedReserved(pool, profile);
      const input: FreezeNativeCollectionPlanInput = { collectorRuntimeDigest: digest('b'), maximumFileBytes: 1_024,
        maximumTotalBytes: 1_024, approvedPaths: [{ relativePath: 'result.txt',
          mediaType: 'text/plain', availability: 'REQUIRED', maximumBytes: 1_024 }] };
      const pathDigest = digestCanonicalJson({ relativePath: 'result.txt', mediaType: 'text/plain',
        availability: 'REQUIRED', maximumBytes: 1_024 });
      const frozen = { format: 'motive.native-collection-plan/0.1', environment_id: fixture.reserved.environment.id,
        attempt_id: fixture.seed.attempt.id, lease_epoch: fixture.lease.epoch,
        controller_generation: fixture.lease.controllerGeneration, profile_digest: profile.profileDigest,
        worker_runtime_digest: profile.protectedRuntime!.runtimeDigest, collector_runtime_digest: input.collectorRuntimeDigest,
        maximum_file_bytes: 1_024, maximum_total_bytes: 1_024, maximum_files: 1, maximum_helper_commands: 2,
        approved_paths: [{ relative_path: 'result.txt', path_digest: pathDigest, media_type: 'text/plain',
          availability: 'REQUIRED', maximum_bytes: 1_024 }] };
      const oldDigest = digestCanonicalJson(frozen);
      await pool.query(`INSERT INTO motive.native_collection_plans
        (environment_id,attempt_id,lease_epoch,controller_generation,profile_digest,worker_runtime_digest,
         collector_runtime_digest,collection_plan_digest,maximum_file_bytes,maximum_total_bytes,maximum_files,path_count,maximum_helper_commands)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1024,1024,1,1,2)`, [fixture.reserved.environment.id,
        fixture.seed.attempt.id, fixture.lease.epoch, fixture.lease.controllerGeneration, profile.profileDigest,
        profile.protectedRuntime!.runtimeDigest, input.collectorRuntimeDigest, oldDigest]);
      await pool.query(`INSERT INTO motive.native_collection_plan_paths
        (environment_id,ordinal,relative_path,path_digest,media_type,availability,maximum_bytes)
        VALUES ($1,0,'result.txt',$2,'text/plain','REQUIRED',1024)`, [fixture.reserved.environment.id, pathDigest]);
      await applyPostgresMigrations(pool);
      const replay = await fixture.store.freezeNativeCollectionPlan(fixture.lease, fixture.reserved.environment.id, input);
      expect(replay).toMatchObject({ collectionPlanDigest: oldDigest, executionBoundaryKind: 'PROTECTED_RUNTIME',
        executionBoundaryDigest: profile.protectedRuntime!.runtimeDigest,
        workerRuntimeDigest: profile.protectedRuntime!.runtimeDigest });
    } finally {
      const resolvedSubset = resolve(subset); const resolvedTemporaryRoot = `${resolve(tmpdir())}${sep}`;
      if (!resolvedSubset.toLowerCase().startsWith(resolvedTemporaryRoot.toLowerCase())
          || !basename(resolvedSubset).startsWith('motive-boundary-migrations-')) {
        throw new Error('Refusing to remove an unsafe temporary migration directory.');
      }
      await rm(resolvedSubset, { recursive: true, force: true });
    }
  }, 40_000);
});
