/** Synthetic BYO rehearsal request metadata only; never records headers, query values, or bodies. */
import { appendFileSync, existsSync } from 'node:fs';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { safeRequestMetadata } from './lib/byo-rehearsal.ts';

const traceFile = process.env.MOTIVE_REHEARSAL_MOTIVE_TRACE_FILE;
const readyFile = process.env.MOTIVE_REHEARSAL_READY_FILE;
if (!traceFile || !readyFile) throw new Error('BYO rehearsal trace paths are required.');
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  let url: URL;
  try { url = new URL(input instanceof Request ? input.url : String(input)); }
  catch { throw new Error('BYO rehearsal blocked an invalid outbound request.'); }
  if (url.origin !== 'http://127.0.0.1:4337') {
    throw new Error('BYO rehearsal blocked a non-engine outbound request.');
  }
  return originalFetch(input, init);
};

const originalEmit = http.Server.prototype.emit;
http.Server.prototype.emit = function emit(event: string | symbol, ...args: unknown[]): boolean {
  if (event === 'request') {
    const request = args[0] as http.IncomingMessage;
    const response = args[1] as http.ServerResponse;
    const started = performance.now();
    const startedAt = new Date().toISOString();
    const metadata = safeRequestMetadata(request.url ?? '/');
    response.once('finish', () => {
      const entry = {
        service: 'motive',
        phase: existsSync(readyFile) ? 'rehearsal' : 'bootstrap',
        startedAt,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        method: request.method ?? 'UNKNOWN',
        ...metadata,
        status: response.statusCode,
      };
      try { appendFileSync(traceFile, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 }); }
      catch { /* request behavior must not depend on diagnostics */ }
    });
  }
  return originalEmit.call(this, event, ...args);
};
