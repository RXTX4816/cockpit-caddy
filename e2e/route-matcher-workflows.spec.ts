/**
 * Route matcher workflows (#48).
 *
 * Tests that matchers are correctly serialized to Caddyfile syntax:
 * - Named matcher block (@m{port}) with handle wrapper for the general case
 * - handle_path for path-only matchers with the handlePath flag
 * - AND logic: multiple matcher types in one @m block
 * - Edit flows: adding and removing matchers on existing proxies
 */
import { test, expect, dismissAdminBanner } from './fixtures';
import { readConf, spawnCmd, openSection, readFile, writeFile, startHttpBackend, CADDYFILE_PATH } from './helpers';
import { waitForListener } from './live';

async function waitForToolbar(page: import('@playwright/test').Page) {
  await dismissAdminBanner(page);
  await page.getByRole('button', { name: /add proxy/i }).first().waitFor({ state: 'visible', timeout: 15000 });
}

/** Opens Add Proxy dialog with matchers section expanded, ready for matcher input. */
async function openAddProxyWithMatchers(page: import('@playwright/test').Page, port: number, target: { host: string; port: number }) {
  await page.getByRole('button', { name: /add proxy/i }).first().click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('External port').fill(String(port));
  await modal.getByLabel(/target host/i).fill(target.host);
  await modal.locator('#target-port').fill(String(target.port));
  // Expand the Route Matchers section
  await openSection(modal, 'routeMatchers');
  return modal;
}

async function submitAndConfirm(modal: import('@playwright/test').Locator) {
  await modal.getByRole('button', { name: /add proxy/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });
}

// ---------------------------------------------------------------------------

test('proxy with path matcher generates named @m block and handle wrapper', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  const modal = await openAddProxyWithMatchers(page, 19200, { host: 'localhost', port: 3000 });

  await modal.getByLabel('Path', { exact: true }).fill('/api/*');
  await modal.getByRole('button', { name: /^add path$/i }).click();
  await submitAndConfirm(modal);

  const conf = await readConf(page);
  expect(conf).toContain('@m19200');
  expect(conf).toContain('path /api/*');
  expect(conf).toContain('handle @m19200');
  // Must NOT use handle_path (handlePath is false by default)
  expect(conf).not.toContain('handle_path');
});

test('proxy with path matcher + handlePath generates handle_path block', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  const modal = await openAddProxyWithMatchers(page, 19201, { host: 'localhost', port: 3000 });

  await modal.getByLabel('Path', { exact: true }).fill('/api/*');
  await modal.getByRole('button', { name: /^add path$/i }).click();
  // handlePath checkbox only appears after a path-only matcher is added
  await modal.getByLabel(/strip matched path prefix/i).check();
  await submitAndConfirm(modal);

  const conf = await readConf(page);
  // handle_path syntax strips the prefix automatically — no @m block needed
  expect(conf).toContain('handle_path /api/*');
  expect(conf).not.toContain('@m19201');
});

test('handlePath checkbox hidden when non-path matchers are also present', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  const modal = await openAddProxyWithMatchers(page, 19202, { host: 'localhost', port: 3000 });

  // Add a path matcher first
  await modal.getByLabel('Path', { exact: true }).fill('/api/*');
  await modal.getByRole('button', { name: /^add path$/i }).click();
  // handlePath checkbox should be visible now (path-only)
  await expect(modal.getByLabel(/strip matched path prefix/i)).toBeVisible();

  // Now also add a host matcher — handlePath becomes ineligible
  await modal.getByLabel('Host', { exact: true }).fill('example.com');
  await modal.getByRole('button', { name: /^add host$/i }).click();
  // handlePath checkbox must disappear or be hidden
  await expect(modal.getByLabel(/strip matched path prefix/i)).not.toBeVisible();

  await modal.getByRole('button', { name: /cancel/i }).click();
});

test('proxy with host matcher writes host line in @m block', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  const modal = await openAddProxyWithMatchers(page, 19203, { host: 'localhost', port: 3000 });

  await modal.getByLabel('Host', { exact: true }).fill('example.com');
  await modal.getByRole('button', { name: /^add host$/i }).click();
  await submitAndConfirm(modal);

  const conf = await readConf(page);
  expect(conf).toContain('@m19203');
  expect(conf).toContain('host example.com');
  expect(conf).toContain('handle @m19203');
});

