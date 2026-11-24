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
import { CONF_HEADER, readConf, openTool } from './helpers';

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
    CONF_HEADER,
    '',
    'default-acme.example.test:19500 {',
    '\treverse_proxy http://localhost:3000',
    '}',
    '',
  ].join('\n'));

  await openTool(page, /acme.*let.?s encrypt/i);
  const modal = page.getByRole('dialog');
  const row = modal.locator('li').filter({ hasText: 'default-acme.example.test' });
  await expect(row).toContainText("Let's Encrypt");
  await expect(row).toContainText('Caddy default');
});

test('classifies an internal-CA (self-signed) hostname distinctly', async ({ pluginPage: page }) => {
  await writeConf(page, [
    CONF_HEADER,
    '',
    'selfsigned.example.test:19501 {',
    '\ttls internal',
    '\treverse_proxy http://localhost:3001',
    '}',
    '',
  ].join('\n'));

  await openTool(page, /acme.*let.?s encrypt/i);
  const modal = page.getByRole('dialog');
  const row = modal.locator('li').filter({ hasText: 'selfsigned.example.test' });
  await expect(row).toContainText('Internal CA');
  await expect(row).toContainText('Explicit policy');
});

test('classifies an explicit http:// hostname as no TLS', async ({ pluginPage: page }) => {
  await writeConf(page, [
    CONF_HEADER,
    '',
    'http://plain.example.test:19502 {',
    '\treverse_proxy http://localhost:3002',
    '}',
    '',
  ].join('\n'));

  await openTool(page, /acme.*let.?s encrypt/i);
  const modal = page.getByRole('dialog');
  const row = modal.locator('li').filter({ hasText: 'plain.example.test' });
  await expect(row).toContainText('No TLS');
});

test('shows the empty state when no public hostnames are configured', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await openTool(page, /acme.*let.?s encrypt/i);
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
    CONF_HEADER,
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

  await openTool(page, /acme.*let.?s encrypt/i);
  const modal = page.getByRole('dialog');
  const acmeRow = modal.locator('li').filter({ hasText: 'default-acme.example.test' });
  await expect(acmeRow).toContainText("Let's Encrypt");
  await expect(acmeRow).toContainText('Caddy default');
  const internalRow = modal.locator('li').filter({ hasText: 'selfsigned.example.test' });
  await expect(internalRow).toContainText('Internal CA');
  await expect(internalRow).toContainText('Explicit policy');
});

// #246: the Edit dialog shows a site on automatic HTTPS as such, and saving it must not
// turn it into `tls internal` (which replaced a working public certificate before).
test('editing an ACME-managed host keeps it on automatic HTTPS', async ({ pluginPage: page }) => {
  await writeConf(page, [
    CONF_HEADER,
    '',
    'default-acme.example.test:19505 {',
    '\treverse_proxy http://localhost:3005',
    '}',
    '',
  ].join('\n'));

  await page.locator('li').filter({ hasText: 'default-acme.example.test' }).getByRole('button', { name: /^edit$/i }).click();
  const modal = page.getByRole('dialog');
  await expect(modal.locator('#edit-tls')).toHaveValue('acme', { timeout: 10000 });
  await modal.locator('#edit-label').fill('kept on acme');
  await modal.getByRole('button', { name: /save changes/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });

  const conf = await readConf(page);
  expect(conf).toContain('default-acme.example.test:19505 {');
  expect(conf).not.toMatch(/\btls\b/);
});

// #282: per-host certificate status from Caddy's storage and its tls log.
test('an internal-CA host shows "valid until" and opens its certificate with the PEM', async ({ pluginPage: page }) => {
  test.setTimeout(120000);
  const host = 'cert282.example.test';
  await writeConf(page, [CONF_HEADER, '', `${host}:19830 {`, '\ttls internal', '\trespond "ok"', '}', ''].join('\n'));

  // Caddy issues the certificate right after the reload; reopen the window until it's stored.
  const modal = page.getByRole('dialog');
  const row = modal.locator('li').filter({ hasText: host });
  await expect(async () => {
    if (await modal.isVisible()) await modal.getByRole('button', { name: /^close$/i }).last().click();
    await openTool(page, /acme.*let.?s encrypt/i);
    await expect(row).toContainText(/Valid until/, { timeout: 5000 });
  }).toPass({ timeout: 60000 });
  await expect(row).toContainText(/renews around/);

  await row.getByRole('button', { name: host }).click();
  const view = modal.getByTestId('acme-cert-view');
  await expect(view).toContainText(`Certificate for ${host}`);
  await expect(view).toContainText(host);
  await expect(view).toContainText(/SHA-256 fingerprint/);
  const pem = (await view.getByTestId('cert-pem').textContent()) ?? '';
  expect(pem).toContain('-----BEGIN CERTIFICATE-----');
  expect(pem).not.toMatch(/PRIVATE KEY/);

  // The PEM shown is a real certificate for this host.
  const parsed = await page.evaluate(([p]) =>
    new Promise<string>((resolve, reject) =>
      (window as any).cockpit.spawn(['openssl', 'x509', '-noout', '-ext', 'subjectAltName'], { err: 'out' })
        .input(p).then(resolve).catch(reject)), [pem] as [string]);
  expect(parsed).toContain(`DNS:${host}`);

  await view.getByRole('button', { name: /back to the list/i }).click();
  await expect(row).toBeVisible();
});

test('an ACME host whose challenge cannot succeed shows "failed" with Caddy\'s error', async ({ pluginPage: page }) => {
  // Let's Encrypt refuses example.com names outright, so the failure comes back fast.
  test.setTimeout(150000);
  const host = 'acme-fail-282.example.com';
  await writeConf(page, [CONF_HEADER, '', `${host}:19831 {`, '\trespond "ok"', '}', ''].join('\n'));

  const modal = page.getByRole('dialog');
  const row = modal.locator('li').filter({ hasText: host });
  await expect(async () => {
    if (await modal.isVisible()) await modal.getByRole('button', { name: /^close$/i }).last().click();
    await openTool(page, /acme.*let.?s encrypt/i);
    await expect(row).toContainText('Failed', { timeout: 5000 });
  }).toPass({ timeout: 90000 });
  await expect(row.getByTestId('cert-error')).toContainText(/rejectedIdentifier|forbidden by policy|could not|challenge/i);
});
