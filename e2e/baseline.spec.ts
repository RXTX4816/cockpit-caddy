import { test, expect, dismissAdminBanner } from './fixtures';

// Smoke test: plugin loads, Caddy is running, toolbar is visible.
test('plugin loads with empty proxy list', async ({ pluginPage: page }) => {
  await dismissAdminBanner(page);
  // The toolbar "Add Proxy" button and the empty-state CTA share the same
  // accessible name when the list is empty — scope to the toolbar one.
  await expect(page.getByRole('button', { name: /add proxy/i }).first()).toBeVisible({ timeout: 15000 });
});
