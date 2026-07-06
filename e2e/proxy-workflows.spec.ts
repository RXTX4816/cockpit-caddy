/**
 * Standalone proxy CRUD workflows.
 *
 * Each test starts from a clean config (resetConfig runs in the pluginPage
 * fixture before every test).  We add/edit/delete via the UI and verify both
 * the proxy list state and the raw cockpit-caddy.conf content.
 */
import { test, expect, dismissAdminBanner } from './fixtures';
import { readConf } from './helpers';

async function waitForToolbar(page: import('@playwright/test').Page) {
  await dismissAdminBanner(page);
  await page.getByRole('button', { name: /add proxy/i }).first().waitFor({ state: 'visible', timeout: 15000 });
}

/** Finds the DataList row for a given port (scopes by the anchor element id). */
function proxyRow(page: import('@playwright/test').Page, port: number) {
  return page.locator('li').filter({ has: page.locator(`#proxy-${port}`) });
}

/** Opens Add Proxy dialog, fills port + target, submits and confirms. */
async function addProxyViaUI(
  page: import('@playwright/test').Page,
  port: number,
  target: { host: string; port: number },
) {
  await page.getByRole('button', { name: /add proxy/i }).first().click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('External port').fill(String(port));
  await modal.getByLabel(/target host/i).fill(target.host);
  await modal.locator('#target-port').fill(String(target.port));
  await modal.getByRole('button', { name: /add proxy/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });
}

// ---------------------------------------------------------------------------

test('create proxy appears in the proxy list', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addProxyViaUI(page, 19100, { host: 'localhost', port: 3000 });
  // Port link is the <a> with id="proxy-PORT"
  await expect(page.getByRole('link', { name: ':19100' })).toBeVisible({ timeout: 5000 });
});

test('create proxy writes correct Caddyfile block', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addProxyViaUI(page, 19101, { host: 'localhost', port: 3001 });
  const conf = await readConf(page);
  expect(conf).toContain(':19101');
  // Plugin always includes scheme prefix in the upstream dial address
  expect(conf).toContain('reverse_proxy http://localhost:3001');
});

test('edit proxy target updates the Caddyfile', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addProxyViaUI(page, 19102, { host: 'localhost', port: 3002 });

  // Edit — change the target port
  await proxyRow(page, 19102).getByRole('button', { name: /^edit$/i }).click();
  const modal = page.getByRole('dialog');
  await modal.locator('#edit-target-port').fill('9999');
  await modal.getByRole('button', { name: /save changes/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });

  const conf = await readConf(page);
  expect(conf).toContain('reverse_proxy http://localhost:9999');
  expect(conf).not.toContain('reverse_proxy http://localhost:3002');
});

test('edit proxy port removes old block and creates new block', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addProxyViaUI(page, 19103, { host: 'localhost', port: 3003 });

  // Edit — change the external port
  await proxyRow(page, 19103).getByRole('button', { name: /^edit$/i }).click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('External port').fill('19104');
  await modal.getByRole('button', { name: /save changes/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });

  const conf = await readConf(page);
  expect(conf).toContain(':19104');
  expect(conf).not.toContain(':19103');
  await expect(page.getByRole('link', { name: ':19104' })).toBeVisible({ timeout: 5000 });
  await expect(page.getByRole('link', { name: ':19103' })).not.toBeVisible();
});

test('delete proxy removes it from the list and the Caddyfile', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addProxyViaUI(page, 19105, { host: 'localhost', port: 3005 });
  await expect(page.getByRole('link', { name: ':19105' })).toBeVisible();

  // Delete
  await proxyRow(page, 19105).getByRole('button', { name: /^delete$/i }).click();
  const confirmModal = page.getByRole('dialog');
  await confirmModal.getByRole('button', { name: /^delete$/i }).click();
  await expect(page.getByRole('link', { name: ':19105' })).not.toBeVisible({ timeout: 10000 });

  // File write may complete slightly after state update — poll until file reflects the deletion.
  await expect.poll(async () => readConf(page), { timeout: 8000 }).not.toContain(':19105');
});

test('duplicate proxy opens prefilled dialog that creates a distinct new entry', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addProxyViaUI(page, 19106, { host: 'localhost', port: 3006 });

  // Duplicate
  await proxyRow(page, 19106).getByRole('button', { name: /^duplicate$/i }).click();
  const modal = page.getByRole('dialog');
  // Port field starts empty for duplicates — fill a distinct port
  await modal.getByLabel('External port').fill('19107');
  // Target host/port is pre-filled from the original
  await modal.getByRole('button', { name: /add proxy/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });

  // Both ports visible in the list
  await expect(page.getByRole('link', { name: ':19106' })).toBeVisible({ timeout: 5000 });
  await expect(page.getByRole('link', { name: ':19107' })).toBeVisible({ timeout: 5000 });

  const conf = await readConf(page);
  expect(conf).toContain(':19106');
  expect(conf).toContain(':19107');
});

