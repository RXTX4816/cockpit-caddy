/**
 * Request Headers section workflows (AddProxyDialog/EditProxyDialog accordion).
 *
 * These headers are injected by Caddy into the upstream request (header_up),
 * so the live check inspects the real backend's own request log rather than
 * curl's response — the response never carries them.
 */
import type { Locator } from '@playwright/test';
import { test, expect, dismissAdminBanner } from './fixtures';
import { readConf, spawnCmd } from './helpers';
import { waitForListener } from './live';

async function waitForToolbar(page: import('@playwright/test').Page) {
  await dismissAdminBanner(page);
  await page.getByRole('button', { name: /add proxy/i }).first().waitFor({ state: 'visible', timeout: 15000 });
}

function proxyRow(page: import('@playwright/test').Page, port: number) {
  return page.locator('li').filter({ has: page.locator(`#proxy-${port}`) });
}

/** Route Matchers also has a header-matcher field labeled "Header name"/"Value" that
 *  stays in the DOM (just visually collapsed) when this accordion section is the one
 *  expanded — getByLabel('Header name') alone is ambiguous across the modal. Scope to
 *  the Request Headers region specifically, matching how PatternFly exposes the
 *  ExpandableSection's toggle text as the region's accessible name. */
function requestHeadersSection(modal: Locator) {
  return modal.getByLabel('Request Headers (optional)');
}

test('add request header preset writes correct Caddyfile directive', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await page.getByRole('button', { name: /add proxy/i }).first().click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('External port').fill('19240');
  await modal.getByLabel(/target host/i).fill('localhost');
  await modal.locator('#target-port').fill('3000');
  await modal.locator('#tls').uncheck();

  await modal.getByRole('button', { name: /request headers/i }).click();
  await modal.getByRole('button', { name: 'X-Forwarded-Proto' }).click();

  await modal.getByRole('button', { name: /^add proxy$/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });

  const conf = await readConf(page);
  expect(conf).toContain('header_up X-Forwarded-Proto {scheme}');
});

test('custom set/add/delete header operations write correct Caddyfile directives', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await page.getByRole('button', { name: /add proxy/i }).first().click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('External port').fill('19241');
  await modal.getByLabel(/target host/i).fill('localhost');
  await modal.locator('#target-port').fill('3000');
  await modal.locator('#tls').uncheck();

  await modal.getByRole('button', { name: /request headers/i }).click();

  // set
  await requestHeadersSection(modal).getByLabel('Header name').fill('X-Custom-Set');
  await requestHeadersSection(modal).getByLabel('Value').fill('hello');
  await requestHeadersSection(modal).getByRole('button', { name: /^add$/i }).last().click();

  // add
  await modal.locator('#hdr-op-add').click();
  await requestHeadersSection(modal).getByLabel('Header name').fill('X-Custom-Add');
  await requestHeadersSection(modal).getByLabel('Value').fill('world');
  await requestHeadersSection(modal).getByRole('button', { name: /^add$/i }).last().click();

  // delete
  await modal.locator('#hdr-op-delete').click();
  await requestHeadersSection(modal).getByLabel('Header name').fill('X-Remove-Me');
  await requestHeadersSection(modal).getByRole('button', { name: /^add$/i }).last().click();

  await modal.getByRole('button', { name: /^add proxy$/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });

  const conf = await readConf(page);
  expect(conf).toContain('header_up X-Custom-Set hello');
  expect(conf).toContain('header_up +X-Custom-Add world');
  expect(conf).toContain('header_up -X-Remove-Me');
});

/** Starts a minimal backend that echoes the request headers it received back as the
 *  response body — python's plain http.server never surfaces headers, so this is the
 *  only way to prove Caddy is actually injecting header_up, not just writing the
 *  directive to disk. */
