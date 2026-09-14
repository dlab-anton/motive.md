import { expect, test } from '@playwright/test';

test('guest following persists without reserving funds or inventing updates', async ({ page }) => {
  await page.goto('/?project=circle-packing');
  await page.getByRole('button', { name: 'Follow project', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Following', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Following saves this project to your local workspace. It does not reserve funds or start work.')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Following', exact: true })).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('tab', { name: 'Updates' }).click();
  await expect(page.getByRole('tabpanel')).toContainText('No community updates yet');
  await expect(page.getByRole('tabpanel')).toContainText('Community assignments, submitted evidence and review decisions will appear here as they happen.');

  await page.getByRole('link', { name: 'Following', exact: true }).click();
  const followed = page.locator('[data-followed-project="circle-packing"]');
  await expect(followed).toContainText('Find a better circle packing');
  await expect(followed).toContainText('Read the latest research updates and checked results.');
  await expect(page.locator('#token-balance')).toHaveCount(0);
  await followed.getByRole('button', { name: 'Unfollow' }).click();
  await expect(page.locator('[data-followed-project]')).toHaveCount(0);
});
