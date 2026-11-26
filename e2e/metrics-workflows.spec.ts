/**
 * Prometheus metrics endpoint workflows (#43).
 *
 * Caddy can expose a Prometheus-compatible /metrics endpoint but the plugin didn't
 * configure or surface it. Verifies the Settings tab toggle writes both the global
 * `metrics` option (needed for request-level caddy_http_* metrics — confirmed empirically
 * that without it /metrics only shows admin/Go-runtime metrics, not proxy traffic) and a
 * dedicated site block exposing the endpoint, and that Caddy actually serves real
 * Prometheus text at that address once reloaded.
 */
import { test, expect } from './fixtures';
import {
  readFile, spawnCmd, CADDYFILE_PATH, PROXY_CONF_PATH,
  openSettingsTab, saveSettings, settingsSaveButton, settingsPanel, reloadFromSettings,
} from './helpers';

// The plugin (and Caddy) run inside the VM — arbitrary ports the metrics site listens on
// aren't forwarded to the host, unlike the Cockpit web UI's own port. page.request/fetch
// would hit the *host's* network, not the guest's, so curl from inside the VM via the
// Cockpit bridge (spawnCmd) instead, exactly like the plugin's own cockpit.spawn calls do.
async function curl(page: import('@playwright/test').Page, url: string): Promise<{ status: string; body: string }> {
  const out = await spawnCmd(page, ['curl', '-s', '-w', '\n%{http_code}', url]);
  const idx = out.lastIndexOf('\n');
  return { body: out.slice(0, idx), status: out.slice(idx + 1).trim() };
}

function openSettings(page: import('@playwright/test').Page) {
  return openSettingsTab(page, 'Logging & metrics');
}

// Saving Settings only writes and *validates* the Caddyfile — `caddy validate` just
// checks the config parses, it doesn't push it to the running instance. The live process
// keeps running the old config until the Settings tab's own "Reload config" fires.
const reloadConfig = reloadFromSettings;

test.afterEach(async ({ page }) => {
  await openSettings(page).catch(() => {});
  const back = page.getByRole('button', { name: /^back$/i });
  if (await back.isVisible({ timeout: 1000 }).catch(() => false)) await back.click();
  const enabled = page.locator('#go-metrics-enabled');
  if (await enabled.isVisible().catch(() => false) && (await enabled.isChecked())) {
    await enabled.setChecked(false);
    await saveSettings(page).catch(() => {});
    // Reload too, so a stray metrics listener from this test doesn't stay bound on the
    // live process for whatever test runs next.
    await reloadConfig(page).catch(() => {});
  }
});

test('enabling metrics writes the global option and a dedicated site block Caddy accepts', async ({ pluginPage: page }) => {
  await openSettings(page);
  await page.locator('#go-metrics-enabled').setChecked(true);
  await page.locator('#go-metrics-listen-address').fill(':9291');
  await saveSettings(page);
  await expect(page.getByText(/settings saved/i).first()).toBeVisible({ timeout: 10000 });

  const mainConf = await readFile(page, CADDYFILE_PATH);
  expect(mainConf).toContain('metrics');

  const proxyConf = await readFile(page, PROXY_CONF_PATH);
  expect(proxyConf).toContain(':9291 {');
  expect(proxyConf).toContain('metrics /metrics');

  // A bad directive would have failed validation and kept the confirm alert visible
  // instead of succeeding above, but the live process only picks up the change once
  // reloaded — verify the endpoint is real and serves Prometheus text after that.
  await reloadConfig(page);
  const res = await curl(page, 'http://localhost:9291/metrics');
  expect(res.status).toBe('200');
  expect(res.body).toContain('# HELP');
  expect(res.body).toContain('# TYPE');
});

test('a custom path and plain-format option round-trip correctly', async ({ pluginPage: page }) => {
  await openSettings(page);
  await page.locator('#go-metrics-enabled').setChecked(true);
  await page.locator('#go-metrics-listen-address').fill(':9292');
  await page.locator('#go-metrics-path').fill('/custom-metrics');
  await page.locator('#go-metrics-plain-format').setChecked(true);
  await saveSettings(page);
  await expect(page.getByText(/settings saved/i).first()).toBeVisible({ timeout: 10000 });

  const proxyConf = await readFile(page, PROXY_CONF_PATH);
  expect(proxyConf).toContain('metrics /custom-metrics {');
  expect(proxyConf).toContain('disable_openmetrics');

  await reloadConfig(page);

  // Regression: a bare `metrics` directive with no path matcher matches every path on
  // that listener (verified against a live instance) — /metrics must NOT respond once a
  // custom path is set, confirming the path is actually scoped.
  const wrongPath = await curl(page, 'http://localhost:9292/metrics');
  expect(wrongPath.body).not.toContain('# HELP');

  const res = await curl(page, 'http://localhost:9292/custom-metrics');
  expect(res.status).toBe('200');
  expect(res.body).toContain('# HELP');
});

test('disabling metrics removes both the global option and the site block', async ({ pluginPage: page }) => {
  await openSettings(page);
  await page.locator('#go-metrics-enabled').setChecked(true);
  await page.locator('#go-metrics-listen-address').fill(':9293');
  // saveSettings waits for the confirm step to return to idle, not for the toast, which
  // stays up a few seconds and would let the second save below match the first one's.
  await saveSettings(page);

  await page.locator('#go-metrics-enabled').setChecked(false);
  await saveSettings(page);

  const mainConf = await readFile(page, CADDYFILE_PATH);
  expect(mainConf).not.toContain('metrics');
  const proxyConf = await readFile(page, PROXY_CONF_PATH);
  expect(proxyConf).not.toContain('cockpit-caddy:metrics');
});

// Save is never disabled (#346): with an error it jumps to the first sub-tab that has
// one and stays out of the confirm step, so nothing reaches the disk.
test('enabling without a listen address is blocked before saving', async ({ pluginPage: page }) => {
  const before = await readFile(page, CADDYFILE_PATH);
  await openSettings(page);
  await page.locator('#go-metrics-enabled').setChecked(true);
  await openSettingsTab(page, 'Core');
  await settingsSaveButton(page).click();

  const loggingTab = settingsPanel(page).getByRole('tab', { name: /^Logging & metrics/ });
  await expect(loggingTab).toHaveAttribute('aria-selected', 'true');
  await expect(loggingTab.getByRole('img', { name: 'Has errors' })).toBeVisible();
  await expect(settingsPanel(page).getByRole('button', { name: 'Confirm', exact: true })).toHaveCount(0);
  expect(await readFile(page, CADDYFILE_PATH)).toBe(before);
});
