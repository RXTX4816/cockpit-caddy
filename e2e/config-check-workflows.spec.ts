/**
 * Config Check modal workflows — the stale-directive scanner.
 *
 * Seeds a known stale shape (an old-style `cert_issuer internal { lifetime X }` inside
 * the global options block — see scanConfigIssues in src/api/caddy.ts) directly on disk,
 * since this is a hand-edited-Caddyfile detection feature, not something the UI itself
 * would ever write. Caddy is never reloaded with the stale content in place — only the
 * Config Check modal's own text-based scan reads it, and apply-fix rewrites it to valid
 * syntax on disk before any reload happens.
 */
import { test, expect, dismissAdminBanner } from './fixtures';
import { readFile, writeFile, spawnCmd, CADDYFILE_PATH } from './helpers';

async function waitForToolbar(page: import('@playwright/test').Page) {
  await dismissAdminBanner(page);
  await page.getByRole('button', { name: /add proxy/i }).first().waitFor({ state: 'visible', timeout: 15000 });
}

const STALE_CADDYFILE = [
  '{',
  '\tadmin "unix//run/caddy/admin.socket"',
  '\tcert_issuer internal {',
  '\t\tlifetime 4320h',
  '\t}',
  '}',
  '',
  'import /etc/caddy/conf.d/*.conf',
  '',
].join('\n');

const CLEAN_CADDYFILE = [
  '{',
  '\tadmin "unix//run/caddy/admin.socket"',
  '}',
  '',
  'import /etc/caddy/conf.d/*.conf',
  '',
].join('\n');

/** resetConfig() (run automatically before every test) only strips a specific managed
 *  marker section — it doesn't know about a fully custom main Caddyfile written directly
 *  by these tests, so each test that seeds STALE_CADDYFILE must restore a clean one
 *  afterward or it leaks into every later test in the whole suite (shared VM, workers: 1). */
async function restoreCleanCaddyfile(page: import('@playwright/test').Page) {
  await writeFile(page, CADDYFILE_PATH, CLEAN_CADDYFILE);
  await spawnCmd(page, ['caddy', 'reload', '--config', CADDYFILE_PATH]);
}

test('stale cert_issuer directive is detected by the scanner', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await writeFile(page, CADDYFILE_PATH, STALE_CADDYFILE);

  try {
    await page.getByRole('button', { name: /check config/i }).click();
    const modal = page.getByRole('dialog');
    await expect(modal.getByText(/replace the old global certificate-lifetime directive/i)).toBeVisible({ timeout: 10000 });
    await expect(modal.locator('#finding-stale-cert-issuer-directive')).toBeChecked();
  } finally {
    await restoreCleanCaddyfile(page);
  }
});

test('apply-fix flow removes the stale directive and Caddy reloads successfully', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await writeFile(page, CADDYFILE_PATH, STALE_CADDYFILE);

  try {
    await page.getByRole('button', { name: /check config/i }).click();
    const modal = page.getByRole('dialog');
    await expect(modal.getByText(/replace the old global certificate-lifetime directive/i)).toBeVisible({ timeout: 10000 });

    await modal.getByRole('button', { name: /apply \d+ selected/i }).click();
    // When the applied fix was the only finding, the modal's post-apply rescan finds zero
    // remaining issues and falls back to the plain "No issues found" state instead of the
    // "Fixes applied" + reload-button alert (ConfigCheckModal only renders that alert while
    // findings.length > 0) — a minor UX gap (no reload prompt survives), but not something
    // worth changing app behavior for here. Accept either outcome as proof the apply worked.
    await expect(modal.getByText(/fixes applied|no issues found/i)).toBeVisible({ timeout: 10000 });

    const onDiskAfterApply = await readFile(page, CADDYFILE_PATH);
    expect(onDiskAfterApply).not.toContain('cert_issuer internal {');

    const reloadButton = modal.getByRole('button', { name: /reload config/i });
    if (await reloadButton.isVisible().catch(() => false)) {
      await reloadButton.click();
      await expect(modal.getByText(/caddy config reloaded successfully/i)).toBeVisible({ timeout: 10000 });
    } else {
      await spawnCmd(page, ['caddy', 'reload', '--config', CADDYFILE_PATH]);
    }
  } finally {
    await restoreCleanCaddyfile(page);
  }
});

test('a clean config shows no issues', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await page.getByRole('button', { name: /check config/i }).click();
  const modal = page.getByRole('dialog');
  await expect(modal.getByText(/no issues found/i)).toBeVisible({ timeout: 10000 });
});