// ---------------------------------------------------------------------------
// #139 — port conflict falsely triggered across subdomains
//
// Regression test: adding a second standalone proxy on an already-used port,
// distinguished only by a different External host/subdomain, used to be
// rejected with "port already in use" even though Caddy has no problem
// serving multiple sites on one port via Host/SNI-based virtual hosting —
// the same way multiple site blocks in a plain Caddyfile share a port by
// subdomain. Two hostless proxies on the same port must still conflict.
// ---------------------------------------------------------------------------

test('two standalone proxies can share a port via distinct subdomains', async ({ pluginPage: page }) => {
  await waitForToolbar(page);

  await page.getByRole('button', { name: /add proxy/i }).first().click();
  let modal = page.getByRole('dialog');
  await modal.locator('#label').fill('Route A');
  await modal.getByLabel('External port').fill('19110');
  await modal.getByLabel(/external host/i).fill('a.example.test');
  await modal.getByLabel(/target host/i).fill('localhost');
  await modal.locator('#target-port').fill('3010');
  await modal.getByRole('button', { name: /add proxy/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });
  // The external host is recovered from the conf.d text via a 3s-interval fallback sync
  // (the live JSON push has no host on a lone port's route — see useProxies.ts syncConf) —
  // wait for it to catch up so the second add's host-aware validation sees proxy A's host.
  await page.waitForTimeout(3500);

  await page.getByRole('button', { name: /add proxy/i }).first().click();
  modal = page.getByRole('dialog');
  await modal.locator('#label').fill('Route B');
  await modal.getByLabel('External port').fill('19110');
  await modal.getByLabel(/external host/i).fill('b.example.test');
  await modal.getByLabel(/target host/i).fill('localhost');
  await modal.locator('#target-port').fill('3011');
  await modal.getByRole('button', { name: /add proxy/i }).click();
  // No "port already in use" validation error should block confirmation.
  await expect(modal.getByText(/port.*already/i)).not.toBeVisible();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });

  // The second proxy shares its port with a different host (#139): a hand-built
  // single-route JSON push can't represent that shared listener, so useProxies
  // automatically reloads Caddy instead (Caddy's own adapter then builds the
  // correct merged multi-route server) — no manual step, both appear right away.
  const conf = await readConf(page);
  expect(conf).toContain('a.example.test:19110');
  expect(conf).toContain('b.example.test:19110');
  await expect(page.getByRole('link', { name: 'a.example.test:19110' })).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole('link', { name: 'b.example.test:19110' })).toBeVisible({ timeout: 10000 });

  // Regression: labels (and TLS/external-address state) must not bleed between two
  // routes sharing a port — each is keyed by its own host-qualified address, not the
  // ambiguous bare-port fallback key.
  const rowA = page.locator('li').filter({ hasText: 'a.example.test:19110' });
  const rowB = page.locator('li').filter({ hasText: 'b.example.test:19110' });
  await expect(rowA).toContainText('Route A');
  await expect(rowB).toContainText('Route B');
});

// Regression: a hand-written (or migrated) Caddyfile with an explicit `https://`
// scheme prefix on two host-qualified blocks sharing a port used to have its
// labels bleed together — buildExternalAddress can't reproduce the scheme until
// it's already been recovered, so the exact-match lookup key missed and both
// routes fell back to the same ambiguous bare-port cache key.
test('two proxies with explicit https:// scheme sharing a port keep distinct labels', async ({ pluginPage: page }) => {
  await waitForToolbar(page);

  const conf = [
    '# Managed by cockpit-caddy - edits to this file may be overwritten by user plugin actions',
    '',
    '# label: 139test1',
    'https://test.speedport.ip:19300 {',
    '\ttls internal',
    '\treverse_proxy http://localhost:3000',
    '}',
    '',
    '# label: jellyfin',
    'https://jellyfin.speedport.ip:19300 {',
    '\ttls internal',
    '\treverse_proxy http://localhost:8096',
    '}',
    '',
  ].join('\n');
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

  const rowA = page.locator('li').filter({ hasText: 'test.speedport.ip:19300' });
  const rowB = page.locator('li').filter({ hasText: 'jellyfin.speedport.ip:19300' });
  await expect(rowA).toContainText('139test1');
  await expect(rowB).toContainText('jellyfin');
});

test('two hostless proxies on the same port still conflict', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addProxyViaUI(page, 19111, { host: 'localhost', port: 3012 });

  await page.getByRole('button', { name: /add proxy/i }).first().click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('External port').fill('19111');
  await modal.getByLabel(/target host/i).fill('localhost');
  await modal.locator('#target-port').fill('3013');
  await modal.getByRole('button', { name: /add proxy/i }).click();
  await expect(modal.getByText(/port.*already/i)).toBeVisible({ timeout: 5000 });
});
