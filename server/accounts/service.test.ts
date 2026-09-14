import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { AccountService } from './service.ts';
import type { AccountPrincipal, AccountRemoteAuthority, AccountStore } from './types.ts';

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
