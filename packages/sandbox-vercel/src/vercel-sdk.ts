import { Sandbox } from '@vercel/sandbox';
import type {
  ProviderSandboxStatus,
  SdkOwnedSandboxDiscovery,
  SandboxSdkFactory,
  SdkCommand,
  SdkCommandRequest,
  SdkCreateRequest,
  SdkSandbox,
  SdkSandboxSummary,
} from './types.ts';

export const VERCEL_SANDBOX_SDK_VERSION = '3.2.1' as const;
export const VERCEL_SANDBOX_NPM_INTEGRITY =
  'sha512-Yw/UJl5T5OwO+TmnMAVgHTWlu2vYmMUAA9x7RhTHCge9y3cx90kvrjvNDDiqtt3euoFnLeoP2kvZFDbNwgWaww==' as const;
export const VERCEL_SANDBOX_SOURCE_COMMIT = 'be86cc619390868ae08435fde227c6896b8acad9' as const;

export type NativeVercelCredentials = {
  token: string;
  teamId: string;
  projectId: string;
};

/**
 * The SDK wraps a supplied fetch and retries network errors, 429, and 5xx by
 * default. Its public factory exposes fetch but no retry option. This boundary
 * makes the raw request single-attempt: network failures are presented to the
 * SDK as an abort (which its retry wrapper bails on), and retryable responses
 * are remapped to a non-retryable response while retaining the original status.
 */
export function createSingleAttemptFetch(rawFetch: typeof globalThis.fetch = globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    let response: Response;
    try {
      response = await rawFetch(input, { ...init, redirect: 'error' });
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') throw cause;
      const error = new Error('Vercel Sandbox transport failed after one request.', { cause });
      error.name = 'AbortError';
      throw error;
    }
    if (response.status !== 429 && (response.status < 500 || response.status > 599)) return response;
    const headers = new Headers(response.headers);
    headers.set('x-motive-upstream-status', String(response.status));
    headers.delete('retry-after');
    return new Response(response.body, {
      status: 409,
      statusText: 'Upstream effect status retained without SDK retry',
      headers,
    });
  };
}

type NativeSandbox = Awaited<ReturnType<typeof Sandbox.get>>;

function wrapSandbox(sandbox: NativeSandbox): SdkSandbox {
  const current = () => sandbox.currentSession();
  return {
    get name() { return sandbox.name; },
    get sessionId() { return current().sessionId; },
    get persistent() { return sandbox.persistent; },
    get status() { return sandbox.status as ProviderSandboxStatus; },
    get expiresAt() { return sandbox.expiresAt; },
    get sourceSnapshotId() { return sandbox.sourceSnapshotId; },
    get image() { return sandbox.image; },
    get tags() { return sandbox.tags; },
    async startCommand(request: SdkCommandRequest): Promise<SdkCommand> {
      // Calling Sandbox.runCommand would invoke the SDK's automatic resume and
      // retry path. A Session call is scoped to the observed current VM.
      const command = await current().runCommand(request);
      return { cmdId: command.cmdId, exitCode: command.exitCode, ...(command.durationMs === undefined ? {} : { durationMs: command.durationMs }) };
    },
    async getCommand(commandId: string): Promise<SdkCommand> {
      const command = await current().getCommand(commandId);
      return { cmdId: command.cmdId, exitCode: command.exitCode, ...(command.durationMs === undefined ? {} : { durationMs: command.durationMs }) };
    },
    async stop() {
      const stopped = await sandbox.stop();
      return { status: stopped.status as ProviderSandboxStatus };
    },
  };
}

export function createNativeVercelSdkFactory(
  credentials: NativeVercelCredentials,
  rawFetch: typeof globalThis.fetch = globalThis.fetch,
): SandboxSdkFactory {
  const fetch = createSingleAttemptFetch(rawFetch);
  const auth = { ...credentials };
  return {
    async create(request: SdkCreateRequest): Promise<SdkSandbox> {
      const sandbox = await Sandbox.create({
        ...request,
        ports: [...request.ports],
        ...auth,
        fetch,
      });
      return wrapSandbox(sandbox);
    },
    async get(request): Promise<SdkSandbox> {
      const sandbox = await Sandbox.get({ ...request, ...auth, fetch });
      return wrapSandbox(sandbox);
    },
    async listOwned(request): Promise<SdkOwnedSandboxDiscovery> {
      const { maximumResults, ...filters } = request;
      const pages = await Sandbox.list({ ...filters, limit: Math.min(100, maximumResults), ...auth, fetch });
      const sandboxes: SdkSandboxSummary[] = [];
      for await (const sandbox of pages) {
        if (sandboxes.length === maximumResults) {
          return { sandboxes, complete: false };
        }
        sandboxes.push({
          name: sandbox.name,
          sessionId: sandbox.currentSessionId,
          persistent: sandbox.persistent,
          status: sandbox.status as ProviderSandboxStatus,
          ...(sandbox.expiresAt === undefined ? {} : { expiresAt: new Date(sandbox.expiresAt) }),
          ...(sandbox.image === undefined ? {} : { image: sandbox.image }),
          ...(sandbox.tags === undefined ? {} : { tags: sandbox.tags }),
        });
      }
      return { sandboxes, complete: true };
    },
  };
}

/** Returns the original HTTP status retained by createSingleAttemptFetch. */
export function retainedUpstreamStatus(error: unknown): number | null {
  const response = (error as { response?: Response } | undefined)?.response;
  const value = response?.headers.get('x-motive-upstream-status');
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}
