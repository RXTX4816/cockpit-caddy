/**
 * Response Headers section workflows (AddProxyDialog/EditProxyDialog accordion).
 *
 * Response headers are added by Caddy on the way back to the client, so curl -I
 * against the proxy is a direct, reliable live check (unlike request headers,
 * which need a header-echoing backend).
 */
import type { Locator } from '@playwright/test';
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

/** Route Matchers also has a header-matcher field labeled "Header name"/"Value" that
 *  stays in the DOM (just visually collapsed) when a different section is expanded —
 *  getByLabel('Header name') alone is ambiguous across the modal. Scope to the Response
 *  Headers region specifically. */
function responseHeadersSection(modal: Locator) {
  return modal.getByLabel('Response Headers (optional)');
}

async function startBackend(page: import('@playwright/test').Page, port: number): Promise<void> {
  await spawnCmd(page, ['bash', '-c', `fuser -k ${port}/tcp 2>&1; true`]);
  await spawnCmd(page, ['bash', '-c',
    `nohup python3 -m http.server ${port} >/tmp/e2e-backend-${port}.log 2>&1 & disown`]);
}

test('add response header (set) is visible in curl -I output', async ({ pluginPage: page }) => {
  const targetPort = 19261;
  await startBackend(page, targetPort);

  try {
    await waitForToolbar(page);
    await page.getByRole('button', { name: /add proxy/i }).first().click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('External port').fill('19260');
    await modal.getByLabel(/target host/i).fill('localhost');
    await modal.locator('#target-port').fill(String(targetPort));
    await modal.locator('#tls').uncheck();

    await modal.getByRole('button', { name: /response headers/i }).click();
    await responseHeadersSection(modal).getByLabel('Header name').fill('X-E2E-Response');
    await responseHeadersSection(modal).getByLabel('Value').fill('resp-value');
    await responseHeadersSection(modal).getByRole('button', { name: /^add$/i }).last().click();

    await modal.getByRole('button', { name: /^add proxy$/i }).click();
    await modal.getByRole('button', { name: /^confirm$/i }).click();
    await expect(modal).not.toBeVisible({ timeout: 15000 });

    await waitForListener(page, `http://localhost:19260/`);
    const headers = await spawnCmd(page, ['bash', '-c',
      `curl -s -o /dev/null -D - 'http://localhost:19260/'; true`]);
    expect(headers.toLowerCase()).toContain('x-e2e-response: resp-value');

    const conf = await readConf(page);
    expect(conf).toContain('header X-E2E-Response "resp-value"');
  } finally {
    await spawnCmd(page, ['bash', '-c', `fuser -k ${targetPort}/tcp 2>&1; true`]);
  }
});

test('delete response header removes it from curl -I output', async ({ pluginPage: page }) => {
  const targetPort = 19263;
  await startBackend(page, targetPort);

  try {
    await waitForToolbar(page);
    await page.getByRole('button', { name: /add proxy/i }).first().click();
    const modal1 = page.getByRole('dialog');
    await modal1.getByLabel('External port').fill('19262');
    await modal1.getByLabel(/target host/i).fill('localhost');
    await modal1.locator('#target-port').fill(String(targetPort));
    await modal1.locator('#tls').uncheck();
    await modal1.getByRole('button', { name: /response headers/i }).click();
    await modal1.locator('#resp-hdr-op-delete').click();
    await responseHeadersSection(modal1).getByLabel('Header name').fill('Server');
    await responseHeadersSection(modal1).getByRole('button', { name: /^add$/i }).last().click();
    await modal1.getByRole('button', { name: /^add proxy$/i }).click();
    await modal1.getByRole('button', { name: /^confirm$/i }).click();
    await expect(modal1).not.toBeVisible({ timeout: 15000 });

    let conf = await readConf(page);
    expect(conf).toContain('header -Server');

    await waitForListener(page, `http://localhost:19262/`);
    // The live-pushed config can lag a beat behind what's already on disk (same class of
    // race as the upstreams/LB tests) — poll rather than assert on a single request.
    await expect.poll(async () => {
      const h = await spawnCmd(page, ['bash', '-c',
        `curl -s -o /dev/null -D - 'http://localhost:19262/'; true`]);
      return h.toLowerCase();
    }, { timeout: 10000 }).not.toContain('server: simplehttp');

    await proxyRow(page, 19262).getByRole('button', { name: /^edit$/i }).click();
    const modal2 = page.getByRole('dialog');
    await modal2.getByRole('button', { name: /response headers/i }).click();
    await modal2.getByRole('button', { name: 'remove', exact: true }).click();
    await modal2.getByRole('button', { name: /save changes/i }).click();
    await modal2.getByRole('button', { name: /^confirm$/i }).click();
    await expect(modal2).not.toBeVisible({ timeout: 15000 });

    conf = await readConf(page);
    expect(conf).not.toContain('header -Server');
  } finally {
    await spawnCmd(page, ['bash', '-c', `fuser -k ${targetPort}/tcp 2>&1; true`]);
  }
});

test('response headers persist across edit dialog reopen', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await page.getByRole('button', { name: /add proxy/i }).first().click();
  const modal1 = page.getByRole('dialog');
  await modal1.getByLabel('External port').fill('19264');
  await modal1.getByLabel(/target host/i).fill('localhost');
  await modal1.locator('#target-port').fill('3000');
  await modal1.locator('#tls').uncheck();
  await modal1.getByRole('button', { name: /response headers/i }).click();
  await modal1.getByRole('button', { name: 'X-Content-Type-Options' }).click();
  await modal1.getByRole('button', { name: /^add proxy$/i }).click();
  await modal1.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal1).not.toBeVisible({ timeout: 15000 });

  await proxyRow(page, 19264).getByRole('button', { name: /^edit$/i }).click();
  const modal2 = page.getByRole('dialog');
  await modal2.getByRole('button', { name: /response headers/i }).click();
  await expect(modal2.getByText('X-Content-Type-Options: nosniff')).toBeVisible();
});
