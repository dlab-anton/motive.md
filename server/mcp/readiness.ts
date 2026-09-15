import type { Pool } from 'pg';
import { getPostgresSchemaStatus } from '../../packages/accounting/src/migrations.ts';
import { memoryRecoveryMigrationPending } from '../app-database.ts';

/** Read-only gate shared by every OAuth/MCP route, including warm rollout instances. */
export function createMcpSchemaReadiness(pool: Pool): () => Promise<boolean> {
  let validUntil = 0;
  let ready = false;
  let pending: Promise<boolean> | null = null;
  return () => {
    if (Date.now() < validUntil) return Promise.resolve(ready);
    if (pending) return pending;
    pending = getPostgresSchemaStatus(pool)
      .then(schema => schema.exact === true || memoryRecoveryMigrationPending(schema), () => false)
      .then(result => {
        ready = result;
        validUntil = Date.now() + 5_000;
        return ready;
      })
      .finally(() => { pending = null; });
    return pending;
  };
}
