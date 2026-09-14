#!/usr/bin/env node

const baseUrlValue = process.argv[2] ?? process.env.CONTROL_SMOKE_BASE_URL;
if (!baseUrlValue) {
  console.error('Usage: node deploy/smoke-control.mjs <control-plane-base-url>');
  process.exitCode = 2;
} else {
  let baseUrl;
  try {
    baseUrl = new URL(baseUrlValue);
  } catch {
    console.error('The control-plane base URL must be an absolute URL.');
    process.exitCode = 2;
  }

  if (baseUrl) {
    const check = async (path) => {
      const url = new URL(path, baseUrl);
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000), redirect: 'error' });
      const body = await response.json().catch(() => undefined);
      if (!response.ok || typeof body !== 'object' || body === null) {
        throw new Error(`${path} returned HTTP ${response.status} or an invalid JSON body.`);
      }
      return { path, status: response.status, body };
    };

    try {
      const results = [];
      for (const path of ['/health/live', '/health/ready']) results.push(await check(path));
      console.log(JSON.stringify({ ok: true, baseUrl: baseUrl.origin, checks: results }, null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'Control-plane smoke check failed.');
      process.exitCode = 1;
    }
  }
}
