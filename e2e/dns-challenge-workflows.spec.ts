/**
 * ACME DNS challenge provider (#261) in Settings.
 *
 * The stock distro Caddy has no DNS provider module, so only the "no module" test runs on a
 * plain VM. The credentials test needs a Caddy build with caddy-dns/cloudflare as /usr/bin/caddy
 * (e.g. from https://caddyserver.com/download with that package) and skips itself otherwise.
 */
import type { Page } from '@playwright/test';
import { test, expect, dismissAdminBanner } from './fixtures';
import { readFile, writeFile, spawnCmd, CADDYFILE_PATH, PROXY_CONF_PATH } from './helpers';

const ENV_FILE = '/etc/caddy/dns.env';
const DROPIN = '/etc/systemd/system/caddy.service.d/cockpit-caddy-dns.conf';
const SECRET = 'e2e-secret-token-261';

async function openSettings(page: Page) {
  await dismissAdminBanner(page);
  await page.getByRole('tab', { name: /settings/i }).click();
  await page.getByRole('heading', { name: 'DNS challenge' }).waitFor({ state: 'visible', timeout: 10000 });
}

async function saveSettings(page: Page) {
  await page.getByRole('button', { name: /^save/i }).click();
  await page.getByRole('button', { name: /^confirm$/i }).click();
  await expect(page.getByText(/settings saved/i)).toBeVisible({ timeout: 15000 });
}

async function hasCloudflare(page: Page): Promise<boolean> {
  const out = await spawnCmd(page, ['bash', '-c', 'caddy list-modules 2>/dev/null | grep -x dns.providers.cloudflare; true']);
  return out.trim() === 'dns.providers.cloudflare';
}

test('without a DNS module, the setting explains what is needed and links the module list', async ({ pluginPage: page }) => {
  test.skip(await hasCloudflare(page), 'this Caddy has a DNS module');
  await openSettings(page);
  const hint = page.getByTestId('go-dns-no-modules');
  await expect(hint).toContainText('No DNS provider module installed');
  await expect(hint.getByRole('link')).toHaveAttribute('href', 'https://caddyserver.com/docs/modules/');
  await expect(page.locator('#go-dns-provider')).toHaveCount(0);
  await expect(page.locator('#go-dns-enabled')).toHaveCount(0);
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
