import { test, expect } from '@rxtx4816/cockpit-plugin-base-react/e2e';

test('all three tabs are visible', async ({ pluginPage: page }) => {
  await expect(page.getByRole('tab', { name: /proxies/i })).toBeVisible();
  await expect(page.getByRole('tab', { name: /caddyfile/i })).toBeVisible();
  await expect(page.getByRole('tab', { name: /logs/i })).toBeVisible();
});

test('switching to Caddyfile tab shows the editor', async ({ pluginPage: page }) => {
  await page.getByRole('tab', { name: /caddyfile/i }).click();
  await expect(page.locator('.cm-editor')).toBeVisible({ timeout: 5000 });
});

test('switching to Logs tab shows the log viewer', async ({ pluginPage: page }) => {
  await page.getByRole('tab', { name: /logs/i }).click();
  // Log area or search input is always rendered even with no entries
  await expect(
    page.locator('[data-testid="log-viewer"]')
      .or(page.getByRole('textbox', { name: /search/i }))
      .or(page.locator('.pf-v6-c-log-viewer'))
      .first(),
  ).toBeVisible({ timeout: 5000 });
});
