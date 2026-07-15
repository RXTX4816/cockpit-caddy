/**
 * Static file-server route CRUD workflows.
 */
import { test, expect, dismissAdminBanner } from './fixtures';
import { readConf, addRedirect, writeFile, spawnCmd } from './helpers';
import { curlStatus, waitForListener } from './live';

async function waitForToolbar(page: import('@playwright/test').Page) {
  await dismissAdminBanner(page);
  await page.getByRole('button', { name: /add static/i }).first().waitFor({ state: 'visible', timeout: 15000 });
}

/** Finds the DataList row for a given port (scopes by the anchor element id). */
function proxyRow(page: import('@playwright/test').Page, port: number) {
  return page.locator('li').filter({ has: page.locator(`#proxy-${port}`) });
}

/** Opens Add Static dialog, fills port + root, unchecks TLS (plain-HTTP for curl
 *  simplicity — TLS itself is already covered by custom-tls-cert-workflows.spec.ts),
 *  submits and confirms. */
async function addStaticViaUI(
  page: import('@playwright/test').Page,
  port: number,
  root: string,
) {
  await page.getByRole('button', { name: /add static/i }).first().click();
  const modal = page.getByRole('dialog');
  await modal.locator('#static-port').fill(String(port));
  await modal.locator('#static-root').fill(root);
  await modal.locator('#static-tls').uncheck();
  await modal.getByRole('button', { name: /^add static server$/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });
}

// ---------------------------------------------------------------------------

test('create static site appears in the route list', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addStaticViaUI(page, 19160, '/var/www/e2e-19160');
  await expect(page.getByRole('link', { name: ':19160' })).toBeVisible({ timeout: 5000 });
});

test('create static site writes correct Caddyfile block', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addStaticViaUI(page, 19161, '/var/www/e2e-19161');
  const conf = await readConf(page);
  expect(conf).toContain(':19161');
  expect(conf).toContain('root * /var/www/e2e-19161');
  expect(conf).toContain('file_server');
});

test('edit static site root path updates the Caddyfile', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addStaticViaUI(page, 19162, '/var/www/e2e-19162-old');

  await proxyRow(page, 19162).getByRole('button', { name: /^edit$/i }).click();
  const modal = page.getByRole('dialog');
  await modal.locator('#static-edit-root').fill('/var/www/e2e-19162-new');
  await modal.getByRole('button', { name: /save changes/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });

  const conf = await readConf(page);
  expect(conf).toContain('/var/www/e2e-19162-new');
  expect(conf).not.toContain('/var/www/e2e-19162-old');
});

test('delete static site removes it from the list and the Caddyfile', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addStaticViaUI(page, 19163, '/var/www/e2e-19163');
  await expect(page.getByRole('link', { name: ':19163' })).toBeVisible();

  await proxyRow(page, 19163).getByRole('button', { name: /^delete$/i }).click();
  const confirmModal = page.getByRole('dialog');
  await confirmModal.getByRole('button', { name: /^delete$/i }).click();
  await expect(page.getByRole('link', { name: ':19163' })).not.toBeVisible({ timeout: 10000 });

  await expect.poll(async () => readConf(page), { timeout: 8000 }).not.toContain(':19163');
});

test('static site serves a real file via curl', async ({ pluginPage: page }) => {
  // caddy.service runs with PrivateTmp=true, so /tmp on the host is invisible to the
  // caddy process — the static root must live somewhere caddy can actually read, e.g.
  // under /etc/caddy (already in its read path since that's where its own config lives).
  const root = '/etc/caddy/e2e-static-19164';
  await spawnCmd(page, ['mkdir', '-p', root]);
  await writeFile(page, `${root}/hello.txt`, 'hello from e2e');

  await waitForToolbar(page);
  await addStaticViaUI(page, 19164, root);

  await waitForListener(page, `http://localhost:19164/hello.txt`);
  const body = await spawnCmd(page, ['bash', '-c', `curl -s 'http://localhost:19164/hello.txt'; true`]);
  expect(body.trim()).toBe('hello from e2e');
});

test('static site returns 404 for a missing file', async ({ pluginPage: page }) => {
  const root = '/etc/caddy/e2e-static-19165';
  await spawnCmd(page, ['mkdir', '-p', root]);
  await writeFile(page, `${root}/present.txt`, 'present');

  await waitForToolbar(page);
  await addStaticViaUI(page, 19165, root);

  await waitForListener(page, `http://localhost:19165/present.txt`);
  const status = await curlStatus(page, `http://localhost:19165/does-not-exist.txt`);
  expect(status).toBe('404');
});

test('static site on a port already used by a redirect is rejected', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addRedirect(page, { port: 19166, to: 'https://example.test/' });

  await page.getByRole('button', { name: /add static/i }).first().click();
  const modal = page.getByRole('dialog');
  await modal.locator('#static-port').fill('19166');
  await modal.locator('#static-root').fill('/var/www/e2e-19166');
  await modal.getByRole('button', { name: /^add static server$/i }).click();
  await expect(modal.getByText(/port.*already/i)).toBeVisible({ timeout: 5000 });
});
