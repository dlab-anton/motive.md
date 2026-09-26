import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { AccountService } from './service.ts';
import { AccountError, type AccountPrincipal, type AccountRemoteAuthority, type AccountStore } from './types.ts';

const subjectId = '22222222-2222-4222-8222-222222222222';
const actorId = `account:${subjectId}` as const;
const principal: AccountPrincipal = {
  provider: 'supabase', subjectId, actorId, name: 'Member', email: 'member@example.test',
  createdAt: new Date('2026-09-01T00:00:00.000Z'), emailVerified: true,
};

function store(overrides: Partial<AccountStore> = {}): AccountStore {
  return {
    establish: vi.fn(async () => undefined),
    status: vi.fn(async () => 'ACTIVE' as const),
    workspace: vi.fn(async () => ({ support: { following: [] }, bio: '' })),
    follow: vi.fn(async () => ({ following: [] })),
    setBio: vi.fn(async value => value),
    ensureWelcome: vi.fn(async () => { throw new Error('unused'); }),
    readWallet: vi.fn(async () => { throw new Error('unused'); }),
    allocate: vi.fn(async () => { throw new Error('unused'); }),
    beginDeletion: vi.fn(async () => 'STARTED' as const),
    finalizeDeletion: vi.fn(async () => undefined),
    ...overrides,
  };
}

function remote(overrides: Partial<AccountRemoteAuthority> = {}): AccountRemoteAuthority {
  return {
    authenticate: vi.fn(async () => principal),
    verifyPassword: vi.fn(async () => true),
    isActive: vi.fn(async () => true),
    deleteUser: vi.fn(async () => undefined),
    ...overrides,
  };
}

function revocationPool(events: string[]): Pool {
  const client = {
    async query(sql: string) {
      if (sql === 'BEGIN') events.push('authority:begin');
      if (sql.includes('participation_agent_tokens') && sql.startsWith('SELECT')) {
        events.push('authority:lock-tokens');
        return { rowCount: 1, rows: [{ id: '33333333-3333-4333-8333-333333333333' }] };
      }
      if (sql.includes('UPDATE motive.memberships')) events.push('authority:memberships-revoked');
      if (sql === 'COMMIT') events.push('authority:commit');
      return { rowCount: 0, rows: [] };
    },
    release: vi.fn(),
  };
  return {
    connect: vi.fn(async () => client),
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM motive.grants')) events.push('authority:grants-read');
      return { rowCount: 0, rows: [] };
    }),
  } as unknown as Pool;
}

describe('Supabase account service authority', () => {
  it('requires both durable ACTIVE status and a live remote identity', async () => {
    const accountStore = store();
    const accountRemote = remote();
    const service = new AccountService({ store: accountStore, remote: accountRemote, pool: null });
    await expect(service.isActorActive(actorId)).resolves.toBe(true);
    expect(accountRemote.isActive).toHaveBeenCalledWith(subjectId);

    vi.mocked(accountStore.status).mockResolvedValueOnce('DELETION_PENDING');
    await expect(service.isActorActive(actorId)).resolves.toBe(false);
    expect(accountRemote.isActive).toHaveBeenCalledTimes(1);
  });

  it('marks the account inactive before revoking project authority and deleting upstream', async () => {
    const events: string[] = [];
    const accountStore = store({
      beginDeletion: vi.fn(async () => { events.push('identity:pending'); return 'STARTED' as const; }),
      finalizeDeletion: vi.fn(async () => { events.push('identity:deleted'); }),
    });
    const accountRemote = remote({
      verifyPassword: vi.fn(async () => { events.push('password:verified'); return true; }),
      deleteUser: vi.fn(async () => { events.push('remote:deleted'); }),
    });
    const pool = revocationPool(events);
    const service = new AccountService({
      store: accountStore,
      remote: accountRemote,
      pool,
      disconnectFunding: async () => { events.push('funding:disconnected'); },
    });

    await service.deleteAccount(principal, 'fresh-password');
    expect(events).toEqual([
      'password:verified',
      'identity:pending',
      'authority:begin',
      'authority:lock-tokens',
      'authority:memberships-revoked',
      'authority:commit',
      'funding:disconnected',
      'authority:grants-read',
      'remote:deleted',
      'identity:deleted',
    ]);
  });

  it('does not change durable authority after a failed password check', async () => {
    const accountStore = store();
    const service = new AccountService({
      store: accountStore,
      remote: remote({ verifyPassword: vi.fn(async () => false) }),
      pool: null,
    });
    await expect(service.deleteAccount(principal, 'wrong-password')).rejects.toMatchObject({
      code: 'UNAUTHORIZED', status: 401,
    });
    expect(accountStore.beginDeletion).not.toHaveBeenCalled();
    expect(accountStore.finalizeDeletion).not.toHaveBeenCalled();
  });
});

