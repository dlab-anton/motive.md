import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearPendingConnectorReturn,
  readPendingConnectorReturn,
  rememberPendingConnectorReturn,
  validateConnectorRedirectUrl,
} from './motive-connector-return';

const REQUEST_ID = '12345678-1234-4123-8123-123456789abc';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

afterEach(() => vi.unstubAllGlobals());

function browser() {
  const sessionStorage = new MemoryStorage();
  vi.stubGlobal('window', { sessionStorage });
  return sessionStorage;
}

describe('Motive connector return', () => {
  it('remembers only the request UUID and returns it for ten minutes', () => {
    const target = browser();
    expect(rememberPendingConnectorReturn(REQUEST_ID, 1_000)).toBe(true);
    expect([...Array.from({ length: target.length }, (_, index) => target.key(index))]).toHaveLength(1);
    expect(target.getItem(target.key(0)!)).not.toContain('credential');
    expect(readPendingConnectorReturn(600_999)).toBe(`/connect/motive?request=${REQUEST_ID}`);
    expect(readPendingConnectorReturn(601_000)).toBeNull();
    expect(target.length).toBe(0);
  });

  it('clears invalid, corrupt, and explicitly completed returns', () => {
    const target = browser();
    expect(rememberPendingConnectorReturn('../not-a-request', 1_000)).toBe(false);
    target.setItem('motive.connector.return.v1', '{broken');
    expect(readPendingConnectorReturn(1_001)).toBeNull();
    rememberPendingConnectorReturn(REQUEST_ID, 1_000);
    clearPendingConnectorReturn();
    expect(target.length).toBe(0);
  });

  it('allows absolute HTTPS and loopback HTTP redirects only', () => {
    expect(validateConnectorRedirectUrl('https://agent.example/callback?code=one')).toBe('https://agent.example/callback?code=one');
    expect(validateConnectorRedirectUrl('http://127.0.0.1:4317/callback')).toBe('http://127.0.0.1:4317/callback');
    expect(validateConnectorRedirectUrl('http://localhost:4317/callback')).toBe('http://localhost:4317/callback');
    expect(validateConnectorRedirectUrl('http://agent.example/callback')).toBeNull();
    expect(validateConnectorRedirectUrl('//agent.example/callback')).toBeNull();
    expect(validateConnectorRedirectUrl('javascript:alert(1)')).toBeNull();
  });
});
