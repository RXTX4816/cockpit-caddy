/**
 * ACME DNS challenge provider (#261) in Settings.
 *
 * The stock distro Caddy has no DNS provider module, so only the "no module" test runs on a
 * plain VM. The credentials test needs a Caddy build with caddy-dns/cloudflare as /usr/bin/caddy
 * (e.g. from https://caddyserver.com/download with that package) and skips itself otherwise.
 * The same goes for the per-site override (#289).
 */
import type { Page } from '@playwright/test';
import { test, expect, dismissAdminBanner } from './fixtures';
import {
  readFile, writeFile, spawnCmd, readConf, rowAction, CADDYFILE_PATH, PROXY_CONF_PATH,
  openSettingsTab, saveSettings as saveSettingsForm,
} from './helpers';

const ENV_FILE = '/etc/caddy/dns.env';
const DROPIN = '/etc/systemd/system/caddy.service.d/cockpit-caddy-dns.conf';
const SECRET = 'e2e-secret-token-261';

async function openSettings(page: Page) {
  await openSettingsTab(page, 'TLS & ACME');
}

async function saveSettings(page: Page) {
  await saveSettingsForm(page);
  await expect(page.getByText(/settings saved/i).first()).toBeVisible({ timeout: 15000 });
}

async function hasCloudflare(page: Page): Promise<boolean> {
  const out = await spawnCmd(page, ['bash', '-c', 'caddy list-modules 2>/dev/null | grep -x dns.providers.cloudflare; true']);
  return out.trim() === 'dns.providers.cloudflare';
}

test('without a DNS module, the setting stays usable and says what is needed (#343)', async ({ pluginPage: page }) => {
  test.skip(await hasCloudflare(page), 'this Caddy has a DNS module');
  await openSettings(page);
  // Options are never hidden: the switch and the fields are there, with a hint.
  await page.locator('#go-dns-enabled').check();
  await expect(page.locator('#go-dns-provider')).toBeVisible();
  const hint = page.getByTestId('go-dns-no-modules');
  await expect(hint).toContainText('No DNS provider module installed');
  await hint.getByRole('button').click();
  await expect(page.getByRole('dialog').getByRole('link')).toHaveAttribute('href', 'https://caddyserver.com/docs/modules/');
});

test('credentials go to the root-only env file, never into the Caddyfile', async ({ pluginPage: page }) => {
  test.skip(!(await hasCloudflare(page)), 'needs a Caddy build with caddy-dns/cloudflare');
  test.setTimeout(120000);
  const baseline = await readFile(page, CADDYFILE_PATH);
  try {
    await openSettings(page);
    await page.locator('#go-dns-enabled').check();
    await page.locator('#go-dns-provider').selectOption('cloudflare');
    await expect(page.locator('#go-dns-cred-key-0')).toHaveValue('api_token');
    await page.locator('#go-dns-cred-value-0').fill(SECRET);
    await saveSettings(page);

    const main = await readFile(page, CADDYFILE_PATH);
    expect(main).toContain('acme_dns cloudflare {');
    expect(main).toContain('api_token {env.CADDY_DNS_API_TOKEN}');
    const grep = await spawnCmd(page, ['bash', '-c', `grep -rl '${SECRET}' ${CADDYFILE_PATH} ${PROXY_CONF_PATH} /etc/caddy/conf.d; true`]);
    expect(grep.trim()).toBe('');
    expect((await spawnCmd(page, ['stat', '-c', '%a %U %G', ENV_FILE])).trim()).toBe('600 root root');
    expect(await readFile(page, DROPIN)).toContain(`EnvironmentFile=-${ENV_FILE}`);

    // The env only reaches Caddy on a restart, which the page offers.
    await page.getByTestId('dns-restart-needed').getByRole('button', { name: /restart caddy/i }).click();
    await expect(page.getByTestId('dns-restart-needed')).toHaveCount(0, { timeout: 30000 });
    const env = await spawnCmd(page, ['bash', '-c', "tr '\\0' '\\n' < /proc/$(systemctl show -p MainPID --value caddy)/environ | grep -c '^CADDY_DNS_API_TOKEN='; true"]);
    expect(env.trim()).toBe('1');

    // Read back: "set", never the value.
    await page.reload({ waitUntil: 'networkidle' });
    await openSettings(page);
    await expect(page.getByTestId('go-dns-cred-set-0')).toBeVisible();
    await expect(page.locator('#go-dns-cred-value-0')).toHaveValue('');
    await expect(page.locator('body')).not.toContainText(SECRET);

    // Turning it off removes the block, the env file and the drop-in.
    await page.locator('#go-dns-enabled').uncheck();
    await saveSettings(page);
    expect(await readFile(page, CADDYFILE_PATH)).not.toContain('acme_dns');
    const left = await spawnCmd(page, ['bash', '-c', `ls ${ENV_FILE} ${DROPIN} 2>/dev/null; true`]);
    expect(left.trim()).toBe('');
  } finally {
    await spawnCmd(page, ['bash', '-c', `rm -f ${ENV_FILE} ${DROPIN}; systemctl daemon-reload`]);
    await writeFile(page, CADDYFILE_PATH, baseline);
    await spawnCmd(page, ['systemctl', 'restart', 'caddy']);
  }
});

