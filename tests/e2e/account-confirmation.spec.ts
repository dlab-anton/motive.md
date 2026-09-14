import { expect, test } from '@playwright/test';

const supabaseOrigin = 'https://browser-auth.supabase.co';
const publishableKey = 'sb_publishable_browserconfirmationtest';

test('Supabase signup remains pending confirmation and the dialog clears passwords', async ({ page }) => {
  const errors: string[] = []; const signupRequests: Array<{ url: string; body: Record<string, unknown> }> = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/account-config', route => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ provider: 'supabase', supabaseUrl: supabaseOrigin, supabasePublishableKey: publishableKey }) }));
  await page.route(`${supabaseOrigin}/**`, async route => {
    const request = route.request(); const url = new URL(request.url());
    if (request.method() === 'POST' && url.pathname === '/auth/v1/signup') {
      const body = request.postDataJSON() as Record<string, unknown>; signupRequests.push({ url: request.url(), body });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        id: 'b946ed1b-d1e1-4134-b650-e76740356f32', aud: 'authenticated', role: 'authenticated',
        email: body.email, confirmation_sent_at: '2026-09-07T14:30:00.000Z',
        app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: body.data,
        identities: [], created_at: '2026-09-07T14:30:00.000Z', updated_at: '2026-09-07T14:30:00.000Z',
      }) });
      return;
    }
    await route.abort('blockedbyclient');
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Email Confirmation Test');
  await page.getByLabel('Email', { exact: true }).fill('confirmation@example.test');
  await page.getByLabel('Password', { exact: true }).fill('Temporary-password-123');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Check your email.' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('confirmation@example.test');
  await expect(page.getByRole('status')).toContainText('10 welcome Motive credits');
  expect(signupRequests).toHaveLength(1);
  const signupUrl = new URL(signupRequests[0].url);
  expect(signupUrl.searchParams.get('redirect_to')).toBe('http://127.0.0.1:4317/');
  expect(signupRequests[0].body).toMatchObject({ email: 'confirmation@example.test',
    data: { name: 'Email Confirmation Test' } });
  await page.screenshot({ path: 'artifacts/account-confirmation-desktop.png', fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.auth-dialog')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const box = await page.locator('.auth-dialog').boundingBox();
  expect(box).not.toBeNull(); expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'artifacts/account-confirmation-mobile.png', fullPage: true });

  await page.getByRole('button', { name: 'Back to sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
  await page.getByLabel('Password', { exact: true }).fill('must-not-survive-close');
  await page.keyboard.press('Escape');
  await expect(page.locator('.auth-dialog')).not.toBeVisible();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
  expect(errors).toEqual([]);
});
