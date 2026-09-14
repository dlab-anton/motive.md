import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  CREDIT_ALLOCATION_STATUS,
  MOTIVE_CREDIT_UNIT,
  WELCOME_CREDIT_AMOUNT,
  type AllocateCreditsInput,
  type AllocateCreditsResponse,
  type CreditAllocation,
  type CreditProject,
  type CreditWallet,
} from '../src/lib/credits.ts';

type WalletRow = { issued: number; allocated: number };
type AllocationRow = {
  id: string;
  project: CreditProject;
  amount: number;
  status: typeof CREDIT_ALLOCATION_STATUS;
  createdAt: string;
  requestDigest?: string;
};

export class CreditStoreError extends Error {
  constructor(
    readonly code: 'IDEMPOTENCY_CONFLICT' | 'INSUFFICIENT_CREDITS',
    message: string,
  ) {
    super(message);
    this.name = 'CreditStoreError';
  }
}

function digest(input: AllocateCreditsInput): string {
  return `sha256:${createHash('sha256').update(JSON.stringify({ project: input.project, amount: input.amount })).digest('hex')}`;
}

function allocation(row: AllocationRow): CreditAllocation {
  return { id: row.id, project: row.project, amount: row.amount, status: row.status, createdAt: row.createdAt };
}

export function initializeCreditSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS credit_wallets (
      userId TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
      unit TEXT NOT NULL CHECK (unit = 'motive_credit'),
      issued INTEGER NOT NULL CHECK (issued = 10),
      allocated INTEGER NOT NULL DEFAULT 0 CHECK (allocated >= 0 AND allocated <= issued),
      issuedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS credit_allocations (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL REFERENCES credit_wallets(userId) ON DELETE CASCADE,
      project TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK (amount > 0),
      status TEXT NOT NULL CHECK (status = 'WAITING_FOR_FUNDED_RUN'),
      idempotencyKey TEXT NOT NULL,
      requestDigest TEXT NOT NULL CHECK (requestDigest GLOB 'sha256:[0-9a-f]*' AND length(requestDigest) = 71),
      createdAt TEXT NOT NULL,
      UNIQUE (userId, idempotencyKey)
    );
    CREATE TABLE IF NOT EXISTS credit_ledger_entries (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL REFERENCES credit_wallets(userId) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('WELCOME_ISSUED', 'PROJECT_ALLOCATED')),
      amount INTEGER NOT NULL CHECK (amount > 0),
      project TEXT,
      allocationId TEXT REFERENCES credit_allocations(id) ON DELETE CASCADE,
      createdAt TEXT NOT NULL,
      CHECK (
        (kind = 'WELCOME_ISSUED' AND project IS NULL AND allocationId IS NULL)
        OR (kind = 'PROJECT_ALLOCATED' AND project IS NOT NULL AND allocationId IS NOT NULL)
      )
    );
    CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_one_welcome_idx
      ON credit_ledger_entries(userId) WHERE kind = 'WELCOME_ISSUED';
    CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_one_allocation_idx
      ON credit_ledger_entries(allocationId) WHERE allocationId IS NOT NULL;
  `);
}

export function createCreditStore(db: Database.Database) {
  const insertWallet = db.prepare(`INSERT OR IGNORE INTO credit_wallets
    (userId, unit, issued, allocated, issuedAt) VALUES (?, ?, ?, 0, ?)`);
  const insertLedger = db.prepare(`INSERT INTO credit_ledger_entries
    (id, userId, kind, amount, project, allocationId, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const selectWallet = db.prepare('SELECT issued, allocated FROM credit_wallets WHERE userId = ?');
  const selectAllocations = db.prepare(`SELECT id, project, amount, status, createdAt
    FROM credit_allocations WHERE userId = ? ORDER BY createdAt, id`);
  const selectRequest = db.prepare(`SELECT id, project, amount, status, createdAt, requestDigest
    FROM credit_allocations WHERE userId = ? AND idempotencyKey = ?`);
  const updateAllocated = db.prepare(`UPDATE credit_wallets SET allocated = allocated + ?
    WHERE userId = ? AND issued - allocated >= ?`);
  const insertAllocation = db.prepare(`INSERT INTO credit_allocations
    (id, userId, project, amount, status, idempotencyKey, requestDigest, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

  const readWallet = (userId: string): CreditWallet => {
    const row = selectWallet.get(userId) as WalletRow | undefined;
    if (!row) throw new Error('Credit wallet was not initialized.');
    return {
      unit: MOTIVE_CREDIT_UNIT,
      issued: row.issued,
      available: row.issued - row.allocated,
      allocated: row.allocated,
      allocations: (selectAllocations.all(userId) as AllocationRow[]).map(allocation),
      executionEnabled: false,
    };
  };

  const ensureWelcome = db.transaction((userId: string): CreditWallet => {
    const issuedAt = new Date().toISOString();
    const inserted = insertWallet.run(userId, MOTIVE_CREDIT_UNIT, WELCOME_CREDIT_AMOUNT, issuedAt);
    if (inserted.changes === 1) {
      insertLedger.run(randomUUID(), userId, 'WELCOME_ISSUED', WELCOME_CREDIT_AMOUNT, null, null, issuedAt);
    }
    return readWallet(userId);
  });

  const allocate = db.transaction((userId: string, idempotencyKey: string, input: AllocateCreditsInput): AllocateCreditsResponse & { replayed: boolean } => {
    ensureWelcome(userId);
    const requestDigest = digest(input);
    const existing = selectRequest.get(userId, idempotencyKey) as AllocationRow | undefined;
    if (existing) {
      if (existing.requestDigest !== requestDigest) {
        throw new CreditStoreError('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used for a different allocation.');
      }
      return { wallet: readWallet(userId), receipt: allocation(existing), replayed: true };
    }

    const advanced = updateAllocated.run(input.amount, userId, input.amount);
    if (advanced.changes !== 1) {
      throw new CreditStoreError('INSUFFICIENT_CREDITS', 'Allocation exceeds the available Motive credits.');
    }
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    insertAllocation.run(
      id, userId, input.project, input.amount, CREDIT_ALLOCATION_STATUS,
      idempotencyKey, requestDigest, createdAt,
    );
    insertLedger.run(id + ':ledger', userId, 'PROJECT_ALLOCATED', input.amount, input.project, id, createdAt);
    const receipt: CreditAllocation = { id, project: input.project, amount: input.amount, status: CREDIT_ALLOCATION_STATUS, createdAt };
    return { wallet: readWallet(userId), receipt, replayed: false };
  });

  return { ensureWelcome, readWallet, allocate };
}
