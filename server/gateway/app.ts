import { createHash, randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { LedgerKernel, OperationProjection } from '../../packages/accounting/src/kernel.ts';
import { LedgerKernelError } from '../../packages/accounting/src/errors.ts';
import { canonicalJson, type Digest } from '../../packages/domain/src/contracts.ts';
import {
  profileDigest, validateAndFreezeProfile, validateRequest, type GatewayProfile,
} from '../../packages/inference-gateway/src/profile.ts';
import { ResponsesSseAccountingParser } from '../../packages/inference-gateway/src/stream.ts';
import { GatewayProtocolError } from '../../packages/inference-gateway/src/protocol.ts';

/** These methods are server-only. A worker never supplies an actor, source or tariff. */
export type GatewayLedger = Pick<LedgerKernel,
  'getRunCapabilityContext' | 'admitCapabilityRequest' | 'claimOperationForDispatch' |
  'recordOperationProviderIdentity' | 'settleOperation' | 'markOperationUnknown'>;

export type GatewayAudit = {
  event: 'gateway_request_failed' | 'gateway_accounting_unavailable' | 'gateway_request_settled';
  requestId: string;
  operationId?: string;
  /** Trusted error category only; never raw request content or provider error text. */
  failureCode?: string;
};

export type InferenceGatewayOptions = {
  ledger: GatewayLedger;
  profiles: readonly GatewayProfile[];
  /** Resolve a server-held credential only when its reference belongs to this funding source. */
  resolveCredential: (sourceId: string, credentialRef: string) => Promise<string | null>;
  isReady?: () => boolean;
  audit?: (event: GatewayAudit) => void;
  fetch?: typeof globalThis.fetch;
  /** Register work that must survive the downstream HTTP response lifecycle. */
  trackBackgroundTask?: (task: Promise<void>) => void;
  /** Hosting-specific ceiling; the generic gateway keeps the profile's validated limit. */
  maximumRequestTimeoutMs?: number;
};

function respondFailure(res: Response, status: number, error: string) {
  if (res.headersSent) { res.destroy(); return; }
  if (!res.destroyed) res.status(status).type('application/json').json({ error: { code: error, message: 'The inference request could not be completed.' } });
}

function publicError(error: unknown): { status: number; code: string } {
  if (error instanceof LedgerKernelError) {
    if (error.code.startsWith('CAPABILITY_')) return { status: 401, code: 'capability_unavailable' };
    if (['OPERATION_IN_FLIGHT', 'SUSPECTED_RETRANSMISSION', 'IDEMPOTENCY_CONFLICT'].includes(error.code)) {
      return { status: 409, code: 'operation_conflict' };
    }
    if (error.code.startsWith('INSUFFICIENT_')) return { status: 402, code: 'allowance_unavailable' };
    return { status: 403, code: 'admission_denied' };
  }
  if (error instanceof Error && error.name === 'GatewayValidationError') return { status: 400, code: 'unsupported_request' };
  return { status: 503, code: 'gateway_unavailable' };
}

/**
 * Responses HTTP/SSE gateway. Construction does not enable or create funding.
 * The caller supplies reviewed profiles and source-bound server credentials;
 * the database must independently admit every request under a live capability.
 */
export function createInferenceGateway(options: InferenceGatewayOptions) {
  if (options.maximumRequestTimeoutMs !== undefined
      && (!Number.isSafeInteger(options.maximumRequestTimeoutMs) || options.maximumRequestTimeoutMs < 1)) {
    throw new Error('Gateway request timeout ceiling is invalid.');
  }
  const profiles = new Map<Digest, Readonly<GatewayProfile>>();
  for (const input of options.profiles) {
    const profile = validateAndFreezeProfile(input);
    if (options.maximumRequestTimeoutMs !== undefined && profile.limits.requestTimeoutMs > options.maximumRequestTimeoutMs) {
      throw new Error('Gateway profile request timeout exceeds the hosting lifecycle ceiling.');
    }
    profiles.set(profileDigest(profile), profile);
  }
  const fetchProvider = options.fetch ?? globalThis.fetch;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  let draining = false;
  const active = new Set<Promise<void>>();
  const aborts = new Set<AbortController>();
  const dispatcherId = `gateway:${randomUUID()}`;
  const maxBodyBytes = Math.max(1, ...[...profiles.values()].map(profile => profile.limits.maxRequestBytes));
  const audit = (event: GatewayAudit) => { try { options.audit?.(event); } catch { /* An observer cannot change accounting. */ } };

  app.use((req, res, next) => {
    res.locals.requestId = randomUUID();
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Request-Id': res.locals.requestId });
    // This is a capability endpoint for the worker, not a browser/cookie endpoint.
    if (req.get('origin') || req.method === 'OPTIONS') { respondFailure(res, 403, 'origin_denied'); return; }
    if (draining || (options.isReady && !options.isReady())) { respondFailure(res, 503, 'gateway_unavailable'); return; }
    next();
  });
  app.use(rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: { code: 'rate_limited' } } }));
  app.post('/v1/responses', (req, res, next) => {
    if (active.size >= 2) { respondFailure(res, 503, 'gateway_busy'); return; }
    if (!req.is('application/json') || (req.get('content-encoding') && req.get('content-encoding') !== 'identity')) {
      respondFailure(res, 415, 'unsupported_content_type'); return;
    }
    next();
  }, express.raw({ type: 'application/json', inflate: false, limit: maxBodyBytes }), (req, res) => {
    const requestId = res.locals.requestId as string;
    const run = async () => {
      let operation: OperationProjection | undefined;
      let settled = false;
      let dispatchOwned = false;
      let downstreamDetached = false;
      const abort = new AbortController();
      aborts.add(abort);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const forward = (chunk: Uint8Array) => {
        if (downstreamDetached || res.destroyed || res.writableEnded) return;
        // Do not let a slow/disconnected worker block terminal usage consumption.
        // Node owns at most its bounded socket buffer; detach rather than queue.
        res.write(chunk);
        if (res.writableLength > 256 * 1024) { downstreamDetached = true; res.destroy(); }
      };
      try {
        if (active.size >= 2) { respondFailure(res, 503, 'gateway_busy'); return; }
        const header = req.get('authorization');
        if (!header || !/^Bearer [A-Za-z0-9_-]{32,512}$/.test(header)) {
          respondFailure(res, 401, 'capability_required'); return;
        }
        const token = header.slice(7);
        const context = await options.ledger.getRunCapabilityContext(token);
        if (!context) { respondFailure(res, 401, 'capability_unavailable'); return; }
        const profile = profiles.get(context.profileDigest);
        if (!profile) { respondFailure(res, 503, 'profile_unavailable'); return; }
        if (!Buffer.isBuffer(req.body) || req.body.byteLength > profile.limits.maxRequestBytes) {
          respondFailure(res, 413, 'request_too_large'); return;
        }
        const rawBodyDigest = `sha256:${createHash('sha256').update(req.body).digest('hex')}` as Digest;
        let body: unknown;
        try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(req.body)); }
        catch { respondFailure(res, 400, 'invalid_json'); return; }
        // Size, UTF-8, JSON, the complete raw field surface, and the pinned
        // Codex extension are validated before any field is normalized away.
        const validated = validateRequest(body, profile, rawBodyDigest);
        const credential = await options.resolveCredential(context.sourceId, profile.upstream.credentialRef);
        if (!credential || credential.length > 8192 || !/^[\x21-\x7e]+$/.test(credential)) {
          respondFailure(res, 503, 'source_unavailable'); return;
        }
        if (draining || (options.isReady && !options.isReady())) { respondFailure(res, 503, 'gateway_unavailable'); return; }
        // Advisory context is insufficient: token, lease, profile, source, grant
        // and controller are checked again inside the admission transaction.
        operation = await options.ledger.admitCapabilityRequest({
          token, requestBody: validated.body, maximumExposure: validated.maximumExposure,
          profileDigest: context.profileDigest, idempotencyKey: randomUUID(),
          admissionMetadata: { normalizations: validated.normalizations, credentialRef: profile.upstream.credentialRef,
            requestedModel: profile.route.model, profileId: profile.profileId,
            rawBodyDigest: validated.rawBodyDigest, normalizedBodyDigest: validated.normalizedBodyDigest },
        });
        const claimed = await options.ledger.claimOperationForDispatch({
          actorId: dispatcherId, idempotencyKey: randomUUID(), providerOperationId: operation.providerOperationId,
          dispatcherId, invocationToken: randomUUID(),
        });
        if (!claimed.claimed) { respondFailure(res, 409, 'operation_already_dispatched'); return; }
        dispatchOwned = true;
        timer = setTimeout(() => abort.abort(), profile.limits.requestTimeoutMs);
        timer.unref();
        // No client headers, endpoint, provider key or idempotency key pass through.
        // Native fetch does not retry HTTP failures; redirects are errors.
        const response = await fetchProvider(profile.upstream.responsesUrl, {
          method: 'POST', redirect: 'error', signal: abort.signal,
          headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', Accept: 'text/event-stream',
            'X-OpenRouter-Metadata': 'enabled' },
          body: canonicalJson(validated.body),
        });
        const providerRequestId = response.headers.get('x-request-id');
        if (providerRequestId) {
          if (providerRequestId.length > 1024 || !/^[\x20-\x7e]+$/.test(providerRequestId)) throw new Error('Invalid provider identity');
          await options.ledger.recordOperationProviderIdentity({ actorId: dispatcherId, idempotencyKey: randomUUID(),
            providerOperationId: operation.providerOperationId, providerRequestId });
        }
        if (!response.ok || !response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream') || !response.body) {
          await response.body?.cancel();
          throw new Error('Provider response unavailable');
        }
        res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8',
          'X-Motive-Operation-Id': operation.providerOperationId, 'X-Accel-Buffering': 'no' });
        const parser = new ResponsesSseAccountingParser({ maxTotalBytes: profile.limits.maxResponseBytes,
          maxEventBytes: profile.limits.maxEventBytes, expectedModel: profile.route.model,
          maximumExposure: validated.maximumExposure });
        let observedResponseId: string | null = null;
        const terminalChunks: Uint8Array[] = [];
        const reader = response.body.getReader();
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            try { parser.push(chunk.value); }
            finally {
              // Preserve the first identity even when a later event in this same
              // network chunk is malformed or lacks authoritative usage.
              if (parser.responseId && parser.responseId !== observedResponseId) {
                await options.ledger.recordOperationProviderIdentity({ actorId: dispatcherId, idempotencyKey: randomUUID(),
                  providerOperationId: operation.providerOperationId, providerResponseId: parser.responseId });
                observedResponseId = parser.responseId;
              }
            }
            // SSE consumers cannot see the complete terminal frame until its
            // completion chunk arrives. Hold it until settlement commits.
            if (parser.terminalSeen) terminalChunks.push(chunk.value);
            else forward(chunk.value);
          }
        } finally { reader.releaseLock(); }
        const terminal = parser.finish();
        await options.ledger.settleOperation({ actorId: dispatcherId, idempotencyKey: `settle:${operation.providerOperationId}`,
          providerOperationId: operation.providerOperationId, actualCost: terminal.actualCost,
          rawProviderAmount: terminal.rawCost, rawProviderUsage: { usage: terminal.usage,
            returnedModel: terminal.returnedModel, returnedProvider: terminal.returnedProvider,
            profileDigest: context.profileDigest, rawBodyDigest: validated.rawBodyDigest,
            normalizedBodyDigest: validated.normalizedBodyDigest,
            normalizations: validated.normalizations },
          // This is namespaced Responses evidence, not an assumed billing-generation ID.
          providerUsageId: `responses:${terminal.providerResponseId}`,
          providerResponseId: terminal.providerResponseId, ...(providerRequestId ? { providerRequestId } : {}),
        });
        settled = true;
        for (const chunk of terminalChunks) forward(chunk);
        if (!res.destroyed) res.end();
        audit({ event: 'gateway_request_settled', requestId, operationId: operation.providerOperationId });
      } catch (error) {
        abort.abort();
        if (operation && !settled) {
          // A failure after admission, including a lost dispatch/settlement
          // acknowledgement, never implies zero consumption or permits retry.
          try {
            await options.ledger.markOperationUnknown({ actorId: dispatcherId, idempotencyKey: `unknown:${operation.providerOperationId}`,
              providerOperationId: operation.providerOperationId,
              reason: dispatchOwned ? 'Gateway issuance or terminal settlement could not be confirmed.' : 'Gateway dispatch claim could not be confirmed.' });
          } catch {
            // ISSUING/IN_FLIGHT holds survive even when the DB is unreachable.
            audit({ event: 'gateway_accounting_unavailable', requestId, operationId: operation.providerOperationId });
          }
        }
        audit({ event: 'gateway_request_failed', requestId, ...(operation ? { operationId: operation.providerOperationId } : {}),
          ...(error instanceof GatewayProtocolError || error instanceof LedgerKernelError ? { failureCode: error.code } : {}) });
        const result = operation ? { status: 502, code: 'provider_usage_unresolved' } : publicError(error);
        respondFailure(res, result.status, result.code);
      } finally {
        if (timer) clearTimeout(timer);
        aborts.delete(abort);
      }
    };
    const task = run();
    active.add(task);
    options.trackBackgroundTask?.(task);
    void task.finally(() => active.delete(task));
  });
  app.use((_req, res) => respondFailure(res, 404, 'not_found'));
  const onError: ErrorRequestHandler = (error, _req, res, _next) => {
    const tooLarge = typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.too.large';
    respondFailure(res, tooLarge ? 413 : 400, tooLarge ? 'request_too_large' : 'invalid_request');
  };
  app.use(onError);
  return {
    app,
    beginDrain() { draining = true; },
    get activeRequests() { return active.size; },
    async drain(timeoutMs = 10_000) {
      draining = true;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error('Invalid drain timeout');
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...active]),
        new Promise<void>(resolve => { timer = setTimeout(() => { for (const abort of aborts) abort.abort(); resolve(); }, timeoutMs); }),
      ]);
      if (timer) clearTimeout(timer);
      // Timed-out external operations remain durable holds; shutdown must not release them.
    },
  };
}
