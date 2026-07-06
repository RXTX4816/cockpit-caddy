/**
 * Storage backend configuration workflows (#46).
 *
 * Caddy's certificate/config storage backend defaults to a fixed filesystem path with
 * no UI visibility. Verifies the Settings tab surfaces the effective path (detected
 * default or explicit override) plus disk usage/certificate count, and that saving a
 * custom root writes a valid `storage file_system { root ... }` global option Caddy
 * actually accepts on reload.
 */
import { test, expect, dismissAdminBanner } from './fixtures';
import { readFile, CADDYFILE_PATH } from './helpers';

async function openSettings(page: import('@playwright/test').Page) {
  await dismissAdminBanner(page);
  await page.getByRole('tab', { name: /settings/i }).click();
  await page.getByRole('heading', { name: 'Storage' }).waitFor({ state: 'visible', timeout: 10000 });
}

test.afterEach(async ({ page }) => {
  // Custom storage path is a global option outside the per-test conf.d/managed-servers
  // reset — clear it so it doesn't leak into later tests in the suite. The confirm step
  // here is an inline form state (not a Modal), so no dialog role to scope into.
  await openSettings(page).catch(() => {});
  // A failed confirm (e.g. the unwritable-path test) leaves the form in the disabled
  // "confirming" state — back out of it first so the field is editable again. Use a
  // short timeout: this button only exists mid-confirm, and the default click timeout
  // would otherwise stall every *other* test's cleanup waiting for it to appear.
  const back = page.getByRole('button', { name: /^back$/i });
  if (await back.isVisible({ timeout: 1000 }).catch(() => false)) await back.click();
  const root = page.locator('#go-storage-root');
  if (await root.isVisible().catch(() => false) && (await root.inputValue())) {
    await root.fill('');
    await page.getByRole('button', { name: /save/i }).click();
    await page.getByRole('button', { name: /^confirm$/i }).click().catch(() => {});
  }
});

test('Settings shows the detected default storage path with disk usage and cert count', async ({ pluginPage: page }) => {
  await openSettings(page);
  const pathRow = page.locator('dl').filter({ hasText: 'Effective path' });
  await expect(pathRow).toContainText('/var/lib/caddy');
  await expect(pathRow).toContainText('Caddy default');

  const usageRow = page.locator('dl').filter({ hasText: 'Disk usage' });
  await expect(usageRow).not.toContainText('Unknown', { timeout: 10000 });
});

test('saving a custom storage root writes a valid global option Caddy accepts', async ({ pluginPage: page }) => {
  await openSettings(page);
  // Must be nested under an allowed systemd ReadWritePaths= prefix (/var/lib/caddy) —
  // a sibling directory like /var/lib/caddy-custom is outside the sandbox and would be
  // rejected by the ReadWritePaths check below, same as the real production failure this
  // feature was built to catch.
  await page.locator('#go-storage-root').fill('/var/lib/caddy/custom-storage');
  await page.getByRole('button', { name: /save/i }).click();
  // The confirm step is an inline form state (not a Modal) — no dialog role involved.
  await page.getByRole('button', { name: /^confirm$/i }).click();
  // A Caddyfile validation failure would keep the confirm alert/error visible instead of
  // succeeding — this is the regression check for a malformed `storage` directive.
  await expect(page.getByText(/settings saved/i)).toBeVisible({ timeout: 10000 });

  const mainConf = await readFile(page, CADDYFILE_PATH);
  expect(mainConf).toContain('storage file_system {');
  expect(mainConf).toContain('root /var/lib/caddy/custom-storage');

  const pathRow = page.locator('dl').filter({ hasText: 'Effective path' });
  await expect(pathRow).toContainText('/var/lib/caddy/custom-storage');
  await expect(pathRow).not.toContainText('Caddy default');
});

// Regression: an unwritable/uncreatable storage path isn't caught by `caddy validate`
// (it only checks config shape, not whether the process can provision its PKI app at
// that path) — a bad path used to save successfully and only fail the next time Caddy
// actually started or reloaded, by which point it could no longer provision anything at
// all (breaking the whole service, not just one proxy), with the broken path as the only
// copy on disk. /etc/hostname is a file, not a directory, so `mkdir -p` under it always
// fails — a reliable way to simulate an uncreatable path without a real read-only mount.
test('an unwritable storage path is rejected before ever being saved', async ({ pluginPage: page }) => {
  await openSettings(page);
  await page.locator('#go-storage-root').fill('/etc/hostname/impossible');
  await page.getByRole('button', { name: /save/i }).click();
  await page.getByRole('button', { name: /^confirm$/i }).click();

  await expect(page.getByText(/isn't writable by caddy/i)).toBeVisible({ timeout: 10000 });

  const mainConf = await readFile(page, CADDYFILE_PATH);
  expect(mainConf).not.toContain('storage');
});

// Regression: caddy.service is systemd-sandboxed (ProtectSystem=strict + ReadWritePaths=
// /var/lib/caddy /var/log/caddy /run/caddy on this VM, matching real Debian/systemd
// deployments), which makes the rest of the filesystem read-only to the *actual* caddy
// process no matter what Unix permissions say. A plain mkdir/touch probe running as root
// via cockpit.spawn is not confined by that sandbox and would report success for a path
// like /var/lib/caddy2 — a sibling of the allowed directory, not nested under it — even
// though Caddy itself can never write there. This is exactly the failure a real user hit
// in production (cert provisioning failed with "permission denied" only after the config
// had already been saved and Caddy reloaded), so it must be caught here before saving.
test('a path outside the systemd sandbox ReadWritePaths is rejected even though root can create it', async ({ pluginPage: page }) => {
  await openSettings(page);
  await page.locator('#go-storage-root').fill('/var/lib/caddy2');
  await page.getByRole('button', { name: /save/i }).click();
  await page.getByRole('button', { name: /^confirm$/i }).click();

  await expect(page.getByText(/isn't writable by caddy/i)).toBeVisible({ timeout: 10000 });
  await expect(page.getByText(/sandboxed/i)).toBeVisible();

  const mainConf = await readFile(page, CADDYFILE_PATH);
  expect(mainConf).not.toContain('storage');
});

// Regression: a *fresh* subdirectory under an allowed ReadWritePaths= prefix (e.g.
// /run/caddy/custom-storage) is created by this check's own `mkdir -p`, which runs as
// root — leaving it root-owned. The caddy service itself runs as a dedicated `caddy`
// user/group, which then has no write access to that root-owned directory despite it
// being inside the sandboxed allow-list. This is the second real production failure a
// user hit ("open /run/caddy/pki/.../root.crt: permission denied" on reload, *after* the
// ReadWritePaths check above had already passed) — the fix chowns the freshly created
// directory to the service's own user/group and probes the write as that user (not
// root), so a passing check here really does mean Caddy itself can write there.
test('a fresh directory under an allowed path is usable by the caddy user, not just root', async ({ pluginPage: page }) => {
  await openSettings(page);
  await page.locator('#go-storage-root').fill('/run/caddy/custom-storage');
  await page.getByRole('button', { name: /save/i }).click();
  await page.getByRole('button', { name: /^confirm$/i }).click();
  await expect(page.getByText(/settings saved/i)).toBeVisible({ timeout: 10000 });

  const mainConf = await readFile(page, CADDYFILE_PATH);
  expect(mainConf).toContain('root /run/caddy/custom-storage');
});
