/**
 * Transport (upstream dial/response) and Server (read/write/idle) timeout workflows.
 *
 * Scoped to config-presence + "Caddy still accepts the reload" — actually waiting out a
 * configured timeout to observe a real connection drop would need either an expensive
 * multi-second sleep or a flaky near-zero timeout, and the timeout *logic* itself is
 * already covered by caddy.test.ts; the value this file adds is proving the UI writes
 * the right Caddyfile shape and Caddy doesn't reject it.
 */
import { test, expect, dismissAdminBanner } from './fixtures';
import { readConf, readFile, CADDYFILE_PATH } from './helpers';
import { expectCaddyActive } from './live';

async function waitForToolbar(page: import('@playwright/test').Page) {
  await dismissAdminBanner(page);
  await page.getByRole('button', { name: /add proxy/i }).first().waitFor({ state: 'visible', timeout: 15000 });
}

test('custom upstream dial/response timeouts are written to the transport block', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await page.getByRole('button', { name: /add proxy/i }).first().click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('External port').fill('19410');
  await modal.getByLabel(/target host/i).fill('localhost');
  await modal.locator('#target-port').fill('3000');
  await modal.locator('#tls').uncheck();

  await modal.getByRole('button', { name: /upstream timeouts/i }).click();
  await modal.locator('#transport-dial').fill('3s');
  await modal.locator('#transport-resp').fill('7s');

  await modal.getByRole('button', { name: /^add proxy$/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });

  const conf = await readConf(page);
  expect(conf).toContain('dial_timeout 3s');
  expect(conf).toContain('response_header_timeout 7s');
  await expectCaddyActive(page);
});

test('server-level timeouts round-trip through edit and persist in the Caddyfile', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await page.getByRole('button', { name: /add proxy/i }).first().click();
  const modal1 = page.getByRole('dialog');
  await modal1.getByLabel('External port').fill('19411');
  await modal1.getByLabel(/target host/i).fill('localhost');
  await modal1.locator('#target-port').fill('3000');
  await modal1.locator('#tls').uncheck();

  await modal1.getByRole('button', { name: /server timeouts/i }).click();
  await modal1.locator('#st-read').fill('5s');
  await modal1.locator('#st-write').fill('10s');
  await modal1.locator('#st-idle').fill('2m');

  await modal1.getByRole('button', { name: /^add proxy$/i }).click();
  await modal1.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal1).not.toBeVisible({ timeout: 15000 });

  const mainConf = await readFile(page, CADDYFILE_PATH);
  const block = mainConf.match(/servers :19411 \{[\s\S]*?\n\t\}/);
  expect(block, 'expected a per-port servers :19411 block in the managed Caddyfile section').toBeTruthy();
  expect(block![0]).toContain('timeouts {');
  expect(block![0]).toContain('read_body 5s');
  expect(block![0]).toContain('write 10s');
  expect(block![0]).toContain('idle 2m');
  await expectCaddyActive(page);
});