test('proxy with method matcher writes method line in @m block', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  const modal = await openAddProxyWithMatchers(page, 19204, { host: 'localhost', port: 3000 });

  // Method toggles are checkboxes/toggle buttons within the Method section
  await modal.getByRole('button', { name: 'GET', exact: true }).first().click();
  await modal.getByRole('button', { name: 'POST', exact: true }).first().click();
  await submitAndConfirm(modal);

  const conf = await readConf(page);
  expect(conf).toContain('@m19204');
  expect(conf).toMatch(/method\s+GET\s+POST|method\s+POST\s+GET/);
  expect(conf).toContain('handle @m19204');
});

test('proxy with header matcher writes header line in @m block', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  const modal = await openAddProxyWithMatchers(page, 19205, { host: 'localhost', port: 3000 });

  // Scope to the Route Matchers expanded region to avoid ambiguity with the
  // Request Headers / Response Headers sections that share the same aria-labels.
  // PF6 ExpandableSection content renders with role="region" + aria-labelledby → toggle text.
  const matchersContent = modal.getByRole('region', { name: /route matchers/i });
  await matchersContent.getByLabel('Header name', { exact: true }).fill('X-API-Key');
  await matchersContent.getByLabel(/^value.*blank.*present/i).fill('secret');
  // Two "Add" buttons exist in the region (header + query); click the enabled one
  await matchersContent.getByRole('button', { name: /^add$/i }).first().click();
  await submitAndConfirm(modal);

  const conf = await readConf(page);
  expect(conf).toContain('@m19205');
  expect(conf).toContain('header X-API-Key secret');
  expect(conf).toContain('handle @m19205');
});

test('path + host matchers both appear in a single @m block (AND logic)', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  const modal = await openAddProxyWithMatchers(page, 19206, { host: 'localhost', port: 3000 });

  await modal.getByLabel('Path', { exact: true }).fill('/api/*');
  await modal.getByRole('button', { name: /^add path$/i }).click();
  await modal.getByLabel('Host', { exact: true }).fill('api.example.com');
  await modal.getByRole('button', { name: /^add host$/i }).click();
  await submitAndConfirm(modal);

  const conf = await readConf(page);
  // Single @m block containing both conditions (AND logic)
  expect(conf).toContain('@m19206');
  expect(conf).toContain('path /api/*');
  expect(conf).toContain('host api.example.com');
  // Only one @m block for this port
  expect(conf.split('@m19206').length - 1).toBe(2); // appears in definition + handle reference
});

test('edit proxy: add path matcher to existing plain proxy regenerates block with @m wrapper', async ({ pluginPage: page }) => {
  await waitForToolbar(page);

  // Create a plain proxy first
  await page.getByRole('button', { name: /add proxy/i }).first().click();
  let modal = page.getByRole('dialog');
  await modal.getByLabel('External port').fill('19207');
  await modal.getByLabel(/target host/i).fill('localhost');
  await modal.locator('#target-port').fill('3000');
  await modal.getByRole('button', { name: /add proxy/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });

  let conf = await readConf(page);
  expect(conf).not.toContain('@m19207');

  // Edit — add a path matcher
  await page.locator('li').filter({ has: page.locator('#proxy-19207') }).getByRole('button', { name: /^edit$/i }).click();
  modal = page.getByRole('dialog');
  await openSection(modal, 'routeMatchers');
  await modal.getByLabel('Path', { exact: true }).fill('/api/*');
  await modal.getByRole('button', { name: /^add path$/i }).click();
  await modal.getByRole('button', { name: /save changes/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });

  conf = await readConf(page);
  expect(conf).toContain('@m19207');
  expect(conf).toContain('path /api/*');
  expect(conf).toContain('handle @m19207');
});

test('edit proxy: remove all matchers reverts to plain block without @m', async ({ pluginPage: page }) => {
  await waitForToolbar(page);

  // Create proxy with a path matcher
  const modal0 = await openAddProxyWithMatchers(page, 19208, { host: 'localhost', port: 3000 });
  await modal0.getByLabel('Path', { exact: true }).fill('/api/*');
  await modal0.getByRole('button', { name: /^add path$/i }).click();
  await submitAndConfirm(modal0);

  let conf = await readConf(page);
  expect(conf).toContain('@m19208');

  // Edit — remove the path matcher using the × button
  await page.locator('li').filter({ has: page.locator('#proxy-19208') }).getByRole('button', { name: /^edit$/i }).click();
  const editModal = page.getByRole('dialog');
  // Matchers section auto-expands when proxy has matchers — only click to expand if the button isn't visible yet
  const removeBtn = editModal.getByRole('button', { name: /^remove path$/i });
  const isVisible = await removeBtn.isVisible();
  if (!isVisible) {
    await openSection(editModal, 'routeMatchers');
  }
  await removeBtn.click();
  await editModal.getByRole('button', { name: /save changes/i }).click();
  await editModal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(editModal).not.toBeVisible({ timeout: 15000 });

  conf = await readConf(page);
  expect(conf).not.toContain('@m19208');
  expect(conf).not.toContain('handle @m19208');
  // Plain block still has the reverse_proxy directive (scheme prefix always included)
  expect(conf).toContain('reverse_proxy http://localhost:3000');
});

