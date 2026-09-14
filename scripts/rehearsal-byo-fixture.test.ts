import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import {
  requestRehearsalAccount,
  seedByoRehearsalDatabase,
  type ByoAccountSession,
} from './rehearsal-byo-fixture.ts';

const session: ByoAccountSession = {
  role: 'REVIEWER',
  subjectId: 'synthetic-user',
  actorId: 'account:synthetic-user',
  name: 'Synthetic Reviewer',
  email: 'synthetic@example.test',
  password: 'private-password-value',
  cookie: 'better-auth.session_token=private-cookie-value',
};

afterEach(() => vi.restoreAllMocks());

describe('BYO real-engine rehearsal fixture boundaries', () => {
  it('refuses to mutate any database outside the exact fresh BYO namespace', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ database_name: 'motive_app_local' }] });
    await expect(seedByoRehearsalDatabase({ query } as unknown as Pool, {
      projectSlug: 'circle-packing', issuerActorId: 'operator:seed', tokenSecret: 'x'.repeat(32),
    })).rejects.toThrow('fresh motive_byo_<32hex> database');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('keeps authenticated controls on the dedicated loopback account API', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch');
    await expect(requestRehearsalAccount(session, {
      apiOrigin: 'https://motive.example.test', appOrigin: 'http://127.0.0.1:4335',
      path: '/api/participation/me',
    })).rejects.toThrow('dedicated loopback rehearsal origin');
    await expect(requestRehearsalAccount(session, {
      apiOrigin: 'http://127.0.0.1:4336', appOrigin: 'http://127.0.0.1:4335',
      path: '/api/account/delete', method: 'POST', body: {},
    })).rejects.toThrow('outside its allowed account API boundary');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('sends a bounded authenticated JSON request without putting credentials in its URL', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ packageDigest: `sha256:${'a'.repeat(64)}` }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const result = await requestRehearsalAccount<{ packageDigest: string }>(session, {
      apiOrigin: 'http://127.0.0.1:4336', appOrigin: 'http://127.0.0.1:4335',
      path: '/api/participation/submissions/123/research-admission/prepare', method: 'POST', body: {},
      idempotencyKey: 'not-used-by-prepare-but-bounded',
    });
    expect(result).toEqual({ status: 200, body: { packageDigest: `sha256:${'a'.repeat(64)}` } });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('http://127.0.0.1:4336/api/participation/submissions/123/research-admission/prepare');
    expect(String(url)).not.toContain('private');
    expect(new Headers(init?.headers).get('cookie')).toBe(session.cookie);
    expect(new Headers(init?.headers).get('origin')).toBe('http://127.0.0.1:4335');
    expect(new Headers(init?.headers).get('idempotency-key')).toBe('not-used-by-prepare-but-bounded');
    expect(init?.redirect).toBe('error');
  });
});
