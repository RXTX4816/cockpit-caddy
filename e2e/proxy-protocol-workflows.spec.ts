/**
 * PROXY protocol Settings workflow.
 *
 * Scoped to config-round-trip + reload-succeeds only (no real PROXY-protocol-v1/v2 wire
 * test) — hand-crafting a raw PROXY protocol preamble over a bare TCP connection is high
 * implementation cost for a directive whose text generation is already covered by
 * caddy.test.ts; the live-behavior gap this file closes is "does Caddy actually accept
 * this generated block on a real reload," which a raw-socket test wouldn't add to.
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

test('enabling PROXY protocol writes the correct listener directive and Caddy accepts the reload', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await openSettings(page);

  await page.locator('#go-proxy-protocol-enabled').check();
  await page.locator('#go-proxy-protocol-allow').fill('10.0.0.0/8');
  await page.locator('#go-proxy-protocol-timeout').fill('2s');
  await saveSettings(page);

  const conf = await readFile(page, CADDYFILE_PATH);
  expect(conf).toContain('proxy_protocol {');
  expect(conf).toContain('timeout 2s');
  expect(conf).toContain('allow 10.0.0.0/8');

  await reloadFromSettings(page);
  await expectCaddyActive(page);
});

test('disabling PROXY protocol removes the directive and Caddy still reloads cleanly', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await openSettings(page);

  await page.locator('#go-proxy-protocol-enabled').check();
  await saveSettings(page);
  let conf = await readFile(page, CADDYFILE_PATH);
  expect(conf).toContain('proxy_protocol');

  await page.locator('#go-proxy-protocol-enabled').uncheck();
  await saveSettings(page);
  // The "settings saved" toast can appear a beat before the write actually flushes to
  // disk — poll rather than assert on a single read right after the toast.
  await expect.poll(() => readFile(page, CADDYFILE_PATH), { timeout: 10000 }).not.toContain('proxy_protocol');

  await reloadFromSettings(page);
  await expectCaddyActive(page);
});
