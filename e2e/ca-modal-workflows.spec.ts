/**
 * Internal CA modal workflows (#97).
 *
 * Regression test: the modal always showed Caddy's internal CA cert
 * regardless of whether any proxy actually uses it, which was confusing
 * for ACME/Let's Encrypt-only setups. It should now warn when unused,
 * and expose the intermediate certificate chain in addition to the root.
 */
import { test, expect, dismissAdminBanner } from './fixtures';
import { addProxy, openTool, spawnCmd } from './helpers';

async function waitForToolbar(page: import('@playwright/test').Page) {
  await dismissAdminBanner(page);
  await page.getByRole('button', { name: /add proxy/i }).first().waitFor({ state: 'visible', timeout: 15000 });
}

test('CA modal warns when no proxy uses the internal CA', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addProxy(page, { port: 19500, target: 'localhost:19501' });
  await page.waitForTimeout(3500); // let the 3s auto-refresh pick up the plain (non-TLS) proxy

  await openTool(page, /internal ca/i);
  const modal = page.getByRole('dialog', { name: /internal certificate authority/i });
  await expect(modal.getByText(/no proxies are using the internal ca/i)).toBeVisible({ timeout: 10000 });
});

test('CA modal shows no warning and offers intermediate chain when a proxy uses internal TLS', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addProxy(page, { port: 19502, target: 'localhost:19503', tls: 'internal' });
  await page.waitForTimeout(3500);

  await openTool(page, /internal ca/i);
  const modal = page.getByRole('dialog', { name: /internal certificate authority/i });
  await expect(modal.getByText(/no proxies are using the internal ca/i)).not.toBeVisible();

  await modal.getByRole('button', { name: /intermediate certificate/i }).click();
  await expect(modal.getByRole('button', { name: /download intermediate ca/i })).toBeVisible({ timeout: 5000 });
});

// #315: the root certificate's dates and fingerprint come from openssl, which only gets the PEM on stdin.
test('CA modal shows the root certificate dates and fingerprint', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addProxy(page, { port: 19504, target: 'localhost:19505', tls: 'internal' });
  await page.waitForTimeout(3500);

  await openTool(page, /internal ca/i);
  const modal = page.getByRole('dialog', { name: /internal certificate authority/i });
  await expect(modal.getByText('Valid from')).toBeVisible({ timeout: 10000 });
  await expect(modal.getByText('Valid until')).toBeVisible();
  const shown = (await modal.locator('code').first().textContent())?.trim() ?? '';
  expect(shown).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);

  const expected = await spawnCmd(page, ['bash', '-c',
    'curl -s --unix-socket /run/caddy/admin.socket http://localhost/pki/ca/local | python3 -c "import json,sys; print(json.load(sys.stdin)[\'root_certificate\'])" | openssl x509 -noout -fingerprint -sha256']);
  expect(expected.trim().replace(/^sha256 Fingerprint=/i, '')).toBe(shown);
});
