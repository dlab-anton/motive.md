import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { createSupabaseAccountAuthority } from '../../server/accounts/supabase.ts';
import { loadAccountConfiguration, type AccountConfiguration } from '../../server/accounts/config.ts';
import type { AccountRemoteAuthority } from '../../server/accounts/types.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type OperatorAccountSelector =
  | { accountEmail: string; accountId?: never }
  | { accountId: string; accountEmail?: never };

export type ResolvedOperatorAccount = Readonly<{
  provider: 'local-better-auth' | 'supabase';
  subjectId: string;
  actorId: `account:${string}`;
  remote: Pick<AccountRemoteAuthority, 'isActive'> | null;
}>;

export type CommandAccountActivityResolver = Readonly<{
  isActorActive(actorId: string): Promise<boolean>;
  close(): void;
}>;

type EnvironmentSource = Readonly<Record<string, string | undefined>>;
type LocalLookup = (email: string, path: string) => Promise<string | null>;

async function defaultLocalLookup(email: string, path: string): Promise<string | null> {
  const { default: BetterSqliteDatabase } = await import('better-sqlite3');
  const database: Database.Database = new BetterSqliteDatabase(path, { readonly: true, fileMustExist: true });
  try {
    const row = database.prepare('SELECT id FROM user WHERE lower(email)=lower(?)').get(email) as { id?: unknown } | undefined;
    return typeof row?.id === 'string' && row.id.length > 0 ? row.id : null;
  } finally { database.close(); }
}

/**
 * Resolves every account referenced by a privileged command through the same
 * durable and remote account boundaries used by the application. The returned
 * callback intentionally uses the unguarded base pool: delivery invokes it
 * before acquiring the transaction whose authority rows remain locked during
 * an outbound request.
 */
export async function createCommandAccountActivityResolver(input: {
  pool: Pick<Pool, 'query'>;
  configuration: AccountConfiguration;
  env?: EnvironmentSource;
  remote?: Pick<AccountRemoteAuthority, 'isActive'>;
}): Promise<CommandAccountActivityResolver> {
  const env = input.env ?? process.env;
  if (input.configuration.provider === 'local-better-auth') {
    const { default: BetterSqliteDatabase } = await import('better-sqlite3');
    const path = resolve(env.MOTIVE_DATA_DIR?.trim() || '.local', 'motive.sqlite');
    const database: Database.Database = new BetterSqliteDatabase(path, { readonly: true, fileMustExist: true });
    return Object.freeze({
      async isActorActive(actorId: string) {
        if (!actorId.startsWith('account:')) return false;
        const subjectId = actorId.slice('account:'.length);
        if (subjectId.length === 0 || !database.prepare('SELECT id FROM user WHERE id=?').get(subjectId)) return false;
        const identity = await input.pool.query(
          `SELECT provider,subject_id,status
             FROM motive.account_identities
            WHERE actor_id=$1`,
          [actorId],
        );
        return identity.rowCount === 1
          && identity.rows[0]?.provider === 'local-better-auth'
          && identity.rows[0]?.subject_id === subjectId
          && identity.rows[0]?.status === 'ACTIVE';
      },
      close() { database.close(); },
    });
  }

  const remote = input.remote ?? createSupabaseAccountAuthority(input.configuration.supabase!);
  return Object.freeze({
    async isActorActive(actorId: string) {
      if (!actorId.startsWith('account:')) return false;
      const subjectId = actorId.slice('account:'.length);
      if (!UUID.test(subjectId)) return false;
      const identity = await input.pool.query(
        `SELECT provider,subject_id,status
           FROM motive.account_identities
          WHERE actor_id=$1`,
        [actorId],
      );
      return identity.rowCount === 1
        && identity.rows[0]?.provider === 'supabase'
        && identity.rows[0]?.subject_id === subjectId
        && identity.rows[0]?.status === 'ACTIVE'
        && await remote.isActive(subjectId);
    },
    close() {},
  });
}

