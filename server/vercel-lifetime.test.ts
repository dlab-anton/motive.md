import { describe, expect, it, vi } from 'vitest';
import {
  createVercelGatewayLifecycleOptions,
  VERCEL_FUNCTION_MAX_DURATION_SECONDS,
  VERCEL_GATEWAY_REQUEST_TIMEOUT_MAX_MS,
} from './vercel-lifetime.ts';

describe('Vercel gateway lifetime configuration', () => {
  it('registers the exact task and retains a sixty-second settlement margin', async () => {
    const register = vi.fn();
    const lifecycle = createVercelGatewayLifecycleOptions(register);
    const task = Promise.resolve();
    lifecycle.trackBackgroundTask!(task);

    expect(register).toHaveBeenCalledExactlyOnceWith(task);
    expect(lifecycle.maximumRequestTimeoutMs).toBe(VERCEL_GATEWAY_REQUEST_TIMEOUT_MAX_MS);
    expect(VERCEL_FUNCTION_MAX_DURATION_SECONDS * 1_000 - VERCEL_GATEWAY_REQUEST_TIMEOUT_MAX_MS).toBe(60_000);
    await task;
  });
});