async function openAddProxy(page: Page, host: string, port: string) {
  await dismissAdminBanner(page);
  await page.getByRole('button', { name: /add proxy/i }).first().click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('External port').fill(port);
  await modal.getByLabel(/external host/i).fill(host);
  await modal.getByLabel(/target host/i).fill('localhost');
  await modal.locator('#target-port').fill('3000');
  return modal;
}

// #289: per site, under automatic HTTPS only.
test('a site under automatic HTTPS inherits the DNS challenge, and a wildcard gets a warning', async ({ pluginPage: page }) => {
  test.skip(await hasCloudflare(page), 'this Caddy has a DNS module');
  const modal = await openAddProxy(page, '*.dns289.example.test', '19289');
  await expect(modal.locator('#tls-dns')).toHaveCount(0); // a wildcard starts on the internal CA
  await modal.locator('#tls').selectOption('acme');
  await expect(modal.locator('#tls-dns')).toHaveValue('inherit');
  await expect(modal.locator('#tls-dns option[value="inherit"]')).toHaveText('Inherit global (none set: HTTP challenge)');
  await expect(modal.getByTestId('tls-dns-wildcard-warning')).toBeVisible();

  // An override needs a provider module; without one the hint shows and the site can't be added.
  await modal.locator('#tls-dns').selectOption('override');
  await expect(modal.getByTestId('tls-dns-no-modules')).toBeVisible();
  await modal.getByRole('button', { name: /^add proxy$/i }).click();
  await expect(modal.getByRole('button', { name: /^confirm$/i })).toHaveCount(0);

  await modal.locator('#tls').selectOption('internal');
  await expect(modal.locator('#tls-dns')).toHaveCount(0);
});

test('a per-site provider keeps its credentials in the env file under the site\'s own names', async ({ pluginPage: page }) => {
  test.skip(!(await hasCloudflare(page)), 'needs a Caddy build with caddy-dns/cloudflare');
  test.setTimeout(120000);
  const SITE_SECRET = 'e2e-site-secret-289';
  try {
    let modal = await openAddProxy(page, 'dns289.example.test', '19289');
    await expect(modal.locator('#tls')).toHaveValue('acme');
    await modal.locator('#tls-dns').selectOption('override');
    await modal.locator('#tls-dns-provider').selectOption('cloudflare');
    await modal.locator('#tls-dns-cred-value-0').fill(SITE_SECRET);
    await modal.getByRole('button', { name: /^add proxy$/i }).click();
    await modal.getByRole('button', { name: /^confirm$/i }).click();
    await expect(modal).not.toBeVisible({ timeout: 30000 });

    const conf = await readConf(page);
    const name = conf.match(/api_token \{env\.(CADDY_DNS_SITE_DNS289_EXAMPLE_TEST_[A-Z0-9]+_API_TOKEN)\}/)?.[1];
    expect(name).toBeTruthy();
    expect(conf).toContain('\t\tdns cloudflare {');
    const grep = await spawnCmd(page, ['bash', '-c', `grep -rl '${SITE_SECRET}' ${CADDYFILE_PATH} /etc/caddy/conf.d; true`]);
    expect(grep.trim()).toBe('');
    expect(await spawnCmd(page, ['bash', '-c', `grep -c '^${name}=' ${ENV_FILE}`])).toContain('1');
    // Caddy restarted before the reload, so the running process has the variable.
    const env = await spawnCmd(page, ['bash', '-c', `tr '\\0' '\\n' < /proc/$(systemctl show -p MainPID --value caddy)/environ | grep -c '^${name}='; true`]);
    expect(env.trim()).toBe('1');

    // Reopened, the override is back, with the value shown only as set.
    const row = page.locator('li').filter({ hasText: 'dns289.example.test' });
    await row.getByRole('button', { name: /^edit$/i }).click();
    modal = page.getByRole('dialog');
    await expect(modal.locator('#edit-tls-dns')).toHaveValue('override', { timeout: 10000 });
    await expect(modal.getByTestId('edit-tls-dns-cred-set-0')).toBeVisible();
    await expect(modal.locator('#edit-tls-dns-cred-value-0')).toHaveValue('');
    await modal.getByRole('button', { name: /cancel/i }).click();

    // Deleting the site takes its variables out of the env file.
    await rowAction(row, 'Delete');
    await page.getByRole('button', { name: /^delete$/i }).click();
    await expect(row).toHaveCount(0, { timeout: 15000 });
    const left = await spawnCmd(page, ['bash', '-c', `grep -c '^${name}=' ${ENV_FILE} 2>/dev/null; true`]);
    expect(left.trim()).not.toBe('1');
  } finally {
    await spawnCmd(page, ['bash', '-c', `rm -f ${ENV_FILE} ${DROPIN}; systemctl daemon-reload`]);
    await spawnCmd(page, ['systemctl', 'restart', 'caddy']);
  }
});
