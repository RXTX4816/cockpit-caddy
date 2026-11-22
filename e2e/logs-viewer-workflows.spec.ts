/**
 * Logs viewer workflows.
 *
 * The viewer polls fetchServiceLogs() (journalctl for the caddy unit) every 5s and
 * debounces its search filter by 1s — assertions need generous timeouts for both.
 */
import { test, expect, dismissAdminBanner } from './fixtures';
import { addProxy } from './helpers';

async function waitForToolbar(page: import('@playwright/test').Page) {
  await dismissAdminBanner(page);
  await page.getByRole('button', { name: /add proxy/i }).first().waitFor({ state: 'visible', timeout: 15000 });
}

test('logs viewer shows recent Caddy log lines after a config reload', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  // addProxy() writes a Caddyfile block and reloads Caddy directly — guarantees a fresh,
  // recent journal entry ("using config from file" / "adapted config to JSON") exists.
  await addProxy(page, { port: 19460, target: 'localhost:3000' });

  await page.getByRole('tab', { name: /logs/i }).click();
  await expect(page.getByText(/config/i).first()).toBeVisible({ timeout: 15000 });
});

test('log filter narrows visible entries to matching text', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addProxy(page, { port: 19461, target: 'localhost:3000' });

  await page.getByRole('tab', { name: /logs/i }).click();
  await expect(page.getByText(/config/i).first()).toBeVisible({ timeout: 15000 });

  await page.getByPlaceholder(/search logs/i).fill('this-string-will-never-appear-in-any-log-line-xyz');
  // Filtering is debounced ~1s before it actually narrows the visible lines.
  await expect(page.getByText(/no log lines match your search/i)).toBeVisible({ timeout: 5000 });
});

// #257: Caddy's JSON lines are a table by default; a row opens to the full JSON, Raw is the old view.
test('logs table shows columns, opens a row to its JSON, and switches to Raw', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addProxy(page, { port: 19462, target: 'localhost:3000' });

  await page.getByRole('tab', { name: /logs/i }).click();
  const table = page.getByRole('table', { name: 'Log entries' });
  await expect(table).toBeVisible({ timeout: 15000 });
  await expect(table.getByRole('columnheader', { name: 'Logger' })).toBeVisible();
  const row = table.getByRole('row').filter({ hasText: 'admin.api' }).first();
  await row.click();
  await expect(row).toHaveAttribute('aria-expanded', 'true');
  await expect(table.locator('pre').first()).toContainText('"logger"');

  await page.getByRole('button', { name: 'Raw' }).click();
  await expect(table).not.toBeVisible();
  await expect(page.getByText(/"logger"/).first()).toBeVisible();
});
