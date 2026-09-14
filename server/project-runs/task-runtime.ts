import { Pool } from 'pg';
import {
  TriggerOutboxDispatcher,
  configureAttemptTaskRuntime,
  isAttemptTaskRuntimeConfigured,
  triggerSdkTaskClient,
  type AttemptTaskTrigger,
  type DispatchBatchResult,
  type RegisteredAttemptTaskRuntime,
} from '../../packages/dispatcher-trigger/src/index.ts';
import { PostgresOrchestrationStore } from '../../packages/orchestration/src/store.ts';
import { getPostgresSchemaStatus, postgresPoolConfigFromEnvironment } from '../../packages/accounting/src/migrations.ts';
import { loadCircleProjectRunConfig } from './config.ts';
import { CIRCLE_PROJECT_LEAD_ACTOR_ID } from './dispatcher.ts';
import {
  createCircleProjectRunApplication,
  type CircleProjectRunApplication,
} from './runtime.ts';

type EnvironmentSource = Readonly<Record<string, string | undefined>>;
type ApplicationFactory = (env: EnvironmentSource) => Promise<CircleProjectRunApplication>;

export type CircleAttemptTaskRuntime = RegisteredAttemptTaskRuntime & {
  close(): Promise<void>;
};

/**
 * Lazily opens the server-side application inside the Trigger worker. The task
 * payload contributes only an attempt UUID; persisted activation authority
 * selects the project budget, actor, frozen profile, and work order.
 */
export function createCircleAttemptTaskRuntime(options: {
  env?: EnvironmentSource;
  applicationFactory?: ApplicationFactory;
} = {}): CircleAttemptTaskRuntime {
  const env = options.env ?? process.env;
  const applicationFactory = options.applicationFactory ?? createCircleProjectRunApplication;
  let application: Promise<CircleProjectRunApplication> | null = null;
  let closed = false;
  const getApplication = () => {
    if (closed) throw new Error('CIRCLE_ATTEMPT_TASK_RUNTIME_CLOSED');
    application ??= applicationFactory(env);
    return application;
  };
  return {
    coordinator: {
      async reconcileAttempt(attemptId) {
        return (await getApplication()).reconcileAttempt(attemptId);
      },
      async reconcileOrphans() {
        return (await getApplication()).reconcileOrphans();
      },
    },
    waitSeconds: 30,
    maxPasses: 8,
    async close() {
      if (closed) return;
      closed = true;
      if (application) await (await application).close();
    },
  };
}

/**
 * Registers only when database and provider control credentials exist. Other
 * reviewed resources remain checked by the application before effects; their
 * absence still permits teardown of already-owned provider environments.
 */
export function bootstrapCircleAttemptTaskRuntime(options: {
  env?: EnvironmentSource;
  applicationFactory?: ApplicationFactory;
} = {}): boolean {
  if (isAttemptTaskRuntimeConfigured()) return true;
  const env = options.env ?? process.env;
  const config = loadCircleProjectRunConfig(env);
  if (!config.databaseConfigured || !config.vercel) return false;
  configureAttemptTaskRuntime(createCircleAttemptTaskRuntime({ env,
    ...(options.applicationFactory ? { applicationFactory: options.applicationFactory } : {}) }));
  return true;
}

export function createCircleAttemptWakeDispatcher(options: {
  pool: Pool;
  trigger?: AttemptTaskTrigger;
  consumerId?: string;
  limit?: number;
}): TriggerOutboxDispatcher {
  return new TriggerOutboxDispatcher(
    new PostgresOrchestrationStore(options.pool),
    options.trigger ?? triggerSdkTaskClient,
    { consumerId: options.consumerId ?? 'circle-project-trigger-dispatch',
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      attemptScope: { kind: 'PROJECT_LEAD_ACTIVATION', projectSlug: 'circle-packing',
        beneficiaryActorId: CIRCLE_PROJECT_LEAD_ACTOR_ID } },
  );
}

/** Claims and hands off one bounded fenced outbox batch; it does not schedule itself. */
export async function dispatchCircleAttemptWakeBatch(options: {
  pool: Pool;
  trigger?: AttemptTaskTrigger;
  consumerId?: string;
  limit?: number;
}): Promise<DispatchBatchResult> {
  return createCircleAttemptWakeDispatcher(options).dispatchBatch();
}

/** Opens one finite database session for a local/operator or scheduled Trigger invocation. */
export async function dispatchCircleAttemptWakeBatchFromEnvironment(
  env: EnvironmentSource = process.env,
  trigger: AttemptTaskTrigger = triggerSdkTaskClient,
): Promise<DispatchBatchResult> {
  const secret = env.TRIGGER_SECRET_KEY?.trim(); const project = env.TRIGGER_PROJECT_REF?.trim();
  if (!secret || !project?.startsWith('proj_')) throw new Error('CIRCLE_TRIGGER_DISPATCH_UNCONFIGURED');
  const config = loadCircleProjectRunConfig(env);
  if (!config.databaseConfigured) throw new Error('CIRCLE_TRIGGER_DATABASE_UNCONFIGURED');
  const pool = new Pool(postgresPoolConfigFromEnvironment(env as NodeJS.ProcessEnv));
  try {
    const schema = await getPostgresSchemaStatus(pool);
    if (!schema.exact) throw new Error('CIRCLE_TRIGGER_DATABASE_SCHEMA_MISMATCH');
    return await dispatchCircleAttemptWakeBatch({ pool, trigger });
  } finally { await pool.end(); }
}
