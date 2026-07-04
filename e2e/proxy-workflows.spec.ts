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
