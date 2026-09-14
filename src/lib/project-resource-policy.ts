import type { PublicCircleProjectUsage, PublicProjectRuns, ProjectRunState } from './project-runs';

export const ACTIVE_PROJECT_POLL_INTERVAL_MS = 5_000;
export const INACTIVE_PROJECT_POLL_INTERVAL_MS = 30_000;
export const STATIC_PROJECT_POLL_INTERVAL_MS = 60_000;

const ACTIVE_RUN_STATES = [
  'queued', 'running', 'stopping', 'checking', 'awaiting-review', 'unresolved',
] as const satisfies readonly ProjectRunState[];
const ALL_RUN_STATES = [
  ...ACTIVE_RUN_STATES, 'finished', 'cancelled', 'failed',
] as const satisfies readonly ProjectRunState[];

export type ProjectResourceInterval<T> = number | ((data: T) => number);

export function projectRunsPollInterval(data: PublicProjectRuns): number {
  if (data?.project !== 'circle-packing' || !data.stateCounts
    || !Number.isInteger(data.totalRuns) || data.totalRuns < 0
    || !ALL_RUN_STATES.every(state => Number.isInteger(data.stateCounts[state]) && data.stateCounts[state] >= 0)
    || ALL_RUN_STATES.reduce((total, state) => total + data.stateCounts[state], 0) !== data.totalRuns) {
    return ACTIVE_PROJECT_POLL_INTERVAL_MS;
  }
  return ACTIVE_RUN_STATES.some(state => data.stateCounts[state] > 0)
    ? ACTIVE_PROJECT_POLL_INTERVAL_MS
    : INACTIVE_PROJECT_POLL_INTERVAL_MS;
}

export function projectUsagePollInterval(data: PublicCircleProjectUsage): number {
  const unresolved = data?.project === 'circle-packing' ? data.hostedGateway?.unresolvedRequests : undefined;
  if (!Number.isInteger(unresolved) || unresolved! < 0) return ACTIVE_PROJECT_POLL_INTERVAL_MS;
  return unresolved! > 0
    ? ACTIVE_PROJECT_POLL_INTERVAL_MS
    : INACTIVE_PROJECT_POLL_INTERVAL_MS;
}

export function resolveProjectResourceInterval<T>(interval: ProjectResourceInterval<T> | undefined, data: T): number {
  const resolved = typeof interval === 'function' ? interval(data) : interval;
  return typeof resolved === 'number' && Number.isFinite(resolved) && resolved > 0
    ? resolved
    : ACTIVE_PROJECT_POLL_INTERVAL_MS;
}

type PollTimer = number | ReturnType<typeof setTimeout>;

type ProjectResourcePollerOptions<T> = {
  poll: (signal: AbortSignal) => Promise<T>;
  onSuccess: (data: T) => void;
  onError: (error: unknown) => void;
  intervalMs?: ProjectResourceInterval<T>;
  hidden: () => boolean;
  setTimer?: (callback: () => void, delay: number) => PollTimer;
  clearTimer?: (timer: PollTimer) => void;
};

/** Coordinates one visible-tab poll stream without overlapping requests. */
export class ProjectResourcePoller<T> {
  private timer: PollTimer | undefined;
  private controller: AbortController | undefined;
  private running = false;
  private refreshPending = false;
  private stopped = false;

  constructor(private readonly options: ProjectResourcePollerOptions<T>) {}

  start(): void { this.requestRefresh(); }

  requestRefresh(): void {
    if (this.stopped || this.options.hidden()) return;
    if (this.running) { this.refreshPending = true; return; }
    void this.poll();
  }

  visibilityChanged(): void {
    if (this.options.hidden()) this.clearScheduledPoll();
    else this.requestRefresh();
  }

  stop(): void {
    this.stopped = true;
    this.refreshPending = false;
    this.clearScheduledPoll();
    this.controller?.abort();
  }

  private async poll(): Promise<void> {
    if (this.stopped || this.running || this.options.hidden()) return;
    this.running = true;
    this.refreshPending = false;
    this.clearScheduledPoll();
    const controller = new AbortController();
    this.controller = controller;
    let nextInterval = ACTIVE_PROJECT_POLL_INTERVAL_MS;
    try {
      const data = await this.options.poll(controller.signal);
      if (this.stopped) return;
      this.options.onSuccess(data);
      nextInterval = resolveProjectResourceInterval(this.options.intervalMs, data);
    } catch (error) {
      if (!this.stopped) this.options.onError(error);
    } finally {
      this.running = false;
      if (this.controller === controller) this.controller = undefined;
      if (this.stopped) return;
      if (this.refreshPending && !this.options.hidden()) this.requestRefresh();
      else this.schedule(nextInterval);
    }
  }

  private schedule(delay: number): void {
    if (this.stopped || this.options.hidden()) return;
    const setTimer = this.options.setTimer ?? setTimeout;
    this.timer = setTimer(() => {
      this.timer = undefined;
      this.requestRefresh();
    }, delay);
  }

  private clearScheduledPoll(): void {
    if (this.timer === undefined) return;
    const clearTimer = this.options.clearTimer ?? clearTimeout;
    clearTimer(this.timer);
    this.timer = undefined;
  }
}
