import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCreditStore, CreditStoreError, initializeCreditSchema } from './credits.ts';

describe('local Motive credit ledger', () => {
  let db: Database.Database;
  let credits: ReturnType<typeof createCreditStore>;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec('CREATE TABLE user (id TEXT PRIMARY KEY)');
    initializeCreditSchema(db);
    credits = createCreditStore(db);
  });

  afterEach(() => db.close());

  function user(id: string) {
    db.prepare('INSERT INTO user (id) VALUES (?)').run(id);
    return id;
  }

  it('issues exactly one welcome grant across repeated eligible requests', () => {
    const actor = user('welcome-user');
    expect(credits.ensureWelcome(actor)).toMatchObject({
      unit: 'motive_credit', issued: 10, available: 10, allocated: 0,
      allocations: [], executionEnabled: false,
    });
    expect(credits.ensureWelcome(actor)).toEqual(credits.readWallet(actor));
    expect(db.prepare("SELECT count(*) AS count FROM credit_ledger_entries WHERE userId = ? AND kind = 'WELCOME_ISSUED'").get(actor))
      .toEqual({ count: 1 });
  });

  it('recovers the same receipt for the same actor, key, and body and conflicts on changed bodies', () => {
    const actor = user('idempotent-user');
    const first = credits.allocate(actor, 'allocation-key', { project: 'circle-packing', amount: 4 });
    const replay = credits.allocate(actor, 'allocation-key', { project: 'circle-packing', amount: 4 });
    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ ...first, replayed: true });
    expect(replay.wallet).toMatchObject({ issued: 10, allocated: 4, available: 6, executionEnabled: false });
    expect(() => credits.allocate(actor, 'allocation-key', { project: 'circle-packing', amount: 5 }))
      .toThrowError(expect.objectContaining<Partial<CreditStoreError>>({ code: 'IDEMPOTENCY_CONFLICT' }));
    expect(db.prepare('SELECT count(*) AS count FROM credit_allocations WHERE userId = ?').get(actor)).toEqual({ count: 1 });
    expect(db.prepare("SELECT count(*) AS count FROM credit_ledger_entries WHERE userId = ? AND kind = 'PROJECT_ALLOCATED'").get(actor))
      .toEqual({ count: 1 });
  });

  it('atomically prevents two competing allocations from overspending the wallet', async () => {
    const actor = user('bounded-user');
    credits.ensureWelcome(actor);
    const attempts = await Promise.allSettled([
      Promise.resolve().then(() => credits.allocate(actor, 'parallel-a', { project: 'circle-packing', amount: 6 })),
      Promise.resolve().then(() => credits.allocate(actor, 'parallel-b', { project: 'circle-packing', amount: 6 })),
    ]);
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'INSUFFICIENT_CREDITS' });
    expect(credits.readWallet(actor)).toMatchObject({ issued: 10, allocated: 6, available: 4 });
    expect(db.prepare('SELECT sum(amount) AS amount FROM credit_allocations WHERE userId = ?').get(actor)).toEqual({ amount: 6 });
  });
});
