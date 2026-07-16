/**
 * HTTP Basic Auth section workflows (AddProxyDialog/EditProxyDialog accordion).
 *
 * Passwords are hashed via the real `caddy hash-password` CLI (bcrypt, non-deterministic),
 * so tests only assert the Caddyfile carries *a* bcrypt hash, not a fixed literal, and prove
 * enforcement through real curl -u round trips.
 */
import { test, expect, dismissAdminBanner } from './fixtures';
import { readConf, spawnCmd } from './helpers';
import { waitForListener, curlStatus } from './live';

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

test('add basic auth user requires credentials for the route', async ({ pluginPage: page }) => {
  const targetPort = 19281;
  await startBackend(page, targetPort);

  try {
    await waitForToolbar(page);
    await page.getByRole('button', { name: /add proxy/i }).first().click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('External port').fill('19280');
    await modal.getByLabel(/target host/i).fill('localhost');
    await modal.locator('#target-port').fill(String(targetPort));
    await modal.locator('#tls').uncheck();

    await modal.getByRole('button', { name: /http basic auth/i }).click();
    await modal.getByRole('button', { name: /add account/i }).click();
    await modal.locator('#auth-user-0').fill('alice');
    await modal.locator('#auth-pass-0').fill('s3cret-pw');

    await modal.getByRole('button', { name: /^add proxy$/i }).click();
    await modal.getByRole('button', { name: /^confirm$/i }).click();
    await expect(modal).not.toBeVisible({ timeout: 15000 });

    await waitForListener(page, `http://localhost:19280/`);
    expect(await curlStatus(page, 'http://localhost:19280/')).toBe('401');
    expect(await curlStatus(page, 'http://localhost:19280/', ['-u', 'alice:s3cret-pw'])).toBe('200');
    expect(await curlStatus(page, 'http://localhost:19280/', ['-u', 'alice:wrong-pw'])).toBe('401');
  } finally {
    await spawnCmd(page, ['bash', '-c', `fuser -k ${targetPort}/tcp 2>&1; true`]);
  }
});

test('basic auth password is stored as a bcrypt hash, not plaintext', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await page.getByRole('button', { name: /add proxy/i }).first().click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('External port').fill('19282');
  await modal.getByLabel(/target host/i).fill('localhost');
  await modal.locator('#target-port').fill('3000');
  await modal.locator('#tls').uncheck();

  await modal.getByRole('button', { name: /http basic auth/i }).click();
  await modal.getByRole('button', { name: /add account/i }).click();
  await modal.locator('#auth-user-0').fill('bob');
  await modal.locator('#auth-pass-0').fill('do-not-leak-me');

  await modal.getByRole('button', { name: /^add proxy$/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });

  const conf = await readConf(page);
  expect(conf).toContain('basic_auth {');
  expect(conf).toContain('bob $2');
  expect(conf).not.toContain('do-not-leak-me');
});

test('remove basic auth user allows unauthenticated access again', async ({ pluginPage: page }) => {
  const targetPort = 19284;
  await startBackend(page, targetPort);

  try {
    await waitForToolbar(page);
    await page.getByRole('button', { name: /add proxy/i }).first().click();
    const modal1 = page.getByRole('dialog');
    await modal1.getByLabel('External port').fill('19283');
    await modal1.getByLabel(/target host/i).fill('localhost');
    await modal1.locator('#target-port').fill(String(targetPort));
    await modal1.locator('#tls').uncheck();
    await modal1.getByRole('button', { name: /http basic auth/i }).click();
    await modal1.getByRole('button', { name: /add account/i }).click();
    await modal1.locator('#auth-user-0').fill('carol');
    await modal1.locator('#auth-pass-0').fill('pw12345');
    await modal1.getByRole('button', { name: /^add proxy$/i }).click();
    await modal1.getByRole('button', { name: /^confirm$/i }).click();
    await expect(modal1).not.toBeVisible({ timeout: 15000 });

    await waitForListener(page, `http://localhost:19283/`);
    expect(await curlStatus(page, 'http://localhost:19283/')).toBe('401');

    await proxyRow(page, 19283).getByRole('button', { name: /^edit$/i }).click();
    const modal2 = page.getByRole('dialog');
    await modal2.getByRole('button', { name: /http basic auth/i }).click();
    await modal2.getByRole('button', { name: /remove account/i }).click();
    await modal2.getByRole('button', { name: /save changes/i }).click();
    await modal2.getByRole('button', { name: /^confirm$/i }).click();
    await expect(modal2).not.toBeVisible({ timeout: 15000 });

    await expect.poll(() => curlStatus(page, 'http://localhost:19283/'), { timeout: 10000 }).toBe('200');
    const conf = await readConf(page);
    expect(conf).not.toContain('basic_auth {');
  } finally {
    await spawnCmd(page, ['bash', '-c', `fuser -k ${targetPort}/tcp 2>&1; true`]);
  }
});

test('edit password re-hashes and old password stops working', async ({ pluginPage: page }) => {
  const targetPort = 19286;
  await startBackend(page, targetPort);

  try {
    await waitForToolbar(page);
    await page.getByRole('button', { name: /add proxy/i }).first().click();
    const modal1 = page.getByRole('dialog');
    await modal1.getByLabel('External port').fill('19285');
    await modal1.getByLabel(/target host/i).fill('localhost');
    await modal1.locator('#target-port').fill(String(targetPort));
    await modal1.locator('#tls').uncheck();
    await modal1.getByRole('button', { name: /http basic auth/i }).click();
    await modal1.getByRole('button', { name: /add account/i }).click();
    await modal1.locator('#auth-user-0').fill('dave');
    await modal1.locator('#auth-pass-0').fill('old-password');
    await modal1.getByRole('button', { name: /^add proxy$/i }).click();
    await modal1.getByRole('button', { name: /^confirm$/i }).click();
    await expect(modal1).not.toBeVisible({ timeout: 15000 });

    await waitForListener(page, `http://localhost:19285/`);
    expect(await curlStatus(page, 'http://localhost:19285/', ['-u', 'dave:old-password'])).toBe('200');

    await proxyRow(page, 19285).getByRole('button', { name: /^edit$/i }).click();
    const modal2 = page.getByRole('dialog');
    await modal2.getByRole('button', { name: /http basic auth/i }).click();
    await modal2.locator('#auth-pass-0').fill('new-password');
    await modal2.getByRole('button', { name: /save changes/i }).click();
    await modal2.getByRole('button', { name: /^confirm$/i }).click();
    await expect(modal2).not.toBeVisible({ timeout: 15000 });

    await expect.poll(() => curlStatus(page, 'http://localhost:19285/', ['-u', 'dave:old-password']), { timeout: 10000 }).toBe('401');
    expect(await curlStatus(page, 'http://localhost:19285/', ['-u', 'dave:new-password'])).toBe('200');
  } finally {
    await spawnCmd(page, ['bash', '-c', `fuser -k ${targetPort}/tcp 2>&1; true`]);
  }
});
