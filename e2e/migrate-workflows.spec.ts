/**
 * Migrate-to-conf.d workflow (#95).
 *
 * Regression test for the exact scenario reported: migrating a Caddyfile
 * containing a bare-hostname site block (no explicit port) with a
 * reverse_proxy directive used to produce an empty conf.d file, and the
 * proxy list showed no entry for it afterward.
 */
import { test, expect, dismissAdminBanner } from './fixtures';
import { addProxy, spawnCmd, writeFile, readConf } from './helpers';

const CADDYFILE_PATH = '/etc/caddy/Caddyfile';

/** `caddy reload` can transiently fail if fired right after a previous reload
 *  is still settling — retry a couple of times before giving up. */
async function reloadCaddy(page: import('@playwright/test').Page): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await spawnCmd(page, ['caddy', 'reload', '--config', CADDYFILE_PATH]);
      return;
    } catch (e) {
      if (attempt === 3) throw e;
      await page.waitForTimeout(1500);
    }
  }
}

test('migrating a bare-hostname site block preserves its content and shows it in the proxy list', async ({ pluginPage: page }) => {
  await dismissAdminBanner(page);

  // Seed a pre-migration Caddyfile: no conf.d import, a bare-hostname reverse_proxy block.
  // Keeps the VM's admin unix-socket directive so `caddy reload`/cockpit.spawn admin
  // calls keep working for this and subsequent tests.
  await writeFile(
    page,
    CADDYFILE_PATH,
    '{\n\tadmin "unix//run/caddy/admin.socket"\n}\n\ngit.example.com {\n\treverse_proxy localhost:4732\n}\n',
  );
  await reloadCaddy(page);
  await page.reload({ waitUntil: 'networkidle' });
  await dismissAdminBanner(page);

  // Migration banner should appear since the Caddyfile has reverse_proxy but no conf.d import.
  await page.getByRole('button', { name: /^migrate…$/i }).click({ timeout: 15000 });
  const modal = page.getByRole('dialog', { name: /migrate caddyfile\?/i });
  await modal.getByRole('button', { name: /^migrate$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });

  // The generated conf.d file must not be empty — it must contain the original block.
  const conf = await readConf(page);
  expect(conf).toContain('git.example.com {');
  expect(conf).toContain('reverse_proxy localhost:4732');

  // The proxy list must show an entry for the migrated bare-hostname site,
  // with the real hostname visible (not just a bare ":443").
  await expect(page.getByRole('link', { name: 'git.example.com:443' })).toBeVisible({ timeout: 10000 });
});

test('detects a hand-added block alongside an existing conf.d import, and migration is additive', async ({ pluginPage: page }) => {
  await dismissAdminBanner(page);

  // An existing conf.d-managed proxy is already in place.
  await addProxy(page, { port: 19510, target: 'localhost:19511' });
  await expect(page.getByRole('link', { name: ':19510' })).toBeVisible({ timeout: 10000 });
  // Give Caddy's reload a moment to fully settle before firing another one —
  // back-to-back reloads can transiently fail otherwise.
  await page.waitForTimeout(1000);

  // User hand-edits the main Caddyfile to add another site block directly,
  // even though conf.d is already imported — this must still trigger the
  // migration prompt (previously it only checked for the conf.d import's
  // absence, so this case was silently missed).
  // No `tls internal` here: a bare-port block enabling internal TLS sets a
  // catch-all automation policy that conflicts with another bare-port block's
  // default ACME policy — a real, documented Caddy limitation unrelated to
  // this test's purpose (detecting + non-destructively merging a stray block).
  await writeFile(
    page,
    CADDYFILE_PATH,
    '{\n\tadmin "unix//run/caddy/admin.socket"\n}\n\n:19512 {\n\treverse_proxy http://localhost:19513\n}\n\nimport /etc/caddy/conf.d/*.conf\n',
  );
  await reloadCaddy(page);
  await page.reload({ waitUntil: 'networkidle' });
  await dismissAdminBanner(page);

  const migrateButton = page.getByRole('button', { name: /^migrate…$/i });
  await expect(migrateButton).toBeVisible({ timeout: 15000 });
  await migrateButton.click();
  const modal = page.getByRole('dialog', { name: /migrate caddyfile\?/i });
  await modal.getByRole('button', { name: /^migrate$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });

  // Migration must be additive: the pre-existing conf.d proxy must survive,
  // alongside the newly migrated block from the Caddyfile.
  const conf = await readConf(page);
  expect(conf).toContain(':19510');
  expect(conf).toContain('localhost:19511');
  expect(conf).toContain(':19512');
  expect(conf).toContain('localhost:19513');
  await expect(page.getByRole('link', { name: ':19510' })).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole('link', { name: ':19512' })).toBeVisible({ timeout: 10000 });
});
