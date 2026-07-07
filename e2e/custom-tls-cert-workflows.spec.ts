/**
 * Custom / bring-your-own TLS certificate workflows (#152).
 *
 * These go beyond "is the field there" — they prove Caddy is actually loading and
 * serving the exact certificate the user pointed at (not silently falling back to the
 * internal CA), and that a bad path fails safely instead of leaving the proxy broken.
 */
import { test, expect, dismissAdminBanner } from './fixtures';
import { readConf, spawnCmd } from './helpers';

async function waitForToolbar(page: import('@playwright/test').Page) {
  await dismissAdminBanner(page);
  await page.getByRole('button', { name: /add proxy/i }).first().waitFor({ state: 'visible', timeout: 15000 });
}

/** Generates a self-signed cert/key pair on the VM with a distinctive CN, and returns
 *  its SHA-256 fingerprint so callers can prove which cert Caddy actually served.
 *  Must live under a path caddy.service's sandbox can actually see — its unit has
 *  `PrivateTmp=true`, so anything written to /tmp here is invisible to Caddy even
 *  though it's readable from this SSH/cockpit session; /etc/caddy is not sandboxed
 *  away (only writes outside ReadWritePaths are blocked, not reads). */
async function generateCert(page: import('@playwright/test').Page, dir: string, cn: string): Promise<string> {
  await spawnCmd(page, ['mkdir', '-p', dir]);
  await spawnCmd(page, [
    'openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', `${dir}/key.pem`, '-out', `${dir}/cert.pem`,
    '-days', '2', '-subj', `/CN=${cn}`,
  ]);
  await spawnCmd(page, ['chmod', '644', `${dir}/key.pem`, `${dir}/cert.pem`]);
  const fp = await spawnCmd(page, ['bash', '-c', `openssl x509 -in ${dir}/cert.pem -noout -fingerprint -sha256`]);
  return fp.trim();
}

test('custom certificate is actually served over TLS, not the internal CA', async ({ pluginPage: page }) => {
  const port = 19320;
  const dir = '/etc/caddy/e2e-custom-cert-320';
  const fingerprint = await generateCert(page, dir, 'custom-cert-320.example.test');

  await waitForToolbar(page);
  await page.getByRole('button', { name: /add proxy/i }).first().click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('External port').fill(String(port));
  await modal.getByLabel(/target host/i).fill('localhost');
  await modal.locator('#target-port').fill('9000');

  await modal.getByRole('button', { name: /tls policy/i }).click();
  await modal.locator('#tls-custom-cert').fill(`${dir}/cert.pem`);
  await modal.locator('#tls-custom-key').fill(`${dir}/key.pem`);

  await modal.getByRole('button', { name: /^add proxy$/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });

  const conf = await readConf(page);
  expect(conf).toContain(`tls ${dir}/cert.pem ${dir}/key.pem`);

  // The proof that matters: ask the live listener for its certificate and compare
  // fingerprints. If this were still using the internal CA, they'd differ.
  const servedFingerprint = await spawnCmd(page, ['bash', '-c',
    `echo | openssl s_client -connect localhost:${port} -servername custom-cert-320.example.test 2>/dev/null | openssl x509 -noout -fingerprint -sha256`,
  ]);
  expect(servedFingerprint.trim()).toBe(fingerprint);
});

test('a nonexistent certificate path fails validation without breaking the running config', async ({ pluginPage: page }) => {
  const port = 19321;

  await waitForToolbar(page);
  const confBefore = await readConf(page);

  await page.getByRole('button', { name: /add proxy/i }).first().click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('External port').fill(String(port));
  await modal.getByLabel(/target host/i).fill('localhost');
  await modal.locator('#target-port').fill('9000');

  await modal.getByRole('button', { name: /tls policy/i }).click();
  await modal.locator('#tls-custom-cert').fill('/etc/caddy/e2e-custom-cert-320/does-not-exist.pem');
  await modal.locator('#tls-custom-key').fill('/etc/caddy/e2e-custom-cert-320/does-not-exist.key');

  await modal.getByRole('button', { name: /^add proxy$/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();

  // Caddy's own `caddy validate` rejects a missing cert file outright — the save must
  // surface that failure instead of silently accepting a config Caddy can't actually run.
  await expect(modal.getByText(/no such file|open .*does-not-exist/i)).toBeVisible({ timeout: 15000 });

  // The previously-working config must be untouched — this proxy must NOT have been
  // written, and Caddy must still be running on whatever it was serving before.
  const confAfter = await readConf(page);
  expect(confAfter).toBe(confBefore);
  const status = await spawnCmd(page, ['systemctl', 'is-active', 'caddy']);
  expect(status.trim()).toBe('active');

  await modal.getByRole('button', { name: /^back$/i }).click().catch(() => {});
  await page.keyboard.press('Escape');
});
