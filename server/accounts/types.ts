import type { AllocateCreditsInput, AllocateCreditsResponse, CreditWallet } from '../../src/lib/credits.ts';
import type { SupportAction, SupportState } from '../../src/lib/support.ts';

export type AccountProvider = 'local-better-auth' | 'supabase';
export type AccountPrincipal = {
  provider: AccountProvider;
  subjectId: string;
  actorId: `account:${string}`;
  name: string;
  email: string;
  createdAt: Date;
  emailVerified: boolean;
};

export type AccountPublicConfig = { provider: 'local-better-auth' }
  | { provider: 'supabase'; supabaseUrl: string; supabasePublishableKey: string };

export type AccountWorkspace = { support: SupportState; bio: string };

export type AccountStore = {
  establish(principal: AccountPrincipal): Promise<void>;
  status(actorId: string): Promise<'ACTIVE' | 'DELETION_PENDING' | 'DELETED' | null>;
  workspace(actorId: string): Promise<AccountWorkspace>;
  follow(actorId: string, action: SupportAction): Promise<SupportState>;
  setBio(actorId: string, bio: string): Promise<string>;
  ensureWelcome(actorId: string): Promise<CreditWallet>;
  readWallet(actorId: string): Promise<CreditWallet>;
  allocate(actorId: string, idempotencyKey: string, input: AllocateCreditsInput): Promise<AllocateCreditsResponse & { replayed: boolean }>;
  beginDeletion(actorId: string): Promise<'STARTED' | 'PENDING'>;
  finalizeDeletion(actorId: string): Promise<void>;
};

export class AccountError extends Error {
  constructor(readonly code: 'CONFIGURATION'|'UNAUTHORIZED'|'EMAIL_UNCONFIRMED'|'INACTIVE'|'NOT_FOUND'|'IDEMPOTENCY_CONFLICT'|'INSUFFICIENT_CREDITS'|'UPSTREAM',
    message: string, readonly status: number) { super(message); this.name='AccountError'; }
}

export type AccountRemoteAuthority = {
  authenticate(authorization: string | undefined): Promise<AccountPrincipal | null>;
  verifyPassword(principal: AccountPrincipal, password: string): Promise<boolean>;
  isActive(subjectId: string): Promise<boolean>;
  deleteUser(subjectId: string): Promise<void>;
};
