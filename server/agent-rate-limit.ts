import { ipAddress } from '@vercel/functions';
import type { Request } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';
import { isIP } from 'node:net';

type ClientAddressRequest = Pick<Request, 'headers' | 'socket'>;

const UNKNOWN_CLIENT_KEY = 'unknown-client';

function normalizedIpKey(candidate: string | undefined): string | undefined {
  return candidate && isIP(candidate) ? ipKeyGenerator(candidate) : undefined;
}

function vercelClientIp(request: ClientAddressRequest): string | undefined {
  const header = request.headers['x-real-ip'];
  if (typeof header !== 'string') return undefined;

  try {
    // Vercel overwrites the forwarding IP to prevent spoofing and documents
    // x-real-ip as identical to it: https://vercel.com/docs/headers/request-headers
    return ipAddress(new Headers({ 'x-real-ip': header }));
  } catch {
    return undefined;
  }
}

export function agentRateLimitClientKey(request: ClientAddressRequest, isVercel: boolean): string {
  const platformKey = isVercel ? normalizedIpKey(vercelClientIp(request)) : undefined;
  return platformKey
    ?? normalizedIpKey(request.socket.remoteAddress)
    ?? UNKNOWN_CLIENT_KEY;
}

export function createAgentRateLimitKeyGenerator(
  environment: NodeJS.ProcessEnv = process.env,
): ((request: Request) => string) | undefined {
  if (environment.VERCEL !== '1') return undefined;
  return request => agentRateLimitClientKey(request, true);
}
