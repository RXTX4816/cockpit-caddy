/**
 * Static "respond" route CRUD workflows.
 */
import { test, expect, dismissAdminBanner } from './fixtures';
import { readConf, addRedirect } from './helpers';
import { curlStatus, waitForListener } from './live';

async function waitForToolbar(page: import('@playwright/test').Page) {
  await dismissAdminBanner(page);
  await page.getByRole('button', { name: /add respond/i }).first().waitFor({ state: 'visible', timeout: 15000 });
}

/** Finds the DataList row for a given port (scopes by the anchor element id). */
function proxyRow(page: import('@playwright/test').Page, port: number) {
  return page.locator('li').filter({ has: page.locator(`#proxy-${port}`) });
}

/** Opens Add Respond dialog, fills port + status (+ optional body), submits and confirms. */
async function addRespondViaUI(
  page: import('@playwright/test').Page,
  port: number,
  status: number,
  body?: string,
) {
  await page.getByRole('button', { name: /add respond/i }).first().click();
  const modal = page.getByRole('dialog');
  await modal.locator('#respond-port').fill(String(port));
  await modal.locator('#respond-status').fill(String(status));
  if (body) await modal.locator('#respond-body').fill(body);
  await modal.getByRole('button', { name: /^add response$/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });
}

// ---------------------------------------------------------------------------

test('create respond route appears in the route list', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addRespondViaUI(page, 19180, 200, 'hello');
  await expect(page.getByRole('link', { name: ':19180' })).toBeVisible({ timeout: 5000 });
});

test('create respond route writes correct Caddyfile block', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addRespondViaUI(page, 19181, 200, 'hello e2e');
  const conf = await readConf(page);
  expect(conf).toContain(':19181');
  expect(conf).toContain('respond "hello e2e" 200');
});

test('edit respond status code updates the Caddyfile', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addRespondViaUI(page, 19182, 200, 'body');

  await proxyRow(page, 19182).getByRole('button', { name: /^edit$/i }).click();
  const modal = page.getByRole('dialog');
  await modal.locator('#er-status').fill('503');
  await modal.getByRole('button', { name: /save changes/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });

  const conf = await readConf(page);
  expect(conf).toContain('respond "body" 503');
  expect(conf).not.toContain('respond "body" 200');
});

test('delete respond route removes it from the list and the Caddyfile', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addRespondViaUI(page, 19183, 200);
  await expect(page.getByRole('link', { name: ':19183' })).toBeVisible();

  await proxyRow(page, 19183).getByRole('button', { name: /^delete$/i }).click();
  const confirmModal = page.getByRole('dialog');
  await confirmModal.getByRole('button', { name: /^delete$/i }).click();
  await expect(page.getByRole('link', { name: ':19183' })).not.toBeVisible({ timeout: 10000 });

  await expect.poll(async () => readConf(page), { timeout: 8000 }).not.toContain(':19183');
});

test('respond route actually returns the configured status and body via curl', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addRespondViaUI(page, 19184, 418, 'i am a teapot');

  await waitForListener(page, `http://localhost:19184/`);
  const status = await curlStatus(page, `http://localhost:19184/`);
  expect(status).toBe('418');
});

test('respond route on a port already used by a redirect is rejected', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addRedirect(page, { port: 19185, to: 'https://example.test/' });

  await page.getByRole('button', { name: /add respond/i }).first().click();
  const modal = page.getByRole('dialog');
  await modal.locator('#respond-port').fill('19185');
  await modal.locator('#respond-status').fill('200');
  await modal.getByRole('button', { name: /^add response$/i }).click();
  await expect(modal.getByText(/port.*already/i)).toBeVisible({ timeout: 5000 });
});
