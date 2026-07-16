/**
 * URI Rewrite section workflows (AddProxyDialog/EditProxyDialog accordion).
 *
 * Only reachable via the reverse-proxy dialogs (not redirect/static/respond),
 * so these drive "Add Proxy" directly rather than reusing addProxy() seeding.
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

test('proxy with strip_prefix rewrite writes correct Caddyfile directive', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await page.getByRole('button', { name: /add proxy/i }).first().click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('External port').fill('19220');
  await modal.getByLabel(/target host/i).fill('localhost');
  await modal.locator('#target-port').fill('3000');
  await modal.locator('#tls').uncheck();

  await modal.getByRole('button', { name: /uri rewrite/i }).click();
  await modal.locator('#rw-type-strip_prefix').click();
  await modal.locator('#rw-prefix').fill('/api');

  await modal.getByRole('button', { name: /^add proxy$/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });

  const conf = await readConf(page);
  expect(conf).toContain(':19220');
  expect(conf).toContain('uri strip_prefix /api');
});

test('proxy with regex rewrite writes matcher and rewrite directive', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await page.getByRole('button', { name: /add proxy/i }).first().click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('External port').fill('19221');
  await modal.getByLabel(/target host/i).fill('localhost');
  await modal.locator('#target-port').fill('3000');
  await modal.locator('#tls').uncheck();

  await modal.getByRole('button', { name: /uri rewrite/i }).click();
  await modal.locator('#rw-type-regex').click();
  await modal.locator('#rw-find').fill('^/old/(.*)$');
  await modal.locator('#rw-replace').fill('/new/$1');

  await modal.getByRole('button', { name: /^add proxy$/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });

  const conf = await readConf(page);
  expect(conf).toContain('path_regexp rw ^/old/(.*)$');
  expect(conf).toContain('/new/{re.rw.1}');
});

test('URI rewrite changes the path the backend actually receives', async ({ pluginPage: page }) => {
  const targetPort = 19223;
  await spawnCmd(page, ['bash', '-c', `fuser -k ${targetPort}/tcp 2>&1; true`]);
  await spawnCmd(page, ['bash', '-c',
    `nohup python3 -m http.server ${targetPort} >/tmp/e2e-backend-${targetPort}.log 2>&1 & disown`]);

  try {
    await waitForToolbar(page);
    await page.getByRole('button', { name: /add proxy/i }).first().click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('External port').fill('19222');
    await modal.getByLabel(/target host/i).fill('localhost');
    await modal.locator('#target-port').fill(String(targetPort));
    await modal.locator('#tls').uncheck();

    await modal.getByRole('button', { name: /uri rewrite/i }).click();
    await modal.locator('#rw-type-strip_prefix').click();
    await modal.locator('#rw-prefix').fill('/api');

    await modal.getByRole('button', { name: /^add proxy$/i }).click();
    await modal.getByRole('button', { name: /^confirm$/i }).click();
    await expect(modal).not.toBeVisible({ timeout: 15000 });

    await waitForListener(page, `http://localhost:19222/api/hello`);
    await spawnCmd(page, ['bash', '-c', `curl -s -o /dev/null 'http://localhost:19222/api/hello'; true`]);

    // python's http.server logs each request line to its own log file — the backend
    // must see the path with the /api prefix already stripped by Caddy.
    const log = await spawnCmd(page, ['bash', '-c', `cat /tmp/e2e-backend-${targetPort}.log`]);
    expect(log).toContain('"GET /hello HTTP/1.1"');
    expect(log).not.toContain('/api/hello');
  } finally {
    await spawnCmd(page, ['bash', '-c', `fuser -k ${targetPort}/tcp 2>&1; true`]);
  }
});

test('clearing rewrite on edit removes the directive from the Caddyfile', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await page.getByRole('button', { name: /add proxy/i }).first().click();
  const modal1 = page.getByRole('dialog');
  await modal1.getByLabel('External port').fill('19224');
  await modal1.getByLabel(/target host/i).fill('localhost');
  await modal1.locator('#target-port').fill('3000');
  await modal1.locator('#tls').uncheck();
  await modal1.getByRole('button', { name: /uri rewrite/i }).click();
  await modal1.locator('#rw-type-strip_prefix').click();
  await modal1.locator('#rw-prefix').fill('/api');
  await modal1.getByRole('button', { name: /^add proxy$/i }).click();
  await modal1.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal1).not.toBeVisible({ timeout: 15000 });

  let conf = await readConf(page);
  expect(conf).toContain('uri strip_prefix /api');

  await proxyRow(page, 19224).getByRole('button', { name: /^edit$/i }).click();
  const modal2 = page.getByRole('dialog');
  await modal2.getByRole('button', { name: /uri rewrite/i }).click();
  await modal2.locator('#rw-type-none').click();
  await modal2.getByRole('button', { name: /save changes/i }).click();
  await modal2.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal2).not.toBeVisible({ timeout: 15000 });

  conf = await readConf(page);
  expect(conf).not.toContain('uri strip_prefix /api');
});
