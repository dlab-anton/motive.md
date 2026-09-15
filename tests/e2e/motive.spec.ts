import { expect, test } from '@playwright/test';

test('shows one real public project without legacy balances or sample activity', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => localStorage.setItem('motive-preview-v2', JSON.stringify({
    allocations: { math: { tokens: 10_000, status: 'paused' } },
    credits: [{ amount: 50_000 }],
  })));

  await page.goto('/');
  await expect(page).toHaveTitle(/motive\.md/);
  await expect(page.locator('[data-project]')).toHaveCount(2);
  const project = page.locator('[data-project="circle-packing"]');
  await expect(project).toContainText('Find a better circle packing');
  await expect(project).toContainText('Open for contributions');
  await expect(project).toContainText('0 active assignments');
  await expect(project).toContainText('0 results');
  await expect(project).toContainText('No accepted Motive result');
  await expect(page.locator('#token-balance')).toHaveCount(0);
  await expect(page.locator('.site-header')).not.toContainText('$');

  await page.getByRole('link', { name: 'Explore Find a better circle packing' }).click();
  await expect(page.getByRole('heading', { name: 'Find a better circle packing', level: 1 })).toBeVisible();
  await expect(page.getByRole('img', { name: 'The independently checked reference arrangement of 101 circles' })).toBeVisible();
  await expect(page.locator('.reference-arrangement')).toContainText('5.291095');
  await expect(page.locator('.welcome-credit')).toContainText('10 free Motive credits');
  await expect(page.getByRole('button', { name: 'Sign in to use your credits' })).toBeVisible();
  await expect(page.locator('.backing-card')).toContainText('They aren’t cash or model tokens');
  await expect(page.getByRole('button', { name: 'OpenRouter, coming later' })).toBeDisabled();
  await expect(page.locator('.openrouter-funding')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Evidence' }).click();
  await expect(page.locator('.reference-exact-score')).toHaveText('5.29109518547430697');
  await page.getByText('Benchmark and acceptance details').click();
  await expect(page.getByRole('tabpanel')).toContainText('The paper prints 5.289154');

  await page.setViewportSize({ width: 320, height: 568 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('lists the matrix multiplication project in preparation with its reference and exact checker', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  const card = page.locator('[data-project="matmul-4x4x4"]');
  await expect(card).toContainText('Multiply 4×4 matrices in fewer than 49 products');
  await expect(card).toContainText('In preparation');
  await expect(card).toContainText('not yet open for agents');
  await expect(card).not.toContainText('active assignments');

  await page.getByRole('link', { name: 'Explore Multiply 4×4 matrices in fewer than 49 products' }).click();
  await expect(page.getByRole('heading', { name: 'Multiply 4×4 matrices in fewer than 49 products', level: 1 })).toBeVisible();
  await expect(page.getByRole('img', { name: 'The frozen reference scheme: 49 products, Strassen applied twice' })).toBeVisible();
  await expect(page.locator('.reference-scheme')).toContainText('49');
  await expect(page.locator('.project-preparation')).toContainText('In preparation');
  await expect(page.locator('.project-context-table')).toContainText('rational coefficients');
  await expect(page.locator('#contribute-agent')).toHaveCount(0);
  await expect(page.locator('.backing-card')).toHaveCount(0);

  await page.goto('/?project=matmul-4x4x4&tab=check');
  await page.getByRole('button', { name: 'Check frozen reference' }).click();
  const pass = page.locator('.checker-pass');
  await expect(pass).toContainText('Valid under the local exact checker');
  await expect(pass).toContainText('Products: 49');
  await expect(pass).toContainText('equal to the frozen reference of 49');
  await expect(page.getByRole('img', { name: 'Sign pattern of the checked scheme with 49 products' })).toBeVisible();

  const input = page.getByLabel('JSON scheme · at most 256 KiB');
  const rational = (await (await page.request.get('/projects/matmul-4x4x4/reference-witness.json')).text()).replace('"u":[[1,', '"u":[[2,').replace('"v":[[1,', '"v":[[0.5,');
  await input.setInputFiles({ name: 'rational.json', mimeType: 'application/json', buffer: Buffer.from(rational) });
  await expect(page.getByRole('button', { name: 'Check selected scheme' })).toBeEnabled();
  await page.getByRole('button', { name: 'Check selected scheme' }).click();
  await expect(page.getByRole('alert')).toContainText('Scheme rejected · NONINTEGER_NUMBER');
  await expect(page.locator('.scheme-preview')).toHaveCount(0);

  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/?project=matmul-4x4x4');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('checks the frozen N=101 reference and rejects malformed or overlapping uploads', async ({ page }) => {
  await page.goto('/?project=circle-packing&tab=check');
  await page.getByRole('button', { name: 'Check frozen reference' }).click();
  const pass = page.locator('.checker-pass');
  await expect(pass).toContainText('Feasible under the local exact checker');
  await expect(pass).toContainText('Radius sum: 5.29109518547430697');
  await expect(pass).toContainText('equal to the frozen reference');
  await expect(pass).toContainText('not an accepted Motive result');
  await expect(page.getByRole('img', { name: 'Approximate plot of 101 circles from the checked witness' })).toBeVisible();
  await expect(page.locator('.packing-figure circle')).toHaveCount(101);

  const input = page.getByLabel('JSON witness · at most 32 KiB');
  await input.setInputFiles({ name: 'malformed.json', mimeType: 'application/json', buffer: Buffer.from('{') });
  await expect(page.getByRole('button', { name: 'Check selected witness' })).toBeEnabled();
  await page.getByRole('button', { name: 'Check selected witness' }).click();
  await expect(page.getByRole('alert')).toContainText('Witness rejected · MALFORMED_JSON');
  await expect(page.locator('.packing-figure')).toHaveCount(0);

  const overlap = JSON.stringify({
    format: 'motive.csqv.witness.v1',
    n: 101,
    circles: Array.from({ length: 101 }, () => ({ x: '0.5', y: '0.5', r: '0.01' })),
  });
  await input.setInputFiles({ name: 'overlap.json', mimeType: 'application/json', buffer: Buffer.from(overlap) });
  await expect(page.getByRole('button', { name: 'Check selected witness' })).toBeEnabled();
  await page.getByRole('button', { name: 'Check selected witness' }).click();
  await expect(page.getByRole('alert')).toContainText('Witness rejected · OVERLAP');
  await expect(page.locator('.packing-figure')).toHaveCount(0);

  await page.getByRole('tab', { name: 'Evidence' }).click();
  await expect(page.getByRole('tabpanel')).toContainText('0 accepted Motive results');
  await expect(page.getByRole('tabpanel')).toContainText('No community submissions have arrived yet.');
});
