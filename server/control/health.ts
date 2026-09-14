import type { Express, NextFunction, Request, Response } from 'express';

export type HealthPhase = 'starting' | 'ready' | 'unavailable' | 'draining';

export type HealthSnapshot = Readonly<{
  status: HealthPhase;
  ready: boolean;
  draining: boolean;
  buildId: string;
  startedAt: string;
  checkedAt: string;
  reason?: string;
}>;

export type HealthController = Readonly<{
  markReady(): void;
  markUnhealthy(reason?: string): void;
  beginDrain(): void;
  isReady(): boolean;
  isDraining(): boolean;
  snapshot(): HealthSnapshot;
}>;

export type ReadinessProbeOptions = Readonly<{
  health: HealthController;
  probe(signal: AbortSignal): Promise<void>;
  intervalMs: number;
  timeoutMs: number;
  onError?(error: unknown): void;
}>;

export function createHealthController(buildId: string): HealthController {
  const startedAt = new Date().toISOString();
  let phase: HealthPhase = 'starting';
  let checkedAt = startedAt;
  let reason: string | undefined = 'startup_in_progress';

  const touch = (): void => { checkedAt = new Date().toISOString(); };

  return Object.freeze({
    markReady(): void {
      if (phase === 'draining') return;
      phase = 'ready';
      reason = undefined;
      touch();
    },
    markUnhealthy(nextReason = 'dependency_check_failed'): void {
      if (phase === 'draining') return;
      phase = 'unavailable';
      reason = nextReason;
      touch();
    },
    beginDrain(): void {
      phase = 'draining';
      reason = 'shutdown_in_progress';
      touch();
    },
    isReady: () => phase === 'ready',
    isDraining: () => phase === 'draining',
    snapshot(): HealthSnapshot {
      return Object.freeze({
        status: phase,
        ready: phase === 'ready',
        draining: phase === 'draining',
        buildId,
        startedAt,
        checkedAt,
        ...(reason ? { reason } : {}),
      });
    },
  });
}

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
}

export function registerHealthRoutes(app: Pick<Express, 'get'>, health: HealthController): void {
  app.get('/health/live', (_req: Request, res: Response) => {
    noStore(res);
    res.status(200).json({ ...health.snapshot(), alive: true });
  });
  app.get('/health/ready', (_req: Request, res: Response) => {
    noStore(res);
    const snapshot = health.snapshot();
    if (!snapshot.ready) res.setHeader('Connection', 'close');
    res.status(snapshot.ready ? 200 : 503).json(snapshot);
  });
}

export function requireReady(health: HealthController) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    if (health.isReady()) {
      next();
      return;
    }
    noStore(res);
    res.setHeader('Connection', 'close');
    res.status(503).json({ error: health.isDraining() ? 'Service is draining.' : 'Service is not ready.' });
  };
}

export function startReadinessProbe(options: ReadinessProbeOptions): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activeController: AbortController | undefined;

  const schedule = (): void => {
    if (stopped || options.health.isDraining()) return;
    timer = setTimeout(() => { void check(); }, options.intervalMs);
    timer.unref();
  };

  const check = async (): Promise<void> => {
    if (stopped || options.health.isDraining()) return;
    const controller = new AbortController();
    activeController = controller;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const probe = Promise.resolve().then(() => options.probe(controller.signal));
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        const error = new Error('Readiness probe timed out.');
        controller.abort(error);
        reject(error);
      }, options.timeoutMs);
      timeout.unref();
    });
    try {
      await Promise.race([probe, deadline]);
      options.health.markReady();
    } catch (error) {
      options.health.markUnhealthy();
      options.onError?.(error);
    } finally {
      if (timeout) clearTimeout(timeout);
      // Do not overlap checks if a dependency ignores cancellation. Its late
      // result cannot restore readiness because only the race above mutates it.
      await probe.catch(() => undefined);
      if (activeController === controller) activeController = undefined;
      schedule();
    }
  };

  void check();
  return (): void => {
    stopped = true;
    if (timer) clearTimeout(timer);
    activeController?.abort(new Error('Readiness probe stopped.'));
  };
}
