import express, { type Request as ExpressRequest, type Response as ExpressResponse, type Router } from 'express';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import {
  defineSandboxProxy,
  type InvalidRequestProxyHandler,
  type ProxyHandler,
} from '@vercel/sandbox/proxy';

export const SANDBOX_PROXY_HEADER = 'X-Motive-Sandbox-Egress';
export const SANDBOX_PROXY_TRANSPORT_TIMEOUT_MS = 250_000;

export type SandboxProxyDiagnosticCode =
  | 'INGRESS_PATH_REJECTED'
  | 'PROXY_UNCONFIGURED'
  | 'SDK_PROXY_HEADERS_MISSING'
  | 'SDK_PROXIED_URL_INVALID'
  | 'OIDC_SOURCE_CLAIMS_MISSING'
  | 'OIDC_JWKS_TIMEOUT'
  | 'OIDC_ISSUER_REJECTED'
  | 'OIDC_AUDIENCE_REJECTED'
  | 'OIDC_SIGNATURE_REJECTED'
  | 'OIDC_TOKEN_EXPIRED'
  | 'OIDC_VERIFICATION_FAILED'
  | 'PREDICATE_HOST_REJECTED'
  | 'PREDICATE_TEAM_REJECTED'
  | 'PREDICATE_PROJECT_REJECTED'
  | 'PREDICATE_METHOD_REJECTED'
  | 'PREDICATE_DESTINATION_REJECTED'
  | 'PREDICATE_BEARER_REJECTED'
  | 'PREDICATE_CONTENT_TYPE_REJECTED'
  | 'REQUEST_BODY_UNAVAILABLE'
  | 'REQUEST_BODY_COMPLETE'
  | 'ADMITTED'
  | 'FETCH_STARTED'
  | 'UPSTREAM_RESPONSE'
  | 'UPSTREAM_RESPONSE_INVALID'
  | 'UPSTREAM_UNAVAILABLE'
  | 'REQUEST_TOO_LARGE'
  | 'TRANSPORT_TIMEOUT'
  | 'PROXY_HANDLER_FAILED';

export type SandboxProxyDiagnostic = Readonly<{
  format: 'motive.sandbox-proxy-diagnostic/0.1';
  code: SandboxProxyDiagnosticCode;
  elapsedMs: number;
  status?: number;
  bytes?: number;
}>;

type ProxyDefinition = (
  handler: ProxyHandler,
  invalidRequestHandler?: InvalidRequestProxyHandler,
) => (request: Request) => Promise<Response>;

export type SandboxGatewayProxyOptions = Readonly<{
  appOrigin: string;
  expectedTeamId?: string;
  expectedProjectId?: string;
  maximumRequestBytes: number;
  maximumResponseBytes: number;
  transportTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  /** Test-only verifier seam. Production composition always uses the SDK. */
  defineProxy?: ProxyDefinition;
  audit?: (diagnostic: SandboxProxyDiagnostic) => void;
}>;

class StreamLimitError extends Error {}
class IncomingBodyUnavailableError extends Error {}

function responseHeaders(contentType: string, identity: 'denied' | 'gateway'): Headers {
  return new Headers({
    'Cache-Control': 'no-store',
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    [SANDBOX_PROXY_HEADER]: identity,
  });
}

function denied(status = 403, code = 'sandbox_proxy_denied'): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: responseHeaders('application/json; charset=utf-8', 'denied'),
  });
}

function boundedStream(
  source: ReadableStream<Uint8Array>,
  maximumBytes: number,
  signal: AbortSignal,
  onLimit?: () => void,
): ReadableStream<Uint8Array> {
  let total = 0;
  const reader = source.getReader();
  let terminal = false;
  let activeController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const cleanup = () => signal.removeEventListener('abort', onAbort);
  const fail = (error: unknown) => {
    if (terminal) return;
    terminal = true; cleanup();
    void reader.cancel(error).catch(() => {});
    activeController?.error(error);
  };
  const onAbort = () => fail(signal.reason instanceof Error ? signal.reason : new Error('Request cancelled.'));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      activeController = controller;
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    },
    async pull(controller) {
      if (terminal) return;
      let item: ReadableStreamReadResult<Uint8Array>;
      try { item = await reader.read(); }
      catch (error) { fail(error); return; }
      if (terminal) return;
      if (item.done) { terminal = true; cleanup(); controller.close(); return; }
      total += item.value.byteLength;
      if (total > maximumBytes) {
        onLimit?.();
        fail(new StreamLimitError('Stream byte limit exceeded.'));
        return;
      }
      controller.enqueue(item.value);
    },
    async cancel(reason) {
      if (terminal) return;
      terminal = true; cleanup();
      await reader.cancel(reason);
    },
  });
}

