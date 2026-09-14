import { waitUntil } from '@vercel/functions';
import type { InferenceGatewayOptions } from './gateway/app.ts';

export const VERCEL_FUNCTION_MAX_DURATION_SECONDS = 300;
export const VERCEL_GATEWAY_REQUEST_TIMEOUT_MAX_MS = 240_000;

export type VercelWaitUntil = (task: Promise<unknown>) => void;

/**
 * Keeps provider accounting alive after a worker disconnects and reserves one
 * minute of the function lifetime for admission and durable settlement.
 */
export function createVercelGatewayLifecycleOptions(
  register: VercelWaitUntil = waitUntil,
): Pick<InferenceGatewayOptions, 'trackBackgroundTask' | 'maximumRequestTimeoutMs'> {
  return {
    maximumRequestTimeoutMs: VERCEL_GATEWAY_REQUEST_TIMEOUT_MAX_MS,
    trackBackgroundTask(task) { register(task); },
  };
}

export const vercelGatewayLifecycleOptions = createVercelGatewayLifecycleOptions();
