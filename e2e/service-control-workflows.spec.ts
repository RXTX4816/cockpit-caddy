/**
 * Service Control (toolbar Start/Stop/Restart/Reload) workflows.
 *
 * Scoped to reload/restart only — "stop" is deliberately not exercised as its own test:
 * under this suite's workers:1 serialization, a stuck-stopped Caddy would cascade-fail
 * every later spec sharing this VM. Both actions this file does test open a real
 * confirmation dialog (unlike the Settings tab's own inline reload button, which doesn't).
 */
import { test, expect, dismissAdminBanner } from './fixtures';
import { addProxy, startHttpBackend } from './helpers';
import { waitForListener, curlStatus } from './live';

async function waitForToolbar(page: import('@playwright/test').Page) {
  await dismissAdminBanner(page);
  await page.getByRole('button', { name: /add proxy/i }).first().waitFor({ state: 'visible', timeout: 15000 });
}

test('reload button reloads without dropping existing routes', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addProxy(page, { port: 19490, target: 'localhost:3000' });
  await page.reload({ waitUntil: 'networkidle' });
  await waitForToolbar(page);
  await expect(page.getByRole('link', { name: ':19490' })).toBeVisible({ timeout: 10000 });

  await page.getByRole('button', { name: /^reload config$/i }).click();
  await expect(page.getByRole('dialog', { name: /reload caddy config/i })).toBeVisible({ timeout: 5000 });
  await page.getByRole('button', { name: /^confirm$/i }).click();
  await expect(page.getByText(/caddy config reloaded/i)).toBeVisible({ timeout: 10000 });

  await expect(page.getByRole('link', { name: ':19490' })).toBeVisible();
});

test('restart button restarts Caddy and existing routes still serve traffic after', async ({ pluginPage: page }) => {
  const backendPort = 19491;
  const backend = await startHttpBackend(page, backendPort);

  try {
    await waitForToolbar(page);
    await addProxy(page, { port: 19492, target: `localhost:${backendPort}` });
    await page.reload({ waitUntil: 'networkidle' });
    await waitForToolbar(page);
    await expect(page.getByRole('link', { name: ':19492' })).toBeVisible({ timeout: 10000 });
    await waitForListener(page, 'http://localhost:19492/');
    expect(await curlStatus(page, 'http://localhost:19492/')).toBe('200');

    await page.getByRole('button', { name: /^restart$/i }).click();
    await expect(page.getByRole('dialog', { name: /restart caddy/i })).toBeVisible({ timeout: 5000 });
    await page.getByRole('button', { name: /^confirm$/i }).click();
    await expect(page.getByText(/caddy restarted/i)).toBeVisible({ timeout: 15000 });

    await expect.poll(() => curlStatus(page, 'http://localhost:19492/'), { timeout: 15000 }).toBe('200');
  } finally {
    await backend.stop();
  }
});
