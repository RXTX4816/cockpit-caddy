/**
 * Route matcher workflows (#48).
 *
 * Tests that matchers are correctly serialized to Caddyfile syntax:
 * - Named matcher block (@m{port}) with handle wrapper for the general case
 * - handle_path for path-only matchers with the handlePath flag
 * - AND logic: multiple matcher types in one @m block
 * - Edit flows: adding and removing matchers on existing proxies
 */
import { test, expect, dismissAdminBanner } from './fixtures';
import { readConf } from './helpers';

async function waitForToolbar(page: import('@playwright/test').Page) {
  await dismissAdminBanner(page);
  await page.getByRole('button', { name: /add proxy/i }).first().waitFor({ state: 'visible', timeout: 15000 });
}

/** Opens Add Proxy dialog with matchers section expanded, ready for matcher input. */
async function openAddProxyWithMatchers(page: import('@playwright/test').Page, port: number, target: { host: string; port: number }) {
  await page.getByRole('button', { name: /add proxy/i }).first().click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('External port').fill(String(port));
  await modal.getByLabel(/target host/i).fill(target.host);
  await modal.locator('#target-port').fill(String(target.port));
  // Expand the Route Matchers section
  await modal.getByText(/route matchers/i).click();
  return modal;
}

async function submitAndConfirm(modal: import('@playwright/test').Locator) {
  await modal.getByRole('button', { name: /add proxy/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });
}

// ---------------------------------------------------------------------------

test('proxy with path matcher generates named @m block and handle wrapper', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  const modal = await openAddProxyWithMatchers(page, 19200, { host: 'localhost', port: 3000 });

  await modal.getByLabel('Path').fill('/api/*');
  await modal.getByRole('button', { name: /add path/i }).click();
  await submitAndConfirm(modal);

  const conf = await readConf(page);
  expect(conf).toContain('@m19200');
  expect(conf).toContain('path /api/*');
  expect(conf).toContain('handle @m19200');
  // Must NOT use handle_path (handlePath is false by default)
  expect(conf).not.toContain('handle_path');
});

test('proxy with path matcher + handlePath generates handle_path block', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  const modal = await openAddProxyWithMatchers(page, 19201, { host: 'localhost', port: 3000 });

  await modal.getByLabel('Path').fill('/api/*');
  await modal.getByRole('button', { name: /add path/i }).click();
  // handlePath checkbox only appears after a path-only matcher is added
  await modal.getByLabel(/strip matched path prefix/i).check();
  await submitAndConfirm(modal);

  const conf = await readConf(page);
  // handle_path syntax strips the prefix automatically — no @m block needed
  expect(conf).toContain('handle_path /api/*');
  expect(conf).not.toContain('@m19201');
});

test('handlePath checkbox hidden when non-path matchers are also present', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  const modal = await openAddProxyWithMatchers(page, 19202, { host: 'localhost', port: 3000 });

  // Add a path matcher first
  await modal.getByLabel('Path').fill('/api/*');
  await modal.getByRole('button', { name: /add path/i }).click();
  // handlePath checkbox should be visible now (path-only)
  await expect(modal.getByLabel(/strip matched path prefix/i)).toBeVisible();

  // Now also add a host matcher — handlePath becomes ineligible
  await modal.getByLabel('Host', { exact: true }).fill('example.com');
  await modal.getByRole('button', { name: /add host/i }).click();
  // handlePath checkbox must disappear or be hidden
  await expect(modal.getByLabel(/strip matched path prefix/i)).not.toBeVisible();

  await modal.getByRole('button', { name: /cancel/i }).click();
});

test('proxy with host matcher writes host line in @m block', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  const modal = await openAddProxyWithMatchers(page, 19203, { host: 'localhost', port: 3000 });

  await modal.getByLabel('Host', { exact: true }).fill('example.com');
  await modal.getByRole('button', { name: /add host/i }).click();
  await submitAndConfirm(modal);

  const conf = await readConf(page);
  expect(conf).toContain('@m19203');
  expect(conf).toContain('host example.com');
  expect(conf).toContain('handle @m19203');
});

test('proxy with method matcher writes method line in @m block', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  const modal = await openAddProxyWithMatchers(page, 19204, { host: 'localhost', port: 3000 });

  // Method toggles are checkboxes/toggle buttons within the Method section
  await modal.getByRole('button', { name: 'GET' }).click();
  await modal.getByRole('button', { name: 'POST' }).click();
  await submitAndConfirm(modal);

  const conf = await readConf(page);
  expect(conf).toContain('@m19204');
  expect(conf).toMatch(/method\s+GET\s+POST|method\s+POST\s+GET/);
  expect(conf).toContain('handle @m19204');
});

