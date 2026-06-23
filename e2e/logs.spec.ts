import { test, expect } from '@rxtx4816/cockpit-plugin-base-react/e2e';

test.beforeEach(async ({ pluginPage: page }) => {
  await page.getByRole('tab', { name: /logs/i }).click();
});

test('log viewer area is visible', async ({ pluginPage: page }) => {
  await expect(
    page.locator('[data-testid="log-viewer"]')
      .or(page.locator('.pf-v6-c-log-viewer'))
      .or(page.locator('[class*="log"]'))
      .first(),
  ).toBeVisible({ timeout: 5000 });
});

test('search input is present', async ({ pluginPage: page }) => {
  await expect(
    page.getByRole('textbox', { name: /search/i })
      .or(page.getByPlaceholder(/search/i))
      .first(),
  ).toBeVisible({ timeout: 5000 });
});
