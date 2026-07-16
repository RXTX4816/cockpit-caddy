/**
 * Additional Upstreams + LB Retry/Failover Tuning workflows (AddProxyDialog accordion).
 *
 * Only reachable for reverse-proxy routes (not redirect/static/respond/PHP), and only
 * meaningful with ≥2 real backends — this file is the one place in the suite that stands
 * up two live backend processes at once to prove load balancing and failover for real.
 */
import { test, expect, dismissAdminBanner } from './fixtures';
import { readConf, spawnCmd } from './helpers';
import { waitForListener } from './live';

async function waitForToolbar(page: import('@playwright/test').Page) {
  await dismissAdminBanner(page);
  await page.getByRole('button', { name: /add proxy/i }).first().waitFor({ state: 'visible', timeout: 15000 });
}

/** Starts a backend that responds with its own port number as the body — lets a test
 *  tell which of several backends actually served a given request. */
async function startTaggedBackend(page: import('@playwright/test').Page, port: number): Promise<void> {
  await spawnCmd(page, ['bash', '-c', `fuser -k ${port}/tcp 2>&1; true`]);
  const script = [
    'import http.server',
    'class H(http.server.BaseHTTPRequestHandler):',
    '    def do_GET(self):',
    '        self.send_response(200)',
    '        self.end_headers()',
    `        self.wfile.write(b"${port}")`,
    '    def log_message(self, *a): pass',
    `http.server.HTTPServer(("0.0.0.0", ${port}), H).serve_forever()`,
  ].join('\n');
  // Wrap in real bash single-quotes (not JSON.stringify) so the script's embedded
  // newlines survive — bash's double-quote parsing doesn't turn a literal `\n` into an
  // actual newline the way JSON.stringify's escaping would need it to.
  await spawnCmd(page, ['bash', '-c',
    `nohup python3 -c '${script}' >/tmp/e2e-tagged-${port}.log 2>&1 & disown`]);
}

async function stopBackend(page: import('@playwright/test').Page, port: number): Promise<void> {
  await spawnCmd(page, ['bash', '-c', `fuser -k ${port}/tcp 2>&1; true`]);
}

test('adding a second upstream writes both to the reverse_proxy Caddyfile line', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await page.getByRole('button', { name: /add proxy/i }).first().click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('External port').fill('19350');
  await modal.getByLabel(/target host/i).fill('localhost');
  await modal.locator('#target-port').fill('19351');
  await modal.locator('#tls').uncheck();

  await modal.getByRole('button', { name: /additional upstreams/i }).click();
  await modal.getByRole('button', { name: /add upstream/i }).click();
  await modal.locator('#upstream-host-0').fill('localhost');
  await modal.locator('#upstream-port-0').fill('19352');

  await modal.getByRole('button', { name: /^add proxy$/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });

  const conf = await readConf(page);
  expect(conf).toContain('reverse_proxy http://localhost:19351 http://localhost:19352');
});

test('load balancing distributes requests across both live backends', async ({ pluginPage: page }) => {
  const portA = 19353;
  const portB = 19354;
  await startTaggedBackend(page, portA);
  await startTaggedBackend(page, portB);

  try {
    await waitForToolbar(page);
    await page.getByRole('button', { name: /add proxy/i }).first().click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('External port').fill('19355');
    await modal.getByLabel(/target host/i).fill('localhost');
    await modal.locator('#target-port').fill(String(portA));
    await modal.locator('#tls').uncheck();

    await modal.getByRole('button', { name: /additional upstreams/i }).click();
    await modal.getByRole('button', { name: /add upstream/i }).click();
    await modal.locator('#upstream-host-0').fill('localhost');
    await modal.locator('#upstream-port-0').fill(String(portB));
    await modal.getByRole('button', { name: /^round robin$/i }).click();

    await modal.getByRole('button', { name: /^add proxy$/i }).click();
    await modal.getByRole('button', { name: /^confirm$/i }).click();
    await expect(modal).not.toBeVisible({ timeout: 15000 });

    await waitForListener(page, `http://localhost:19355/`);
    // waitForListener only proves *a* response came back, not that the live-pushed config
    // has finished transitioning to the final 2-upstream/round-robin state — a request
    // landing in that gap can get an empty/failed response. Poll until a real tagged body
    // shows up before starting to count distribution.
    await expect.poll(async () => {
      const body = await spawnCmd(page, ['bash', '-c', `curl -s 'http://localhost:19355/'; true`]);
      return body.trim();
    }, { timeout: 10000 }).not.toBe('');

    const bodies = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const body = await spawnCmd(page, ['bash', '-c', `curl -s 'http://localhost:19355/'; true`]);
      bodies.add(body.trim());
      // Requests fired back-to-back with no gap can all land on the same upstream in this
      // environment (verified directly against the VM) — round robin only alternates
      // reliably with a little spacing between requests.
      await new Promise(r => setTimeout(r, 300));
    }
    expect(bodies).toEqual(new Set([String(portA), String(portB)]));

    const conf = await readConf(page);
    expect(conf).toContain('lb_policy round_robin');
  } finally {
    await stopBackend(page, portA);
    await stopBackend(page, portB);
  }
});

