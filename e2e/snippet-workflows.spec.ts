/**
 * Snippets (#288): a snippet is written once to the plugin's snippets file, sites import it,
 * Caddy applies it on reload, and reading a site back doesn't copy the snippet into it.
 */
import { test, expect, dismissAdminBanner } from './fixtures';
import { readConf, readFile, spawnCmd, SNIPPETS_CONF_PATH } from './helpers';
import type { Page, Locator } from '@playwright/test';

const BODY = 'header {\n\tX-Snippet-Test e2e\n}';

async function openSettings(page: Page): Promise<Locator> {
  await dismissAdminBanner(page);
  await page.getByRole('tab', { name: /settings/i }).click();
  return page.getByRole('region', { name: 'Snippets' });
}

async function createSnippet(page: Page, name: string, body: string) {
  const section = await openSettings(page);
  await section.getByRole('button', { name: 'Add snippet' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByLabel('Snippet body').fill(body);
  await dialog.getByRole('button', { name: 'Save' }).click();
  return dialog;
}

async function addProxyImporting(page: Page, port: number, snippet: string) {
  await page.getByRole('tab', { name: /proxy list/i }).click();
  await page.getByRole('button', { name: /add proxy/i }).first().click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('External port').fill(String(port));
  await modal.getByLabel(/target host/i).fill('localhost');
  await modal.locator('#target-port').fill('3000');
  await modal.getByRole('button', { name: 'Import snippet' }).click();
  await page.getByRole('menuitem', { name: snippet }).click();
  await modal.getByRole('button', { name: /add proxy/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });
}

test('create a snippet, import it into two sites, and Caddy applies it once per site', async ({ pluginPage: page }) => {
  const dialog = await createSnippet(page, 'security-headers', BODY);
  await expect(dialog).not.toBeVisible({ timeout: 15000 });
  const snippets = await readFile(page, SNIPPETS_CONF_PATH);
  expect(snippets.match(/\(security-headers\) \{/g)).toHaveLength(1);

  await addProxyImporting(page, 19300, 'security-headers');
  await addProxyImporting(page, 19301, 'security-headers');

  let conf = await readConf(page);
  expect(conf.match(/import security-headers/g)).toHaveLength(2);
  expect(conf).not.toContain('X-Snippet-Test');
  await spawnCmd(page, ['caddy', 'adapt', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile']);
  const live = await spawnCmd(page, ['curl', '-s', '--unix-socket', '/run/caddy/admin.socket', 'http://localhost/config/']);
  expect(live.match(/X-Snippet-Test/g)).toHaveLength(2);

  // Reopen one site and save it unchanged: the snippet's header must not move into the site block.
  await page.locator('li').filter({ has: page.locator('#proxy-19300') }).getByRole('button', { name: /^edit$/i }).click();
  const edit = page.getByRole('dialog');
  await expect(edit.getByText(/come from snippet security-headers/i)).toBeVisible();
  await edit.getByRole('button', { name: /save changes/i }).click();
  await edit.getByRole('button', { name: /^confirm$/i }).click();
  await expect(edit).not.toBeVisible({ timeout: 15000 });
  conf = await readConf(page);
  expect(conf).not.toContain('X-Snippet-Test');
  expect(conf.match(/import security-headers/g)).toHaveLength(2);

  // Deleting a snippet that's still imported is refused and names the sites.
  const section = await openSettings(page);
  await section.getByRole('button', { name: 'Delete security-headers' }).click();
  await section.getByRole('button', { name: 'Delete snippet' }).click();
  await expect(section.getByText(/still imported by: .*19300.*19301/)).toBeVisible();
  expect(await readFile(page, SNIPPETS_CONF_PATH)).toContain('(security-headers)');
});

test('a snippet with a syntax error is refused and the previous file stays', async ({ pluginPage: page }) => {
  const ok = await createSnippet(page, 'good', 'encode gzip');
  await expect(ok).not.toBeVisible({ timeout: 15000 });
  const before = await readFile(page, SNIPPETS_CONF_PATH);

  const bad = await createSnippet(page, 'broken', 'header {\n\tX-A 1');
  await expect(bad.getByText(/caddy rejected the snippet/i)).toBeVisible({ timeout: 15000 });
  expect(await readFile(page, SNIPPETS_CONF_PATH)).toBe(before);
});
