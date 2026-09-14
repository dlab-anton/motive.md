import type { IncomingMessage, ServerResponse } from 'node:http';

export type VercelApplication = (request: IncomingMessage, response: ServerResponse) => unknown;
export type VercelApplicationLoader = () => Promise<VercelApplication>;
const ROUTED_API_PATH = '__motive_api_path';

function clearVercelParsedQuery(request: IncomingMessage): void {
  const descriptor = Object.getOwnPropertyDescriptor(request, 'query');
  if (!descriptor) return;
  if (!descriptor.configurable) throw new Error('VERCEL_API_ROUTE_INVALID');
  delete (request as IncomingMessage & { query?: unknown }).query;
}

/** Restore the captured public API path after Vercel selects this one function. */
export function restoreVercelApiPath(request: IncomingMessage): void {
  const url = new URL(request.url ?? '/', 'http://internal.invalid');
  if (!url.searchParams.has(ROUTED_API_PATH)) return;
  const values = url.searchParams.getAll(ROUTED_API_PATH);
  const path = values[0];
  if (values.length !== 1 || path === undefined || path.length > 2_048 || /[\\?#\u0000-\u001f\u007f]/.test(path)
      || path.split('/').some(segment => segment === '.' || segment === '..')) {
    throw new Error('VERCEL_API_ROUTE_INVALID');
  }
  url.searchParams.delete(ROUTED_API_PATH);
  // Vercel pre-parses the rewrite query onto the request. Remove that cache so
  // Express derives req.query from the restored URL without the internal key.
  clearVercelParsedQuery(request);
  request.url = `/api${path ? `/${path}` : ''}${url.search}`;
}

export async function loadVercelApplication(): Promise<VercelApplication> {
  if (process.env.VERCEL !== '1') throw new Error('VERCEL_APPLICATION_CONTEXT_REQUIRED');
  if (process.env.MOTIVE_ACCOUNT_PROVIDER !== 'supabase') throw new Error('VERCEL_SUPABASE_ACCOUNTS_REQUIRED');
  const module = await import('../server/index.ts');
  return module.createApplication();
}

function safeMissingModuleIdentity(error: unknown, code: string): string | undefined {
  if (code !== 'ERR_MODULE_NOT_FOUND' || !(error instanceof Error)) return undefined;
  const missingUrl = error && typeof error === 'object' && 'url' in error ? error.url : undefined;
  if (typeof missingUrl === 'string') {
    try {
      const parsed = new URL(missingUrl);
      const prefix = '/var/task/';
      if (parsed.protocol === 'file:' && parsed.hostname === '' && parsed.search === '' && parsed.hash === ''
          && parsed.pathname.startsWith(prefix) && /^\/var\/task\/[A-Za-z0-9._/-]{1,240}$/.test(parsed.pathname)) {
        const relative = parsed.pathname.slice(prefix.length);
        if (relative.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')) {
          return `file:${relative}`;
        }
      }
    } catch { /* malformed URLs are intentionally not logged */ }
  }
  const packageMatch = /^Cannot find package '((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:\/[a-z0-9._-]+)*)' imported from /i.exec(error.message);
  return packageMatch ? `package:${packageMatch[1]}` : undefined;
}

function safeErrorIdentity(error: unknown): { name: string; code: string; module?: string } {
  const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name) ? error.name : 'Error';
  const coded = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const candidate = typeof coded === 'string' ? coded : error instanceof Error ? error.message : '';
  const code = /^[A-Z][A-Z0-9_]{2,80}$/.test(candidate) ? candidate : 'UNCLASSIFIED';
  const module = safeMissingModuleIdentity(error, code);
  return module ? { name, code, module } : { name, code };
}

function logFailure(event: string, failure: ReturnType<typeof safeErrorIdentity>): void {
  if (failure.module) console.error(event, failure.name, failure.code, failure.module);
  else console.error(event, failure.name, failure.code);
}

function unavailable(response: ServerResponse): void {
  if (response.headersSent || response.destroyed) { response.destroy(); return; }
  response.statusCode = 503;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify({ error: 'The application service is unavailable.' }));
}

/** One warm function instance shares one initialized application composition. */
export function createVercelApiHandler(load: VercelApplicationLoader = loadVercelApplication) {
  let application: Promise<VercelApplication> | undefined;
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    let pending: Promise<VercelApplication>;
    try {
      restoreVercelApiPath(request);
      pending = application ??= load();
    } catch (error) {
      const failure = safeErrorIdentity(error);
      logFailure('VERCEL_API_ROUTE_REJECTED', failure);
      unavailable(response); return;
    }
    let handler: VercelApplication;
    try {
      handler = await pending;
    } catch (error) {
      // A transient composition failure must not poison this warm instance.
      // Compare by identity so a late observer of an older rejection cannot
      // clear a newer initialization that another request has already begun.
      if (application === pending) application = undefined;
      const failure = safeErrorIdentity(error);
      logFailure('VERCEL_APPLICATION_INITIALIZATION_FAILED', failure);
      unavailable(response); return;
    }
    try {
      await handler(request, response);
    } catch (error) {
      const failure = safeErrorIdentity(error);
      logFailure('VERCEL_APPLICATION_REQUEST_FAILED', failure);
      unavailable(response);
    }
  };
}

export default createVercelApiHandler();
