/**
 * ACME status modal workflows (#141).
 *
 * "ACME not extracted in webui": Caddy's automatic HTTPS needs zero configuration, so
 * a route with no explicit `tls`/email/CA setting isn't "not using TLS" — it's
 * silently getting a Let's Encrypt cert from Caddy's built-in defaults, and none of
 * that was visible anywhere in the app. This only verifies **policy detection** from
 * the live config — actual Let's Encrypt certificate issuance isn't testable here (no
 * internet-reachable domain, no port 80/443 exposure for an HTTP-01 challenge).
 */
import { test, expect, dismissAdminBanner } from './fixtures';

async function waitForToolbar(page: import('@playwright/test').Page) {
  await dismissAdminBanner(page);
  await page.getByRole('button', { name: /add proxy/i }).first().waitFor({ state: 'visible', timeout: 15000 });
}

async function writeConf(page: import('@playwright/test').Page, conf: string) {
  await page.evaluate(([c]) =>
    new Promise<void>((resolve, reject) =>
      (window as any).cockpit.file('/etc/caddy/conf.d/cockpit-caddy.conf', { superuser: 'try' }).replace(c)
        .then(resolve).catch(reject)), [conf] as [string]);
  await page.evaluate(() =>
    new Promise<void>((resolve, reject) =>
      (window as any).cockpit.spawn(['caddy', 'reload', '--config', '/etc/caddy/Caddyfile'], { superuser: 'try' })
        .then(resolve).catch(reject)));
  await page.reload({ waitUntil: 'networkidle' });
  await waitForToolbar(page);
}

test('classifies a bare public hostname as using Caddy default automatic HTTPS', async ({ pluginPage: page }) => {
  await writeConf(page, [
    '# Managed by cockpit-caddy - edits to this file may be overwritten by user plugin actions',
    '',
    'default-acme.example.test:19500 {',
    '\treverse_proxy http://localhost:3000',
    '}',
    '',
  ].join('\n'));

  await page.getByRole('button', { name: /acme.*let.?s encrypt/i }).click();
  const modal = page.getByRole('dialog');
  const row = modal.locator('li').filter({ hasText: 'default-acme.example.test' });
  await expect(row).toContainText("Let's Encrypt");
  await expect(row).toContainText('Caddy default');
});

test('classifies an internal-CA (self-signed) hostname distinctly', async ({ pluginPage: page }) => {
  await writeConf(page, [
    '# Managed by cockpit-caddy - edits to this file may be overwritten by user plugin actions',
    '',
    'selfsigned.example.test:19501 {',
    '\ttls internal',
    '\treverse_proxy http://localhost:3001',
    '}',
    '',
  ].join('\n'));

  await page.getByRole('button', { name: /acme.*let.?s encrypt/i }).click();
  const modal = page.getByRole('dialog');
  const row = modal.locator('li').filter({ hasText: 'selfsigned.example.test' });
  await expect(row).toContainText('Internal CA');
  await expect(row).toContainText('Explicit policy');
});

test('classifies an explicit http:// hostname as no TLS', async ({ pluginPage: page }) => {
  await writeConf(page, [
    '# Managed by cockpit-caddy - edits to this file may be overwritten by user plugin actions',
    '',
    'http://plain.example.test:19502 {',
    '\treverse_proxy http://localhost:3002',
    '}',
    '',
  ].join('\n'));

  await page.getByRole('button', { name: /acme.*let.?s encrypt/i }).click();
  const modal = page.getByRole('dialog');
  const row = modal.locator('li').filter({ hasText: 'plain.example.test' });
  await expect(row).toContainText('No TLS');
});

test('shows the empty state when no public hostnames are configured', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await page.getByRole('button', { name: /acme.*let.?s encrypt/i }).click();
  const modal = page.getByRole('dialog');
  await expect(modal.getByText(/no hostnames were found/i)).toBeVisible({ timeout: 10000 });
});

// Regression: once any host has a customized automation policy (e.g. the internal-CA
// host below), Caddy's adapter must explicitly enumerate every other host too, so it
// isn't accidentally caught by that policy's scope. A subjects-only entry with no
// issuers array is just that bookkeeping — it must still classify as Caddy-default
// ACME, not get miscounted as an "explicit policy" the way it did before this fix.
test('a default-ACME host stays classified as Caddy default even alongside an internal-CA host', async ({ pluginPage: page }) => {
  await writeConf(page, [
    '# Managed by cockpit-caddy - edits to this file may be overwritten by user plugin actions',
    '',
    'default-acme.example.test:19503 {',
    '\treverse_proxy http://localhost:3003',
    '}',
    '',
    'selfsigned.example.test:19504 {',
    '\ttls internal',
    '\treverse_proxy http://localhost:3004',
    '}',
    '',
  ].join('\n'));

  await page.getByRole('button', { name: /acme.*let.?s encrypt/i }).click();
  const modal = page.getByRole('dialog');
  const acmeRow = modal.locator('li').filter({ hasText: 'default-acme.example.test' });
  await expect(acmeRow).toContainText("Let's Encrypt");
  await expect(acmeRow).toContainText('Caddy default');
  const internalRow = modal.locator('li').filter({ hasText: 'selfsigned.example.test' });
  await expect(internalRow).toContainText('Internal CA');
  await expect(internalRow).toContainText('Explicit policy');
});

test('Edit Proxy shows a note when the host is already ACME-managed', async ({ pluginPage: page }) => {
  await writeConf(page, [
    '# Managed by cockpit-caddy - edits to this file may be overwritten by user plugin actions',
    '',
    'default-acme.example.test:19505 {',
    '\treverse_proxy http://localhost:3005',
    '}',
    '',
  ].join('\n'));

  await page.locator('li').filter({ hasText: 'default-acme.example.test' }).getByRole('button', { name: /^edit$/i }).click();
  const modal = page.getByRole('dialog');
  await expect(modal.getByText(/already getting a certificate from let.?s encrypt/i)).toBeVisible({ timeout: 10000 });
});
