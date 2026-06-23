import { test, expect } from '@rxtx4816/cockpit-plugin-base-react/e2e';

test('logs into Cockpit and reaches the plugin', async ({ pluginPage: page }) => {
  await expect(page).toHaveURL(/cockpit-caddy/);
  await expect(page.locator('#root')).toBeVisible();
});

test('shows the Caddy page heading', async ({ pluginPage: page }) => {
  await expect(page.getByRole('heading', { name: /caddy/i }).first()).toBeVisible();
});
