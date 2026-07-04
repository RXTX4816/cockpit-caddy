/**
 * Internal CA modal workflows (#97).
 *
 * Regression test: the modal always showed Caddy's internal CA cert
 * regardless of whether any proxy actually uses it, which was confusing
 * for ACME/Let's Encrypt-only setups. It should now warn when unused,
 * and expose the intermediate certificate chain in addition to the root.
 */
import { test, expect, dismissAdminBanner } from './fixtures';
import { addProxy } from './helpers';

async function waitForToolbar(page: import('@playwright/test').Page) {
  await dismissAdminBanner(page);
  await page.getByRole('button', { name: /add proxy/i }).first().waitFor({ state: 'visible', timeout: 15000 });
}

test('CA modal warns when no proxy uses the internal CA', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addProxy(page, { port: 19500, target: 'localhost:19501' });
  await page.waitForTimeout(3500); // let the 3s auto-refresh pick up the plain (non-TLS) proxy

  await page.getByRole('button', { name: /internal ca/i }).click();
  const modal = page.getByRole('dialog', { name: /internal certificate authority/i });
  await expect(modal.getByText(/no proxies are using the internal ca/i)).toBeVisible({ timeout: 10000 });
});

test('CA modal shows no warning and offers intermediate chain when a proxy uses internal TLS', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addProxy(page, { port: 19502, target: 'localhost:19503', tls: 'internal' });
  await page.waitForTimeout(3500);

  await page.getByRole('button', { name: /internal ca/i }).click();
  const modal = page.getByRole('dialog', { name: /internal certificate authority/i });
  await expect(modal.getByText(/no proxies are using the internal ca/i)).not.toBeVisible();

  await modal.getByRole('button', { name: /intermediate certificate/i }).click();
  await expect(modal.getByRole('button', { name: /download intermediate ca/i })).toBeVisible({ timeout: 5000 });
});
