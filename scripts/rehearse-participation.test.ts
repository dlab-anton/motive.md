import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  createParticipationRehearsalDatabaseName,
  hasParticipationRehearsalListenLine,
  observeChild,
  participationRehearsalChildEnvironment,
  participationRehearsalUrls,
  terminateChild,
  validateParticipationRehearsalDatabaseName,
} from './rehearse-participation.ts';

const UUID = '12345678-1234-4123-8123-123456789abc';
const DATABASE_NAME = 'motive_ui_12345678123441238123123456789abc';

describe('participation rehearsal database isolation', () => {
  it.each([
    'postgres://rehearsal:secret@127.0.0.1:5432/motive_test',
    'postgresql://rehearsal:secret@localhost/bootstrap',
    'postgres://rehearsal:secret@[::1]:5432/bootstrap',
  ])('derives separate admin and UUID rehearsal URLs from %s', source => {
    const { adminUrl, rehearsalUrl } = participationRehearsalUrls(source, DATABASE_NAME);

    expect(adminUrl.pathname).toBe('/postgres');
    expect(rehearsalUrl.pathname).toBe(`/${DATABASE_NAME}`);
    expect(adminUrl.hostname).toBe(new URL(source).hostname);
    expect(rehearsalUrl.username).toBe('rehearsal');
  });

  it.each([
    ['malformed', 'not a URL'],
    ['wrong protocol', 'https://localhost/bootstrap'],
    ['remote hostname', 'postgres://user:secret@db.example.test/bootstrap'],
    ['lookalike IPv4', 'postgres://user:secret@127.0.0.2/bootstrap'],
    ['lookalike hostname', 'postgres://user:secret@localhost./bootstrap'],
    ['query parameters', 'postgres://user:secret@localhost/bootstrap?host=db.example.test'],
    ['bare query marker', 'postgres://user:secret@localhost/bootstrap?'],
    ['fragment', 'postgres://user:secret@localhost/bootstrap#unsafe'],
    ['bare fragment marker', 'postgres://user:secret@localhost/bootstrap#'],
  ])('rejects %s without connecting', (_description, source) => {
    expect(() => participationRehearsalUrls(source, DATABASE_NAME)).toThrow(/loopback|query parameters/);
  });

  it('creates the exact database name from a canonical UUID', () => {
    expect(createParticipationRehearsalDatabaseName(UUID)).toBe(DATABASE_NAME);
    expect(validateParticipationRehearsalDatabaseName(DATABASE_NAME)).toBe(DATABASE_NAME);
  });

  it.each([
    'motive_test',
    'motive_app_local',
    'motive_ui_12345678123441238123123456789ab',
    'motive_ui_12345678123441238123123456789abc_extra',
    'motive_ui_12345678123441238123123456789ABC',
    'motive_ui_12345678123441238123123456789abc";DROP DATABASE postgres;--',
  ])('rejects unsafe database name %s', databaseName => {
    expect(() => validateParticipationRehearsalDatabaseName(databaseName)).toThrow(
      'Invalid participation rehearsal database name.',
    );
  });

  it.each([
    '12345678123441238123123456789abc',
    '12345678-1234-0123-8123-123456789abc',
    '12345678-1234-4123-7123-123456789abc',
    '12345678-1234-4123-8123-123456789abg',
  ])('rejects non-canonical database UUID %s', id => {
    expect(() => createParticipationRehearsalDatabaseName(id)).toThrow('Invalid rehearsal database UUID.');
  });

  it('recognizes only the spawned API exact successful-listen line', () => {
    expect(hasParticipationRehearsalListenLine(
      'setup\nmotive.md application service listening on 127.0.0.1:4319\n',
    )).toBe(true);
    expect(hasParticipationRehearsalListenLine(
      'prefix motive.md application service listening on 127.0.0.1:4319\n',
    )).toBe(false);
    expect(hasParticipationRehearsalListenLine(
      'motive.md application service listening on 0.0.0.0:4319\n',
    )).toBe(false);
    expect(hasParticipationRehearsalListenLine(
      'motive.md application service listening on 127.0.0.1:4318\n',
    )).toBe(false);
  });

  it('overrides inherited remote runtime and account configuration', () => {
    const env = participationRehearsalChildEnvironment({
      parent: {
        NODE_ENV: 'production', VERCEL: '1', MOTIVE_API_HOST: '0.0.0.0',
        MOTIVE_APP_ORIGIN: 'https://remote.example.test', MOTIVE_ACCOUNT_PROVIDER: 'supabase',
        SUPABASE_URL: 'https://remote.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'remote-public',
        SUPABASE_SECRET_KEY: 'remote-secret', MOTIVE_AGENT_TOKEN_SECRET: 'remote-agent-secret',
      },
      rehearsalUrl: `postgres://local:secret@127.0.0.1:5432/${DATABASE_NAME}`,
      dataDirectory: '.local/rehearsal',
      objectFixturePath: '.local/rehearsal/objects.json',
    });

    expect(env).toMatchObject({
      NODE_ENV: 'test', VERCEL: '', MOTIVE_API_HOST: '127.0.0.1',
      MOTIVE_APP_ORIGIN: 'http://127.0.0.1:4317', MOTIVE_ACCOUNT_PROVIDER: 'local-better-auth',
      SUPABASE_URL: 'http://127.0.0.1:4320', SUPABASE_PUBLISHABLE_KEY: '', SUPABASE_SECRET_KEY: '',
      MOTIVE_AGENT_TOKEN_SECRET: '', MOTIVE_REHEARSAL_API_URL: 'http://127.0.0.1:4319',
    });
  });

  it('fully closes a harmless spawned child through the bounded lifecycle helper', async () => {
    const child = observeChild(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
      windowsHide: true,
      stdio: 'ignore',
    }));

    await terminateChild(child, 'Harmless lifecycle test child');

    expect(child.result).not.toBeNull();
  }, 15_000);
});
