import { test, expect } from '@rxtx4816/cockpit-plugin-base-react/e2e';

test('service status badge is visible', async ({ pluginPage: page }) => {
  // PatternFly Label used for active/inactive/failed/not-installed state
  const badge = page.locator('.pf-v6-c-label').first();
  await expect(badge).toBeVisible();
});

test('service control buttons are present', async ({ pluginPage: page }) => {
  await expect(page.getByRole('button', { name: /start/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /stop/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /restart/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /reload/i })).toBeVisible();
});