async function startHeaderEchoBackend(page: import('@playwright/test').Page, port: number): Promise<void> {
  await spawnCmd(page, ['bash', '-c', `fuser -k ${port}/tcp 2>&1; true`]);
  const script = [
    'import http.server, json',
    'class H(http.server.BaseHTTPRequestHandler):',
    '    def do_GET(self):',
    '        self.send_response(200)',
    '        self.send_header("Content-Type", "application/json")',
    '        self.end_headers()',
    '        self.wfile.write(json.dumps(dict(self.headers)).encode())',
    '    def log_message(self, *a): pass',
    `http.server.HTTPServer(("0.0.0.0", ${port}), H).serve_forever()`,
  ].join('\n');
  // Wrap in real bash single-quotes (not JSON.stringify) so the script's embedded
  // newlines survive — bash's double-quote parsing doesn't turn a literal `\n` into an
  // actual newline the way JSON.stringify's escaping would need it to.
  await spawnCmd(page, ['bash', '-c',
    `nohup python3 -c '${script}' >/tmp/e2e-echo-${port}.log 2>&1 & disown`]);
}

test('request headers actually reach the backend', async ({ pluginPage: page }) => {
  const targetPort = 19243;
  await startHeaderEchoBackend(page, targetPort);

  try {
    await waitForToolbar(page);
    await page.getByRole('button', { name: /add proxy/i }).first().click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('External port').fill('19242');
    await modal.getByLabel(/target host/i).fill('localhost');
    await modal.locator('#target-port').fill(String(targetPort));
    await modal.locator('#tls').uncheck();

    await modal.getByRole('button', { name: /request headers/i }).click();
    await requestHeadersSection(modal).getByLabel('Header name').fill('X-E2E-Marker');
    await requestHeadersSection(modal).getByLabel('Value').fill('rh-test-value');
    await requestHeadersSection(modal).getByRole('button', { name: /^add$/i }).last().click();

    await modal.getByRole('button', { name: /^add proxy$/i }).click();
    await modal.getByRole('button', { name: /^confirm$/i }).click();
    await expect(modal).not.toBeVisible({ timeout: 15000 });

    await waitForListener(page, `http://localhost:19242/`);
    // The live-pushed config can lag a beat behind what's already on disk (same class of
    // race as the upstreams/LB tests) — poll rather than assert on a single request. Look
    // up the header case-insensitively: Caddy's header_up re-canonicalizes header names
    // via Go's http.Header rules (X-E2E-Marker -> X-E2e-Marker), which HTTP headers are
    // meant to be insensitive to anyway.
    await expect.poll(async () => {
      const body = await spawnCmd(page, ['bash', '-c', `curl -s 'http://localhost:19242/'; true`]);
      try {
        const headers = JSON.parse(body) as Record<string, string>;
        const key = Object.keys(headers).find(k => k.toLowerCase() === 'x-e2e-marker');
        return key ? headers[key] : undefined;
      } catch {
        return undefined;
      }
    }, { timeout: 10000 }).toBe('rh-test-value');
  } finally {
    await spawnCmd(page, ['bash', '-c', `fuser -k ${targetPort}/tcp 2>&1; true`]);
  }
});

test('remove header operation updates the Caddyfile', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await page.getByRole('button', { name: /add proxy/i }).first().click();
  const modal1 = page.getByRole('dialog');
  await modal1.getByLabel('External port').fill('19244');
  await modal1.getByLabel(/target host/i).fill('localhost');
  await modal1.locator('#target-port').fill('3000');
  await modal1.locator('#tls').uncheck();
  await modal1.getByRole('button', { name: /request headers/i }).click();
  await requestHeadersSection(modal1).getByLabel('Header name').fill('X-To-Remove');
  await requestHeadersSection(modal1).getByLabel('Value').fill('temp');
  await requestHeadersSection(modal1).getByRole('button', { name: /^add$/i }).last().click();
  await modal1.getByRole('button', { name: /^add proxy$/i }).click();
  await modal1.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal1).not.toBeVisible({ timeout: 15000 });

  let conf = await readConf(page);
  expect(conf).toContain('header_up X-To-Remove temp');

  await proxyRow(page, 19244).getByRole('button', { name: /^edit$/i }).click();
  const modal2 = page.getByRole('dialog');
  await modal2.getByRole('button', { name: /request headers/i }).click();
  await modal2.getByRole('button', { name: 'remove', exact: true }).click();
  await modal2.getByRole('button', { name: /save changes/i }).click();
  await modal2.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal2).not.toBeVisible({ timeout: 15000 });

  conf = await readConf(page);
  expect(conf).not.toContain('header_up X-To-Remove temp');
});
