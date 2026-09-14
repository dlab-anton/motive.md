export const MOTIVE_ORIGIN = 'https://motive-md.vercel.app' as const;

const PROJECT_KEY = /^motive_agent_[a-f0-9]{32}_[A-Za-z0-9_-]{43}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._~-]{8,200}$/;
const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;

const PUBLIC_PATHS = new Set([
  '/agents/SKILL.md',
  '/agents/circle-packing.json',
  '/agents/submission-api.md',
  '/agents/finding-review.md',
  '/agents/research-context.md',
  '/agents/peer-validation.md',
  '/agents/experiment-protocol.md',
  '/agents/optimizer-protocol.md',
  '/projects/circle-packing/reference-witness.json',
  '/projects/circle-packing/reference-provenance.json',
  '/api/public/projects/circle-packing/research-brief',
  '/api/public/projects/circle-packing/hosted-results',
]);

const PUBLIC_DYNAMIC_PATHS = [
  /^\/api\/public\/projects\/circle-packing\/research-updates(?:\/[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})?$/,
  /^\/api\/public\/projects\/circle-packing\/submissions\/[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\/(?:artifact|report|investigation|post-check-assessment|reproducibility|finding-review)$/,
  /^\/api\/public\/projects\/circle-packing\/submissions\/[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\/reproducibility\/(?:solver-source|trial-results)\.txt$/,
];

const AGENT_PATHS = new Set([
  '/api/agent/assignment',
  '/api/agent/work-queue',
  '/api/agent/session',
  '/api/agent/research-context',
  '/api/agent/research-context/retained-latest',
  '/api/agent/research-sync-capability',
  '/api/agent/experiment-protocol-matches',
]);

const AGENT_DYNAMIC_PATHS = [
  /^\/api\/agent\/research-context\/hypotheses\/[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  /^\/api\/agent\/research-context\/snapshots\/[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  /^\/api\/agent\/assignments\/[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\/(?:claim|renew|intent|release|submissions|complete)$/,
  /^\/api\/agent\/submissions\/[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\/(?:post-check-assessment|reproducibility|research-sync)$/,
  /^\/api\/agent\/finding-reviews\/[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\/targets\/[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\/(?:preview|decisions)$/,
];

const SECRET_FIELD = /^(?:authorization|token|access_?token|refresh_?token|api_?key|project_?access_?key|secret)$/i;
const SAFE_ERROR_CODES = new Set([
  'validation', 'unauthorized', 'forbidden', 'not_found', 'conflict', 'expired',
  'service_coverage_required', 'service_coverage_exhausted', 'service_execution_unknown',
  'unverified_contract',
]);

export type MotiveMethod = 'GET' | 'POST';
export type MotiveRequest = {
  method: MotiveMethod;
  path: string;
  query?: Readonly<Record<string, string | number | undefined>>;
  body?: unknown;
  idempotencyKey?: string;
  /** A fixed read operation whose existing HTTP contract uses POST for a structured query body. */
  readOnlyPost?: true;
};

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class MotiveClientError extends Error {
  constructor(message: string, readonly uncertain = false) {
    super(message);
    this.name = 'MotiveClientError';
  }
}

export function readProjectKey(environment: NodeJS.ProcessEnv = process.env): string {
  const raw = environment.MOTIVE_PROJECT_ACCESS_KEY;
  if (!raw || raw.startsWith('__encrypted__:') || !PROJECT_KEY.test(raw)) {
    throw new MotiveClientError('The Motive project access key is missing or unavailable. Re-enter it in the extension settings.');
  }
  return raw;
}

function isAllowed(path: string): 'public' | 'agent' | null {
  if (PUBLIC_PATHS.has(path) || PUBLIC_DYNAMIC_PATHS.some(pattern => pattern.test(path))) return 'public';
  if (AGENT_PATHS.has(path) || AGENT_DYNAMIC_PATHS.some(pattern => pattern.test(path))) return 'agent';
  return null;
}

function validatedUrl(request: MotiveRequest): { url: URL; authority: 'public' | 'agent' } {
  if (!request.path.startsWith('/') || request.path.includes('?') || request.path.includes('#') || request.path.includes('\\')
    || request.path.split('/').includes('..')) {
    throw new MotiveClientError('The extension rejected an invalid Motive API path.');
  }
  const authority = isAllowed(request.path);
  if (!authority) throw new MotiveClientError('The extension rejected a Motive API path outside its fixed allowlist.');
  const url = new URL(request.path, MOTIVE_ORIGIN);
  if (url.origin !== MOTIVE_ORIGIN) throw new MotiveClientError('The extension rejected a request outside Motive.');
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key) || value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
  return { url, authority };
}

function scrubText(value: string, projectKey: string): string {
  return value.split(projectKey).join('[redacted]');
}

function sanitize(value: unknown, projectKey: string, depth = 0): unknown {
  if (depth > 30) return '[truncated]';
  if (typeof value === 'string') return scrubText(value, projectKey);
  if (Array.isArray(value)) return value.slice(0, 2000).map(item => sanitize(item, projectKey, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let redactedField = 0;
  for (const [key, item] of Object.entries(value).slice(0, 2000)) {
    const scrubbedKey = scrubText(key, projectKey);
    const safeKey = SECRET_FIELD.test(key) || Object.hasOwn(result, scrubbedKey)
      ? `[redacted-field-${++redactedField}]`
      : scrubbedKey;
    result[safeKey] = SECRET_FIELD.test(key) ? '[redacted]' : sanitize(item, projectKey, depth + 1);
  }
  return result;
}

async function boundedText(response: Response): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > MAX_RESPONSE_BYTES) throw new MotiveClientError('Motive returned a response larger than the extension limit.');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new MotiveClientError('Motive returned a response larger than the extension limit.');
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}

function safeApiError(status: number, responseBody: string, retryAfter: string | null): MotiveClientError {
  let code: string | undefined;
  try {
    const parsed = JSON.parse(responseBody) as { error?: unknown };
    if (typeof parsed.error === 'string' && SAFE_ERROR_CODES.has(parsed.error)) code = parsed.error.toUpperCase();
  } catch {
    // Response bodies are intentionally not relayed to the model.
  }
  const wait = retryAfter && /^\d{1,6}$/.test(retryAfter) ? ` Retry after ${retryAfter} seconds.` : '';
  const recovery = status === 401
    ? ' Re-enter the project access key in the extension settings.'
    : status === 409 || status === 410
      ? ' Read the work queue before choosing the next recovery action.'
      : '';
  return new MotiveClientError(`Motive API request failed with HTTP ${status}${code ? ` (${code})` : ''}.${wait}${recovery}`);
}

export class MotiveClient {
  constructor(
    private readonly projectKey: string,
    private readonly fetcher: FetchLike = fetch,
    private readonly timeoutMs = REQUEST_TIMEOUT_MS,
  ) {
    if (!PROJECT_KEY.test(projectKey)) throw new MotiveClientError('The Motive project access key is invalid. Re-enter it in the extension settings.');
  }

  async request(request: MotiveRequest): Promise<unknown> {
    const { url, authority } = validatedUrl(request);
    if (request.readOnlyPost === true && (request.method !== 'POST'
      || request.path !== '/api/agent/experiment-protocol-matches'
      || request.idempotencyKey !== undefined)) {
      throw new MotiveClientError('The extension rejected an invalid read-only POST request.');
    }
    const mutation = request.method === 'POST' && request.readOnlyPost !== true;
    if (mutation) {
      if (!request.idempotencyKey || !IDEMPOTENCY_KEY.test(request.idempotencyKey)) {
        throw new MotiveClientError('A mutation requires an idempotencyKey of 8-200 URL-safe characters.');
      }
    } else if (request.method === 'GET' && (request.idempotencyKey !== undefined || request.body !== undefined)) {
      throw new MotiveClientError('Read requests cannot include a body or idempotency key.');
    }
    if (authority === 'public' && mutation) throw new MotiveClientError('The extension does not permit writes to public routes.');

    const headers = new Headers({ Accept: 'application/json, text/plain;q=0.9' });
    if (authority === 'agent') headers.set('Authorization', `Bearer ${this.projectKey}`);
    let body: string | undefined;
    if (request.method === 'POST') {
      body = JSON.stringify(request.body ?? {});
      if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) throw new MotiveClientError('The request is larger than Motive permits.');
      headers.set('Content-Type', 'application/json');
      if (mutation) headers.set('Idempotency-Key', request.idempotencyKey!);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(url, { method: request.method, headers, body, redirect: 'error', signal: controller.signal });
    } catch {
      clearTimeout(timeout);
      if (mutation) {
        throw new MotiveClientError('The Motive request outcome is uncertain. Retry this same tool with the same idempotencyKey and identical arguments.', true);
      }
      throw new MotiveClientError('The Motive request could not be completed. Check network access to motive-md.vercel.app and retry.');
    }

    let responseBody: string;
    try {
      responseBody = await boundedText(response);
    } catch {
      if (mutation) {
        throw new MotiveClientError('The Motive request outcome is uncertain because its response could not be read. Retry this same tool with the same idempotencyKey and identical arguments.', true);
      }
      throw new MotiveClientError('The Motive response could not be read. Check network access to motive-md.vercel.app and retry.');
    } finally {
      clearTimeout(timeout);
    }
    if (mutation && response.status >= 500) {
      throw new MotiveClientError(`The Motive request outcome is uncertain after HTTP ${response.status}. Retry this same tool with the same idempotencyKey and identical arguments.`, true);
    }
    if (!response.ok) throw safeApiError(response.status, responseBody, response.headers.get('retry-after'));
    try {
      return sanitize(JSON.parse(responseBody), this.projectKey);
    } catch {
      if (authority === 'public' && /\.(?:md|txt)$/.test(request.path)) return scrubText(responseBody, this.projectKey);
      if (mutation) {
        throw new MotiveClientError('The Motive request outcome is uncertain because its success response was invalid. Retry this same tool with the same idempotencyKey and identical arguments.', true);
      }
      throw new MotiveClientError('Motive returned an invalid response for this operation.');
    }
  }
}
