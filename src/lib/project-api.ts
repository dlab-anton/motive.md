import { useCallback, useEffect, useRef, useState } from 'react';
import { authenticatedFetch, isAccountApiPath } from './account-fetch';
import { ProjectResourcePoller, type ProjectResourceInterval } from './project-resource-policy';

class ProjectRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function projectRequest<T>(path: string, body?: unknown, key?: string): Promise<T> {
  const response = await authenticatedFetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ProjectRequestError(typeof data?.message === 'string' ? data.message : typeof data?.error === 'string' ? data.error : typeof data?.error?.message === 'string' ? data.error.message : 'The project service is unavailable. Please try again.', response.status);
  return data as T;
}

/** Refresh after local actions and while visible; retain the last observation on an outage. */
export function useProjectResource<T>(path: string | null, options: { intervalMs?: ProjectResourceInterval<T> } = {}) {
  const [value, setValue] = useState<{ path: string; data: T } | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision(value => value + 1), []);
  const intervalMs = options.intervalMs;
  useEffect(() => {
    if (!path) return;
    const poller = new ProjectResourcePoller<T>({
      hidden: () => document.hidden,
      intervalMs,
      poll: async signal => {
        const response = await (isAccountApiPath(new URL(path, window.location.origin).pathname)
          ? authenticatedFetch(path, { signal })
          : fetch(path, { credentials: 'same-origin', signal, redirect: 'error' }));
        const data = await response.json();
        if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : 'Project updates are unavailable.');
        return data as T;
      },
      onSuccess: data => { setValue({ path, data }); setError(''); },
      onError: error => setError(error instanceof Error ? error.message : 'Project updates are unavailable.'),
    });
    const visible = () => poller.visibilityChanged();
    const changed = () => poller.requestRefresh();
    poller.start();
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('motive:project-changed', changed);
    return () => { poller.stop(); document.removeEventListener('visibilitychange', visible); window.removeEventListener('motive:project-changed', changed); };
  }, [path, revision, intervalMs]);
  return { data: value?.path === path ? value.data : null, loaded: Boolean(value && value.path === path), error: path ? error : '', reload };
}

export function notifyProjectChanged() { window.dispatchEvent(new Event('motive:project-changed')); }

export function useProjectMutation<T>() {
  const pending = useRef<{ path: string; body: unknown; key: string } | null>(null);
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retryPending, setRetryPending] = useState(false);
  async function submit(path: string, body: unknown): Promise<T | null> {
    if (locked.current) return null;
    const attempt = pending.current ?? { path, body, key: crypto.randomUUID() };
    pending.current = attempt; locked.current = true; setBusy(true); setError('');
    try {
      const result = await projectRequest<T>(attempt.path, attempt.body, attempt.key);
      pending.current = null; setRetryPending(false); notifyProjectChanged();
      return result;
    } catch (error) {
      if (error instanceof ProjectRequestError && error.status >= 400 && error.status < 500) pending.current = null;
      setRetryPending(Boolean(pending.current));
      setError(error instanceof Error ? error.message : 'This action could not be confirmed.');
      return null;
    } finally { locked.current = false; setBusy(false); }
  }
  return { busy, error, retryPending, submit };
}
