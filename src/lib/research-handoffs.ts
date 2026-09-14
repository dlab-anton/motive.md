import type { PublicResearchHandoff, PublicResearchHandoffPage } from './participation';
import { authenticatedFetch } from './account-fetch';

type JsonRecord = Record<string, unknown>;

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PAGE_FORMAT = 'motive.research-handoff-page/0.1';
const INVALID_RESPONSE = 'The unfinished-experiment response could not be read. Please try again.';
const PAGE_UNAVAILABLE = 'Unfinished experiments could not be loaded. Your current place is preserved; try again.';
const EXACT_UNAVAILABLE = 'This unfinished experiment could not be loaded. Please try again.';

export class HandoffReadError extends Error {
  constructor(message: string, readonly reset: boolean, readonly accessDenied: boolean) {
    super(message); this.name = 'HandoffReadError';
  }
}

function record(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exact(value: JsonRecord, required: string[]): boolean {
  const keys = Object.keys(value).sort(); const expected = [...required].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function text(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximum
    && value.trim() === value && !value.includes('\u0000');
}

function dateTime(value: unknown): value is string {
  return typeof value === 'string' && DATE_TIME.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function invalidResponse(): HandoffReadError {
  return new HandoffReadError(INVALID_RESPONSE, false, false);
}

function parseIntent(value: unknown): PublicResearchHandoff['intent'] {
  if (value === null) return null;
  if (!record(value) || !exact(value, ['proposal', 'expectation', 'conditions', 'workOrderRevision', 'declaredAt'])
    || !text(value.proposal, 2_000) || !text(value.expectation, 1_000)
    || !Array.isArray(value.conditions) || value.conditions.length < 1 || value.conditions.length > 12
    || !value.conditions.every(condition => text(condition, 500))
    || !Number.isSafeInteger(value.workOrderRevision) || Number(value.workOrderRevision) < 1
    || !dateTime(value.declaredAt)) throw invalidResponse();
  return { proposal: value.proposal, expectation: value.expectation, conditions: [...value.conditions] as string[],
    workOrderRevision: Number(value.workOrderRevision), declaredAt: value.declaredAt };
}

function parseHandoff(value: unknown, expectedId?: string): PublicResearchHandoff {
  if (!record(value) || !exact(value, ['id', 'claimId', 'assignmentId', 'agentName', 'contributorDisplayName',
    'createdAt', 'stopReason', 'intent', 'interpretationStatus'])
    || typeof value.id !== 'string' || !UUID.test(value.id) || expectedId !== undefined && value.id !== expectedId
    || typeof value.claimId !== 'string' || !UUID.test(value.claimId)
    || typeof value.assignmentId !== 'string' || !UUID.test(value.assignmentId)
    || !text(value.agentName, 120)
    || !(value.contributorDisplayName === null || text(value.contributorDisplayName, 120))
    || !dateTime(value.createdAt) || !text(value.stopReason, 1_000)
    || value.interpretationStatus !== 'AGENT_DECLARED_UNVERIFIED') throw invalidResponse();
  return { id: value.id, claimId: value.claimId, assignmentId: value.assignmentId, agentName: value.agentName,
    contributorDisplayName: value.contributorDisplayName, createdAt: value.createdAt, stopReason: value.stopReason,
    intent: parseIntent(value.intent), interpretationStatus: 'AGENT_DECLARED_UNVERIFIED' };
}

function parsePage(value: unknown): PublicResearchHandoffPage {
  if (!record(value) || !exact(value, ['format', 'items', 'nextCursor']) || value.format !== PAGE_FORMAT
    || !Array.isArray(value.items) || value.items.length > 20
    || !(value.nextCursor === null || typeof value.nextCursor === 'string' && UUID.test(value.nextCursor))) throw invalidResponse();
  const items = value.items.map(item => parseHandoff(item));
  if (new Set(items.map(item => item.id)).size !== items.length
    || items.some((item, index) => index > 0 && items[index - 1]!.createdAt < item.createdAt)
    || value.nextCursor !== null && (items.length !== 20 || value.nextCursor !== items.at(-1)?.id)) throw invalidResponse();
  return { format: PAGE_FORMAT, items, nextCursor: value.nextCursor };
}

async function request(path: string, signal: AbortSignal, authenticated: boolean, exactRead: boolean): Promise<unknown> {
  let response: Response;
  try {
    const requester = authenticated ? authenticatedFetch : fetch;
    response = await requester(path, { method: 'GET', credentials: 'same-origin', redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), headers: { Accept: 'application/json' } });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new HandoffReadError(exactRead ? EXACT_UNAVAILABLE : PAGE_UNAVAILABLE, false, false);
  }
  if (response.status === 401 || response.status === 403) {
    throw new HandoffReadError('Your access to unfinished experiments is no longer available. Reload your account to continue.', true, true);
  }
  if (response.status === 404) {
    throw new HandoffReadError(exactRead
      ? 'This unfinished experiment is not available in the public project.'
      : 'The place saved in unfinished experiments is no longer available. Return to the latest notes to continue.',
    !exactRead, false);
  }
  if (!response.ok) throw new HandoffReadError(exactRead ? EXACT_UNAVAILABLE : PAGE_UNAVAILABLE, false, false);
  try { return await response.json(); } catch { throw invalidResponse(); }
}

export async function readHandoffPage(
  mine: boolean,
  before: string | null,
  signal: AbortSignal,
): Promise<PublicResearchHandoffPage> {
  if (!(before === null || typeof before === 'string' && UUID.test(before))) throw invalidResponse();
  const path = `${mine ? '/api/participation/research-handoffs' : '/api/public/projects/circle-packing/research-handoffs'}${before ? `?before=${encodeURIComponent(before)}` : ''}`;
  return parsePage(await request(path, signal, mine, false));
}

export async function readHandoff(id: string, signal: AbortSignal): Promise<PublicResearchHandoff> {
  if (typeof id !== 'string' || !UUID.test(id)) throw invalidResponse();
  const path = `/api/public/projects/circle-packing/research-handoffs/${encodeURIComponent(id)}`;
  return parseHandoff(await request(path, signal, false, true), id);
}
