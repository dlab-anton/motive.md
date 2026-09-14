import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { digestCanonicalJson } from '../packages/domain/src/contracts.ts';
import { parseByoReviewArguments, runByoReviewControl } from './review-byo-rehearsal.ts';

const submissionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const decisionId = '22222222-2222-4222-8222-222222222222';
const directories: string[] = [];

async function fixture() {
  const runDirectory = resolve('.local', `motive_byo_${randomUUID().replaceAll('-', '')}`);
  directories.push(runDirectory);
  await mkdir(runDirectory, { recursive: true });
  const reviewer = { role: 'REVIEWER', subjectId: 'synthetic-reviewer', actorId: 'account:synthetic-reviewer',
    name: 'Synthetic Reviewer', email: 'reviewer@example.test', password: 'private-password',
    cookie: 'better-auth.session_token=private-cookie' };
  await writeFile(resolve(runDirectory, 'READY'), 'ready\n');
  await writeFile(resolve(runDirectory, 'status.json'), JSON.stringify({ format: 'motive.byo-engine-rehearsal-status/0.1',
    state: 'ready', origins: { app: 'http://127.0.0.1:4335', motiveApi: 'http://127.0.0.1:4336' } }));
  await writeFile(resolve(runDirectory, 'private.json'), JSON.stringify({ accounts: { reviewer } }));
  return runDirectory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('BYO rehearsal review control', () => {
  it('requires one explicit action, canonical submission, and a decision file only for decide', () => {
    const runDirectory = resolve('.local', `motive_byo_${'a'.repeat(32)}`);
    expect(parseByoReviewArguments(['--run-dir', runDirectory, '--submission-id', submissionId, '--prepare']))
      .toEqual({ runDirectory, submissionId, action: 'PREPARE', decisionFile: null });
    expect(() => parseByoReviewArguments(['--run-dir', runDirectory, '--submission-id', submissionId,
      '--prepare', '--decide', '--decision-file', 'choice.json'])).toThrow('Usage:');
    expect(() => parseByoReviewArguments(['--run-dir', runDirectory, '--submission-id', submissionId.toUpperCase(),
      '--prepare'])).toThrow('Usage:');
    expect(() => parseByoReviewArguments(['--run-dir', runDirectory, '--submission-id', submissionId,
      '--decide'])).toThrow('Usage:');
  });

  it('prepares privately, then binds and replays the exact human-authored decision with one stable key', async () => {
    const runDirectory = await fixture();
    const reviewPackage = { format: 'motive.research-delivery-review-package/0.1', source: { submissionId } };
    const packageDigest = digestCanonicalJson(reviewPackage);
    const preview = { format: 'motive.research-delivery-admission-preview/0.1', package: reviewPackage,
      packageDigest, latestDecision: null };
    const decision = { format: 'motive.research-delivery-admission/0.1', id: decisionId, packageDigest,
      decision: 'ADMIT', createdAt: '2026-09-09T09:00:00.000Z' };
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (request, init) => {
      calls.push({ url: String(request), init });
      return new Response(JSON.stringify(String(request).endsWith('/prepare') ? preview : decision),
        { status: String(request).endsWith('/prepare') ? 200 : 201, headers: { 'content-type': 'application/json' } });
    });
    const prepared = await runByoReviewControl({ runDirectory, submissionId, action: 'PREPARE', decisionFile: null });
    expect(prepared).toMatchObject({ action: 'PREPARED', submissionId, packageDigest, expectedDecisionId: null });
    expect(JSON.stringify(prepared)).not.toContain('private-cookie');
    const decisionFile = resolve(runDirectory, 'root-decision.json');
    await writeFile(decisionFile, JSON.stringify({ submissionId, packageDigest, expectedDecisionId: null,
      decision: 'ADMIT', rationale: 'The independent reviewer inspected and admits this exact neutral research package.' }));
    const first = await runByoReviewControl({ runDirectory, submissionId, action: 'DECIDE', decisionFile });
    expect(first).toMatchObject({ action: 'DECIDED', submissionId, packageDigest, decision: 'ADMIT', decisionId });
    const firstDecision = calls.at(-1)!;
    const firstKey = new Headers(firstDecision.init?.headers).get('idempotency-key');
    expect(firstKey).toMatch(/^byo-review-/);
    const beforeReplay = calls.length;
    const replay = await runByoReviewControl({ runDirectory, submissionId, action: 'DECIDE', decisionFile });
    expect(replay).toEqual(first);
    expect(calls).toHaveLength(beforeReplay + 1);
    expect(calls.at(-1)!.url).toContain('/research-admission/reviews');
    expect(new Headers(calls.at(-1)!.init?.headers).get('idempotency-key')).toBe(firstKey);
    expect(calls.every(call => !call.url.includes('private'))).toBe(true);
  });

  it('rejects a decision outside the run directory before making an HTTP request', async () => {
    const runDirectory = await fixture();
    const outside = resolve('.local', `outside-${randomUUID()}.json`);
    directories.push(outside);
    await writeFile(outside, '{}');
    const fetcher = vi.spyOn(globalThis, 'fetch');
    await expect(runByoReviewControl({ runDirectory, submissionId, action: 'DECIDE', decisionFile: outside }))
      .rejects.toThrow('inside the active rehearsal directory');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
