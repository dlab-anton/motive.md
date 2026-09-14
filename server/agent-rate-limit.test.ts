import type { Request } from 'express';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { agentRateLimitClientKey, createAgentRateLimitKeyGenerator } from './agent-rate-limit.ts';

function requestWith(
  headers: Record<string, string | string[] | undefined>,
  remoteAddress?: string,
): Pick<Request, 'headers' | 'socket'> {
  return { headers, socket: { remoteAddress } } as Pick<Request, 'headers' | 'socket'>;
}

describe('agent request rate-limit keys', () => {
  it('uses the Vercel client IPv4 address instead of the shared proxy socket', () => {
    const first = requestWith({ 'x-real-ip': '203.0.113.10' }, '10.0.0.1');
    const second = requestWith({ 'x-real-ip': '203.0.113.11' }, '10.0.0.1');

    expect(agentRateLimitClientKey(first, true)).toBe('203.0.113.10');
    expect(agentRateLimitClientKey(second, true)).toBe('203.0.113.11');
  });

  it('groups Vercel IPv6 clients by the express-rate-limit default /56 subnet', () => {
    const first = requestWith({ 'x-real-ip': '2001:db8:1234:5601::1' }, '10.0.0.1');
    const second = requestWith({ 'x-real-ip': '2001:db8:1234:56ff::9' }, '10.0.0.1');

    expect(agentRateLimitClientKey(first, true)).toBe('2001:db8:1234:5600::/56');
    expect(agentRateLimitClientKey(second, true)).toBe(agentRateLimitClientKey(first, true));
  });

  it('ignores a spoofed forwarding chain on Vercel', () => {
    const request = requestWith({
      'x-real-ip': '198.51.100.8',
      'x-forwarded-for': '192.0.2.200, 192.0.2.201',
      forwarded: 'for=192.0.2.202',
    }, '10.0.0.1');

    expect(agentRateLimitClientKey(request, true)).toBe('198.51.100.8');
  });

  it('leaves local limiting on the socket address and omits the custom generator', () => {
    const request = requestWith({
      'x-real-ip': '198.51.100.8',
      'x-forwarded-for': '192.0.2.200',
      forwarded: 'for=192.0.2.201',
    }, '127.0.0.1');

    expect(agentRateLimitClientKey(request, false)).toBe('127.0.0.1');
    expect(createAgentRateLimitKeyGenerator({})).toBeUndefined();
  });

  it('falls back conservatively when the Vercel client IP is missing or invalid', () => {
    expect(agentRateLimitClientKey(requestWith({}, '::ffff:192.0.2.44'), true)).toBe('192.0.2.44');
    expect(agentRateLimitClientKey(requestWith({ 'x-real-ip': 'not-an-ip' }), true)).toBe('unknown-client');
  });

  it('does not emit proxy-header validation errors for a Vercel request', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = express();
    app.set('trust proxy', false);
    app.use(rateLimit({ limit: 120, keyGenerator: createAgentRateLimitKeyGenerator({ VERCEL: '1' })! }));
    app.get('/', (_request, response) => { response.sendStatus(204); });
    const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });

    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}`, { headers: {
        'x-real-ip': '203.0.113.10', 'x-forwarded-for': '192.0.2.10', forwarded: 'for=192.0.2.11',
      } });
      expect(response.status).toBe(204);
      expect(error.mock.calls.flat().join(' ')).not.toMatch(/ERR_ERL_(UNEXPECTED_X_FORWARDED_FOR|FORWARDED_HEADER)/);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(cause => cause ? reject(cause) : resolve()));
      error.mockRestore();
    }
  });
});
