import { test, expect, dismissAdminBanner } from './fixtures';

// Smoke test: plugin loads, Caddy is running, toolbar is visible.
test('plugin loads with empty proxy list', async ({ pluginPage: page }) => {
  await dismissAdminBanner(page);
  await expect(page.getByRole('button', { name: /add proxy/i })).toBeVisible({ timeout: 15000 });
});
