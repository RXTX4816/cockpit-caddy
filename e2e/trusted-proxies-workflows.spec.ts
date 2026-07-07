/**
 * Trusted proxies workflows (#153).
 *
 * Goes beyond "the setting saves" — proves trusted_proxies actually reaches the live,
 * already-running Caddy server (via the admin API's own /config/ endpoint), not just the
 * Caddyfile on disk. And regression-tests the exact bug found while building this
 * feature: a per-port `servers :PORT { }` block (written whenever a proxy sets its own
 * HTTP/3/timeout override) completely replaces the global `servers { }` block for that
 * port in Caddy, silently dropping trusted_proxies unless it's re-merged into every such
 * block too.
 *
 * Along the way this also caught a real gap in the test itself worth documenting: saving
 * Settings only writes+validates the Caddyfile — it does NOT reload the running Caddy
 * process. A separate explicit "Reload config" click is required before a change like
 * trusted_proxies actually takes effect live, and the Settings tab's own inline reload
 * button (unlike the toolbar's copy of the same label) has no confirmation dialog.
 */
import { test, expect, dismissAdminBanner } from './fixtures';
import { spawnCmd, readFile, CADDYFILE_PATH } from './helpers';

async function waitForToolbar(page: import('@playwright/test').Page) {
  await dismissAdminBanner(page);
  await page.getByRole('button', { name: /add proxy/i }).first().waitFor({ state: 'visible', timeout: 15000 });
}

async function startListener(page: import('@playwright/test').Page, port: number): Promise<void> {
  await spawnCmd(page, ['bash', '-c', `fuser -k ${port}/tcp 2>&1; true`]);
  await spawnCmd(page, ['bash', '-c', `nohup python3 -m http.server ${port} >/tmp/tp-e2e-${port}.log 2>&1 & disown`]);
}

async function stopListener(page: import('@playwright/test').Page, port: number): Promise<void> {
  await spawnCmd(page, ['bash', '-c', `fuser -k ${port}/tcp 2>&1; true`]);
}

/** Saves the trusted-proxies Settings fields. Does not reload — callers that need the
 *  change live (not just on disk) must also call reloadConfig() themselves. */
async function saveTrustedProxies(page: import('@playwright/test').Page, ranges: string | null): Promise<void> {
  await page.getByRole('tab', { name: /settings/i }).click();
  await page.getByRole('heading', { name: 'Global Caddy options' }).waitFor({ state: 'visible', timeout: 10000 });

  const enabledCheckbox = page.locator('#go-trusted-proxies-enabled');
  if (ranges === null) {
    if (await enabledCheckbox.isChecked()) await enabledCheckbox.uncheck();
  } else {
    if (!(await enabledCheckbox.isChecked())) await enabledCheckbox.check();
    await page.locator('#go-trusted-proxies-ranges').fill(ranges);
  }
  await page.getByRole('button', { name: /save/i }).click();
  await page.getByRole('button', { name: /^confirm$/i }).click();
  await expect(page.getByText(/settings saved/i)).toBeVisible({ timeout: 10000 });
}

/** The Settings tab's own inline "Reload config" button (inside its "needs reload"
 *  warning banner) calls reloadService directly with no confirmation dialog — unlike the
 *  toolbar's copy of the same label, which opens a "Reload Caddy config?" confirm dialog
 *  that then sits open and blocks the tab bar underneath it if left unconfirmed. Scoped to
 *  the Settings tabpanel specifically so it can't accidentally match the toolbar button. */
async function reloadConfig(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('tabpanel', { name: /settings/i }).getByRole('button', { name: /reload config/i }).click();
  await expect(page.getByText(/caddy config reloaded/i)).toBeVisible({ timeout: 10000 });
}

/** Reads Caddy's own live running config straight from the admin API socket — the
 *  ground truth for "did this setting actually reach the already-running server,"
 *  independent of what's merely written to disk. */
async function liveConfig(page: import('@playwright/test').Page): Promise<any> {
  const raw = await spawnCmd(page, ['bash', '-c', 'sudo curl -s --unix-socket /run/caddy/admin.socket http://localhost/config/']);
  return JSON.parse(raw);
}

test('trusted_proxies reaches the live server only after an explicit reload', async ({ pluginPage: page }) => {
  const port = 19340;
  const targetPort = 19341;
  await startListener(page, targetPort);

  try {
    await waitForToolbar(page);
    await page.getByRole('button', { name: /add proxy/i }).first().click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('External port').fill(String(port));
    await modal.getByLabel(/target host/i).fill('localhost');
    await modal.locator('#target-port').fill(String(targetPort));
    await modal.locator('#tls').uncheck();
    await modal.getByRole('button', { name: /^add proxy$/i }).click();
    await modal.getByRole('button', { name: /^confirm$/i }).click();
    await expect(modal).not.toBeVisible({ timeout: 15000 });

    function serverFor(config: any): any {
      return Object.values(config.apps?.http?.servers ?? {}).find(
        (s: any) => s.listen?.includes(`:${port}`),
      );
    }

    // Saving alone must not affect the already-running server.
    await saveTrustedProxies(page, 'private_ranges');
    const beforeReload = serverFor(await liveConfig(page));
    expect(beforeReload?.trusted_proxies, 'trusted_proxies must not be live before an explicit reload').toBeUndefined();

    // Only the explicit reload actually pushes it to the live server.
    await reloadConfig(page);
    await expect.poll(async () => serverFor(await liveConfig(page))?.trusted_proxies?.ranges, { timeout: 10000 })
      .toEqual(['192.168.0.0/16', '172.16.0.0/12', '10.0.0.0/8', '127.0.0.1/8', 'fd00::/8', '::1']);
  } finally {
    await stopListener(page, targetPort);
    await saveTrustedProxies(page, null);
    await reloadConfig(page).catch(() => {});
  }
});

test('trusted_proxies survives a per-port servers block also carrying an HTTP/3 override', async ({ pluginPage: page }) => {
  const port = 19342;
  const targetPort = 19343;
  await startListener(page, targetPort);

  try {
    await waitForToolbar(page);
    // This regression only needs to be checked in the Caddyfile that's written to disk —
    // no live traffic is involved, so no reload is needed here.
    await saveTrustedProxies(page, 'private_ranges');
    await page.getByRole('tab', { name: /proxy list/i }).click();

    await page.getByRole('button', { name: /add proxy/i }).first().click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('External port').fill(String(port));
    await modal.getByLabel(/target host/i).fill('localhost');
    await modal.locator('#target-port').fill(String(targetPort));
    await modal.locator('#tls').uncheck();

    // Forces buildManagedServersBlocks to emit a per-port `servers :PORT { }` block —
    // the exact situation that used to silently drop the global trusted_proxies setting
    // for this port.
    await modal.getByRole('button', { name: /server timeouts/i }).click();
    await modal.locator('#st-disable-http3').check();

    await modal.getByRole('button', { name: /^add proxy$/i }).click();
    await modal.getByRole('button', { name: /^confirm$/i }).click();
    await expect(modal).not.toBeVisible({ timeout: 15000 });

    const mainConf = await readFile(page, CADDYFILE_PATH);
    const blockMatch = mainConf.match(new RegExp(`servers :${port} \\{[\\s\\S]*?\\n\\t\\}`));
    expect(blockMatch, `expected a per-port servers :${port} block in the managed Caddyfile section`).toBeTruthy();
    expect(blockMatch![0]).toContain('protocols h1 h2');
    expect(blockMatch![0]).toContain('trusted_proxies static private_ranges');
  } finally {
    await stopListener(page, targetPort);
    await saveTrustedProxies(page, null);
  }
});
