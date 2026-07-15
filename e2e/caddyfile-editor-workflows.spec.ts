/**
 * Raw Caddyfile editor tab workflows.
 *
 * The editor is a CodeMirror instance (contenteditable), not a plain textarea —
 * select-all + type is used to replace its content rather than .fill().
 */
import { test, expect, dismissAdminBanner } from './fixtures';
import { readFile, addProxy, CADDYFILE_PATH } from './helpers';

async function waitForToolbar(page: import('@playwright/test').Page) {
  await dismissAdminBanner(page);
  await page.getByRole('button', { name: /add proxy/i }).first().waitFor({ state: 'visible', timeout: 15000 });
}

async function openCaddyfileTab(page: import('@playwright/test').Page) {
  await page.getByRole('tab', { name: 'Caddyfile' }).click();
  await page.getByRole('button', { name: 'Caddyfile', exact: true }).waitFor({ state: 'visible', timeout: 10000 });
}

/** Replaces the CodeMirror editor's full content via select-all + insertText.
 *  CodeMirror's basicSetup includes auto-closing brackets, which corrupts
 *  brace-heavy Caddyfile content typed key-by-key via pressSequentially (each `{`
 *  auto-inserts a matching `}`, doubling up once the real one is typed later) —
 *  insertText dispatches a single input event instead of simulating keystrokes,
 *  bypassing that per-keystroke bracket-matching logic entirely. */
async function replaceEditorContent(page: import('@playwright/test').Page, content: string) {
  const editor = page.locator('.cm-content');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(content);
}

test('raw Caddyfile tab shows current on-disk content', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  const onDisk = await readFile(page, CADDYFILE_PATH);
  expect(onDisk).toContain('import');

  await openCaddyfileTab(page);
  await expect(page.locator('.cm-content, pre')).toContainText('import');
});

test('editing and saving a valid Caddyfile updates the file and reloads successfully', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await openCaddyfileTab(page);

  await page.getByRole('button', { name: /^edit$/i }).click();
  const marker = `# e2e-marker-${Date.now()}`;
  const original = await readFile(page, CADDYFILE_PATH);
  await replaceEditorContent(page, `${original.trimEnd()}\n${marker}\n`);
  await page.getByRole('button', { name: /^save$/i }).click();

  await expect(page.getByText(/reload caddy to apply changes/i)).toBeVisible({ timeout: 10000 });
  const onDisk = await readFile(page, CADDYFILE_PATH);
  expect(onDisk).toContain(marker);

  await page.getByRole('tabpanel', { name: /caddyfile/i }).getByRole('button', { name: /reload config/i }).click();
  await expect(page.getByText(/caddy config reloaded successfully/i)).toBeVisible({ timeout: 10000 });
});

test('saving an invalid Caddyfile surfaces a validation error and does not overwrite the file', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  const originalBefore = await readFile(page, CADDYFILE_PATH);

  await openCaddyfileTab(page);
  await page.getByRole('button', { name: /^edit$/i }).click();
  await replaceEditorContent(page, 'this is not { valid caddyfile syntax {{{');
  await page.getByRole('button', { name: /^save$/i }).click();

  await expect(page.getByText(/save failed/i)).toBeVisible({ timeout: 10000 });
  const onDiskAfter = await readFile(page, CADDYFILE_PATH);
  expect(onDiskAfter).toBe(originalBefore);
});

test('saving unrelated changes does not drop an existing proxy route', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addProxy(page, { port: 19430, target: 'localhost:3000' });
  await page.reload({ waitUntil: 'networkidle' });
  await waitForToolbar(page);

  await openCaddyfileTab(page);
  await page.getByRole('button', { name: /^edit$/i }).click();
  const original = await readFile(page, CADDYFILE_PATH);
  const marker = `# e2e-marker-${Date.now()}`;
  await replaceEditorContent(page, `${original.trimEnd()}\n${marker}\n`);
  await page.getByRole('button', { name: /^save$/i }).click();
  await expect(page.getByText(/reload caddy to apply changes/i)).toBeVisible({ timeout: 10000 });
  await page.getByRole('tabpanel', { name: /caddyfile/i }).getByRole('button', { name: /reload config/i }).click();
  await expect(page.getByText(/caddy config reloaded successfully/i)).toBeVisible({ timeout: 10000 });

  await page.getByRole('tab', { name: /proxy list/i }).click();
  await expect(page.getByRole('link', { name: ':19430' })).toBeVisible({ timeout: 10000 });
});
