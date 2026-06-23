import { test, expect } from '@rxtx4816/cockpit-plugin-base-react/e2e';

test('Add proxy button is visible in the toolbar', async ({ pluginPage: page }) => {
  await expect(page.getByRole('button', { name: /add/i })).toBeVisible();
});

test('clicking Add opens the proxy dialog', async ({ pluginPage: page }) => {
  await page.getByRole('button', { name: /add/i }).click();
  const modal = page.getByRole('dialog');
  await expect(modal).toBeVisible();
});

test('proxy dialog contains port and target fields', async ({ pluginPage: page }) => {
  await page.getByRole('button', { name: /add/i }).click();
  const modal = page.getByRole('dialog');
  await expect(modal.getByRole('spinbutton').or(modal.getByLabel(/port/i)).first()).toBeVisible();
  await expect(modal.getByLabel(/target|host/i).first()).toBeVisible();
});

test('cancelling the dialog returns to proxy list', async ({ pluginPage: page }) => {
  await page.getByRole('button', { name: /add/i }).click();
  const modal = page.getByRole('dialog');
  await modal.getByRole('button', { name: /cancel|close/i }).first().click();
  await expect(modal).not.toBeVisible();
  await expect(page.getByRole('button', { name: /add/i })).toBeVisible();
});