test('failover: killing one backend still serves via the other', async ({ pluginPage: page }) => {
  const portA = 19356;
  const portB = 19357;
  await startTaggedBackend(page, portA);
  await startTaggedBackend(page, portB);

  try {
    await waitForToolbar(page);
    await page.getByRole('button', { name: /add proxy/i }).first().click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('External port').fill('19358');
    await modal.getByLabel(/target host/i).fill('localhost');
    await modal.locator('#target-port').fill(String(portA));
    await modal.locator('#tls').uncheck();

    await modal.getByRole('button', { name: /additional upstreams/i }).click();
    await modal.getByRole('button', { name: /add upstream/i }).click();
    await modal.locator('#upstream-host-0').fill('localhost');
    await modal.locator('#upstream-port-0').fill(String(portB));
    await modal.getByRole('button', { name: /^round robin$/i }).click();

    // Caddy does not retry a failed upstream within the same request unless
    // lb_try_duration is explicitly set (default is 0 = no retry loop) — without this,
    // a request routed to the now-dead backend would just 502 instead of failing over.
    await modal.getByRole('button', { name: /retry & failover tuning/i }).click();
    await modal.locator('#lbr-try-duration').fill('5s');
    await modal.locator('#lbr-try-interval').fill('100ms');

    await modal.getByRole('button', { name: /^add proxy$/i }).click();
    await modal.getByRole('button', { name: /^confirm$/i }).click();
    await expect(modal).not.toBeVisible({ timeout: 15000 });

    await waitForListener(page, `http://localhost:19358/`);
    // Let the live-pushed config finish settling to the final 2-upstream state before
    // killing a backend, same rationale as the load-balancing test above.
    await expect.poll(async () => {
      const body = await spawnCmd(page, ['bash', '-c', `curl -s 'http://localhost:19358/'; true`]);
      return body.trim();
    }, { timeout: 10000 }).not.toBe('');

    await stopBackend(page, portA);

    // A few requests may still race the now-dead backend depending on round-robin
    // position, but the retry loop must fail over to the live backend within a
    // handful of requests — the route must never go fully down.
    let sawB = false;
    for (let i = 0; i < 8; i++) {
      const body = await spawnCmd(page, ['bash', '-c', `curl -s 'http://localhost:19358/'; true`]);
      if (body.trim() === String(portB)) sawB = true;
    }
    expect(sawB).toBe(true);
  } finally {
    await stopBackend(page, portA);
    await stopBackend(page, portB);
  }
});

test('lb retry count and interval settings are written to the Caddyfile', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await page.getByRole('button', { name: /add proxy/i }).first().click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('External port').fill('19359');
  await modal.getByLabel(/target host/i).fill('localhost');
  await modal.locator('#target-port').fill('19360');
  await modal.locator('#tls').uncheck();

  await modal.getByRole('button', { name: /additional upstreams/i }).click();
  await modal.getByRole('button', { name: /add upstream/i }).click();
  await modal.locator('#upstream-host-0').fill('localhost');
  await modal.locator('#upstream-port-0').fill('19361');

  await modal.getByRole('button', { name: /retry & failover tuning/i }).click();
  await modal.locator('#lbr-retries').fill('5');
  await modal.locator('#lbr-try-duration').fill('10s');
  await modal.locator('#lbr-try-interval').fill('500ms');

  await modal.getByRole('button', { name: /^add proxy$/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });

  const conf = await readConf(page);
  expect(conf).toContain('lb_retries 5');
  expect(conf).toContain('lb_try_duration 10s');
  expect(conf).toContain('lb_try_interval 500ms');
});
