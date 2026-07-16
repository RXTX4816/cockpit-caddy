/**
 * Admin API Address dialog workflows.
 *
 * Unlike every other Settings surface, this dialog persists to the browser's own
 * localStorage (per admin_address.storage_note), not to the Caddyfile — Save requires
 * a real successful connection test first, so these tests exercise the actual admin
 * socket/TCP endpoints rather than any Caddyfile state.
 */
import { test, expect, dismissAdminBanner } from './fixtures';

async function waitForToolbar(page: import('@playwright/test').Page) {
  await dismissAdminBanner(page);
  await page.getByRole('button', { name: /add proxy/i }).first().waitFor({ state: 'visible', timeout: 15000 });
}

async function openAdminAddressDialog(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Admin API Address' }).click();
  return page.getByRole('dialog');
}

test('test-connection button reports success against the real reachable admin socket', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  const modal = await openAdminAddressDialog(page);

  await modal.locator('#aa-socket').fill('/run/caddy/admin.socket');
  await modal.locator('#aa-socket-test').click();
  await expect(modal.getByText(/connection successful/i)).toBeVisible({ timeout: 10000 });
});

test('test-connection button reports failure against an unreachable address', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  const modal = await openAdminAddressDialog(page);

  await modal.locator('#aa-tcp').fill('http://127.0.0.1:19999');
  await modal.locator('#aa-tcp-test').click();
  await expect(modal.getByText(/tcp connection failed/i)).toBeVisible({ timeout: 10000 });
});

test('save is disabled until a connection test succeeds, then persists the value', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  const modal = await openAdminAddressDialog(page);

  await expect(modal.getByRole('button', { name: /^save$/i })).toBeDisabled();

  // A redundant double-slash still resolves to the same real socket (the OS collapses
  // repeated slashes transparently), but is NOT a byte-identical match to the app's own
  // default string — so save() actually persists it instead of treating it as "equals
  // the default, nothing to store".
  const customSocket = '/run/caddy//admin.socket';
  await modal.locator('#aa-socket').fill(customSocket);
  await modal.locator('#aa-socket-test').click();
  await expect(modal.getByText(/connection successful/i)).toBeVisible({ timeout: 10000 });
  await expect(modal.getByRole('button', { name: /^save$/i })).toBeEnabled();

  await modal.getByRole('button', { name: /^save$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 10000 });

  const stored = await page.evaluate(() => localStorage.getItem('cockpit-caddy:admin-socket'));
  expect(stored).toBe(customSocket);
});

test('reset to defaults restores default fields and clears test results', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  const modal = await openAdminAddressDialog(page);

  await modal.locator('#aa-socket').fill('/tmp/not-the-real-socket');
  await modal.locator('#aa-socket-test').click();
  await expect(modal.getByText(/unix socket unreachable/i)).toBeVisible({ timeout: 10000 });

  await modal.getByRole('button', { name: /reset to defaults/i }).click();
  await expect(modal.getByText(/unix socket unreachable/i)).not.toBeVisible();
  // Confirm the field actually points at the real default again, not just that the
  // error text cleared — test it and expect the real socket to answer.
  await modal.locator('#aa-socket-test').click();
  await expect(modal.getByText(/connection successful/i)).toBeVisible({ timeout: 10000 });
});
