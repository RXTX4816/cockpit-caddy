/**
 * Backup / Restore dialog workflows.
 *
 * BackupDialog exposes a read-only "#bd-preview" field with the exact archive path
 * it's about to write — that's used instead of intercepting a browser download event
 * (the archive is written server-side via tar, never sent to the browser at all).
 * RestoreDialog scans a directory for caddy-config-*.tar.gz files and lists them as
 * radio options rather than using a file-upload picker.
 */
import { test, expect, dismissAdminBanner } from './fixtures';
import { readConf, addProxy, spawnCmd, resetConfig } from './helpers';

async function waitForToolbar(page: import('@playwright/test').Page) {
  await dismissAdminBanner(page);
  await page.getByRole('button', { name: /add proxy/i }).first().waitFor({ state: 'visible', timeout: 15000 });
}

const BACKUP_DIR = '/etc/caddy/e2e-backups';

test('backup produces a tar archive containing the /etc/caddy config', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addProxy(page, { port: 19540, target: 'localhost:3000' });
  await page.reload({ waitUntil: 'networkidle' });
  await waitForToolbar(page);

  await page.getByRole('button', { name: /^backup$/i }).click();
  const modal = page.getByRole('dialog');
  await modal.locator('#bd-dest-dir').fill(BACKUP_DIR);
  const archivePath = await modal.locator('#bd-preview').inputValue();
  expect(archivePath).toContain(BACKUP_DIR);
  expect(archivePath).toMatch(/caddy-config-.*\.tar\.gz$/);

  await modal.getByRole('button', { name: /create backup/i }).click();
  await expect(modal.getByText(/backup created/i)).toBeVisible({ timeout: 10000 });
  await modal.getByRole('contentinfo').getByRole('button', { name: 'Close' }).click();

  const listing = await spawnCmd(page, ['tar', '-tzf', archivePath]);
  expect(listing).toContain('caddy/conf.d/cockpit-caddy.conf');
});

test('restore from a backup tar replaces current config exactly', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addProxy(page, { port: 19541, target: 'localhost:3000' });
  await page.reload({ waitUntil: 'networkidle' });
  await waitForToolbar(page);
  const stateAConf = await readConf(page);

  // Back up state A.
  await page.getByRole('button', { name: /^backup$/i }).click();
  let modal = page.getByRole('dialog');
  await modal.locator('#bd-dest-dir').fill(BACKUP_DIR);
  const archivePath = await modal.locator('#bd-preview').inputValue();
  await modal.getByRole('button', { name: /create backup/i }).click();
  await expect(modal.getByText(/backup created/i)).toBeVisible({ timeout: 10000 });
  await modal.getByRole('contentinfo').getByRole('button', { name: 'Close' }).click();

  // Move to a different state B.
  await resetConfig(page);
  await addProxy(page, { port: 19542, target: 'localhost:3001' });
  await page.reload({ waitUntil: 'networkidle' });
  await waitForToolbar(page);
  const stateBConf = await readConf(page);
  expect(stateBConf).not.toBe(stateAConf);

  // Restore state A from the archive.
  await page.getByRole('button', { name: /^restore$/i }).click();
  modal = page.getByRole('dialog');
  await modal.locator('#rd-scan-dir').fill(BACKUP_DIR);
  await modal.getByRole('button', { name: /^scan$/i }).click();
  await modal.locator(`input[id="rd-${archivePath}"]`).waitFor({ state: 'visible', timeout: 10000 });
  await modal.locator(`input[id="rd-${archivePath}"]`).check();
  await modal.getByRole('button', { name: /^restore$/i }).click();
  await expect(modal.getByText(/restored successfully/i)).toBeVisible({ timeout: 10000 });
  await modal.getByRole('button', { name: /reload config/i }).click().catch(() => {});
  await modal.getByRole('contentinfo').getByRole('button', { name: 'Close' }).click();

  const restoredConf = await readConf(page);
  expect(restoredConf).toBe(stateAConf);
});

test('restore of a corrupt archive is rejected without touching existing config', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addProxy(page, { port: 19543, target: 'localhost:3000' });
  await page.reload({ waitUntil: 'networkidle' });
  await waitForToolbar(page);
  const before = await readConf(page);

  const badArchive = `${BACKUP_DIR}/caddy-config-corrupt.tar.gz`;
  await spawnCmd(page, ['mkdir', '-p', BACKUP_DIR]);
  await spawnCmd(page, ['bash', '-c', `echo 'not a real tar file' > '${badArchive}'`]);

  await page.getByRole('button', { name: /^restore$/i }).click();
  const modal = page.getByRole('dialog');
  await modal.locator('#rd-scan-dir').fill(BACKUP_DIR);
  await modal.getByRole('button', { name: /^scan$/i }).click();
  await modal.locator(`input[id="rd-${badArchive}"]`).waitFor({ state: 'visible', timeout: 10000 });
  await modal.locator(`input[id="rd-${badArchive}"]`).check();
  await modal.getByRole('button', { name: /^restore$/i }).click();

  await expect(modal.getByText(/restored successfully/i)).not.toBeVisible({ timeout: 5000 });
  await modal.getByRole('button', { name: /^cancel$/i }).click();

  const after = await readConf(page);
  expect(after).toBe(before);
});