// #250: Caddy rejects `header X-Foo` (no value) and `query debug true`; the written file must
// use `header X-Foo *` and `query debug=true` so the next reload/validate still works.
test('header-presence and query matchers write a Caddyfile that caddy adapt accepts', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  const modal = await openAddProxyWithMatchers(page, 19209, { host: 'localhost', port: 3000 });

  const matchersContent = modal.getByRole('region', { name: /route matchers/i });
  await matchersContent.getByLabel('Header name', { exact: true }).fill('X-Present');
  await matchersContent.getByRole('button', { name: /^add$/i }).first().click();
  await matchersContent.getByLabel('Param', { exact: true }).fill('debug');
  await matchersContent.getByLabel('Value', { exact: true }).fill('true');
  await matchersContent.getByRole('button', { name: /^add$/i }).last().click();
  await submitAndConfirm(modal);

  const conf = await readConf(page);
  expect(conf).toContain('header X-Present *');
  expect(conf).toContain('query debug=true');
  // adapt, not validate: validate as root provisions the app and can leave root-owned log files.
  await spawnCmd(page, ['caddy', 'adapt', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile']);
});

// #287: an Exclude group becomes `not { ... }` inside the named matcher, and the CEL expression
// is written quoted; both survive a reload and reopening the dialog.
test('exclude path and expression are written, adapt, and read back in the edit dialog', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  const modal = await openAddProxyWithMatchers(page, 19210, { host: 'localhost', port: 3000 });

  const exclude = modal.getByRole('group', { name: /exclude requests that match/i });
  await exclude.getByLabel('Exclude: Path', { exact: true }).fill('/api/*');
  await exclude.getByRole('button', { name: 'Exclude: Add path' }).click();
  const expression = '{method} == "GET"';
  await modal.getByLabel('Expression (CEL)').fill(expression);
  await submitAndConfirm(modal);

  const conf = await readConf(page);
  expect(conf).toContain('@m19210 {');
  expect(conf).toMatch(/not \{\s+path \/api\/\*\s+\}/);
  expect(conf).toContain('expression "{method} == \\"GET\\""');
  expect(conf).not.toContain('handle_path');
  await spawnCmd(page, ['caddy', 'adapt', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile']);

  await page.locator('li').filter({ has: page.locator('#proxy-19210') }).getByRole('button', { name: /^edit$/i }).click();
  const editModal = page.getByRole('dialog');
  const excludeGroup = editModal.getByRole('group', { name: /exclude requests that match/i });
  if (!(await excludeGroup.isVisible())) await openSection(editModal, 'routeMatchers');
  await expect(excludeGroup.getByText('/api/*', { exact: true })).toBeVisible();
  await expect(editModal.getByLabel('Expression (CEL)')).toHaveValue(expression);
});

// #255: Caddy accepts one path in handle_path. Two strip-prefix paths are written as a named
// matcher + `uri path_regexp`, which adapts, and both reach the upstream with the prefix stripped.
test('strip prefix on two paths: the Caddyfile validates and both paths reach the upstream stripped', async ({ pluginPage: page }) => {
  const targetPort = 19231;
  await spawnCmd(page, ['bash', '-c', `fuser -k ${targetPort}/tcp 2>&1; mkdir -p /tmp/e2e-hp && echo hit > /tmp/e2e-hp/x; true`]);
  await spawnCmd(page, ['bash', '-c',
    `nohup python3 -m http.server ${targetPort} --directory /tmp/e2e-hp >/tmp/e2e-hp.log 2>&1 & disown`]);
  try {
    await waitForToolbar(page);
    await page.getByRole('button', { name: /add proxy/i }).first().click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('External port').fill('19230');
    await modal.getByLabel(/target host/i).fill('localhost');
    await modal.locator('#target-port').fill(String(targetPort));
    await modal.locator('#tls').selectOption('off');
    await openSection(modal, 'routeMatchers');
    for (const path of ['/a/*', '/bb/*']) {
      await modal.getByLabel('Path', { exact: true }).fill(path);
      await modal.getByRole('button', { name: /^add path$/i }).click();
    }
    await modal.getByLabel(/strip matched path prefix/i).check();
    await submitAndConfirm(modal);

    const conf = await readConf(page);
    expect(conf).not.toMatch(/handle_path \S+ \S+ \{/);
    expect(conf).toContain('uri path_regexp ^(?:/bb|/a)/? /');
    await spawnCmd(page, ['caddy', 'adapt', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile']);

    await spawnCmd(page, ['systemctl', 'reload', 'caddy']);
    await waitForListener(page, 'http://localhost:19230/a/x');
    for (const path of ['/a/x', '/bb/x']) {
      await expect.poll(() => spawnCmd(page, ['bash', '-c', `curl -s 'http://localhost:19230${path}'; true`]), { timeout: 10000 })
        .toBe('hit\n');
    }
  } finally {
    await spawnCmd(page, ['bash', '-c', `fuser -k ${targetPort}/tcp 2>&1; true`]);
  }
});

// #286: behind trusted proxies, client_ip matches the forwarded visitor IP; remote_ip matches
// the connection (here 127.0.0.1) and ignores the header.
test('client_ip honours trusted_proxies, remote_ip with the same range does not', async ({ pluginPage: page }) => {
  test.setTimeout(120000);
  const baseline = await readFile(page, CADDYFILE_PATH);
  const backend = await startHttpBackend(page, 19851);
  try {
    await writeFile(page, CADDYFILE_PATH, baseline.replace(
      /^\{\n/, '{\n\tservers {\n\t\ttrusted_proxies static 127.0.0.1/8 ::1\n\t}\n',
    ));
    const out = await spawnCmd(page, ['bash', '-c', `caddy reload --config ${CADDYFILE_PATH} 2>&1 || true`]);
    expect(out).not.toMatch(/Error/);
    await page.reload({ waitUntil: 'networkidle' });
    await waitForToolbar(page);

    await page.getByRole('button', { name: /add proxy/i }).first().click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('External port').fill('19850');
    await modal.getByLabel(/target host/i).fill('localhost');
    await modal.locator('#target-port').fill('19851');
    await modal.locator('#tls').selectOption('off');
    await openSection(modal, 'routeMatchers');
    await expect(modal.getByLabel('Match IP of', { exact: true })).toHaveValue('client_ip');
    await modal.getByLabel('IP address or range', { exact: true }).fill('203.0.113.0/24');
    await modal.getByRole('button', { name: /^add cidr range$/i }).click();
    await submitAndConfirm(modal);
    expect(await readConf(page)).toContain('client_ip 203.0.113.0/24');

    const fetch = (xff: string) => spawnCmd(page, ['bash', '-c', `curl -s -H 'X-Forwarded-For: ${xff}' 'http://localhost:19850/'; true`]);
    await waitForListener(page, 'http://localhost:19850/');
    await expect.poll(() => fetch('203.0.113.7'), { timeout: 10000 }).toContain('Directory listing');
    expect(await fetch('198.51.100.1')).not.toContain('Directory listing');

    // The same range as a connection-IP matcher: the forwarded header no longer counts.
    await page.locator('li').filter({ has: page.locator('#proxy-19850') }).getByRole('button', { name: /^edit$/i }).click();
    const edit = page.getByRole('dialog');
    await openSection(edit, 'routeMatchers');
    await edit.getByLabel('Match IP of', { exact: true }).selectOption('remote_ip');
    await edit.getByRole('button', { name: /save changes/i }).click();
    await edit.getByRole('button', { name: /^confirm$/i }).click();
    await expect(edit).not.toBeVisible({ timeout: 15000 });
    expect(await readConf(page)).toContain('remote_ip 203.0.113.0/24');
    await expect.poll(() => fetch('203.0.113.7'), { timeout: 10000 }).not.toContain('Directory listing');
  } finally {
    await backend.stop();
    await writeFile(page, CADDYFILE_PATH, baseline);
    await spawnCmd(page, ['caddy', 'reload', '--config', CADDYFILE_PATH]);
  }
});
