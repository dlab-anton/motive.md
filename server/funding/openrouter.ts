import { createHash, randomBytes } from 'node:crypto';
import type { FundingModel } from '../../src/lib/funding.ts';

export const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth';
export const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1';

export type OpenRouterKeyMetadata = {
  label: string | null;
  limitUsd: string | null;
  limitRemainingUsd: string | null;
  expiresAt: string | null;
  isFreeTier: boolean | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 512 ? value : null;
}

function amount(value: unknown): string | null {
  if ((typeof value === 'string' || typeof value === 'number') && /^\d+(?:\.\d+)?$/.test(String(value))) return String(value);
  return null;
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function openRouterAuthorizationUrl(callbackUrl: string, challenge: string): string {
  const url = new URL(OPENROUTER_AUTH_URL);
  url.searchParams.set('callback_url', callbackUrl);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

async function safeJson(response: Response, maximumBytes = 32 * 1024): Promise<unknown> {
  if (!response.body) throw new Error('Provider response body is missing.');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maximumBytes) { await reader.cancel(); throw new Error('Provider response exceeded the safe limit.'); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  try { return JSON.parse(text); } catch { throw new Error('Provider response was not valid JSON.'); }
}

export async function exchangeOpenRouterCode(
  fetchProvider: typeof globalThis.fetch,
  code: string,
  verifier: string,
): Promise<string> {
  const response = await fetchProvider(`${OPENROUTER_API_URL}/auth/keys`, {
    method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
  });
  if (!response.ok) throw new Error('OpenRouter rejected the authorization code.');
  const body = record(await safeJson(response));
  if (!body || typeof body.key !== 'string' || body.key.length < 16 || body.key.length > 8192 || !/^[\x21-\x7e]+$/.test(body.key)) {
    throw new Error('OpenRouter did not return a usable key.');
  }
  return body.key;
}

export async function validateOpenRouterKey(fetchProvider: typeof globalThis.fetch, key: string): Promise<OpenRouterKeyMetadata> {
  const response = await fetchProvider(`${OPENROUTER_API_URL}/key`, {
    method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${key}` },
  });
  if (!response.ok) throw new Error('OpenRouter rejected the connected key.');
  const root = record(await safeJson(response, 2 * 1024 * 1024));
  const data = record(root?.data);
  if (!data || data.is_management_key === true) throw new Error('A restricted OpenRouter inference key is required.');
  return {
    label: nullableString(data.label),
    limitUsd: amount(data.limit),
    limitRemainingUsd: amount(data.limit_remaining),
    expiresAt: nullableString(data.expires_at),
    isFreeTier: typeof data.is_free_tier === 'boolean' ? data.is_free_tier : null,
  };
}

export async function listOpenRouterModels(fetchProvider: typeof globalThis.fetch): Promise<FundingModel[]> {
  const response = await fetchProvider(`${OPENROUTER_API_URL}/models?supported_parameters=tools`, { redirect: 'error' });
  if (!response.ok) return [];
  const root = record(await safeJson(response));
  if (!Array.isArray(root?.data)) return [];
  const models: FundingModel[] = [];
  for (const item of root.data) {
    const model = record(item); const pricing = record(model?.pricing);
    if (!model || typeof model.id !== 'string' || !/^[a-z0-9._-]+\/[A-Za-z0-9._:-]+$/.test(model.id)) continue;
    const supported = Array.isArray(model.supported_parameters) ? model.supported_parameters : [];
    if (!supported.includes('tools')) continue;
    models.push({
      id: model.id,
      name: typeof model.name === 'string' && model.name.length <= 512 ? model.name : model.id,
      contextLength: Number.isSafeInteger(model.context_length) && Number(model.context_length) > 0 ? Number(model.context_length) : null,
      inputUsdPerToken: amount(pricing?.prompt), outputUsdPerToken: amount(pricing?.completion),
      activationProfileReady: false,
    });
  }
  return models.slice(0, 500);
}
