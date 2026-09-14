import { expect, test } from '@playwright/test';

const origin = process.env.MOTIVE_ACCOUNT_TEST_ORIGIN ?? 'http://127.0.0.1:4317';
const headers = { Origin: origin };

test('server isolates accounts and denies legacy funding actions', async ({ browser }) => {
  const first = await browser.newContext();
  const second = await browser.newContext();
  const anotherSession = await browser.newContext();
  const one = { name: 'Isolation One', email: `one-${crypto.randomUUID()}@example.test`, password: `Test-${crypto.randomUUID()}` };
  const two = { name: 'Isolation Two', email: `two-${crypto.randomUUID()}@example.test`, password: `Test-${crypto.randomUUID()}` };
  try {
    const registered = await first.request.post(`${origin}/api/auth/sign-up/email`, { headers, data: one });
    expect(registered.ok()).toBe(true);
    const firstId = (await registered.json()).user.id;
    expect((await second.request.post(`${origin}/api/auth/sign-up/email`, { headers, data: two })).ok()).toBe(true);

    const welcome = await first.request.get(`${origin}/api/credits`);
    expect(welcome.ok()).toBe(true);
    expect(await welcome.json()).toEqual({
      unit: 'motive_credit', issued: 10, available: 10, allocated: 0, allocations: [], executionEnabled: false,
    });
    const firstAllocation = await first.request.post(`${origin}/api/credits/allocations`, {
      headers: { ...headers, 'Idempotency-Key': 'repeat-allocation' },
      data: { project: 'circle-packing', amount: 3 },
    });
    expect(firstAllocation.status()).toBe(201);
    const firstAllocationBody = await firstAllocation.json();
    expect(firstAllocationBody).toMatchObject({
      wallet: { issued: 10, available: 7, allocated: 3, executionEnabled: false },
      receipt: { project: 'circle-packing', amount: 3, status: 'WAITING_FOR_FUNDED_RUN' },
    });
    const replay = await first.request.post(`${origin}/api/credits/allocations`, {
      headers: { ...headers, 'Idempotency-Key': 'repeat-allocation' },
      data: { project: 'circle-packing', amount: 3 },
    });
    expect(replay.status()).toBe(200);
    expect((await replay.json()).receipt.id).toBe(firstAllocationBody.receipt.id);
    const changedBody = await first.request.post(`${origin}/api/credits/allocations`, {
      headers: { ...headers, 'Idempotency-Key': 'repeat-allocation' },
      data: { project: 'circle-packing', amount: 4 },
    });
    expect(changedBody.status()).toBe(409);
    const competing = await Promise.all([
      first.request.post(`${origin}/api/credits/allocations`, {
        headers: { ...headers, 'Idempotency-Key': 'competing-a' },
        data: { project: 'circle-packing', amount: 5 },
      }),
      first.request.post(`${origin}/api/credits/allocations`, {
        headers: { ...headers, 'Idempotency-Key': 'competing-b' },
        data: { project: 'circle-packing', amount: 5 },
      }),
    ]);
    expect(competing.map(response => response.status()).sort()).toEqual([201, 409]);
    expect(await (await first.request.get(`${origin}/api/credits`)).json()).toMatchObject({
      issued: 10, allocated: 8, available: 2, executionEnabled: false,
    });

    const topup = await first.request.post(`${origin}/api/support`, { headers, data: { type: 'topup', amount: 25_000 } });
    expect(topup.status()).toBe(400);
    expect(await topup.json()).toMatchObject({ error: 'Only following a public project is available.' });
    const allocation = await first.request.post(`${origin}/api/support`, {
      headers, data: { type: 'confirm', goal: 'circle-packing', tokens: 3_000 },
    });
    expect(allocation.status()).toBe(400);
    expect((await first.request.post(`${origin}/api/support`, {
      headers, data: { type: 'follow', goal: 'circle-packing', following: true },
    })).ok()).toBe(true);
    expect((await first.request.post(`${origin}/api/profile`, {
      headers, data: { bio: 'Private to the first account.' },
    })).ok()).toBe(true);

    const secondState = await (await second.request.get(`${origin}/api/workspace`)).json();
    expect(secondState).toMatchObject({ bio: '', support: { following: [] } });
    const callerSuppliedIdentity = await second.request.post(`${origin}/api/support`, {
      headers, data: { type: 'follow', goal: 'circle-packing', following: true, userId: firstId },
    });
    expect(callerSuppliedIdentity.status()).toBe(400);
    const firstState = await (await first.request.get(`${origin}/api/workspace`)).json();
    expect(firstState).toMatchObject({
      bio: 'Private to the first account.',
      support: { following: ['circle-packing'] },
    });
    expect(JSON.stringify(firstState)).not.toContain('tokens');

    expect((await anotherSession.request.post(`${origin}/api/auth/sign-in/email`, {
      headers, data: { email: one.email, password: one.password },
    })).ok()).toBe(true);
    expect((await first.request.post(`${origin}/api/auth/revoke-other-sessions`, { headers, data: {} })).ok()).toBe(true);
    expect((await anotherSession.request.get(`${origin}/api/workspace`)).status()).toBe(401);
    expect((await first.request.get(`${origin}/api/workspace`)).ok()).toBe(true);
  } finally {
    await first.request.post(`${origin}/api/auth/delete-user`, { headers, data: { password: one.password } });
    await second.request.post(`${origin}/api/auth/delete-user`, { headers, data: { password: two.password } });
    await Promise.all([first.close(), second.close(), anotherSession.close()]);
  }
});

