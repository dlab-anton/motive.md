import { expect, test } from '@playwright/test';

const supabaseOrigin = 'https://github-signin-test.supabase.co';
const config = { provider: 'supabase', supabaseUrl: supabaseOrigin,
  supabasePublishableKey: 'sb_publishable_githubsignintestonly' };

test('GitHub works from signup without requiring email fields and uses the exact root callback', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/account-config', route => route.fulfill({ json: config }));
  await page.route(`${supabaseOrigin}/auth/v1/settings`, route => route.fulfill({ json: { external: { github: true } } }));
  let authorization: URL | undefined;
  await page.route(`${supabaseOrigin}/auth/v1/authorize**`, async route => {
    authorization = new URL(route.request().url());
    await route.fulfill({ contentType: 'text/plain', body: 'OAuth navigation captured by test. No provider login performed.' });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Continue with GitHub' })).toBeVisible();
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Become part of the work.' })).toBeVisible();
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('');
  await page.screenshot({ path: 'artifacts/github-signin-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Continue with GitHub' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/github-signin-mobile.png' });
  const appOrigin = new URL(page.url()).origin;
  await page.getByRole('button', { name: 'Continue with GitHub' }).click();
  await expect.poll(() => authorization?.pathname).toBe('/auth/v1/authorize');
  expect(authorization!.searchParams.get('provider')).toBe('github');
  expect(authorization!.searchParams.get('redirect_to')).toBe(`${appOrigin}/`);
  expect(authorization!.searchParams.has('repo')).toBe(false);
  expect(errors).toEqual([]);
});

test('unavailable social-provider settings leave email sign-in usable', async ({ page }) => {
  await page.route('**/api/account-config', route => route.fulfill({ json: config }));
  await page.route(`${supabaseOrigin}/auth/v1/settings`, route => route.fulfill({ status: 503, body: 'Unavailable' }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Continue with GitHub' })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
