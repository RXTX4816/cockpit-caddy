/**
 * On-Demand TLS Settings workflows.
 *
 * Settings tab only writes+validates the Caddyfile — it does not reload the running
 * Caddy process (see trusted-proxies-workflows.spec.ts for the established pattern);
 * an explicit "Reload config" click on the Settings tab's own inline button is required.
 */
import { test, expect, dismissAdminBanner } from './fixtures';
import { readFile, CADDYFILE_PATH } from './helpers';
import { expectCaddyActive } from './live';

async function waitForToolbar(page: import('@playwright/test').Page) {
  await dismissAdminBanner(page);
  await page.getByRole('button', { name: /add proxy/i }).first().waitFor({ state: 'visible', timeout: 15000 });
}

async function openSettings(page: import('@playwright/test').Page) {
  await page.getByRole('tab', { name: /settings/i }).click();
  await page.getByRole('heading', { name: 'Global Caddy options' }).waitFor({ state: 'visible', timeout: 10000 });
}

async function saveSettings(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: /^save$/i }).click();
  await page.getByRole('button', { name: /^confirm$/i }).click();
  await expect(page.getByText(/settings saved/i)).toBeVisible({ timeout: 10000 });
}

async function reloadFromSettings(page: import('@playwright/test').Page) {
  await page.getByRole('tabpanel', { name: /settings/i }).getByRole('button', { name: /reload config/i }).click();
  await expect(page.getByText(/caddy config reloaded/i)).toBeVisible({ timeout: 10000 });
}

test('enabling on-demand TLS writes the correct global tls block', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await openSettings(page);

  // Deliberately not setting interval/burst here: Caddy 2.11.4 (installed on this VM)
  // rejects them outright — "the on_demand_tls 'interval' option is no longer
  // supported" — a real upstream-removed feature, not something for an e2e test to
  // paper over. `ask` alone is still valid and is the field that matters most.
  await page.locator('#go-on-demand-enabled').check();
  await page.locator('#go-on-demand-ask').fill('http://localhost:9090/check');
  await saveSettings(page);

  const conf = await readFile(page, CADDYFILE_PATH);
  expect(conf).toContain('on_demand_tls {');
  expect(conf).toContain('ask http://localhost:9090/check');

  await reloadFromSettings(page);
  await expectCaddyActive(page);
});

test('disabling on-demand TLS removes the block and Caddy still reloads cleanly', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await openSettings(page);

  await page.locator('#go-on-demand-enabled').check();
  await page.locator('#go-on-demand-ask').fill('http://localhost:9090/check');
  await saveSettings(page);
  let conf = await readFile(page, CADDYFILE_PATH);
  expect(conf).toContain('on_demand_tls {');

  await page.locator('#go-on-demand-enabled').uncheck();
  await saveSettings(page);
  // The "settings saved" toast can appear a beat before the write actually flushes to
  // disk — poll rather than assert on a single read right after the toast.
  await expect.poll(() => readFile(page, CADDYFILE_PATH), { timeout: 10000 }).not.toContain('on_demand_tls {');

  await reloadFromSettings(page);
  await expectCaddyActive(page);
});
