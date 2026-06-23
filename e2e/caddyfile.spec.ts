import { test, expect } from '@rxtx4816/cockpit-plugin-base-react/e2e';

test.beforeEach(async ({ pluginPage: page }) => {
  await page.getByRole('tab', { name: /caddyfile/i }).click();
});

test('CodeMirror editor is visible', async ({ pluginPage: page }) => {
  await expect(page.locator('.cm-editor')).toBeVisible({ timeout: 5000 });
});

test('Save button is present', async ({ pluginPage: page }) => {
  await expect(page.getByRole('button', { name: /save/i })).toBeVisible();
});

test('Reload button is present', async ({ pluginPage: page }) => {
  await expect(page.getByRole('button', { name: /reload/i })).toBeVisible();
});