export async function resolveOperatorAccount(input: {
  selector: OperatorAccountSelector;
  pool: Pick<Pool, 'query'>;
  env?: EnvironmentSource;
  configuration?: AccountConfiguration;
  localLookup?: LocalLookup;
  remote?: Pick<AccountRemoteAuthority, 'isActive'>;
}): Promise<ResolvedOperatorAccount> {
  const env = input.env ?? process.env;
  const configuration = input.configuration ?? loadAccountConfiguration(env);
  if (configuration.provider === 'local-better-auth') {
    if (!('accountEmail' in input.selector) || typeof input.selector.accountEmail !== 'string'
        || !/^[^\s@]+@[^\s@]+$/.test(input.selector.accountEmail) || input.selector.accountEmail.length > 320) {
      throw new Error('LOCAL_OPERATOR_ACCOUNT_EMAIL_REQUIRED');
    }
    const path = resolve(env.MOTIVE_DATA_DIR?.trim() || '.local', 'motive.sqlite');
    const subjectId = await (input.localLookup ?? defaultLocalLookup)(input.selector.accountEmail, path);
    if (!subjectId) throw new Error('LOCAL_OPERATOR_ACCOUNT_NOT_FOUND');
    const actorId = `account:${subjectId}` as const;
    const identity = await input.pool.query(
      `SELECT provider,subject_id,status FROM motive.account_identities WHERE actor_id=$1`, [actorId],
    );
    if (identity.rowCount !== 1 || identity.rows[0]?.provider !== 'local-better-auth'
        || identity.rows[0]?.subject_id !== subjectId || identity.rows[0]?.status !== 'ACTIVE') {
      throw new Error('LOCAL_OPERATOR_ACCOUNT_NOT_ACTIVE');
    }
    return Object.freeze({ provider: configuration.provider, subjectId, actorId, remote: null });
  }

  if (!('accountId' in input.selector) || typeof input.selector.accountId !== 'string'
      || !UUID.test(input.selector.accountId)) throw new Error('SUPABASE_OPERATOR_ACCOUNT_ID_REQUIRED');
  const subjectId = input.selector.accountId;
  const actorId = `account:${subjectId}` as const;
  const identity = await input.pool.query(
    `SELECT provider,subject_id,status FROM motive.account_identities WHERE actor_id=$1`, [actorId],
  );
  if (identity.rowCount !== 1 || identity.rows[0]?.provider !== 'supabase'
      || identity.rows[0]?.subject_id !== subjectId || identity.rows[0]?.status !== 'ACTIVE') {
    throw new Error('SUPABASE_OPERATOR_ACCOUNT_NOT_ACTIVE');
  }
  const remote = input.remote ?? createSupabaseAccountAuthority(configuration.supabase!);
  if (!await remote.isActive(subjectId)) throw new Error('SUPABASE_OPERATOR_ACCOUNT_NOT_ACTIVE');
  return Object.freeze({ provider: configuration.provider, subjectId, actorId, remote });
}

/** Lock and recheck immediately before a privileged transaction mutates project authority. */
export async function assertOperatorAccountActive(
  client: Pick<PoolClient, 'query'>,
  account: ResolvedOperatorAccount,
): Promise<void> {
  const identity = await client.query(
    `SELECT provider,subject_id,status FROM motive.account_identities WHERE actor_id=$1 FOR UPDATE`, [account.actorId],
  );
  if (identity.rowCount !== 1 || identity.rows[0]?.provider !== account.provider
      || identity.rows[0]?.subject_id !== account.subjectId || identity.rows[0]?.status !== 'ACTIVE') {
    throw new Error(account.provider === 'supabase'
      ? 'SUPABASE_OPERATOR_ACCOUNT_NOT_ACTIVE' : 'LOCAL_OPERATOR_ACCOUNT_NOT_ACTIVE');
  }
  if (account.provider === 'supabase' && (!account.remote || !await account.remote.isActive(account.subjectId))) {
    throw new Error('SUPABASE_OPERATOR_ACCOUNT_NOT_ACTIVE');
  }
}

/** Injects the identity lock into a service that begins and owns its own transaction. */
export function guardOperatorTransactions(pool: Pool, account: ResolvedOperatorAccount): Pool {
  return new Proxy(pool, {
    get(target, property, receiver) {
      if (property !== 'connect') {
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return async () => {
        const client = await target.connect();
        return new Proxy(client, {
          get(clientTarget, clientProperty, clientReceiver) {
            if (clientProperty !== 'query') {
              const value = Reflect.get(clientTarget, clientProperty, clientReceiver);
              return typeof value === 'function' ? value.bind(clientTarget) : value;
            }
            return async (...args: unknown[]) => {
              const result = await (clientTarget.query as (...queryArgs: unknown[]) => Promise<QueryResult>)
                .apply(clientTarget, args);
              if (typeof args[0] === 'string' && args[0].trim().toUpperCase() === 'BEGIN') {
                await assertOperatorAccountActive(clientTarget, account);
              }
              return result;
            };
          },
        });
      };
    },
  });
}