test('proxy with header matcher writes header line in @m block', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  const modal = await openAddProxyWithMatchers(page, 19205, { host: 'localhost', port: 3000 });

  // Scope to the Route Matchers expanded region to avoid ambiguity with the
  // Request Headers / Response Headers sections that share the same aria-labels.
  // PF6 ExpandableSection content renders with role="region" + aria-labelledby → toggle text.
  const matchersContent = modal.getByRole('region', { name: /route matchers/i });
  await matchersContent.getByLabel('Header name').fill('X-API-Key');
  await matchersContent.getByLabel(/value.*blank.*present/i).fill('secret');
  // Two "Add" buttons exist in the region (header + query); click the enabled one
  await matchersContent.getByRole('button', { name: /^add$/i }).first().click();
  await submitAndConfirm(modal);

  const conf = await readConf(page);
  expect(conf).toContain('@m19205');
  expect(conf).toContain('header X-API-Key secret');
  expect(conf).toContain('handle @m19205');
});

test('path + host matchers both appear in a single @m block (AND logic)', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  const modal = await openAddProxyWithMatchers(page, 19206, { host: 'localhost', port: 3000 });

  await modal.getByLabel('Path').fill('/api/*');
  await modal.getByRole('button', { name: /add path/i }).click();
  await modal.getByLabel('Host', { exact: true }).fill('api.example.com');
  await modal.getByRole('button', { name: /add host/i }).click();
  await submitAndConfirm(modal);

  const conf = await readConf(page);
  // Single @m block containing both conditions (AND logic)
  expect(conf).toContain('@m19206');
  expect(conf).toContain('path /api/*');
  expect(conf).toContain('host api.example.com');
  // Only one @m block for this port
  expect(conf.split('@m19206').length - 1).toBe(2); // appears in definition + handle reference
});

test('edit proxy: add path matcher to existing plain proxy regenerates block with @m wrapper', async ({ pluginPage: page }) => {
  await waitForToolbar(page);

  // Create a plain proxy first
  await page.getByRole('button', { name: /add proxy/i }).first().click();
  let modal = page.getByRole('dialog');
  await modal.getByLabel('External port').fill('19207');
  await modal.getByLabel(/target host/i).fill('localhost');
  await modal.locator('#target-port').fill('3000');
  await modal.getByRole('button', { name: /add proxy/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });

  let conf = await readConf(page);
  expect(conf).not.toContain('@m19207');

  // Edit — add a path matcher
  await page.locator('li').filter({ has: page.locator('#proxy-19207') }).getByRole('button', { name: /^edit$/i }).click();
  modal = page.getByRole('dialog');
  await modal.getByText(/route matchers/i).click();
  await modal.getByLabel('Path').fill('/api/*');
  await modal.getByRole('button', { name: /add path/i }).click();
  await modal.getByRole('button', { name: /save changes/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });

  conf = await readConf(page);
  expect(conf).toContain('@m19207');
  expect(conf).toContain('path /api/*');
  expect(conf).toContain('handle @m19207');
});

test('edit proxy: remove all matchers reverts to plain block without @m', async ({ pluginPage: page }) => {
  await waitForToolbar(page);

  // Create proxy with a path matcher
  const modal0 = await openAddProxyWithMatchers(page, 19208, { host: 'localhost', port: 3000 });
  await modal0.getByLabel('Path').fill('/api/*');
  await modal0.getByRole('button', { name: /add path/i }).click();
  await submitAndConfirm(modal0);

  let conf = await readConf(page);
  expect(conf).toContain('@m19208');

  // Edit — remove the path matcher using the × button
  await page.locator('li').filter({ has: page.locator('#proxy-19208') }).getByRole('button', { name: /^edit$/i }).click();
  const editModal = page.getByRole('dialog');
  // Matchers section auto-expands when proxy has matchers — only click to expand if the button isn't visible yet
  const removeBtn = editModal.getByRole('button', { name: /remove path/i });
  const isVisible = await removeBtn.isVisible();
  if (!isVisible) {
    await editModal.getByText(/route matchers/i).click();
  }
  await removeBtn.click();
  await editModal.getByRole('button', { name: /save changes/i }).click();
  await editModal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(editModal).not.toBeVisible({ timeout: 15000 });

  conf = await readConf(page);
  expect(conf).not.toContain('@m19208');
  expect(conf).not.toContain('handle @m19208');
  // Plain block still has the reverse_proxy directive (scheme prefix always included)
  expect(conf).toContain('reverse_proxy http://localhost:3000');
});
