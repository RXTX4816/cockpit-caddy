/**
 * Forward Authentication section workflows (AddProxyDialog/EditProxyDialog accordion).
 *
 * forward_auth sends a subrequest to a separate auth backend before letting the real
 * request through — tests stand up a minimal auth backend that returns a fixed status,
 * proving Caddy actually honors its verdict rather than just writing the directive.
 */
import { test, expect, dismissAdminBanner } from './fixtures';
import { readConf, spawnCmd } from './helpers';
import { waitForListener, curlStatus } from './live';

async function waitForToolbar(page: import('@playwright/test').Page) {
  await dismissAdminBanner(page);
  await page.getByRole('button', { name: /add proxy/i }).first().waitFor({ state: 'visible', timeout: 15000 });
}

async function startBackend(page: import('@playwright/test').Page, port: number): Promise<void> {
  await spawnCmd(page, ['bash', '-c', `fuser -k ${port}/tcp 2>&1; true`]);
  await spawnCmd(page, ['bash', '-c',
    `nohup python3 -m http.server ${port} >/tmp/e2e-backend-${port}.log 2>&1 & disown`]);
}

/** A minimal auth backend that returns a fixed status code for every request — stands
 *  in for a real auth service so the test can force an "allow" or "deny" verdict. */
async function startAuthBackend(page: import('@playwright/test').Page, port: number, status: number): Promise<void> {
  await spawnCmd(page, ['bash', '-c', `fuser -k ${port}/tcp 2>&1; true`]);
  const script = [
    'import http.server',
    'class H(http.server.BaseHTTPRequestHandler):',
    '    def do_GET(self):',
    `        self.send_response(${status})`,
    '        self.end_headers()',
    '    def log_message(self, *a): pass',
    `http.server.HTTPServer(("0.0.0.0", ${port}), H).serve_forever()`,
  ].join('\n');
  // Wrap in real bash single-quotes (not JSON.stringify) so the script's embedded
  // newlines survive — bash's double-quote parsing doesn't turn a literal `\n` into an
  // actual newline the way JSON.stringify's escaping would need it to.
  await spawnCmd(page, ['bash', '-c',
    `nohup python3 -c '${script}' >/tmp/e2e-auth-${port}.log 2>&1 & disown`]);
}

async function stopBackend(page: import('@playwright/test').Page, port: number): Promise<void> {
  await spawnCmd(page, ['bash', '-c', `fuser -k ${port}/tcp 2>&1; true`]);
}

test('configuring forward_auth writes the correct Caddyfile directive', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await page.getByRole('button', { name: /add proxy/i }).first().click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('External port').fill('19370');
  await modal.getByLabel(/target host/i).fill('localhost');
  await modal.locator('#target-port').fill('19371');
  await modal.locator('#tls').uncheck();

  await modal.getByRole('button', { name: /forward authentication/i }).click();
  await modal.getByRole('button', { name: /enable forward authentication/i }).click();
  await modal.locator('#fa-url').fill('http://localhost:19372');
  await modal.locator('#fa-uri').fill('/verify');

  await modal.getByRole('button', { name: /^add proxy$/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });

  const conf = await readConf(page);
  expect(conf).toContain('forward_auth http://localhost:19372 {');
  expect(conf).toContain('uri /verify');
});

test('request is rejected when the forward_auth backend denies it', async ({ pluginPage: page }) => {
  const backendPort = 19374;
  const authPort = 19375;
  await startBackend(page, backendPort);
  await startAuthBackend(page, authPort, 401);

  try {
    await waitForToolbar(page);
    await page.getByRole('button', { name: /add proxy/i }).first().click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('External port').fill('19373');
    await modal.getByLabel(/target host/i).fill('localhost');
    await modal.locator('#target-port').fill(String(backendPort));
    await modal.locator('#tls').uncheck();

    await modal.getByRole('button', { name: /forward authentication/i }).click();
    await modal.getByRole('button', { name: /enable forward authentication/i }).click();
    await modal.locator('#fa-url').fill(`http://localhost:${authPort}`);
    await modal.locator('#fa-uri').fill('/verify');

    await modal.getByRole('button', { name: /^add proxy$/i }).click();
    await modal.getByRole('button', { name: /^confirm$/i }).click();
    await expect(modal).not.toBeVisible({ timeout: 15000 });

    await waitForListener(page, `http://localhost:19373/`);
    // The proxy port coming up doesn't guarantee the auth backend has finished binding
    // yet — a request landing in that gap gets a transient 502 (connection refused to
    // the auth subrequest), not the real verdict. Poll past that startup race.
    await expect.poll(() => curlStatus(page, 'http://localhost:19373/'), { timeout: 10000 }).toBe('401');
  } finally {
    await stopBackend(page, backendPort);
    await stopBackend(page, authPort);
  }
});

test('request passes through to the real backend when forward_auth approves it', async ({ pluginPage: page }) => {
  const backendPort = 19377;
  const authPort = 19378;
  await startBackend(page, backendPort);
  await startAuthBackend(page, authPort, 200);

  try {
    await waitForToolbar(page);
    await page.getByRole('button', { name: /add proxy/i }).first().click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('External port').fill('19376');
    await modal.getByLabel(/target host/i).fill('localhost');
    await modal.locator('#target-port').fill(String(backendPort));
    await modal.locator('#tls').uncheck();

    await modal.getByRole('button', { name: /forward authentication/i }).click();
    await modal.getByRole('button', { name: /enable forward authentication/i }).click();
    await modal.locator('#fa-url').fill(`http://localhost:${authPort}`);
    await modal.locator('#fa-uri').fill('/verify');

    await modal.getByRole('button', { name: /^add proxy$/i }).click();
    await modal.getByRole('button', { name: /^confirm$/i }).click();
    await expect(modal).not.toBeVisible({ timeout: 15000 });

    await waitForListener(page, `http://localhost:19376/`);
    await expect.poll(() => curlStatus(page, 'http://localhost:19376/'), { timeout: 10000 }).toBe('200');
  } finally {
    await stopBackend(page, backendPort);
    await stopBackend(page, authPort);
  }
});
