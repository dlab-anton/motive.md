import type { Pool, PoolClient } from 'pg';
import { revokeAccountProjectAuthority } from './service.ts';
import { AccountError, type AccountPrincipal } from './types.ts';

const LOCAL_SUBJECT = /^[A-Za-z0-9._~-]{1,480}$/;

export type LocalAccountIdentity = Readonly<{
  provider: 'local-better-auth';
  subjectId: string;
  actorId: `account:${string}`;
}>;

export type LocalAccountIdentityBridge = Readonly<{
  establish(principal: AccountPrincipal): Promise<LocalAccountIdentity>;
  isActive(actorId: string): Promise<boolean>;
  retire(nativeUser: Readonly<{ subjectId: string; createdAt: Date }>): Promise<void>;
}>;

function identityFor(subjectId: string): LocalAccountIdentity {
  if (!LOCAL_SUBJECT.test(subjectId)) {
    throw new AccountError('UNAUTHORIZED', 'The local account identity is invalid.', 401);
  }
  return Object.freeze({ provider: 'local-better-auth', subjectId,
    actorId: `account:${subjectId}` as const });
}

/** Rechecks the exact local provider/subject binding in durable project state. */
export async function isLocalAccountIdentityActive(
  database: Pick<Pool, 'query'>,
  actorId: string,
): Promise<boolean> {
  if (!actorId.startsWith('account:')) return false;
  const subjectId = actorId.slice('account:'.length);
  if (!LOCAL_SUBJECT.test(subjectId) || identityFor(subjectId).actorId !== actorId) return false;
  const row = await database.query(
    `SELECT 1 FROM motive.account_identities
      WHERE actor_id=$1 AND provider='local-better-auth' AND subject_id=$2 AND status='ACTIVE'`,
    [actorId, subjectId],
  );
  return row.rowCount === 1;
}

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

/**
 * Connects an existing native Better Auth user to PostgreSQL project authority.
 * It deliberately creates no profile, wallet, membership, or agent credential.
 */
export function createLocalAccountIdentityBridge(pool: Pool): LocalAccountIdentityBridge {
  return Object.freeze({
    async establish(principal) {
      if (principal.provider !== 'local-better-auth') {
        throw new AccountError('UNAUTHORIZED', 'A local identity requires a local account.', 401);
      }
      const expected = identityFor(principal.subjectId);
      if (principal.actorId !== expected.actorId) {
        throw new AccountError('UNAUTHORIZED', 'The local account identity binding is invalid.', 401);
      }
      return transaction(pool, async client => {
        await client.query(
          `INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at)
           VALUES($1,'local-better-auth',$2,'ACTIVE',$3)
           ON CONFLICT DO NOTHING`,
          [expected.actorId, expected.subjectId, principal.createdAt],
        );
        const row = await client.query(
          `SELECT actor_id,provider,subject_id,status
             FROM motive.account_identities
            WHERE actor_id=$1 OR (provider='local-better-auth' AND subject_id=$2)
            ORDER BY actor_id
            FOR UPDATE`,
          [expected.actorId, expected.subjectId],
        );
        if (row.rowCount !== 1 || row.rows[0]?.actor_id !== expected.actorId
            || row.rows[0]?.provider !== expected.provider || row.rows[0]?.subject_id !== expected.subjectId) {
          throw new AccountError('UNAUTHORIZED', 'The local account identity conflicts with an existing identity.', 401);
        }
        if (row.rows[0]?.status !== 'ACTIVE') {
          throw new AccountError('INACTIVE', 'This local account is no longer active.', 403);
        }
        return expected;
      });
    },

    async isActive(actorId) {
      return isLocalAccountIdentityActive(pool, actorId);
    },

    async retire(nativeUser) {
      const expected = identityFor(nativeUser.subjectId);
      const status = await transaction(pool, async client => {
        // Even a user deleting immediately after signup receives a tombstone.
        // That prevents a stale native session from establishing project authority.
        await client.query(
          `INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at)
           VALUES($1,'local-better-auth',$2,'ACTIVE',$3)
           ON CONFLICT DO NOTHING`,
          [expected.actorId, expected.subjectId, nativeUser.createdAt],
        );
        const row = await client.query(
          `SELECT provider,subject_id,status FROM motive.account_identities
            WHERE actor_id=$1 FOR UPDATE`, [expected.actorId],
        );
        if (row.rowCount !== 1 || row.rows[0]?.provider !== expected.provider
            || row.rows[0]?.subject_id !== expected.subjectId) {
          throw new AccountError('UNAUTHORIZED', 'The local account identity binding is invalid.', 401);
        }
        if (row.rows[0]?.status === 'ACTIVE') {
          await client.query(
            `UPDATE motive.account_identities
                SET status='DELETION_PENDING',deletion_requested_at=clock_timestamp()
              WHERE actor_id=$1`, [expected.actorId],
          );
          return 'DELETION_PENDING' as const;
        }
        return row.rows[0]?.status as 'DELETION_PENDING' | 'DELETED';
      });
      if (status === 'DELETED') return;

      // DELETION_PENDING is a durable fail-closed tombstone. A retry completes
      // revocation if a prior native deletion attempt stopped partway through.
      await revokeAccountProjectAuthority(pool, expected.actorId);
      await transaction(pool, async client => {
        const updated = await client.query(
          `UPDATE motive.account_identities
              SET status='DELETED',deleted_at=clock_timestamp()
            WHERE actor_id=$1 AND provider='local-better-auth' AND subject_id=$2
              AND status='DELETION_PENDING'`,
          [expected.actorId, expected.subjectId],
        );
        if (updated.rowCount !== 1) {
          const current = await client.query(
            `SELECT status FROM motive.account_identities
              WHERE actor_id=$1 AND provider='local-better-auth' AND subject_id=$2 FOR UPDATE`,
            [expected.actorId, expected.subjectId],
          );
          if (current.rowCount === 1 && current.rows[0]?.status === 'DELETED') return;
          throw new AccountError('INACTIVE', 'The local account deletion state changed unexpectedly.', 409);
        }
      });
    },
  });
}