function appendIncomingHeaders(req: ExpressRequest): Headers {
  const headers = new Headers();
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    const name = req.rawHeaders[index]; const value = req.rawHeaders[index + 1];
    if (name && value !== undefined) headers.append(name, value);
  }
  return headers;
}

function collectIncomingBody(
  req: ExpressRequest,
  maximumBytes: number,
  declaredBytes: number | undefined,
  signal: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      signal.removeEventListener('abort', onSignalAbort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer | Uint8Array | string) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > maximumBytes) {
        req.pause();
        fail(new StreamLimitError('Stream byte limit exceeded.'));
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (declaredBytes !== undefined && total !== declaredBytes) {
        reject(new IncomingBodyUnavailableError('Incoming request body length did not match its declaration.'));
        return;
      }
      resolve(Buffer.concat(chunks, total));
    };
    const onError = (error: Error) => fail(error);
    const onAborted = () => fail(new Error('Request aborted.'));
    const onSignalAbort = () => fail(signal.reason instanceof Error ? signal.reason : new Error('Request cancelled.'));
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
    signal.addEventListener('abort', onSignalAbort, { once: true });
    if (signal.aborted) onSignalAbort();
    else if (req.readableEnded) onEnd();
    else req.resume();
  });
}

function webRequest(req: ExpressRequest, appOrigin: string, signal: AbortSignal, bodyBytes: Buffer): Request {
  const url = new URL(req.originalUrl, appOrigin);
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : new Uint8Array(bodyBytes);
  const headers = appendIncomingHeaders(req);
  headers.delete('transfer-encoding');
  if (body) headers.set('content-length', String(body.byteLength));
  return new Request(url, {
    method: req.method,
    headers,
    body,
    signal,
  });
}

async function writeWebResponse(response: Response, res: ExpressResponse): Promise<void> {
  res.status(response.status);
  for (const name of ['cache-control', 'content-type', 'x-content-type-options',
    'x-motive-operation-id', 'x-request-id', SANDBOX_PROXY_HEADER.toLowerCase()]) {
    const value = response.headers.get(name); if (value) res.setHeader(name, value);
  }
  if (!res.hasHeader(SANDBOX_PROXY_HEADER)) res.setHeader(SANDBOX_PROXY_HEADER, 'denied');
  if (!response.body) { res.end(); return; }
  await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>), res);
}

function validIdentifier(value: string | undefined): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function safeErrorField(error: unknown, field: 'code' | 'name' | 'claim'): string | undefined {
  if (!error || typeof error !== 'object' || !(field in error)) return undefined;
  const value = (error as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

function oidcDiagnostic(error: unknown): SandboxProxyDiagnosticCode {
  const code = safeErrorField(error, 'code');
  const name = safeErrorField(error, 'name');
  const message = error instanceof Error ? error.message : undefined;
  if (message === 'Missing required proxy headers') return 'SDK_PROXY_HEADERS_MISSING';
  if (message === 'Invalid proxied request URL') return 'SDK_PROXIED_URL_INVALID';
  if (message === 'Missing required claims in OIDC token') return 'OIDC_SOURCE_CLAIMS_MISSING';
  if (message === 'Missing OIDC issuer' || message === 'Invalid OIDC issuer') return 'OIDC_ISSUER_REJECTED';
  if (code === 'ERR_JWKS_TIMEOUT' || name === 'JWKSTimeout' || name === 'TimeoutError') return 'OIDC_JWKS_TIMEOUT';
  if (code === 'ERR_JWT_EXPIRED' || name === 'JWTExpired') return 'OIDC_TOKEN_EXPIRED';
  if (code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' || name === 'JWSSignatureVerificationFailed') {
    return 'OIDC_SIGNATURE_REJECTED';
  }
  if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' || name === 'JWTClaimValidationFailed') {
    // Only the standard failed-claim name is inspected. No claim value or JWT
    // payload is retained or emitted.
    const claim = safeErrorField(error, 'claim');
    if (claim === 'iss') return 'OIDC_ISSUER_REJECTED';
    if (claim === 'aud') return 'OIDC_AUDIENCE_REJECTED';
  }
  return 'OIDC_VERIFICATION_FAILED';
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, Math.min(SANDBOX_PROXY_TRANSPORT_TIMEOUT_MS, Math.round(performance.now() - startedAt)));
}

