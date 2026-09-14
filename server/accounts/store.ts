import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { createCreditStore, CreditStoreError, initializeCreditSchema } from '../credits.ts';
import {
  applySupportAction,
  emptyState,
  restoreState,
  type SupportAction,
  type SupportState,
} from '../../src/lib/support.ts';
import {
  CREDIT_ALLOCATION_STATUS,
  MOTIVE_CREDIT_UNIT,
  type AllocateCreditsInput,
  type CreditAllocation,
  type CreditWallet,
} from '../../src/lib/credits.ts';
import { AccountError, type AccountPrincipal, type AccountStore } from './types.ts';

function userId(actorId: string): string {
  if (!actorId.startsWith('account:')) {
    throw new AccountError('UNAUTHORIZED', 'Account identity is invalid.', 401);
  }
  return actorId.slice('account:'.length);
}

function date(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) throw new Error('ACCOUNT_DATE_INVALID');
  return parsed.toISOString();
}

function requestDigest(input: AllocateCreditsInput): string {
  const payload = JSON.stringify({ project: input.project, amount: input.amount });
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

function allocation(row: QueryResultRow): CreditAllocation {
  return {
    id: String(row.id),
    project: String(row.project) as CreditAllocation['project'],
    amount: Number(row.amount),
    status: CREDIT_ALLOCATION_STATUS,
    createdAt: date(row.created_at),
  };
}

export function createLocalAccountStore(db: Database.Database): AccountStore {
  db.exec(`CREATE TABLE IF NOT EXISTS workspace (
    userId TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
    support TEXT NOT NULL,
    bio TEXT NOT NULL DEFAULT ''
  )`);
  initializeCreditSchema(db);
  const credits = createCreditStore(db);
  const read = db.prepare('SELECT support,bio FROM workspace WHERE userId=?');
  const create = db.prepare('INSERT OR IGNORE INTO workspace(userId,support) VALUES(?,?)');
  const save = db.prepare('UPDATE workspace SET support=? WHERE userId=?');
  const updateBio = db.prepare('UPDATE workspace SET bio=? WHERE userId=?');

  return {
    async establish(principal) {
      const id = userId(principal.actorId);
      create.run(id, JSON.stringify(emptyState));
      credits.ensureWelcome(id);
    },
    async status(actorId) {
      return db.prepare('SELECT id FROM user WHERE id=?').get(userId(actorId)) ? 'ACTIVE' : null;
    },
    async workspace(actorId) {
      const row = read.get(userId(actorId)) as { support: string; bio: string } | undefined;
      if (!row) throw new AccountError('NOT_FOUND', 'Account workspace not found.', 404);
      return { support: restoreState(JSON.parse(row.support)), bio: row.bio };
    },
    async follow(actorId, action) {
      const id = userId(actorId);
      return db.transaction(() => {
        const row = read.get(id) as { support: string } | undefined;
        if (!row) throw new AccountError('NOT_FOUND', 'Account workspace not found.', 404);
        const next = applySupportAction(restoreState(JSON.parse(row.support)), action);
        save.run(JSON.stringify(next), id);
        return next;
      })();
    },
    async setBio(actorId, value) {
      updateBio.run(value, userId(actorId));
      return value;
    },
    async ensureWelcome(actorId) {
      return credits.ensureWelcome(userId(actorId));
    },
    async readWallet(actorId) {
      return credits.readWallet(userId(actorId));
    },
    async allocate(actorId, key, input) {
      try {
        return credits.allocate(userId(actorId), key, input);
      } catch (error) {
        if (error instanceof CreditStoreError) {
          throw new AccountError(error.code, error.message, 409);
        }
        throw error;
      }
    },
    async beginDeletion() {
      return 'STARTED';
    },
    async finalizeDeletion() {},
  };
}

export class PostgresAccountStore implements AccountStore {
  constructor(private readonly pool: Pool) {}

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async requireActive(client: PoolClient, actorId: string, lock = false): Promise<void> {
    const result = await client.query(
      `SELECT status FROM motive.account_identities WHERE actor_id=$1${lock ? ' FOR UPDATE' : ''}`,
      [actorId],
    );
    if (result.rowCount !== 1 || result.rows[0].status !== 'ACTIVE') {
      throw new AccountError('INACTIVE', 'The account is no longer active.', 401);
    }
  }

  async establish(principal: AccountPrincipal): Promise<void> {
    if (principal.provider !== 'supabase' || !principal.emailVerified) {
      throw new AccountError('UNAUTHORIZED', 'A confirmed Supabase account identity is required.', 401);
    }
    await this.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`account:${principal.actorId}`]);
      await client.query(
        `INSERT INTO motive.account_identities(actor_id,provider,subject_id,status,created_at)
         VALUES($1,'supabase',$2,'ACTIVE',$3)
         ON CONFLICT(actor_id) DO NOTHING`,
        [principal.actorId, principal.subjectId, principal.createdAt],
      );
      const identity = await client.query(
        'SELECT provider,subject_id,status FROM motive.account_identities WHERE actor_id=$1 FOR UPDATE',
        [principal.actorId],
      );
      if (identity.rowCount !== 1 || identity.rows[0].provider !== 'supabase'
          || identity.rows[0].subject_id !== principal.subjectId || identity.rows[0].status !== 'ACTIVE') {
        throw new AccountError('INACTIVE', 'The account identity cannot be reactivated.', 401);
      }
      await client.query(
        `INSERT INTO motive.account_profiles(actor_id,display_name)
         VALUES($1,$2) ON CONFLICT(actor_id) DO NOTHING`,
        [principal.actorId, principal.name],
      );
      const inserted = await client.query(
        `INSERT INTO motive.account_credit_wallets(actor_id,unit,issued,allocated,issued_at)
         VALUES($1,'motive_credit',10,0,clock_timestamp())
         ON CONFLICT(actor_id) DO NOTHING RETURNING issued_at`,
        [principal.actorId],
      );
      if (inserted.rowCount === 1) {
        await client.query(
          `INSERT INTO motive.account_credit_ledger_entries(id,actor_id,kind,amount,created_at)
           VALUES($1,$2,'WELCOME_ISSUED',10,$3)`,
          [randomUUID(), principal.actorId, inserted.rows[0].issued_at],
        );
      }
    });
  }

  async status(actorId: string): Promise<'ACTIVE' | 'DELETION_PENDING' | 'DELETED' | null> {
    const result = await this.pool.query(
      'SELECT status FROM motive.account_identities WHERE actor_id=$1',
      [actorId],
    );
    return result.rowCount
      ? result.rows[0].status as 'ACTIVE' | 'DELETION_PENDING' | 'DELETED'
      : null;
  }

  async workspace(actorId: string) {
    const result = await this.pool.query(
      `SELECT profile.bio,
              COALESCE(array_agg(project.slug ORDER BY project.slug)
                FILTER(WHERE project.slug IS NOT NULL),'{}') AS following
         FROM motive.account_profiles profile
         JOIN motive.account_identities identity
           ON identity.actor_id=profile.actor_id AND identity.status='ACTIVE'
         LEFT JOIN motive.account_project_follows follow ON follow.actor_id=profile.actor_id
         LEFT JOIN motive.projects project
           ON project.id=follow.project_id AND project.visibility='PUBLIC'
        WHERE profile.actor_id=$1
        GROUP BY profile.bio`,
      [actorId],
    );
    if (result.rowCount !== 1) {
      throw new AccountError('INACTIVE', 'The account is no longer active.', 401);
    }
    return {
      bio: String(result.rows[0].bio),
      support: restoreState({ following: result.rows[0].following }),
    };
  }

  async follow(actorId: string, action: SupportAction): Promise<SupportState> {
    return this.transaction(async client => {
      await this.requireActive(client, actorId, true);
      const project = await client.query(
        "SELECT id FROM motive.projects WHERE slug=$1 AND visibility='PUBLIC'",
        [action.goal],
      );
      if (project.rowCount !== 1) {
        throw new AccountError('NOT_FOUND', 'Public project not found.', 404);
      }
      if (action.following) {
        await client.query(
          `INSERT INTO motive.account_project_follows(actor_id,project_id)
           VALUES($1,$2) ON CONFLICT DO NOTHING`,
          [actorId, project.rows[0].id],
        );
      } else {
        await client.query(
          'DELETE FROM motive.account_project_follows WHERE actor_id=$1 AND project_id=$2',
          [actorId, project.rows[0].id],
        );
      }
      return (await this.workspaceWith(client, actorId)).support;
    });
  }

  private async workspaceWith(client: PoolClient, actorId: string) {
    const result = await client.query(
      `SELECT profile.bio,
              COALESCE(array_agg(project.slug ORDER BY project.slug)
                FILTER(WHERE project.slug IS NOT NULL),'{}') AS following
         FROM motive.account_profiles profile
         LEFT JOIN motive.account_project_follows follow ON follow.actor_id=profile.actor_id
         LEFT JOIN motive.projects project
           ON project.id=follow.project_id AND project.visibility='PUBLIC'
        WHERE profile.actor_id=$1
        GROUP BY profile.bio`,
      [actorId],
    );
    if (result.rowCount !== 1) {
      throw new AccountError('NOT_FOUND', 'Account workspace not found.', 404);
    }
    return {
      bio: String(result.rows[0].bio),
      support: restoreState({ following: result.rows[0].following }),
    };
  }

  async setBio(actorId: string, bio: string): Promise<string> {
    const result = await this.pool.query(
      `UPDATE motive.account_profiles
          SET bio=$2,updated_at=clock_timestamp()
        WHERE actor_id=$1
          AND EXISTS(SELECT 1 FROM motive.account_identities identity
                      WHERE identity.actor_id=$1 AND identity.status='ACTIVE')
        RETURNING bio`,
      [actorId, bio],
    );
    if (result.rowCount !== 1) {
      throw new AccountError('INACTIVE', 'The account is no longer active.', 401);
    }
    return String(result.rows[0].bio);
  }

  async ensureWelcome(actorId: string): Promise<CreditWallet> {
    return this.readWallet(actorId);
  }

  async readWallet(actorId: string): Promise<CreditWallet> {
    const wallet = await this.pool.query(
      `SELECT wallet.issued,wallet.allocated
         FROM motive.account_credit_wallets wallet
         JOIN motive.account_identities identity
           ON identity.actor_id=wallet.actor_id AND identity.status='ACTIVE'
        WHERE wallet.actor_id=$1`,
      [actorId],
    );
    if (wallet.rowCount !== 1) {
      throw new AccountError('INACTIVE', 'The account is no longer active.', 401);
    }
    const allocations = await this.pool.query(
      `SELECT allocation.id,project.slug AS project,allocation.amount,allocation.created_at
         FROM motive.account_credit_allocations allocation
         JOIN motive.projects project ON project.id=allocation.project_id
        WHERE allocation.actor_id=$1
        ORDER BY allocation.created_at,allocation.id`,
      [actorId],
    );
    return this.wallet(wallet.rows[0], allocations.rows);
  }

  async allocate(actorId: string, key: string, input: AllocateCreditsInput) {
    return this.transaction(async client => {
      await this.requireActive(client, actorId, true);
      const digest = requestDigest(input);
      const prior = await client.query(
        `SELECT allocation.id,project.slug AS project,allocation.amount,
                allocation.created_at,allocation.request_digest
           FROM motive.account_credit_allocations allocation
           JOIN motive.projects project ON project.id=allocation.project_id
          WHERE allocation.actor_id=$1 AND allocation.idempotency_key=$2`,
        [actorId, key],
      );
      if (prior.rowCount) {
        if (prior.rows[0].request_digest !== digest) {
          throw new AccountError(
            'IDEMPOTENCY_CONFLICT',
            'Idempotency key was already used for a different allocation.',
            409,
          );
        }
        return {
          wallet: await this.readWalletWith(client, actorId),
          receipt: allocation(prior.rows[0]),
          replayed: true,
        };
      }

      const project = await client.query(
        "SELECT id FROM motive.projects WHERE slug=$1 AND visibility='PUBLIC'",
        [input.project],
      );
      if (project.rowCount !== 1) {
        throw new AccountError('NOT_FOUND', 'Public project not found.', 404);
      }
      const advanced = await client.query(
        `UPDATE motive.account_credit_wallets
            SET allocated=allocated+$2
          WHERE actor_id=$1 AND issued-allocated >= $2
          RETURNING allocated`,
        [actorId, input.amount],
      );
      if (advanced.rowCount !== 1) {
        throw new AccountError('INSUFFICIENT_CREDITS', 'Allocation exceeds the available Motive credits.', 409);
      }

      const id = randomUUID();
      const saved = await client.query(
        `INSERT INTO motive.account_credit_allocations
          (id,actor_id,project_id,amount,status,idempotency_key,request_digest)
         VALUES($1,$2,$3,$4,'WAITING_FOR_FUNDED_RUN',$5,$6)
         RETURNING id,amount,created_at`,
        [id, actorId, project.rows[0].id, input.amount, key, digest],
      );
      await client.query(
        `INSERT INTO motive.account_credit_ledger_entries
          (id,actor_id,kind,amount,project_id,allocation_id)
         VALUES($1,$2,'PROJECT_ALLOCATED',$3,$4,$5)`,
        [randomUUID(), actorId, input.amount, project.rows[0].id, id],
      );
      return {
        wallet: await this.readWalletWith(client, actorId),
        receipt: allocation({ ...saved.rows[0], project: input.project }),
        replayed: false,
      };
    });
  }

  private wallet(row: QueryResultRow, rows: QueryResultRow[]): CreditWallet {
    return {
      unit: MOTIVE_CREDIT_UNIT,
      issued: Number(row.issued),
      allocated: Number(row.allocated),
      available: Number(row.issued) - Number(row.allocated),
      allocations: rows.map(allocation),
      executionEnabled: false,
    };
  }

  private async readWalletWith(client: PoolClient, actorId: string): Promise<CreditWallet> {
    const wallet = await client.query(
      'SELECT issued,allocated FROM motive.account_credit_wallets WHERE actor_id=$1',
      [actorId],
    );
    const allocations = await client.query(
      `SELECT allocation.id,project.slug AS project,allocation.amount,allocation.created_at
         FROM motive.account_credit_allocations allocation
         JOIN motive.projects project ON project.id=allocation.project_id
        WHERE allocation.actor_id=$1
        ORDER BY allocation.created_at,allocation.id`,
      [actorId],
    );
    return this.wallet(wallet.rows[0], allocations.rows);
  }

  async beginDeletion(actorId: string): Promise<'STARTED' | 'PENDING'> {
    return this.transaction(async client => {
      const row = await client.query(
        'SELECT status FROM motive.account_identities WHERE actor_id=$1 FOR UPDATE',
        [actorId],
      );
      if (row.rowCount !== 1) {
        throw new AccountError('NOT_FOUND', 'Account identity not found.', 404);
      }
      if (row.rows[0].status === 'DELETED') {
        throw new AccountError('INACTIVE', 'The account is already deleted.', 401);
      }
      if (row.rows[0].status === 'DELETION_PENDING') return 'PENDING';
      await client.query(
        `UPDATE motive.account_identities
            SET status='DELETION_PENDING',deletion_requested_at=clock_timestamp()
          WHERE actor_id=$1`,
        [actorId],
      );
      return 'STARTED';
    });
  }

  async finalizeDeletion(actorId: string): Promise<void> {
    await this.transaction(async client => {
      const current = await client.query(
        'SELECT status FROM motive.account_identities WHERE actor_id=$1 FOR UPDATE',
        [actorId],
      );
      if (current.rowCount !== 1) {
        throw new AccountError('NOT_FOUND', 'Account identity not found.', 404);
      }
      if (current.rows[0].status === 'DELETION_PENDING') {
        await client.query(
          `UPDATE motive.account_identities
              SET status='DELETED',deleted_at=clock_timestamp()
            WHERE actor_id=$1`,
          [actorId],
        );
      } else if (current.rows[0].status !== 'DELETED') {
        throw new AccountError('INACTIVE', 'Account deletion state is invalid.', 409);
      }
      await client.query('DELETE FROM motive.account_project_follows WHERE actor_id=$1', [actorId]);
      await client.query('DELETE FROM motive.account_profiles WHERE actor_id=$1', [actorId]);
    });
  }
}