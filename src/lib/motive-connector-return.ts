const STORAGE_KEY = 'motive.connector.return.v1';
const RETURN_TTL_MS = 10 * 60 * 1000;
const CANONICAL_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

type PendingConnectorReturn = {
  requestId: string;
  expiresAt: number;
};

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function isCanonicalConnectorRequestId(value: string | null | undefined): value is string {
  return typeof value === 'string' && CANONICAL_UUID.test(value);
}

export function rememberPendingConnectorReturn(requestId: string, now = Date.now()): boolean {
  const target = storage();
  if (!target || !isCanonicalConnectorRequestId(requestId) || !Number.isFinite(now)) {
    clearPendingConnectorReturn();
    return false;
  }
  const pending: PendingConnectorReturn = { requestId, expiresAt: now + RETURN_TTL_MS };
  try {
    target.setItem(STORAGE_KEY, JSON.stringify(pending));
    return true;
  } catch {
    return false;
  }
}

export function readPendingConnectorReturn(now = Date.now()): string | null {
  const target = storage();
  if (!target || !Number.isFinite(now)) return null;
  try {
    const raw = target.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PendingConnectorReturn>;
    if (!isCanonicalConnectorRequestId(value.requestId)
        || typeof value.expiresAt !== 'number'
        || !Number.isFinite(value.expiresAt)
        || value.expiresAt <= now
        || value.expiresAt > now + RETURN_TTL_MS) {
      target.removeItem(STORAGE_KEY);
      return null;
    }
    return `/connect/motive?request=${value.requestId}`;
  } catch {
    try { target.removeItem(STORAGE_KEY); } catch { /* Storage is unavailable. */ }
    return null;
  }
}

export function clearPendingConnectorReturn(): void {
  try { storage()?.removeItem(STORAGE_KEY); } catch { /* Storage is unavailable. */ }
}

export function validateConnectorRedirectUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2_048) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === 'https:') return url.href;
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  return url.protocol === 'http:' && loopback ? url.href : null;
}
