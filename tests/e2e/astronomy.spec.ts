import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const projectPath = '/?project=exoplanet-hunting';
const planPath = '/projects/exoplanet-hunting/research-plan.json';
test.use({ baseURL: process.env.MOTIVE_E2E_BASE_URL ?? 'http://127.0.0.1:4317' });

// Vite serves the public page without the API. These two read-only stubs give
// each test an isolated guest session; project endpoints remain unstubbed.
test.beforeEach(async ({ page }) => {
  await page.route('**/api/account-config', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ provider: 'local-better-auth' }),
  }));
  await page.route('**/api/auth/**', route => route.fulfill({
    status: 200, contentType: 'application/json', body: 'null',
  }));
});

function captureProjectRequests(page: Page): string[] {
  const requests: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (/^\/api\/public\/projects\/(?:exoplanet-hunting|circle-packing)(?:\/|$)/.test(path)) requests.push(path);
  });
  return requests;
}

test('catalogue filters Astronomy, Math, and All projects with URL state', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.project-count')).toHaveText('3 projects');
  await expect(page.locator('[data-project]')).toHaveCount(3);

  await page.getByRole('tab', { name: 'Astronomy' }).click();
  await expect(page).toHaveURL(/\?category=Astronomy$/);
  await expect(page.locator('.project-count')).toHaveText('1 project');
  await expect(page.locator('[data-project]')).toHaveCount(1);
  await expect(page.locator('[data-project="exoplanet-hunting"]')).toContainText('Hunt for exoplanets');
  await expect(page.locator('[data-project="exoplanet-hunting"]')).toContainText('In preparation');
  await expect(page.locator('[data-project="exoplanet-hunting"] .project-stats')).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole('tab', { name: 'Astronomy' })).toHaveAttribute('data-state', 'active');
  await expect(page.locator('[data-project]')).toHaveCount(1);

  await page.getByRole('tab', { name: 'Math' }).click();
  await expect(page).toHaveURL(/\?category=Math$/);
  await expect(page.locator('.project-count')).toHaveText('2 projects');
  await expect(page.locator('[data-project]')).toHaveCount(2);
  await page.getByRole('tab', { name: 'All projects' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.locator('.project-count')).toHaveText('3 projects');
});

test('astronomy detail exposes a draft plan without enrollment, activity, or project API calls', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const projectRequests = captureProjectRequests(page);

  await page.goto(projectPath);
  await expect(page.getByRole('heading', { name: 'Hunt for exoplanets', level: 1 })).toBeVisible();
  await expect(page.locator('.project-preparation')).toContainText('In preparation');
  await expect(page.locator('#contribute-agent')).toHaveCount(0);
  await expect(page.locator('.backing-card, .project-task-section, .research-journal, .project-stats')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Connect an agent' })).toHaveCount(0);
  await expect(page.locator('.agent-join-footer')).toHaveCount(0);

  await expect(page.locator(`a[href="${planPath}"]`).first()).toBeVisible();
  await expect(page.locator('a[href="https://archive.stsci.edu/missions-and-data/tess"]').first()).toBeVisible();
  await expect(page.locator('a[href="https://tess.mit.edu/science/ddt/"]').first()).toBeVisible();
  await expect(page.locator('a[href="https://exoplanetarchive.ipac.caltech.edu/docs/faq.html"]').first()).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator(`a[href="${planPath}"]`).first().click(),
  ]);
  const plan = JSON.parse(await readFile(await download.path(), 'utf8'));
  expect(plan).toMatchObject({
    format: 'motive.exoplanet-hunting.research-plan.v1',
    projectId: 'exoplanet-hunting',
    status: 'draft-proposed',
  });

  const illustration = page.locator('.transit-illustration');
  await expect(illustration.getByRole('button', { name: 'See the signal' })).toHaveAttribute('aria-pressed', 'true');
  await illustration.getByRole('button', { name: 'Predict the next dip' }).click();
  await expect(illustration.getByRole('button', { name: 'Predict the next dip' })).toHaveAttribute('aria-pressed', 'true');
  await expect(illustration.locator('figcaption')).toContainText('Lock the predicted window before looking at new observations.');
  await expect(illustration.getByRole('img')).toHaveAttribute('aria-label', /No future measurement is shown/);
  await illustration.getByRole('button', { name: 'See the signal' }).click();
  await expect(illustration.getByRole('button', { name: 'See the signal' })).toHaveAttribute('aria-pressed', 'true');
  await expect(illustration.locator('figcaption')).toContainText('Repeating dips suggest an orbit');

  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.screenshot({ path: 'artifacts/astronomy-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 320, height: 568 });
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/astronomy-mobile.png', fullPage: true });

  await page.goto(`${projectPath}&tab=check`);
  await expect(page.getByRole('heading', { name: 'Hunt for exoplanets', level: 1 })).toBeVisible();
  await expect(page.locator(`a[href="${planPath}"]`).first()).toBeVisible();
  await expect(page.locator('input[type="file"], .checker-pass')).toHaveCount(0);
  await expect(page.locator('.agent-join-footer')).toHaveCount(0);
  expect(projectRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test('guest can follow and unfollow Astronomy across reloads', async ({ page }) => {
  const projectRequests = captureProjectRequests(page);
  await page.goto(projectPath);
  await page.getByRole('button', { name: 'Follow project' }).click();
  await expect(page.getByRole('button', { name: 'Following' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem('motive-public-projects-v1') ?? '{}').following ?? [])).toContain('exoplanet-hunting');

  await page.reload();
  await expect(page.getByRole('button', { name: 'Following' })).toBeVisible();
  await page.getByRole('button', { name: 'Following' }).click();
  await expect(page.getByRole('button', { name: 'Follow project' })).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem('motive-public-projects-v1') ?? '{}').following ?? [])).not.toContain('exoplanet-hunting');

  expect(projectRequests).toEqual([]);
});
