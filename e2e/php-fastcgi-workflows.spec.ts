/**
 * PHP FastCGI handler workflows (#35).
 *
 * `php_fastcgi` is a Caddyfile macro with no single JSON handler equivalent — it expands
 * into 4 separate routes (vars/redirect/rewrite/reverse_proxy-with-fastcgi-transport).
 * These tests verify the Add/Edit UI writes a real `php_fastcgi` Caddyfile block that
 * Caddy actually accepts and reloads, and — the higher-risk direction — that reopening
 * the entry for editing after a reload shows the same values back, proving parseProxies
 * correctly re-groups that 4-route expansion from the live JSON config rather than
 * misreading it as several broken partial routes.
 *
 * No PHP-FPM process runs in this VM — Caddy doesn't dial the FastCGI upstream until an
 * actual request arrives, so config load/reload succeeds regardless of whether the
 * socket exists.
 */
import { test, expect, dismissAdminBanner } from './fixtures';
import { readConf } from './helpers';

async function waitForToolbar(page: import('@playwright/test').Page) {
  await dismissAdminBanner(page);
  await page.getByRole('button', { name: /add php site/i }).waitFor({ state: 'visible', timeout: 15000 });
}

function proxyRow(page: import('@playwright/test').Page, port: number) {
  return page.locator('li').filter({ has: page.locator(`#proxy-${port}`) });
}

test('create PHP site writes a valid php_fastcgi Caddyfile block', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await page.getByRole('button', { name: /add php site/i }).click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel(/listen port/i).fill('19300');
  await modal.getByLabel(/fastcgi upstream/i).fill('unix//run/php-fpm.sock');
  await modal.getByLabel(/root directory/i).fill('/var/www/html');
  await modal.getByRole('button', { name: /add php site/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });

  await expect(page.getByRole('link', { name: ':19300' })).toBeVisible({ timeout: 5000 });

  const conf = await readConf(page);
  expect(conf).toContain(':19300');
  expect(conf).toContain('root * /var/www/html');
  expect(conf).toContain('php_fastcgi unix//run/php-fpm.sock');
});

test('PHP site with custom index/split/env round-trips through a reload', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await page.getByRole('button', { name: /add php site/i }).click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel(/listen port/i).fill('19301');
  await modal.getByLabel(/fastcgi upstream/i).fill('127.0.0.1:9000');
  await modal.getByLabel(/root directory/i).fill('/srv/app/public');
  await modal.getByLabel(/index file/i).fill('custom.php');
  // Environment variables section is a collapsed ExpandableSection by default — expand
  // it before the "Add variable" button inside becomes clickable.
  await modal.getByRole('button', { name: /environment variables/i }).click();
  await modal.getByRole('button', { name: /add variable/i }).click();
  await modal.locator('#php-env-key-0').fill('APP_ENV');
  await modal.locator('#php-env-value-0').fill('production');
  await modal.getByRole('button', { name: /add php site/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });

  const conf = await readConf(page);
  expect(conf).toContain('php_fastcgi 127.0.0.1:9000 {');
  expect(conf).toContain('index custom.php');
  expect(conf).toContain('env APP_ENV production');

  // Reopen for editing — this is what actually exercises parseProxies re-grouping the
  // live 4-route JSON expansion back into one entry, since the proxy list is rebuilt from
  // the running config after the add flow's own reload, not from the values just typed in.
  await proxyRow(page, 19301).getByRole('button', { name: /edit/i }).click();
  const editModal = page.getByRole('dialog');
  await expect(editModal.getByLabel(/fastcgi upstream/i)).toHaveValue('127.0.0.1:9000');
  await expect(editModal.getByLabel(/root directory/i)).toHaveValue('/srv/app/public');
  await expect(editModal.getByLabel(/index file/i)).toHaveValue('custom.php');
  await expect(editModal.locator('#php-env-key-0')).toHaveValue('APP_ENV');
  await expect(editModal.locator('#php-env-value-0')).toHaveValue('production');
  await editModal.getByRole('button', { name: /cancel/i }).click();
});

test('editing a PHP site updates the Caddyfile block', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await page.getByRole('button', { name: /add php site/i }).click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel(/listen port/i).fill('19302');
  await modal.getByLabel(/fastcgi upstream/i).fill('unix//run/php-fpm.sock');
  await modal.getByLabel(/root directory/i).fill('/var/www/html');
  await modal.getByRole('button', { name: /add php site/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });

  await proxyRow(page, 19302).getByRole('button', { name: /edit/i }).click();
  const editModal = page.getByRole('dialog');
  await editModal.getByLabel(/root directory/i).fill('/var/www/updated');
  await editModal.getByRole('button', { name: /save changes/i }).click();
  await editModal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(editModal).not.toBeVisible({ timeout: 15000 });

  const conf = await readConf(page);
  expect(conf).toContain('root * /var/www/updated');
  expect(conf).not.toContain('root * /var/www/html');
});

test('deleting a PHP site removes it from the list and the Caddyfile', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await page.getByRole('button', { name: /add php site/i }).click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel(/listen port/i).fill('19303');
  await modal.getByLabel(/fastcgi upstream/i).fill('unix//run/php-fpm.sock');
  await modal.getByLabel(/root directory/i).fill('/var/www/html');
  await modal.getByRole('button', { name: /add php site/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });

  await proxyRow(page, 19303).getByRole('button', { name: /^delete$/i }).click();
  const confirmModal = page.getByRole('dialog');
  await confirmModal.getByRole('button', { name: /^delete$/i }).click();
  await expect(page.getByRole('link', { name: ':19303' })).not.toBeVisible({ timeout: 10000 });

  // File write may complete slightly after the UI state update.
  await expect.poll(async () => readConf(page), { timeout: 8000 }).not.toContain(':19303');
});
