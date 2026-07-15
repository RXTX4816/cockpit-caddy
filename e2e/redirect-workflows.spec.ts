/**
 * Redirect route CRUD workflows.
 *
 * Redirect routes share the same DataList/anchor pattern as standalone proxies
 * (id="proxy-{port}"), so this mirrors proxy-workflows.spec.ts's structure but
 * drives the "Add Redirect" toolbar button and dialog instead.
 */
import { test, expect, dismissAdminBanner } from './fixtures';
import { readConf, addProxy, spawnCmd } from './helpers';
import { curlStatus, waitForListener } from './live';

async function waitForToolbar(page: import('@playwright/test').Page) {
  await dismissAdminBanner(page);
  await page.getByRole('button', { name: /add redirect/i }).first().waitFor({ state: 'visible', timeout: 15000 });
}

/** Finds the DataList row for a given port (scopes by the anchor element id). */
function proxyRow(page: import('@playwright/test').Page, port: number) {
  return page.locator('li').filter({ has: page.locator(`#proxy-${port}`) });
}

/** Opens Add Redirect dialog, fills port + target URL, submits and confirms. */
async function addRedirectViaUI(
  page: import('@playwright/test').Page,
  port: number,
  to: string,
) {
  await page.getByRole('button', { name: /add redirect/i }).first().click();
  const modal = page.getByRole('dialog');
  await modal.locator('#redirect-port').fill(String(port));
  await modal.locator('#redirect-to').fill(to);
  await modal.getByRole('button', { name: /^add redirect$/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });
}

// ---------------------------------------------------------------------------

test('create redirect appears in the route list', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addRedirectViaUI(page, 19140, 'https://example.test/');
  await expect(page.getByRole('link', { name: ':19140' })).toBeVisible({ timeout: 5000 });
});

test('create redirect writes correct Caddyfile block', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addRedirectViaUI(page, 19141, 'https://example.test/target');
  const conf = await readConf(page);
  expect(conf).toContain(':19141');
  expect(conf).toContain('redir https://example.test/target 308');
});

test('edit redirect target updates the Caddyfile', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addRedirectViaUI(page, 19142, 'https://example.test/old');

  await proxyRow(page, 19142).getByRole('button', { name: /^edit$/i }).click();
  const modal = page.getByRole('dialog');
  await modal.locator('#edit-redirect-to').fill('https://example.test/new');
  await modal.getByRole('button', { name: /save changes/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });

  const conf = await readConf(page);
  expect(conf).toContain('https://example.test/new');
  expect(conf).not.toContain('https://example.test/old');
});

test('delete redirect removes it from the list and the Caddyfile', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addRedirectViaUI(page, 19143, 'https://example.test/');
  await expect(page.getByRole('link', { name: ':19143' })).toBeVisible();

  await proxyRow(page, 19143).getByRole('button', { name: /^delete$/i }).click();
  const confirmModal = page.getByRole('dialog');
  await confirmModal.getByRole('button', { name: /^delete$/i }).click();
  await expect(page.getByRole('link', { name: ':19143' })).not.toBeVisible({ timeout: 10000 });

  await expect.poll(async () => readConf(page), { timeout: 8000 }).not.toContain(':19143');
});

test('redirect actually returns the configured status and Location header via curl', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addRedirectViaUI(page, 19144, 'https://example.test/there');

  await waitForListener(page, `http://localhost:19144/`);
  const status = await curlStatus(page, `http://localhost:19144/`);
  expect(status).toBe('308');

  const headers = await spawnCmd(page, ['bash', '-c',
    `curl -s -o /dev/null -D - 'http://localhost:19144/'; true`]);
  expect(headers.toLowerCase()).toContain('location: https://example.test/there');
});

test('redirect on a port already used by a proxy is rejected', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addProxy(page, { port: 19145, target: 'localhost:3000' });
  await page.reload({ waitUntil: 'networkidle' });
  await waitForToolbar(page);

  await page.getByRole('button', { name: /add redirect/i }).first().click();
  const modal = page.getByRole('dialog');
  await modal.locator('#redirect-port').fill('19145');
  await modal.locator('#redirect-to').fill('https://example.test/');
  await modal.getByRole('button', { name: /^add redirect$/i }).click();
  await expect(modal.getByText(/port.*already/i)).toBeVisible({ timeout: 5000 });
});
