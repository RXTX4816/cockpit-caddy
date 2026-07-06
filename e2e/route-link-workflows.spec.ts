/**
 * Route link workflows (#140).
 *
 * Regression test: the clickable link on a route's external port always
 * pointed at window.location.hostname, which is `localhost` when Cockpit is
 * viewed over an SSH port-forward — even when the route has a real subdomain
 * configured. The link should prefer the route's own hostname over the
 * browser's, but only when one is actually configured (a plain hostless
 * proxy must keep pointing at whatever host Cockpit itself is served from).
 */
import { test, expect, dismissAdminBanner } from './fixtures';
import { addProxy } from './helpers';

async function waitForToolbar(page: import('@playwright/test').Page) {
  await dismissAdminBanner(page);
  await page.getByRole('button', { name: /add proxy/i }).first().waitFor({ state: 'visible', timeout: 15000 });
}

test('route link uses the configured subdomain instead of the browser host', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addProxy(page, { port: 19510, target: 'localhost:19511', host: 'sub.example.test' });
  await page.waitForTimeout(3500); // let the 3s auto-refresh pick up the new proxy

  const link = page.locator('a', { hasText: 'sub.example.test:19510' });
  await expect(link).toBeVisible({ timeout: 10000 });
  await expect(link).toHaveAttribute('href', /^http:\/\/sub\.example\.test:19510\//);
});

test('route link falls back to the current host when no subdomain is configured', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addProxy(page, { port: 19512, target: 'localhost:19513' });
  await page.waitForTimeout(3500);

  const link = page.locator('a', { hasText: ':19512' });
  await expect(link).toBeVisible({ timeout: 10000 });
  const href = await link.getAttribute('href');
  expect(href).not.toBeNull();
  expect(new URL(href!).hostname).toBe(new URL(page.url()).hostname);
});
