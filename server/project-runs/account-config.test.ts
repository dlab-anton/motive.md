import { describe, expect, it } from 'vitest';
import { loadCircleProjectRunConfig } from './config.ts';

const publicKey = `sb_publishable_${'p'.repeat(24)}`;
const secretKey = `sb_secret_${'s'.repeat(24)}`;

describe('project-run account authority configuration', () => {
  it('keeps the default local runtime closed when its SQLite authority is absent', () => {
    const config = loadCircleProjectRunConfig({ MOTIVE_DATA_DIR: 'Z:/definitely-missing-motive-account-dir' });
    expect(config.accountProvider).toBe('local-better-auth');
    expect(config.accountDatabasePath).toBeNull();
    expect(config.readinessReasons).toContain('ACCOUNT_STORE_REQUIRED');
  });

  it('selects durable Supabase authority without opening or requiring a SQLite path', () => {
    const config = loadCircleProjectRunConfig({
      NODE_ENV: 'production',
      MOTIVE_ACCOUNT_PROVIDER: 'supabase',
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: publicKey,
      SUPABASE_SECRET_KEY: secretKey,
      MOTIVE_AGENT_TOKEN_SECRET: 'runtime-agent-token-secret-has-32-bytes',
    });
    expect(config.accountProvider).toBe('supabase');
    expect(config.accountDatabasePath).toBeNull();
    expect(config.accountSupabase).toEqual({
      url: 'https://project.supabase.co', publishableKey: publicKey, secretKey,
    });
    expect(config.readinessReasons).not.toContain('ACCOUNT_STORE_REQUIRED');
  });
});