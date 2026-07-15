/**
 * Custom Error Handlers section workflows (AddProxyDialog/EditProxyDialog accordion).
 *
 * When error handlers are configured, the reverse_proxy block gains an @upstream_error
 * matcher that re-raises an upstream's HTTP error status as a real Caddy error so the
 * site-level handle_errors block actually fires — see src/api/caddy.ts buildReverseProxyLines.
 */
import { test, expect, dismissAdminBanner } from './fixtures';
import { readConf, spawnCmd } from './helpers';
import { waitForListener } from './live';

async function waitForToolbar(page: import('@playwright/test').Page) {
  await dismissAdminBanner(page);
  await page.getByRole('button', { name: /add proxy/i }).first().waitFor({ state: 'visible', timeout: 15000 });
}

function proxyRow(page: import('@playwright/test').Page, port: number) {
  return page.locator('li').filter({ has: page.locator(`#proxy-${port}`) });
}

async function startBackend(page: import('@playwright/test').Page, port: number): Promise<void> {
  await spawnCmd(page, ['bash', '-c', `fuser -k ${port}/tcp 2>&1; true`]);
  await spawnCmd(page, ['bash', '-c',
    `nohup python3 -m http.server ${port} >/tmp/e2e-backend-${port}.log 2>&1 & disown`]);
}

test('custom error handler for 404 writes correct handle_errors block', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await page.getByRole('button', { name: /add proxy/i }).first().click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('External port').fill('19390');
  await modal.getByLabel(/target host/i).fill('localhost');
  await modal.locator('#target-port').fill('19391');
  await modal.locator('#tls').uncheck();

  await modal.getByRole('button', { name: /custom error handlers/i }).click();
  await modal.getByRole('button', { name: /add error handler/i }).click();
  // A freshly-added handler already defaults to matchType "specific" / codes [404] /
  // type "respond" — no toggle clicks needed, just fill the codes field explicitly.
  await modal.locator('#eh-codes-0').fill('404');
  await modal.locator('#eh-body-0').fill('Custom 404 Content');
  await modal.locator('#eh-sc-0').fill('404');

  await modal.getByRole('button', { name: /^add proxy$/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });

  const conf = await readConf(page);
  expect(conf).toContain('handle_errors 404 {');
  expect(conf).toContain('respond "Custom 404 Content" 404');
});

test('custom error handler actually renders for a real 404 response', async ({ pluginPage: page }) => {
  const targetPort = 19393;
  await startBackend(page, targetPort);

  try {
    await waitForToolbar(page);
    await page.getByRole('button', { name: /add proxy/i }).first().click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('External port').fill('19392');
    await modal.getByLabel(/target host/i).fill('localhost');
    await modal.locator('#target-port').fill(String(targetPort));
    await modal.locator('#tls').uncheck();

    await modal.getByRole('button', { name: /custom error handlers/i }).click();
    await modal.getByRole('button', { name: /add error handler/i }).click();
    await modal.locator('#eh-codes-0').fill('404');
    await modal.locator('#eh-body-0').fill('Custom 404 Content');
    await modal.locator('#eh-sc-0').fill('404');

    await modal.getByRole('button', { name: /^add proxy$/i }).click();
    await modal.getByRole('button', { name: /^confirm$/i }).click();
    await expect(modal).not.toBeVisible({ timeout: 15000 });

    await waitForListener(page, `http://localhost:19392/`);
    const status = await spawnCmd(page, ['bash', '-c',
      `curl -s -o /dev/null -w '%{http_code}' 'http://localhost:19392/does-not-exist'; true`]);
    expect(status.trim()).toBe('404');
    const body = await spawnCmd(page, ['bash', '-c', `curl -s 'http://localhost:19392/does-not-exist'; true`]);
    expect(body).toBe('Custom 404 Content');
  } finally {
    await spawnCmd(page, ['bash', '-c', `fuser -k ${targetPort}/tcp 2>&1; true`]);
  }
});

test('removing the error handler reverts to the default Caddy error page', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await page.getByRole('button', { name: /add proxy/i }).first().click();
  const modal1 = page.getByRole('dialog');
  await modal1.getByLabel('External port').fill('19394');
  await modal1.getByLabel(/target host/i).fill('localhost');
  await modal1.locator('#target-port').fill('19395');
  await modal1.locator('#tls').uncheck();
  await modal1.getByRole('button', { name: /custom error handlers/i }).click();
  await modal1.getByRole('button', { name: /add error handler/i }).click();
  await modal1.locator('#eh-codes-0').fill('404');
  await modal1.locator('#eh-body-0').fill('Custom 404 Content');
  await modal1.getByRole('button', { name: /^add proxy$/i }).click();
  await modal1.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal1).not.toBeVisible({ timeout: 15000 });

  let conf = await readConf(page);
  expect(conf).toContain('handle_errors 404 {');

  await proxyRow(page, 19394).getByRole('button', { name: /^edit$/i }).click();
  const modal2 = page.getByRole('dialog');
  await modal2.getByRole('button', { name: /custom error handlers/i }).click();
  await modal2.getByRole('button', { name: /remove handler/i }).click();
  await modal2.getByRole('button', { name: /save changes/i }).click();
  await modal2.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal2).not.toBeVisible({ timeout: 15000 });

  conf = await readConf(page);
  expect(conf).not.toContain('handle_errors 404 {');
});
