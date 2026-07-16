/**
 * Health Monitor (upstream probe) live-update workflow.
 *
 * Regression test for #99: the status dot must reflect upstream health
 * changes on its own polling cadence, without requiring a page reload.
 */
import { test, expect, dismissAdminBanner } from './fixtures';
import { addProxy, startHttpBackend } from './helpers';

async function waitForToolbar(page: import('@playwright/test').Page) {
  await dismissAdminBanner(page);
  await page.getByRole('button', { name: /add proxy/i }).first().waitFor({ state: 'visible', timeout: 15000 });
}

/** Finds the DataList row for a given port (scopes by the anchor element id). */
function proxyRow(page: import('@playwright/test').Page, port: number) {
  return page.locator('li').filter({ has: page.locator(`#proxy-${port}`) });
}

test('health monitor status dot updates live without page reload', async ({ pluginPage: page }) => {
  await waitForToolbar(page);

  const port = 19210;
  const targetPort = 19211;
  const backend = await startHttpBackend(page, targetPort);

  try {
    await addProxy(page, { port, target: `localhost:${targetPort}` });
    await expect(page.getByRole('link', { name: `:${port}` })).toBeVisible({ timeout: 10000 });

    // Enable Health Monitor via the toggle + confirm dialog.
    await page.getByRole('switch', { name: /health monitor/i }).click({ force: true });
    await page.getByRole('button', { name: /^enable$/i }).click();

    const dot = proxyRow(page, port).locator('span[style*="border-radius: 50%"]').first();

    // Upstream is up — dot should turn green (reachable) within a couple of polling cycles.
    await expect(dot).toHaveAttribute('style', /var\(--pf-t--global--color--status--success--default\)/, { timeout: 15000 });

    // Kill the upstream without touching the page — the dot must update on its own
    // (previously required a full reload; interval was 30s, now 5s).
    await backend.stop();

    await expect(dot).toHaveAttribute('style', /var\(--pf-t--global--color--status--danger--default\)/, { timeout: 15000 });
  } finally {
    await backend.stop();
  }
});