test('account profile, settings, password, and followed project persist', async ({ page, browser }) => {
  const email = `flow-${crypto.randomUUID()}@example.test`;
  const initialPassword = `Motive-${crypto.randomUUID()}`;
  const updatedPassword = `Updated-${crypto.randomUUID()}`;
  let cleanupPassword = initialPassword;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill('Test Contributor');
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(initialPassword);
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Open account menu' })).toBeVisible();

    await page.goto('/?project=circle-packing');
    await expect(page.locator('.credit-balance')).toContainText('10');
    await page.getByLabel('Credits for this project').fill('4');
    await page.getByRole('button', { name: 'Allocate 4 credits' }).click();
    await expect(page.locator('.allocation-receipt')).toContainText('4 credits allocated to this project');
    await expect(page.locator('.allocation-receipt')).toContainText('waiting for a funded run');
    await expect(page.locator('.credit-balance')).toContainText('6');
    await expect(page.locator('.backing-card')).toContainText('no AI spending starts when you allocate');
    await page.getByRole('button', { name: 'Follow project', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Following', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#token-balance')).toHaveCount(0);

    await page.goto('/?view=settings');
    await page.getByLabel('Display name').fill('Motive Tester');
    await page.getByLabel('A little about you').fill('Checking open mathematical work carefully.');
    await page.getByRole('button', { name: 'Save profile' }).click();
    await expect(page.getByText('Profile saved', { exact: true })).toBeVisible();
    await page.goto('/?view=profile');
    await expect(page.locator('.profile-card')).toContainText('Motive Tester');
    await expect(page.locator('.profile-card')).toContainText('Checking open mathematical work carefully.');
    await expect(page.locator('.profile-stats')).toContainText('1');
    await expect(page.locator('.profile-goals')).toContainText('Find a better circle packing');
    await page.reload();
    await expect(page.locator('.profile-card')).toContainText('Motive Tester');

    const signedOut = await browser.newContext();
    expect((await signedOut.request.get(`${origin}/api/workspace`)).status()).toBe(401);
    await signedOut.close();
    const foreignOrigin = await page.request.post('/api/profile', {
      headers: { Origin: 'https://untrusted.example' }, data: { bio: 'Rejected' },
    });
    expect(foreignOrigin.status()).toBe(403);

    await page.goto('/?view=settings');
    await page.getByLabel('Current password', { exact: true }).fill(initialPassword);
    await page.getByLabel('New password', { exact: true }).fill(updatedPassword);
    await page.getByRole('button', { name: 'Update password' }).click();
    await expect(page.getByText('Password updated. Other sessions signed out.', { exact: true })).toBeVisible();
    cleanupPassword = updatedPassword;
    await page.getByRole('button', { name: 'Open account menu' }).click();
    await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();

    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(initialPassword);
    await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
    await expect(page.getByRole('alert')).toBeVisible();
    await page.getByLabel('Password', { exact: true }).fill(updatedPassword);
    await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
    await expect(page.getByRole('button', { name: 'Open account menu' })).toBeVisible();
    await page.goto('/?view=support');
    await expect(page.locator('[data-followed-project="circle-packing"]')).toContainText('Find a better circle packing');
    await expect(page.locator('#token-balance')).toHaveCount(0);
    await page.goto('/?project=circle-packing');
    await expect(page.locator('.allocation-receipt')).toContainText('4 credits allocated to this project');
    await expect(page.locator('.credit-balance')).toContainText('6');

    await page.goto('/?view=settings');
    await page.getByRole('button', { name: 'Delete account', exact: true }).click();
    await page.getByLabel('Password', { exact: true }).fill(updatedPassword);
    await page.getByRole('button', { name: 'Permanently delete account' }).click();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await page.request.post('/api/auth/sign-in/email', { headers, data: { email, password: cleanupPassword } }).catch(() => undefined);
    await page.request.post('/api/auth/delete-user', { headers, data: { password: cleanupPassword } }).catch(() => undefined);
  }
});
