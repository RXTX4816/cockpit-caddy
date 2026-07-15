/**
 * Access Log workflows — per-route (AddProxyDialog accordion, #al-* ids) and the
 * global runtime/error log (Settings tab, AccessLogSection with idPrefix="rl", #rl-* ids).
 *
 * caddy.service's systemd sandbox only allows writes under /var/lib/caddy, /var/log/caddy,
 * and /run/caddy (ReadWritePaths) — the log file path must live under one of those, not
 * /etc/caddy, or Caddy silently can't write to it despite the config being valid.
 */
import { test, expect, dismissAdminBanner } from './fixtures';
import { readFile, readConf, spawnCmd, CADDYFILE_PATH } from './helpers';
import { waitForListener } from './live';

async function waitForToolbar(page: import('@playwright/test').Page) {
  await dismissAdminBanner(page);
  await page.getByRole('button', { name: /add proxy/i }).first().waitFor({ state: 'visible', timeout: 15000 });
}

test('enabling per-route access log writes the correct log directive', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await page.getByRole('button', { name: /add proxy/i }).first().click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('External port').fill('19450');
  await modal.getByLabel(/target host/i).fill('localhost');
  await modal.locator('#target-port').fill('3000');
  await modal.locator('#tls').uncheck();

  await modal.getByRole('button', { name: /access logging/i }).click();
  await modal.locator('#al-enabled').check();
  await modal.locator('#al-output-file').check();
  await modal.locator('#al-file-path').fill('/var/log/caddy/e2e-access-19450.log');
  await modal.locator('#al-format-json').check();

  await modal.getByRole('button', { name: /^add proxy$/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });

  // Per-route access log directives live in the proxy's own conf.d block, not the main
  // Caddyfile (that's only for the global runtime log — see the Settings-tab test below).
  const conf = await readConf(page);
  expect(conf).toContain('log {');
  expect(conf).toContain('output file /var/log/caddy/e2e-access-19450.log');
  expect(conf).toContain('format json');
});

test('a real request produces a log entry in the configured access log file', async ({ pluginPage: page }) => {
  const logPath = '/var/log/caddy/e2e-access-19452.log';
  await spawnCmd(page, ['bash', '-c', `rm -f '${logPath}'`]);
  await spawnCmd(page, ['bash', '-c', `fuser -k 19453/tcp 2>&1; true`]);
  await spawnCmd(page, ['bash', '-c',
    `nohup python3 -m http.server 19453 >/tmp/e2e-backend-19453.log 2>&1 & disown`]);

  try {
    await waitForToolbar(page);
    await page.getByRole('button', { name: /add proxy/i }).first().click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('External port').fill('19452');
    await modal.getByLabel(/target host/i).fill('localhost');
    await modal.locator('#target-port').fill('19453');
    await modal.locator('#tls').uncheck();

    await modal.getByRole('button', { name: /access logging/i }).click();
    await modal.locator('#al-enabled').check();
    await modal.locator('#al-output-file').check();
    await modal.locator('#al-file-path').fill(logPath);
    await modal.locator('#al-format-json').check();

    await modal.getByRole('button', { name: /^add proxy$/i }).click();
    await modal.getByRole('button', { name: /^confirm$/i }).click();
    await expect(modal).not.toBeVisible({ timeout: 15000 });

    await waitForListener(page, `http://localhost:19452/e2e-marker-path`);
    await spawnCmd(page, ['bash', '-c', `curl -s -o /dev/null 'http://localhost:19452/e2e-marker-path'; true`]);

    await expect.poll(async () => {
      const content = await spawnCmd(page, ['bash', '-c', `cat '${logPath}' 2>&1; true`]);
      return content;
    }, { timeout: 10000 }).toContain('/e2e-marker-path');
  } finally {
    await spawnCmd(page, ['bash', '-c', `fuser -k 19453/tcp 2>&1; true`]);
  }
});

test('enabling the global runtime log writes the correct log directive', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await page.getByRole('tab', { name: /settings/i }).click();
  await page.getByRole('heading', { name: 'Global Caddy options' }).waitFor({ state: 'visible', timeout: 10000 });

  await page.getByRole('button', { name: /runtime log/i }).click();
  await page.locator('#rl-enabled').check();
  await page.locator('#rl-output-file').check();
  await page.locator('#rl-file-path').fill('/var/log/caddy/e2e-runtime.log');
  await page.locator('#rl-level-ERROR').check();

  await page.getByRole('button', { name: /^save$/i }).click();
  await page.getByRole('button', { name: /^confirm$/i }).click();
  await expect(page.getByText(/settings saved/i)).toBeVisible({ timeout: 10000 });

  const conf = await readFile(page, CADDYFILE_PATH);
  expect(conf).toContain('log {');
  expect(conf).toContain('output file /var/log/caddy/e2e-runtime.log');
  expect(conf).toContain('level ERROR');

  // Cleanup: disable so this doesn't leak a global log override into later tests.
  await page.locator('#rl-enabled').uncheck();
  await page.getByRole('button', { name: /^save$/i }).click();
  await page.getByRole('button', { name: /^confirm$/i }).click();
  await expect(page.getByText(/settings saved/i)).toBeVisible({ timeout: 10000 });
});
