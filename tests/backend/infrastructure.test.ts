import { describe, expect, it } from 'vitest';
import express from 'express';
import { ControlConfigError, loadControlConfig } from '../../server/control/config.ts';
import { createHealthController, registerHealthRoutes, startReadinessProbe } from '../../server/control/health.ts';

const validDevelopment = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://motive:local-only@127.0.0.1:5432/motive',
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_PUBLISHABLE_KEY: 'local-publishable-key',
} as const;

const validProduction = {
  NODE_ENV: 'production',
  HOST: '0.0.0.0',
  PORT: '8080',
  CONTROL_ALLOWED_ORIGINS: 'https://motive.test',
  CONTROL_BUILD_ID: 'git-0123456789abcdef',
  DATABASE_URL: 'postgresql://motive:secret@db.project.supabase.co:5432/postgres',
  DATABASE_CONNECTION_MODE: 'direct',
  DATABASE_CA_CERT: '-----BEGIN CERTIFICATE-----\\ncertificate-data\\n-----END CERTIFICATE-----',
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test-value',
} as const;

const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

describe('control-plane configuration', () => {
  it('uses loopback defaults only for development', () => {
    const config = loadControlConfig(validDevelopment);
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(4320);
    expect(config.database.ssl).toBeUndefined();
    expect(config.trigger).toBeUndefined();
  });

  it('builds a verified production database configuration', () => {
    const config = loadControlConfig(validProduction);
    expect(config.database.ssl).toEqual(expect.objectContaining({ rejectUnauthorized: true }));
    expect(config.database.ssl?.ca).toContain('\ncertificate-data\n');
    expect(config.allowedOrigins).toEqual(['https://motive.test']);
  });

  it.each([
    [{ ...validProduction, CONTROL_ALLOWED_ORIGINS: 'http://localhost:4317' }, 'CONTROL_ALLOWED_ORIGINS must use https:'],
    [{ ...validProduction, DATABASE_URL: `${validProduction.DATABASE_URL}?sslmode=require` }, 'must omit sslmode'],
    [{ ...validProduction, DATABASE_CA_CERT: '' }, 'DATABASE_CA_CERT is required'],
    [{ ...validProduction, SUPABASE_PUBLISHABLE_KEY: 'replace-me' }, 'placeholder value'],
    [{ ...validProduction, DATABASE_POOL_MAX: '0' }, 'DATABASE_POOL_MAX must be an integer'],
  ])('rejects unsafe production input', (environment, expected) => {
    expect(() => loadControlConfig(environment)).toThrowError(ControlConfigError);
    expect(() => loadControlConfig(environment)).toThrowError(expected);
  });
});

describe('control-plane readiness', () => {
  it('serves liveness while readiness follows startup and drain state', async () => {
    const health = createHealthController('test-build');
    const app = express();
    registerHealthRoutes(app, health);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test port');
    const base = `http://127.0.0.1:${address.port}`;
    try {
      expect((await fetch(`${base}/health/live`)).status).toBe(200);
      expect((await fetch(`${base}/health/ready`)).status).toBe(503);
      health.markReady();
      expect((await fetch(`${base}/health/ready`)).status).toBe(200);
      health.beginDrain();
      expect((await fetch(`${base}/health/ready`)).status).toBe(503);
      expect((await fetch(`${base}/health/live`)).status).toBe(200);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('recovers after a dependency probe succeeds', async () => {
    const health = createHealthController('test-build');
    let attempts = 0;
    const stop = startReadinessProbe({
      health,
      intervalMs: 5,
      timeoutMs: 2,
      probe: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('database unavailable');
      },
    });
    await wait(15);
    stop();
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(health.isReady()).toBe(true);
  });

  it('times out, aborts, and does not overlap a stuck probe', async () => {
    const health = createHealthController('test-build');
    let attempts = 0;
    let aborted = false;
    const stop = startReadinessProbe({
      health,
      intervalMs: 5,
      timeoutMs: 2,
      probe: signal => new Promise<void>(resolve => {
        attempts += 1;
        signal.addEventListener('abort', () => { aborted = true; }, { once: true });
        void resolve;
      }),
    });
    await wait(15);
    expect(health.snapshot().status).toBe('unavailable');
    expect(aborted).toBe(true);
    expect(attempts).toBe(1);
    stop();
  });

  it('cannot become ready after drain begins', async () => {
    const health = createHealthController('test-build');
    let finish: (() => void) | undefined;
    const stop = startReadinessProbe({
      health,
      intervalMs: 20,
      timeoutMs: 10,
      probe: () => new Promise<void>(resolve => { finish = resolve; }),
    });
    await wait(1);
    health.beginDrain();
    finish?.();
    await wait(2);
    stop();
    expect(health.snapshot()).toEqual(expect.objectContaining({ status: 'draining', ready: false, draining: true }));
  });
});
