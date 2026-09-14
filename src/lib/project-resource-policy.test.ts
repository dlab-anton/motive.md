import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicCircleProjectUsage, PublicProjectRuns, ProjectRunState } from './project-runs';
import {
  ACTIVE_PROJECT_POLL_INTERVAL_MS,
  INACTIVE_PROJECT_POLL_INTERVAL_MS,
  ProjectResourcePoller,
  STATIC_PROJECT_POLL_INTERVAL_MS,
  projectRunsPollInterval,
  projectUsagePollInterval,
  resolveProjectResourceInterval,
} from './project-resource-policy';

const states: ProjectRunState[] = [
  'queued', 'running', 'stopping', 'checking', 'awaiting-review', 'finished', 'cancelled', 'failed', 'unresolved',
];

function runs(active: ProjectRunState | null): PublicProjectRuns {
  const stateCounts = Object.fromEntries(states.map(state => [state, state === active ? 1 : 0])) as Record<ProjectRunState, number>;
  return { project: 'circle-packing', totalRuns: active ? 1 : 0, stateCounts, runs: [] };
}

function usage(unresolvedRequests: number): PublicCircleProjectUsage {
  return {
    project: 'circle-packing',
    hostedGateway: {
      gatewayRequests: unresolvedRequests,
      settledRequests: 0,
      unresolvedRequests,
      requestsWithTokenCounts: 0,
      requestsWithoutTokenCounts: 0,
      recordedInputTokens: '0',
      recordedOutputTokens: '0',
      recordedTotalTokens: '0',
      inputBreakdownComplete: unresolvedRequests === 0,
      outputBreakdownComplete: unresolvedRequests === 0,
      complete: unresolvedRequests === 0,
    },
    externalAgents: { submissions: 0, tokenUsage: 'NOT_RECORDED_BY_MOTIVE' },
    projectTokenLimit: { status: 'NOT_CONFIGURED', totalTokens: null },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('project resource cadence', () => {
  it.each(['queued', 'running', 'stopping', 'checking', 'awaiting-review', 'unresolved'] as const)(
    'keeps %s runs live', state => expect(projectRunsPollInterval(runs(state))).toBe(ACTIVE_PROJECT_POLL_INTERVAL_MS),
  );

  it.each(['finished', 'cancelled', 'failed'] as const)(
    'slows terminal %s runs', state => expect(projectRunsPollInterval(runs(state))).toBe(INACTIVE_PROJECT_POLL_INTERVAL_MS),
  );

  it('slows empty runs and settled usage while keeping unresolved usage live', () => {
    expect(projectRunsPollInterval(runs(null))).toBe(INACTIVE_PROJECT_POLL_INTERVAL_MS);
    expect(projectUsagePollInterval(usage(0))).toBe(INACTIVE_PROJECT_POLL_INTERVAL_MS);
    expect(projectUsagePollInterval(usage(1))).toBe(ACTIVE_PROJECT_POLL_INTERVAL_MS);
  });

  it('keeps malformed or unknown successful projections at the safe active cadence', () => {
    expect(projectRunsPollInterval({ ...runs(null), stateCounts: {} as Record<ProjectRunState, number> }))
      .toBe(ACTIVE_PROJECT_POLL_INTERVAL_MS);
    expect(projectRunsPollInterval({ ...runs(null), stateCounts: { ...runs(null).stateCounts, running: Number.NaN } }))
      .toBe(ACTIVE_PROJECT_POLL_INTERVAL_MS);
    expect(projectRunsPollInterval({ ...runs(null), stateCounts: { ...runs(null).stateCounts, failed: -1 } }))
      .toBe(ACTIVE_PROJECT_POLL_INTERVAL_MS);
    expect(projectRunsPollInterval({ ...runs(null), totalRuns: 1 }))
      .toBe(ACTIVE_PROJECT_POLL_INTERVAL_MS);
    expect(projectUsagePollInterval({ ...usage(0), hostedGateway: { ...usage(0).hostedGateway, unresolvedRequests: Number.NaN } }))
      .toBe(ACTIVE_PROJECT_POLL_INTERVAL_MS);
    expect(projectUsagePollInterval({ ...usage(0), hostedGateway: { ...usage(0).hostedGateway, unresolvedRequests: -1 } }))
      .toBe(ACTIVE_PROJECT_POLL_INTERVAL_MS);
  });

  it('accepts fixed and data-driven intervals and safely defaults invalid values', () => {
    expect(resolveProjectResourceInterval(STATIC_PROJECT_POLL_INTERVAL_MS, 'data')).toBe(STATIC_PROJECT_POLL_INTERVAL_MS);
    expect(resolveProjectResourceInterval((value: string) => value.length * 1_000, 'scope')).toBe(5_000);
    expect(resolveProjectResourceInterval(0, 'data')).toBe(ACTIVE_PROJECT_POLL_INTERVAL_MS);
  });
});

describe('ProjectResourcePoller', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('uses the resolved interval and never overlaps refreshes', async () => {
    const first = deferred<number>();
    const second = deferred<number>();
    const poll = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const poller = new ProjectResourcePoller({
      poll,
      onSuccess: vi.fn(),
      onError: vi.fn(),
      intervalMs: (value: number) => value,
      hidden: () => false,
    });

    poller.start();
    poller.requestRefresh();
    poller.requestRefresh();
    expect(poll).toHaveBeenCalledTimes(1);

    first.resolve(INACTIVE_PROJECT_POLL_INTERVAL_MS);
    await flush();
    expect(poll).toHaveBeenCalledTimes(2);

    second.resolve(INACTIVE_PROJECT_POLL_INTERVAL_MS);
    await flush();
    await vi.advanceTimersByTimeAsync(INACTIVE_PROJECT_POLL_INTERVAL_MS - 1);
    expect(poll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(3);
    poller.stop();
  });

  it('refreshes immediately on a change notification and replaces the scheduled poll', async () => {
    const poll = vi.fn(async () => 'ok');
    const poller = new ProjectResourcePoller({
      poll,
      onSuccess: vi.fn(),
      onError: vi.fn(),
      intervalMs: INACTIVE_PROJECT_POLL_INTERVAL_MS,
      hidden: () => false,
    });

    poller.start();
    await flush();
    expect(poll).toHaveBeenCalledTimes(1);
    poller.requestRefresh();
    expect(poll).toHaveBeenCalledTimes(2);
    await flush();
    await vi.advanceTimersByTimeAsync(INACTIVE_PROJECT_POLL_INTERVAL_MS - 1);
    expect(poll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(3);
    poller.stop();
  });

  it('does not poll while hidden and refreshes immediately when visible', async () => {
    let hidden = true;
    const poll = vi.fn(async () => 'ok');
    const poller = new ProjectResourcePoller({ poll, onSuccess: vi.fn(), onError: vi.fn(), hidden: () => hidden });

    poller.start();
    await vi.advanceTimersByTimeAsync(ACTIVE_PROJECT_POLL_INTERVAL_MS * 2);
    expect(poll).not.toHaveBeenCalled();

    hidden = false;
    poller.visibilityChanged();
    expect(poll).toHaveBeenCalledTimes(1);
    await flush();
    hidden = true;
    poller.visibilityChanged();
    await vi.advanceTimersByTimeAsync(ACTIVE_PROJECT_POLL_INTERVAL_MS * 2);
    expect(poll).toHaveBeenCalledTimes(1);
    poller.stop();
  });

  it('cancels an in-flight request and ignores its result after stop', async () => {
    const request = deferred<string>();
    let signal: AbortSignal | undefined;
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const poller = new ProjectResourcePoller({
      poll: currentSignal => { signal = currentSignal; return request.promise; },
      onSuccess,
      onError,
      hidden: () => false,
    });

    poller.start();
    poller.stop();
    expect(signal?.aborted).toBe(true);
    request.resolve('stale');
    await flush();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries errors at the safe active cadence and retains later success scheduling', async () => {
    const onError = vi.fn();
    const onSuccess = vi.fn();
    const poll = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(INACTIVE_PROJECT_POLL_INTERVAL_MS);
    const poller = new ProjectResourcePoller({
      poll,
      onSuccess,
      onError,
      intervalMs: (value: number) => value,
      hidden: () => false,
    });

    poller.start();
    await flush();
    expect(onError).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(ACTIVE_PROJECT_POLL_INTERVAL_MS - 1);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(2);
    await flush();
    expect(onSuccess).toHaveBeenCalledWith(INACTIVE_PROJECT_POLL_INTERVAL_MS);
    poller.stop();
  });
});
