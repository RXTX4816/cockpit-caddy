/**
 * Migrate-to-conf.d workflow (#95).
 *
 * Regression test for the exact scenario reported: migrating a Caddyfile
 * containing a bare-hostname site block (no explicit port) with a
 * reverse_proxy directive used to produce an empty conf.d file, and the
 * proxy list showed no entry for it afterward.
 */
import { test, expect, dismissAdminBanner } from './fixtures';
import { addProxy, spawnCmd, writeFile, readConf, PROXY_CONF_PATH, CONF_HEADER } from './helpers';

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

// #267: migration rebuilt the main Caddyfile from only the global block plus its own
// `conf.d/*.conf` import, dropping snippets and narrowing the distro's `conf.d/*` import.
test('migration keeps snippets and the existing conf.d import as written', async ({ pluginPage: page }) => {
  await dismissAdminBanner(page);
  const baseline = '{\n\tadmin "unix//run/caddy/admin.socket"\n}\n\nimport /etc/caddy/conf.d/*\n';
  try {
    await writeFile(
      page,
      CADDYFILE_PATH,
      '{\n\tadmin "unix//run/caddy/admin.socket"\n}\n\n(common) {\n\theader X-Common yes\n}\n\n:19514 {\n\timport common\n\trespond "migrated"\n}\n\n# Import additional caddy config files in /etc/caddy/conf.d/\nimport /etc/caddy/conf.d/*\n',
    );
    await reloadCaddy(page);
    await page.reload({ waitUntil: 'networkidle' });
    await dismissAdminBanner(page);

    await page.getByRole('button', { name: /^migrate…$/i }).click({ timeout: 15000 });
    const modal = page.getByRole('dialog', { name: /migrate caddyfile\?/i });
    await modal.getByRole('button', { name: /^migrate$/i }).click();
    await expect(modal).not.toBeVisible({ timeout: 15000 });

    const main = await spawnCmd(page, ['cat', CADDYFILE_PATH]);
    expect(main).toContain('(common) {\n\theader X-Common yes\n}');
    expect(main).toContain('import /etc/caddy/conf.d/*\n');
    expect(main).not.toContain('conf.d/*.conf');
    expect(main).not.toContain(':19514');
    expect(await readConf(page)).toContain(':19514 {');

    // The migrated site still gets the snippet's header, so the reload found it.
    const headers = await spawnCmd(page, ['bash', '-c', "curl -s -D - -o /dev/null 'http://localhost:19514/'; true"]);
    expect(headers.toLowerCase()).toContain('x-common: yes');
    await expect(page.getByRole('button', { name: /^migrate…$/i })).not.toBeVisible();
  } finally {
    // conf.d now holds a site that imports the snippet, so reset both files before reloading.
    await writeFile(page, PROXY_CONF_PATH, `${CONF_HEADER}\n`);
    await writeFile(page, CADDYFILE_PATH, baseline);
    await reloadCaddy(page);
  }
});

// #256: the distro's own Caddyfile is no migration case. No warning, no gate; the first
// save moves the welcome site into conf.d as "Distro welcome page", and it keeps serving.
test('a stock distro Caddyfile has no migration gate and moves the welcome site on the first save', async ({ pluginPage: page }) => {
  await dismissAdminBanner(page);
  const baseline = '{\n\tadmin "unix//run/caddy/admin.socket"\n}\n\nimport /etc/caddy/conf.d/*\n';
  // The Arch package's Caddyfile, as shipped (comments shortened).
  const stock = '# The Caddyfile is an easy way to configure your Caddy web server.\n#\n# https://caddyserver.com/docs/caddyfile\n{\n\t# Restrict the admin interface to a local unix file socket.\n\tadmin "unix//run/caddy/admin.socket"\n}\n\nhttp:// {\n\t# Set this path to your site\'s directory.\n\troot * /usr/share/caddy\n\n\t# Enable the static file server.\n\tfile_server\n\n\t# Another common task is to set up a reverse proxy:\n\t# reverse_proxy localhost:8080\n}\n\n# Import additional caddy config files in /etc/caddy/conf.d/\nimport /etc/caddy/conf.d/*\n';
  try {
    await writeFile(page, CADDYFILE_PATH, stock);
    await reloadCaddy(page);
    await page.reload({ waitUntil: 'networkidle' });
    await dismissAdminBanner(page);

    await page.getByRole('button', { name: /add proxy/i }).first().waitFor({ state: 'visible', timeout: 15000 });
    await expect(page.getByText('Migrate Caddyfile to conf.d')).not.toBeVisible();

    await page.getByRole('button', { name: /add proxy/i }).first().click();
    const modal = page.getByRole('dialog');
    await expect(modal.getByLabel('External port')).toBeVisible();
    await modal.getByLabel('External port').fill('19516');
    await modal.getByLabel(/target host/i).fill('localhost');
    await modal.locator('#target-port').fill('19517');
    await modal.getByRole('button', { name: /add proxy/i }).click();
    await modal.getByRole('button', { name: /^confirm$/i }).click();
    await expect(modal).not.toBeVisible({ timeout: 15000 });

    const main = await spawnCmd(page, ['cat', CADDYFILE_PATH]);
    expect(main).not.toContain('root * /usr/share/caddy');
    expect(main).toContain('import /etc/caddy/conf.d/*\n');
    const conf = await readConf(page);
    expect(conf).toContain('# label: Distro welcome page\nhttp:// {');
    expect(conf).toContain(':19516');

    await expect(page.getByRole('link', { name: ':19516' })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Distro welcome page')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Migrate Caddyfile to conf.d')).not.toBeVisible();

    const body = await spawnCmd(page, ['bash', '-c', "curl -s 'http://localhost/'; true"]);
    expect(body).toContain('Caddy');
  } finally {
    await writeFile(page, PROXY_CONF_PATH, `${CONF_HEADER}\n`);
    await writeFile(page, CADDYFILE_PATH, baseline);
    await reloadCaddy(page);
  }
});

test('a Caddyfile with a user site keeps the shortened warning with details', async ({ pluginPage: page }) => {
  await dismissAdminBanner(page);
  const baseline = '{\n\tadmin "unix//run/caddy/admin.socket"\n}\n\nimport /etc/caddy/conf.d/*\n';
  try {
    await writeFile(page, CADDYFILE_PATH, '{\n\tadmin "unix//run/caddy/admin.socket"\n}\n\n:19518 {\n\trespond "mine"\n}\n\nimport /etc/caddy/conf.d/*\n');
    await reloadCaddy(page);
    await page.reload({ waitUntil: 'networkidle' });
    await dismissAdminBanner(page);

    await expect(page.getByText('Migrate Caddyfile to conf.d')).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("The sites in your Caddyfile will move to the plugin's conf.d file so it can manage them.")).toBeVisible();
    await expect(page.getByText(/Caddyfile\.bak/)).not.toBeVisible();
    await page.getByRole('button', { name: 'Details' }).click();
    await expect(page.getByText(/Caddyfile\.bak/)).toBeVisible();

    await page.getByRole('button', { name: /add proxy/i }).first().click();
    await expect(page.getByRole('dialog', { name: /caddyfile migration needed/i })).toBeVisible();
  } finally {
    await writeFile(page, CADDYFILE_PATH, baseline);
    await reloadCaddy(page);
  }
});
