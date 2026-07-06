/**
 * HTTP/3 (QUIC) toggle workflows (#51).
 *
 * Caddy enables h1/h2/h3 by default whenever TLS is configured. This is a toggle to
 * explicitly opt a server out of h3. `protocols` is only valid inside the top-level
 * global `servers { }` options block (Caddy rejects it as an "unrecognized directive"
 * at the per-site level) — the same mechanism this app already uses for standalone
 * proxies' server-level timeouts/header limits. Verifies the main Caddyfile output and
 * that Caddy actually accepts and applies it on reload — not real QUIC traffic (not
 * exercisable in this VM).
 */
import { test, expect, dismissAdminBanner } from './fixtures';
import { addProxy, readFile, CADDYFILE_PATH } from './helpers';

async function waitForToolbar(page: import('@playwright/test').Page) {
  await dismissAdminBanner(page);
  await page.getByRole('button', { name: /add proxy/i }).first().waitFor({ state: 'visible', timeout: 15000 });
}

test('disabling HTTP/3 writes a global servers block and Caddy accepts the reload', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addProxy(page, { port: 19700, target: 'localhost:3000', tls: 'internal' });
  await page.waitForTimeout(3500);

  await page.locator('li').filter({ hasText: ':19700' }).getByRole('button', { name: /^edit$/i }).click();
  const modal = page.getByRole('dialog');
  await modal.getByRole('button', { name: /server timeouts/i }).click();
  await modal.getByRole('checkbox', { name: /disable http\/3/i }).check();
  await modal.getByRole('button', { name: /save changes/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  // A validation/apply error would keep the dialog open with a danger alert instead of
  // closing — this is the regression check for "unrecognized directive: protocols".
  await expect(modal).not.toBeVisible({ timeout: 15000 });

  const mainConf = await readFile(page, CADDYFILE_PATH);
  expect(mainConf).toContain('servers :19700 {');
  expect(mainConf).toContain('protocols h1 h2');

  // The proxy itself must still be reachable/listed — a rejected reload would have left
  // the service in a broken state.
  await expect(page.getByRole('link', { name: ':19700' })).toBeVisible({ timeout: 10000 });
});

test('HTTP/3 stays enabled (no protocols restriction) by default', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addProxy(page, { port: 19701, target: 'localhost:3001', tls: 'internal' });
  const mainConf = await readFile(page, CADDYFILE_PATH);
  expect(mainConf).not.toContain('protocols');
});

// Regression: the global `servers` managed section used to emit one `servers :PORT { }`
// block per proxy rather than one per port — the moment two proxies on different ports
// each had *some* server-level setting (a timeout on one, HTTP/3 disabled on another),
// unrelated edits started failing with "duplicate listener addresses" the instant a
// third proxy shared a port with one of them, since Caddy rejects two `servers` blocks
// naming the same address. Editing any proxy re-syncs the whole managed section, so this
// reproduces via an edit to a proxy that has nothing to do with HTTP/3 at all.
test('editing an unrelated proxy does not break when another port has HTTP/3 disabled', async ({ pluginPage: page }) => {
  await waitForToolbar(page);

  // Proxy on its own port with a plain timeout — completely unrelated to HTTP/3.
  await page.getByRole('button', { name: /add proxy/i }).first().click();
  let modal = page.getByRole('dialog');
  await modal.getByLabel('External port').fill('19702');
  await modal.getByLabel(/target host/i).fill('localhost');
  await modal.locator('#target-port').fill('3002');
  await modal.getByRole('button', { name: /server timeouts/i }).click();
  await modal.getByLabel(/read body timeout/i).fill('5s');
  await modal.getByRole('button', { name: /add proxy/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(3500);

  // A different port, HTTP/3 disabled.
  await page.getByRole('button', { name: /add proxy/i }).first().click();
  modal = page.getByRole('dialog');
  await modal.getByLabel('External port').fill('19703');
  await modal.getByLabel(/target host/i).fill('localhost');
  await modal.locator('#target-port').fill('3003');
  await modal.getByRole('button', { name: /server timeouts/i }).click();
  await modal.getByRole('checkbox', { name: /disable http\/3/i }).check();
  await modal.getByRole('button', { name: /add proxy/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });
  await page.waitForTimeout(3500);

  // Edit the first (unrelated) proxy — must not error.
  await page.locator('li').filter({ hasText: ':19702' }).getByRole('button', { name: /^edit$/i }).click();
  modal = page.getByRole('dialog');
  await modal.locator('#edit-target-port').fill('9998');
  await modal.getByRole('button', { name: /save changes/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });

  const mainConf = await readFile(page, CADDYFILE_PATH);
  expect(mainConf).toContain('servers :19702 {');
  expect(mainConf).toContain('servers :19703 {');
  expect(mainConf).toContain('protocols h1 h2');
});