describe('Supabase account activity cache and provider fallback', () => {
  const unavailable = () => new AccountError('UPSTREAM', 'The account provider is unavailable.', 502);
  let time: number;
  let warn: MockInstance<typeof console.warn>;

  beforeEach(() => {
    time = Date.parse('2026-09-26T00:00:00.000Z');
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  function service(accountStore: AccountStore, accountRemote: AccountRemoteAuthority) {
    return new AccountService({ store: accountStore, remote: accountRemote, pool: null, now: () => time });
  }

  it('falls back to durable ACTIVE status while the provider is unavailable', async () => {
    const accountStore = store();
    const accountRemote = remote({ isActive: vi.fn(async () => { throw unavailable(); }) });
    const accounts = service(accountStore, accountRemote);

    await expect(accounts.isActorActive(actorId)).resolves.toBe(true);
    expect(accountRemote.isActive).toHaveBeenCalledWith(subjectId);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    expect(JSON.parse(line)).toEqual({ event: 'account_provider_unavailable_fallback', suppressed: 0 });
    expect(line).not.toContain(subjectId);
    expect(line).not.toContain(principal.email);
  });

  it('keeps durable revocation authoritative while the provider is unavailable', async () => {
    const accountRemote = remote({ isActive: vi.fn(async () => { throw unavailable(); }) });
    for (const status of ['DELETION_PENDING', 'DELETED', null] as const) {
      const accounts = service(store({ status: vi.fn(async () => status) }), accountRemote);
      await expect(accounts.isActorActive(actorId)).resolves.toBe(false);
    }
    await expect(service(store(), accountRemote).isActorActive('agent:33333333-3333-4333-8333-333333333333'))
      .resolves.toBe(false);
    expect(accountRemote.isActive).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('rate-limits the fallback warning to about once per minute, counting breaker fallbacks', async () => {
    const accountRemote = remote({ isActive: vi.fn(async () => { throw unavailable(); }) });
    const accounts = service(store(), accountRemote);
    await accounts.isActorActive(actorId);
    time += 30_000;
    await accounts.isActorActive(actorId);
    await accounts.isActorActive(actorId);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(accountRemote.isActive).toHaveBeenCalledTimes(1);

    time += 30_000;
    await accounts.isActorActive(actorId);
    expect(accountRemote.isActive).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(warn.mock.calls[1]![0]))).toEqual({
      event: 'account_provider_unavailable_fallback', suppressed: 2,
    });
  });

  it('opens a one-minute breaker after one unavailable response, then probes the provider again', async () => {
    const otherActor = 'account:33333333-3333-4333-8333-333333333333';
    const accountStore = store();
    const accountRemote = remote({
      isActive: vi.fn()
        .mockRejectedValueOnce(unavailable())
        .mockRejectedValueOnce(unavailable())
        .mockResolvedValue(true),
    });
    const accounts = service(accountStore, accountRemote);
    const opened = time;

    await expect(accounts.isActorActive(actorId)).resolves.toBe(true);
    expect(accountRemote.isActive).toHaveBeenCalledTimes(1);
    time = opened + 60_000 - 1;
    await expect(accounts.isActorActive(actorId)).resolves.toBe(true);
    await expect(accounts.isActorActive(otherActor)).resolves.toBe(true);
    vi.mocked(accountStore.status).mockResolvedValueOnce('DELETED');
    await expect(accounts.isActorActive(otherActor)).resolves.toBe(false);
    expect(accountRemote.isActive).toHaveBeenCalledTimes(1);
    expect(accountStore.status).toHaveBeenCalledTimes(4);

    // The probe finds the provider still unavailable and reopens the breaker for another minute.
    time = opened + 60_000;
    await expect(accounts.isActorActive(actorId)).resolves.toBe(true);
    expect(accountRemote.isActive).toHaveBeenCalledTimes(2);
    time = opened + 120_000 - 1;
    await expect(accounts.isActorActive(otherActor)).resolves.toBe(true);
    expect(accountRemote.isActive).toHaveBeenCalledTimes(2);

    time = opened + 120_000;
    await expect(accounts.isActorActive(actorId)).resolves.toBe(true);
    await expect(accounts.isActorActive(otherActor)).resolves.toBe(true);
    expect(accountRemote.isActive).toHaveBeenCalledTimes(4);
    expect(accountRemote.isActive).toHaveBeenLastCalledWith('33333333-3333-4333-8333-333333333333');
  });

  it('does not cache a fallback, so a recovered provider applies its answer once the breaker closes', async () => {
    const accountRemote = remote({
      isActive: vi.fn().mockRejectedValueOnce(unavailable()).mockResolvedValueOnce(false),
    });
    const accounts = service(store(), accountRemote);
    await expect(accounts.isActorActive(actorId)).resolves.toBe(true);
    time += 60_000;
    await expect(accounts.isActorActive(actorId)).resolves.toBe(false);
    expect(accountRemote.isActive).toHaveBeenCalledTimes(2);
  });

  it('caches a positive remote result for five minutes while reading durable status every call', async () => {
    const accountStore = store();
    const accountRemote = remote();
    const accounts = service(accountStore, accountRemote);

    await expect(accounts.isActorActive(actorId)).resolves.toBe(true);
    time += 5 * 60_000 - 1;
    await expect(accounts.isActorActive(actorId)).resolves.toBe(true);
    await expect(accounts.isActorActive(actorId)).resolves.toBe(true);
    expect(accountRemote.isActive).toHaveBeenCalledTimes(1);
    expect(accountStore.status).toHaveBeenCalledTimes(3);

    vi.mocked(accountStore.status).mockResolvedValueOnce('DELETION_PENDING');
    await expect(accounts.isActorActive(actorId)).resolves.toBe(false);
    expect(accountRemote.isActive).toHaveBeenCalledTimes(1);

    time += 1;
    await expect(accounts.isActorActive(actorId)).resolves.toBe(true);
    expect(accountRemote.isActive).toHaveBeenCalledTimes(2);
  });

  it('does not cache a negative remote result', async () => {
    const accountRemote = remote({ isActive: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true) });
    const accounts = service(store(), accountRemote);
    await expect(accounts.isActorActive(actorId)).resolves.toBe(false);
    await expect(accounts.isActorActive(actorId)).resolves.toBe(true);
    expect(accountRemote.isActive).toHaveBeenCalledTimes(2);
  });

  it.each([
    new AccountError('CONFIGURATION', 'The account provider is unavailable.', 502),
    new Error('unexpected failure'),
  ])('propagates a failure other than provider unavailability without opening the breaker %#', async failure => {
    const accountRemote = remote({ isActive: vi.fn(async () => { throw failure; }) });
    const accounts = service(store(), accountRemote);
    await expect(accounts.isActorActive(actorId)).rejects.toBe(failure);
    await expect(accounts.isActorActive(actorId)).rejects.toBe(failure);
    expect(accountRemote.isActive).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it('evicts the oldest cached actor beyond ten thousand entries', async () => {
    const accountRemote = remote();
    const accounts = service(store(), accountRemote);
    const actor = (index: number) => `account:${String(index).padStart(12, '0')}`;
    for (let index = 0; index <= 10_000; index += 1) await accounts.isActorActive(actor(index));
    expect(accountRemote.isActive).toHaveBeenCalledTimes(10_001);

    await accounts.isActorActive(actor(10_000));
    expect(accountRemote.isActive).toHaveBeenCalledTimes(10_001);
    await accounts.isActorActive(actor(0));
    expect(accountRemote.isActive).toHaveBeenCalledTimes(10_002);
  });

  it('clears the cached remote result when the account is deleted', async () => {
    const accountStore = store();
    const accountRemote = remote();
    const accounts = service(accountStore, accountRemote);
    await expect(accounts.isActorActive(actorId)).resolves.toBe(true);
    expect(accountRemote.isActive).toHaveBeenCalledTimes(1);

    await accounts.deleteAccount(principal, 'fresh-password');
    expect(accountStore.beginDeletion).toHaveBeenCalledWith(actorId);
    // Were durable status ever ACTIVE again, the remote identity would be consulted afresh.
    await expect(accounts.isActorActive(actorId)).resolves.toBe(true);
    expect(accountRemote.isActive).toHaveBeenCalledTimes(2);
  });

  it('clears the cached remote result once deletion begins, even if upstream deletion fails', async () => {
    const accountStore = store();
    const accountRemote = remote({ deleteUser: vi.fn(async () => { throw unavailable(); }) });
    const accounts = service(accountStore, accountRemote);
    await expect(accounts.isActorActive(actorId)).resolves.toBe(true);

    await expect(accounts.deleteAccount(principal, 'fresh-password')).rejects.toMatchObject({ code: 'UPSTREAM' });
    expect(accountStore.finalizeDeletion).not.toHaveBeenCalled();
    await expect(accounts.isActorActive(actorId)).resolves.toBe(true);
    expect(accountRemote.isActive).toHaveBeenCalledTimes(2);
  });
});
