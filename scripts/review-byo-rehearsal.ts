import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { canonicalJson } from '../packages/domain/src/contracts.ts';
import {
  requestRehearsalAccount,
  type ByoAccountSession,
} from './rehearsal-byo-fixture.ts';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ACTUAL_DIRECTORY = /^motive_byo_[a-f0-9]{32}$/;
const MAX_FILE_BYTES = 512 * 1024;
const USAGE = 'Usage: node --import tsx scripts/review-byo-rehearsal.ts --run-dir ABSOLUTE_PATH --submission-id UUID (--prepare | --decide --decision-file PATH)';

export type ByoReviewArguments = Readonly<{
  runDirectory: string;
  submissionId: string;
  action: 'PREPARE' | 'DECIDE';
  decisionFile: string | null;
}>;

type ReviewChoice = Readonly<{
  submissionId: string;
  packageDigest: string;
  expectedDecisionId: string | null;
  decision: 'ADMIT' | 'DECLINE';
  rationale: string;
}>;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is invalid.`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

async function boundedJson(path: string, label: string): Promise<Record<string, unknown>> {
  const metadata = await lstat(path).catch(() => { throw new Error(`${label} is invalid.`); });
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_FILE_BYTES) throw new Error(`${label} is invalid.`);
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error(`${label} is invalid.`);
  try { return record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), label); }
  catch { throw new Error(`${label} is invalid.`); }
}

export function parseByoReviewArguments(args: readonly string[]): ByoReviewArguments {
  const values = new Map<string, string>();
  let prepare = false;
  let decide = false;
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index]!;
    if (name === '--prepare' || name === '--decide') {
      if (name === '--prepare' ? prepare : decide) throw new Error(USAGE);
      if (name === '--prepare') prepare = true; else decide = true;
      continue;
    }
    if (!['--run-dir', '--submission-id', '--decision-file'].includes(name) || values.has(name)) throw new Error(USAGE);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(USAGE);
    values.set(name, value);
  }
  const runDirectory = values.get('--run-dir');
  const submissionId = values.get('--submission-id');
  const decisionFile = values.get('--decision-file') ?? null;
  if (!runDirectory || !isAbsolute(runDirectory) || !submissionId || !UUID.test(submissionId)
    || prepare === decide || prepare && decisionFile !== null || decide && decisionFile === null) throw new Error(USAGE);
  return { runDirectory: resolve(runDirectory), submissionId, action: prepare ? 'PREPARE' : 'DECIDE', decisionFile };
}

function reviewerSession(value: unknown): ByoAccountSession {
  const source = record(value, 'Private reviewer session');
  const keys = ['role', 'subjectId', 'actorId', 'name', 'email', 'password', 'cookie'];
  if (!exact(source, keys) || source.role !== 'REVIEWER' || typeof source.subjectId !== 'string'
    || typeof source.actorId !== 'string' || source.actorId !== `account:${source.subjectId}`
    || typeof source.name !== 'string' || typeof source.email !== 'string' || typeof source.password !== 'string'
    || typeof source.cookie !== 'string' || !source.cookie) throw new Error('Private reviewer session is invalid.');
  return source as ByoAccountSession;
}

function reviewChoice(value: unknown, submissionId: string): ReviewChoice {
  const source = record(value, 'Review decision file');
  const keys = ['submissionId', 'packageDigest', 'expectedDecisionId', 'decision', 'rationale'];
  if (!exact(source, keys) || source.submissionId !== submissionId || typeof source.packageDigest !== 'string'
    || !DIGEST.test(source.packageDigest) || !(source.expectedDecisionId === null
      || typeof source.expectedDecisionId === 'string' && UUID.test(source.expectedDecisionId))
    || !['ADMIT', 'DECLINE'].includes(String(source.decision)) || typeof source.rationale !== 'string'
    || source.rationale.length < 1 || source.rationale.length > 2_000 || source.rationale.trim() !== source.rationale) {
    throw new Error('Review decision file is invalid.');
  }
  return source as ReviewChoice;
}

async function atomicPrivateJson(path: string, value: unknown, exclusive = false): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    if (exclusive) await writeFile(path, await readFile(temporary), { mode: 0o600, flag: 'wx' });
    else await rename(temporary, path);
  } finally {
    await import('node:fs/promises').then(fs => fs.rm(temporary, { force: true }));
  }
}

async function context(arguments_: ByoReviewArguments) {
  const localRoot = resolve(import.meta.dirname, '..', '.local');
  const runDirectory = await realpath(arguments_.runDirectory).catch(() => {
    throw new Error('Review control requires an existing rehearsal directory.');
  });
  const inside = relative(localRoot, runDirectory);
  if (!inside || inside.startsWith('..') || isAbsolute(inside) || !ACTUAL_DIRECTORY.test(basename(runDirectory))) {
    throw new Error('Review control requires an exact .local/motive_byo_<32hex> rehearsal directory.');
  }
  const ready = await lstat(resolve(runDirectory, 'READY')).catch(() => null);
  if (!ready?.isFile() || ready.isSymbolicLink()) throw new Error('The BYO rehearsal is not ready.');
  const status = await boundedJson(resolve(runDirectory, 'status.json'), 'Rehearsal status');
  const origins = record(status.origins, 'Rehearsal origins');
  if (status.format !== 'motive.byo-engine-rehearsal-status/0.1' || status.state !== 'ready'
    || origins.app !== 'http://127.0.0.1:4335' || origins.motiveApi !== 'http://127.0.0.1:4336') {
    throw new Error('The BYO rehearsal status is not ready on its fixed local origins.');
  }
  const privateValue = await boundedJson(resolve(runDirectory, 'private.json'), 'Private rehearsal credentials');
  const accounts = record(privateValue.accounts, 'Private rehearsal accounts');
  return { runDirectory, appOrigin: String(origins.app), apiOrigin: String(origins.motiveApi),
    reviewer: reviewerSession(accounts.reviewer) };
}

async function preview(session: Awaited<ReturnType<typeof context>>, submissionId: string): Promise<Record<string, unknown>> {
  const response = await requestRehearsalAccount(session.reviewer, {
    apiOrigin: session.apiOrigin,
    appOrigin: session.appOrigin,
    path: `/api/participation/submissions/${submissionId}/research-admission/prepare`,
    method: 'POST',
    body: {},
  });
  if (response.status !== 200) throw new Error(`Research admission preparation returned HTTP ${response.status}.`);
  const value = record(response.body, 'Research admission preview');
  const latest = value.latestDecision;
  if (value.format !== 'motive.research-delivery-admission-preview/0.1' || typeof value.packageDigest !== 'string'
    || !DIGEST.test(value.packageDigest) || !value.package || typeof value.package !== 'object' || Array.isArray(value.package)
    || `sha256:${createHash('sha256').update(canonicalJson(value.package)).digest('hex')}` !== value.packageDigest
    || !(latest === null || typeof latest === 'object' && !Array.isArray(latest)
      && typeof (latest as Record<string, unknown>).id === 'string' && UUID.test(String((latest as Record<string, unknown>).id)))) {
    throw new Error('Research admission preview is invalid.');
  }
  return value;
}

export async function runByoReviewControl(arguments_: ByoReviewArguments): Promise<Record<string, unknown>> {
  const session = await context(arguments_);
  if (arguments_.action === 'PREPARE') {
    const value = await preview(session, arguments_.submissionId);
    const path = resolve(session.runDirectory, `research-admission-preview-${arguments_.submissionId}.json`);
    await atomicPrivateJson(path, value);
    const latest = value.latestDecision as Record<string, unknown> | null;
    return { action: 'PREPARED', submissionId: arguments_.submissionId, packageDigest: value.packageDigest,
      expectedDecisionId: latest?.id ?? null, previewFile: relative(resolve(import.meta.dirname, '..'), path) };
  }

  const requestedDecision = resolve(arguments_.decisionFile!);
  const decisionRelative = relative(session.runDirectory, requestedDecision);
  if (!decisionRelative || decisionRelative.startsWith('..') || isAbsolute(decisionRelative)) {
    throw new Error('Review decision file must be inside the active rehearsal directory.');
  }
  const choice = reviewChoice(await boundedJson(requestedDecision, 'Review decision file'), arguments_.submissionId);
  const body = { packageDigest: choice.packageDigest, expectedDecisionId: choice.expectedDecisionId,
    decision: choice.decision, rationale: choice.rationale };
  const requestDigest = `sha256:${createHash('sha256').update(canonicalJson({ submissionId: choice.submissionId, ...body })).digest('hex')}`;
  const statePath = resolve(session.runDirectory,
    `research-admission-request-${choice.submissionId}-${choice.packageDigest.slice(-16)}.json`);
  let idempotencyKey: string;
  const stateMetadata = await lstat(statePath).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('Review idempotency binding could not be inspected.');
  });
  if (stateMetadata !== null) {
    const saved = await boundedJson(statePath, 'Review idempotency binding');
    if (!exact(saved, ['format', 'submissionId', 'requestDigest', 'idempotencyKey'])
      || saved.format !== 'motive.byo-rehearsal-review-request/0.1' || saved.submissionId !== choice.submissionId
      || saved.requestDigest !== requestDigest || typeof saved.idempotencyKey !== 'string'
      || !/^[A-Za-z0-9._~-]{8,200}$/.test(saved.idempotencyKey)) {
      throw new Error('Review idempotency binding conflicts with this decision.');
    }
    idempotencyKey = saved.idempotencyKey;
  } else {
    const current = await preview(session, arguments_.submissionId);
    const currentLatest = current.latestDecision as Record<string, unknown> | null;
    if (choice.packageDigest !== current.packageDigest || choice.expectedDecisionId !== (currentLatest?.id ?? null)) {
      throw new Error('Review decision file does not bind the current exact admission package and decision tail.');
    }
    idempotencyKey = `byo-review-${randomUUID()}`;
    await atomicPrivateJson(statePath, { format: 'motive.byo-rehearsal-review-request/0.1',
      submissionId: choice.submissionId, requestDigest, idempotencyKey }, true);
  }
  const response = await requestRehearsalAccount(session.reviewer, {
    apiOrigin: session.apiOrigin,
    appOrigin: session.appOrigin,
    path: `/api/participation/submissions/${choice.submissionId}/research-admission/reviews`,
    method: 'POST', body, idempotencyKey,
  });
  if (response.status !== 201) throw new Error(`Research admission decision returned HTTP ${response.status}.`);
  const result = record(response.body, 'Research admission decision');
  if (typeof result.id !== 'string' || !UUID.test(result.id) || result.packageDigest !== choice.packageDigest
    || result.decision !== choice.decision || typeof result.createdAt !== 'string') {
    throw new Error('Research admission decision response is invalid.');
  }
  return { action: 'DECIDED', submissionId: choice.submissionId, packageDigest: choice.packageDigest,
    decision: choice.decision, decisionId: result.id, reviewedAt: result.createdAt };
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const result = await runByoReviewControl(parseByoReviewArguments(args));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
