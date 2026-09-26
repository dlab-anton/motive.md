import type { Pool } from 'pg';
import { LedgerKernel } from '../../packages/accounting/src/kernel.ts';
import type { AllocateCreditsInput } from '../../src/lib/credits.ts';
import type { SupportAction } from '../../src/lib/support.ts';
import {
  AccountError,
  type AccountPrincipal,
  type AccountRemoteAuthority,
  type AccountStore,
} from './types.ts';

type AccountServiceOptions = {
  store: AccountStore;
  remote: AccountRemoteAuthority;
  pool: Pool | null;
  disconnectFunding?: (actorId: string) => Promise<void>;
  now?: () => number;
};

const REMOTE_ACTIVE_TTL_MS = 5 * 60_000;
const REMOTE_ACTIVE_MAX_ENTRIES = 10_000;
const PROVIDER_FALLBACK_WARNING_INTERVAL_MS = 60_000;
const PROVIDER_UNAVAILABLE_BREAKER_MS = 60_000;

export class AccountService {
  private readonly ledger: LedgerKernel | null;
  private readonly now: () => number;
  // Positive remote confirmations only, keyed by actor, in insertion order so the oldest evicts first.
  private readonly remoteActiveUntil = new Map<string, number>();
  private lastFallbackWarningAt = Number.NEGATIVE_INFINITY;
  private suppressedFallbackWarnings = 0;
  // Per-process circuit breaker: after the provider is found unavailable, skip it until this time.
  private providerUnavailableUntil = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: AccountServiceOptions) {
    this.ledger = options.pool ? new LedgerKernel(options.pool) : null;
    this.now = options.now ?? Date.now;
  }

  async authenticate(header: string | undefined, establish = true): Promise<AccountPrincipal | null> {
    const principal = await this.options.remote.authenticate(header);
    if (!principal) return null;
    if (establish) await this.options.store.establish(principal);
    return principal;
  }

  // The durable store is authoritative for revocation and is read on every call. The remote identity check is
  // cached when positive, and an unavailable provider falls back to the durable ACTIVE status, then is not
  // consulted again until the breaker interval has passed.
  async isActorActive(actorId: string): Promise<boolean> {
    if (!actorId.startsWith('account:')) return false;
    const status = await this.options.store.status(actorId);
    if (status !== 'ACTIVE') return false;
    const cachedUntil = this.remoteActiveUntil.get(actorId);
    if (cachedUntil !== undefined) {
      if (this.now() < cachedUntil) return true;
      this.remoteActiveUntil.delete(actorId);
    }
    if (this.now() < this.providerUnavailableUntil) {
      this.warnProviderFallback();
      return true;
    }
    let active: boolean;
    try {
      active = await this.options.remote.isActive(actorId.slice('account:'.length));
    } catch (error) {
      if (!(error instanceof AccountError) || error.code !== 'UPSTREAM') throw error;
      this.providerUnavailableUntil = this.now() + PROVIDER_UNAVAILABLE_BREAKER_MS;
      this.warnProviderFallback();
      return true;
    }
    if (active) this.rememberRemoteActive(actorId);
    return active;
  }

  private rememberRemoteActive(actorId: string): void {
    this.remoteActiveUntil.delete(actorId);
    this.remoteActiveUntil.set(actorId, this.now() + REMOTE_ACTIVE_TTL_MS);
    while (this.remoteActiveUntil.size > REMOTE_ACTIVE_MAX_ENTRIES) {
      this.remoteActiveUntil.delete(this.remoteActiveUntil.keys().next().value!);
    }
  }

  private warnProviderFallback(): void {
    const now = this.now();
    if (now - this.lastFallbackWarningAt < PROVIDER_FALLBACK_WARNING_INTERVAL_MS) {
      this.suppressedFallbackWarnings += 1;
      return;
    }
    console.warn(JSON.stringify({
      event: 'account_provider_unavailable_fallback',
      suppressed: this.suppressedFallbackWarnings,
    }));
    this.lastFallbackWarningAt = now;
    this.suppressedFallbackWarnings = 0;
  }

  workspace(actorId: string) {
    return this.options.store.workspace(actorId);
  }

  follow(actorId: string, action: SupportAction) {
    return this.options.store.follow(actorId, action);
  }

  setBio(actorId: string, bio: string) {
    return this.options.store.setBio(actorId, bio);
  }

  readWallet(actorId: string) {
    return this.options.store.readWallet(actorId);
  }

  allocate(actorId: string, key: string, input: AllocateCreditsInput) {
    return this.options.store.allocate(actorId, key, input);
  }

  async deleteAccount(principal: AccountPrincipal, password: string): Promise<void> {
    if (!await this.options.remote.verifyPassword(principal, password)) {
      throw new AccountError('UNAUTHORIZED', 'Password confirmation failed.', 401);
    }
    const status = await this.options.store.status(principal.actorId);
    if (status === 'DELETED') {
      throw new AccountError('INACTIVE', 'The account is already deleted.', 401);
    }
    if (status === null) await this.options.store.establish(principal);

    await this.options.store.beginDeletion(principal.actorId);
    this.remoteActiveUntil.delete(principal.actorId);
    if (this.options.pool) {
      await revokeAccountProjectAuthority(this.options.pool, principal.actorId);
      await this.options.disconnectFunding?.(principal.actorId);
      if (this.ledger) {
        const grants = await this.options.pool.query(
          `SELECT id
             FROM motive.grants
            WHERE issuer_actor_id=$1 AND status='ACTIVE'
            ORDER BY id`,
          [principal.actorId],
        );
        for (const row of grants.rows) {
          await this.ledger.revokeGrant({
            actorId: principal.actorId,
            idempotencyKey: `account-delete:${row.id}`,
            grantId: row.id,
            reason: 'Account deletion revoked remaining authority.',
          });
        }
      }
    }
    await this.options.remote.deleteUser(principal.subjectId);
    await this.options.store.finalizeDeletion(principal.actorId);
    // A check that read ACTIVE before beginDeletion may have cached after the first clear.
    this.remoteActiveUntil.delete(principal.actorId);
  }
}

export async function revokeAccountProjectAuthority(pool: Pool, actorId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tokens = await client.query(
      `SELECT id
         FROM motive.participation_agent_tokens
        WHERE owner_actor_id=$1 AND revoked_at IS NULL
        ORDER BY id
        FOR UPDATE`,
      [actorId],
    );
    await client.query(
      `UPDATE motive.participation_agent_tokens
          SET revoked_at=clock_timestamp()
        WHERE owner_actor_id=$1 AND revoked_at IS NULL`,
      [actorId],
    );
    for (const token of tokens.rows) {
      await client.query(
        `UPDATE motive.work_claims
            SET status='REVOKED', released_at=clock_timestamp(), updated_at=clock_timestamp()
          WHERE operator_actor_id=$1 AND status='ACTIVE'`,
        [`agent:${token.id}`],
      );
    }
    await client.query(
      `UPDATE motive.memberships
          SET revoked_at=clock_timestamp()
        WHERE actor_id=$1 AND revoked_at IS NULL`,
      [actorId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}