/**
 * Receives unconditional Sandbox forwardURL traffic and permits only the
 * Motive Responses gateway. The SDK verifier owns OIDC signature/audience
 * validation; this layer additionally binds the reviewed team and project.
 */
export function createSandboxGatewayProxyRouter(options: SandboxGatewayProxyOptions): Router {
  if (!Number.isSafeInteger(options.maximumRequestBytes) || options.maximumRequestBytes < 1
      || !Number.isSafeInteger(options.maximumResponseBytes) || options.maximumResponseBytes < 1) {
    throw new Error('SANDBOX_PROXY_LIMIT_INVALID');
  }
  const transportTimeoutMs = options.transportTimeoutMs ?? SANDBOX_PROXY_TRANSPORT_TIMEOUT_MS;
  if (!Number.isSafeInteger(transportTimeoutMs) || transportTimeoutMs < 1 || transportTimeoutMs > 250_000) {
    throw new Error('SANDBOX_PROXY_TIMEOUT_INVALID');
  }
  const app = new URL(options.appOrigin);
  const gateway = new URL('/api/inference/v1/responses', app);
  const configured = app.protocol === 'https:' && app.origin === options.appOrigin
    && validIdentifier(options.expectedTeamId) && validIdentifier(options.expectedProjectId);
  const defineProxy = options.defineProxy ?? defineSandboxProxy;
  const fetchUpstream = options.fetch ?? globalThis.fetch;
  const router = express.Router();

  router.use(async (req, res) => {
    const startedAt = performance.now();
    const emit = (code: SandboxProxyDiagnosticCode, details: { status?: number; bytes?: number } = {}) => {
      const diagnostic: SandboxProxyDiagnostic = {
        format: 'motive.sandbox-proxy-diagnostic/0.1',
        code,
        elapsedMs: elapsedSince(startedAt),
        ...(details.status === undefined ? {} : { status: details.status }),
        ...(details.bytes === undefined ? {} : { bytes: details.bytes }),
      };
      try { options.audit?.(diagnostic); } catch { /* diagnostics never affect authorization or transport */ }
    };
    const abort = new AbortController();
    const cancel = () => abort.abort();
    req.once('aborted', cancel);
    const cancelIncompleteResponse = () => { if (!res.writableEnded) cancel(); };
    res.once('close', cancelIncompleteResponse);
    const timer = setTimeout(() => { emit('TRANSPORT_TIMEOUT'); cancel(); }, transportTimeoutMs);
    timer.unref();
    try {
      // forwardURL itself has no query. Any query here changes neither the
      // intended proxy audience nor the one allowed destination.
      if (!/^\/api\/sandbox-egress(?:\/[^?\\\u0000-\u001f\u007f]*)?$/.test(req.originalUrl)
          || req.originalUrl.includes('//') || !configured) {
        emit(configured ? 'INGRESS_PATH_REJECTED' : 'PROXY_UNCONFIGURED');
        await writeWebResponse(denied(configured ? 403 : 503,
          configured ? 'sandbox_proxy_denied' : 'sandbox_proxy_unconfigured'), res); return;
      }
      const contentLength = req.get('content-length');
      const declaredBytes = contentLength && /^(0|[1-9][0-9]{0,15})$/.test(contentLength)
        ? Number(contentLength)
        : undefined;
      if (declaredBytes !== undefined && declaredBytes > options.maximumRequestBytes) {
        emit('REQUEST_TOO_LARGE');
        await writeWebResponse(denied(413, 'sandbox_proxy_request_too_large'), res); return;
      }
      const bodyBytes = req.method === 'GET' || req.method === 'HEAD'
        ? Buffer.alloc(0)
        : await collectIncomingBody(req, options.maximumRequestBytes, declaredBytes, abort.signal);
      emit('REQUEST_BODY_COMPLETE', { bytes: bodyBytes.byteLength });
      const proxy = defineProxy(async (original, meta) => {
        if (meta.host !== app.host) { emit('PREDICATE_HOST_REJECTED'); return denied(); }
        if (meta.teamId !== options.expectedTeamId) { emit('PREDICATE_TEAM_REJECTED'); return denied(); }
        if (meta.projectId !== options.expectedProjectId) { emit('PREDICATE_PROJECT_REJECTED'); return denied(); }
        if (original.method !== 'POST') { emit('PREDICATE_METHOD_REJECTED'); return denied(); }
        let destination: URL;
        try { destination = new URL(original.url); }
        catch { emit('PREDICATE_DESTINATION_REJECTED'); return denied(); }
        if (destination.href !== gateway.href || destination.protocol !== 'https:'
            || destination.username || destination.password || destination.search || destination.hash) {
          emit('PREDICATE_DESTINATION_REJECTED'); return denied();
        }
        const authorization = original.headers.get('authorization');
        if (!authorization || !/^Bearer [A-Za-z0-9_-]{32,512}$/.test(authorization)) {
          emit('PREDICATE_BEARER_REJECTED'); return denied();
        }
        const contentType = original.headers.get('content-type')?.toLowerCase();
        if (contentType !== 'application/json' || (original.headers.get('content-encoding') ?? 'identity') !== 'identity'
            || !original.body) { emit('PREDICATE_CONTENT_TYPE_REJECTED'); return denied(); }
        emit('ADMITTED');
        let requestTooLarge = false;
        try {
          const upstreamInit: RequestInit & { duplex: 'half' } = {
            method: 'POST', redirect: 'error', signal: abort.signal, duplex: 'half',
            headers: { Authorization: authorization, 'Content-Type': 'application/json', Accept: 'text/event-stream',
              'Content-Length': String(bodyBytes.byteLength) },
            body: new Uint8Array(bodyBytes),
          };
          emit('FETCH_STARTED', { bytes: bodyBytes.byteLength });
          const upstream = await fetchUpstream(gateway, upstreamInit);
          emit('UPSTREAM_RESPONSE', { status: upstream.status });
          const upstreamType = upstream.headers.get('content-type')?.toLowerCase() ?? '';
          if (upstream.ok && (!upstream.body || !upstreamType.startsWith('text/event-stream'))) {
            emit('UPSTREAM_RESPONSE_INVALID', { status: upstream.status });
            await upstream.body?.cancel(); return denied(502, 'sandbox_proxy_upstream_invalid');
          }
          const headers = responseHeaders(upstreamType || 'application/json; charset=utf-8', 'gateway');
          for (const name of ['x-motive-operation-id', 'x-request-id']) {
            const value = upstream.headers.get(name);
            if (value && /^[\x20-\x7e]{1,1024}$/.test(value)) headers.set(name, value);
          }
          return new Response(upstream.body ? boundedStream(upstream.body, options.maximumResponseBytes, abort.signal) : null,
            { status: upstream.status, headers });
        } catch (error) {
          if (requestTooLarge || error instanceof StreamLimitError) {
            emit('REQUEST_TOO_LARGE'); return denied(413, 'sandbox_proxy_request_too_large');
          }
          emit('UPSTREAM_UNAVAILABLE');
          return denied(502, 'sandbox_proxy_upstream_unavailable');
        }
      }, (_request, error) => { emit(oidcDiagnostic(error)); return denied(); });
      const response = await proxy(webRequest(req, app.origin, abort.signal, bodyBytes));
      await writeWebResponse(response, res);
    } catch (error) {
      emit(error instanceof StreamLimitError ? 'REQUEST_TOO_LARGE'
        : error instanceof IncomingBodyUnavailableError ? 'REQUEST_BODY_UNAVAILABLE'
          : 'PROXY_HANDLER_FAILED');
      if (!res.headersSent && !res.destroyed) {
        await writeWebResponse(error instanceof StreamLimitError
          ? denied(413, 'sandbox_proxy_request_too_large')
          : denied(502, 'sandbox_proxy_upstream_unavailable'), res);
      } else if (!res.destroyed) res.destroy();
    } finally {
      clearTimeout(timer);
      req.off('aborted', cancel);
      res.off('close', cancelIncompleteResponse);
      abort.abort();
    }
  });
  return router;
}
