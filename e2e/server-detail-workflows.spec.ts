/**
 * Server-level setting workflows (#49 — TLS, info card).
 *
 * Tests that server-level flags are persisted to the Caddyfile block
 * and reflected in the UI detail panel.
 */
import { test, expect, dismissAdminBanner } from './fixtures';
import { addServer, readConf } from './helpers';

async function waitForToolbar(page: import('@playwright/test').Page) {
  await dismissAdminBanner(page);
  await page.getByRole('button', { name: /add proxy/i }).waitFor({ state: 'visible', timeout: 15000 });
}

function getServerTablist(page: import('@playwright/test').Page) {
  return page.getByRole('tablist').filter({ has: page.getByRole('tab', { name: /^all$/i }) });
}

// ---------------------------------------------------------------------------

test('create server with TLS enabled — Caddyfile block contains tls directive', async ({ pluginPage: page }) => {
  await waitForToolbar(page);

  await page.getByRole('button', { name: /add server/i }).click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel(/display name/i).fill('TLS Server');
  await modal.getByLabel(/\+ add port/i).fill('19400');
  await modal.getByRole('button', { name: /\+ add port/i }).click();
  // Enable TLS
  await modal.getByRole('checkbox', { name: /enable tls/i }).check();
  await modal.getByRole('button', { name: /add server/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });

  const conf = await readConf(page);
  // Named server block must contain a tls directive
  expect(conf).toContain('# server:');
  expect(conf).toContain('tls');
});

test('edit server: enable TLS on existing server — Caddyfile block updated with tls', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  // Start with TLS disabled
  await addServer(page, { key: 'e2e-srv', name: 'E2E Server', ports: [':19401'], tls: false });

  let conf = await readConf(page);
  // Verify TLS is not yet in the block
  const blockStart = conf.indexOf('# server: e2e-srv');
  const blockEnd = conf.indexOf('\n}', blockStart);
  const block = conf.slice(blockStart, blockEnd);
  expect(block).not.toContain('tls internal');

  // Edit server to enable TLS
  const tablist = getServerTablist(page);
  await tablist.getByRole('tab', { name: /e2e server/i }).click();
  await page.getByRole('button', { name: /edit server/i }).click();
  const modal = page.getByRole('dialog');
  await modal.getByRole('checkbox', { name: /enable tls/i }).check();
  await modal.getByRole('button', { name: /save/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });

  conf = await readConf(page);
  expect(conf).toContain('tls');
});

test('server info card shows the listen address for the server', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addServer(page, { key: 'e2e-srv', name: 'E2E Server', ports: [':19402'] });

  const tablist = getServerTablist(page);
  await tablist.getByRole('tab', { name: /e2e server/i }).click();

  // ServerDetailPanel renders the listen addresses as a clickable link
  await expect(page.getByRole('link', { name: /:19402/ })).toBeVisible({ timeout: 5000 });
});
