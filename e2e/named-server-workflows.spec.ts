/**
 * Named server workflows (#49).
 *
 * Tests server creation, route management within servers, route ordering
 * (matchers before catch-all), ID renumbering after deletion, port conflicts,
 * and server-level edit/delete.
 */
import { test, expect, dismissAdminBanner } from './fixtures';
import { addServer, addProxy, readConf } from './helpers';

async function waitForToolbar(page: import('@playwright/test').Page) {
  await dismissAdminBanner(page);
  await page.getByRole('button', { name: /add proxy/i }).first().waitFor({ state: 'visible', timeout: 15000 });
}

/**
 * Returns the server filter tablist (All / Ungrouped / named servers).
 * Scoped to the Proxy List tabpanel to avoid matching the outer app tablist.
 * PF6 v6 does not put aria-label on the <div role="tablist"> element even
 * when aria-label is passed to <Tabs>, so we scope via the parent tabpanel.
 */
function getServerTablist(page: import('@playwright/test').Page) {
  return page.getByRole('tabpanel', { name: /proxy list/i }).getByRole('tablist');
}

/**
 * Creates a named server via the UI dialog.
 * Returns after the dialog closes and the server tab is visible.
 */
async function addServerViaUI(page: import('@playwright/test').Page, name: string, port: number) {
  await page.getByRole('button', { name: /add server/i }).click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel(/display name/i).fill(name);
  await modal.getByLabel(/\+ add port/i).fill(String(port));
  await modal.getByRole('button', { name: /\+ add port/i }).click();
  await modal.getByRole('button', { name: /add server/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });
}

/**
 * Adds a route to the currently-active named server tab.
 * Assumes a server tab is selected (toolbar shows "Add Proxy" pre-scoped to that server).
 */
async function addRouteToActiveServer(
  page: import('@playwright/test').Page,
  target: { host: string; port: number },
  pathMatcher?: string,
) {
  // Two "Add Proxy" buttons when a server tab is active; first is the server panel button
  await page.getByRole('button', { name: /add proxy/i }).first().click();
  const modal = page.getByRole('dialog');
  // When a named server is active, there is no External Port field — just target
  await modal.getByLabel(/target host/i).fill(target.host);
  await modal.locator('#target-port').fill(String(target.port));
  if (pathMatcher) {
    await modal.getByText(/route matchers/i).click();
    await modal.getByLabel('Path').fill(pathMatcher);
    await modal.getByRole('button', { name: /add path/i }).click();
  }
  await modal.getByRole('button', { name: /add proxy/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });
}

// ---------------------------------------------------------------------------

test('create named server via UI — tab appears with display name and listen address', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addServerViaUI(page, 'E2E Server', 19300);

  // Server tab appears with the display name
  await expect(page.getByRole('tab', { name: /e2e server/i })).toBeVisible({ timeout: 5000 });
  // Server info card shows the listen address as a clickable link
  await page.getByRole('tab', { name: /e2e server/i }).click();
  await expect(page.getByRole('link', { name: /:19300/ })).toBeVisible({ timeout: 5000 });
});

test('route added via server tab appears in that server\'s filtered view', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addServer(page, { key: 'e2e-srv', name: 'E2E Server', ports: [':19301'] });

  // Switch to the server tab (wait for auto-refresh to pick up the written server)
  const tablist = getServerTablist(page);
  await tablist.getByRole('tab', { name: /e2e server/i }).click({ timeout: 15000 });

  // Add a route while the server tab is active
  await addRouteToActiveServer(page, { host: 'localhost', port: 3001 });

  // Route appears in the server-scoped view (ServerDetailPanel shows full scheme URL)
  await expect(page.getByText('http://localhost:3001')).toBeVisible({ timeout: 5000 });

  // Switch to "All" — the route is still visible there (included in the global view)
  await tablist.getByRole('tab', { name: /^all$/i }).click();
  await expect(page.getByText('http://localhost:3001')).toBeVisible({ timeout: 3000 });
});

test('matcher route is placed before catch-all route in Caddyfile block', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addServer(page, { key: 'e2e-srv', name: 'E2E Server', ports: [':19302'] });

  const tablist = getServerTablist(page);
  await tablist.getByRole('tab', { name: /e2e server/i }).click();

  // Add catch-all route first (no matchers)
  await addRouteToActiveServer(page, { host: 'localhost', port: 3001 });
  // Then add a route with a path matcher
  await addRouteToActiveServer(page, { host: 'localhost', port: 3002 }, '/api/*');

  const conf = await readConf(page);

  // The matcher handle (@r or handle_path) must appear before the catch-all handle
  const catchAllIdx = conf.indexOf('\n\thandle {');
  const matcherIdx = conf.search(/\thandle[_ ]@?r\d|handle_path/);
  expect(matcherIdx).toBeGreaterThanOrEqual(0);
  expect(catchAllIdx).toBeGreaterThan(matcherIdx);
});

test('deleting middle route renumbers remaining routes in conf (no ID gaps)', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addServer(page, { key: 'e2e-srv', name: 'E2E Server', ports: [':19303'] });

  const tablist = getServerTablist(page);
  await tablist.getByRole('tab', { name: /e2e server/i }).click();

  // Add 3 routes with distinct targets
  await addRouteToActiveServer(page, { host: 'localhost', port: 3001 });
  await addRouteToActiveServer(page, { host: 'localhost', port: 3002 });
  await addRouteToActiveServer(page, { host: 'localhost', port: 3003 });

  // Delete the middle route (port 3002)
  const middleRow = page.locator('li').filter({ hasText: 'localhost:3002' });
  await middleRow.getByRole('button', { name: /^delete$/i }).click();
  const confirmModal = page.getByRole('dialog');
  await confirmModal.getByRole('button', { name: /^delete$/i }).click();
  // Wait for the confirm dialog to close before checking route absence — both the
  // dialog body and the route row contain "http://localhost:3002", which triggers
  // a strict-mode violation if we query before the dialog is dismissed.
  await expect(confirmModal).not.toBeVisible({ timeout: 10000 });
  await expect(page.getByText('http://localhost:3002')).not.toBeVisible({ timeout: 5000 });

  // Remaining routes are still there
  await expect(page.getByText('http://localhost:3001')).toBeVisible();
  await expect(page.getByText('http://localhost:3003')).toBeVisible();

  // Conf should contain both remaining targets and no reference to the deleted one
  const conf = await readConf(page);
  expect(conf).toContain('localhost:3001');  // appears as http://localhost:3001
  expect(conf).toContain('localhost:3003');
  expect(conf).not.toContain('localhost:3002');

  // Exactly 2 routes remain — verify the block has exactly 2 reverse_proxy directives
  const rpMatches = conf.match(/reverse_proxy/g);
  expect(rpMatches?.length).toBe(2);
});

test('deleting last route of a named server removes the server tab', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addServer(page, { key: 'e2e-srv', name: 'E2E Server', ports: [':19304'] });

  const tablist = getServerTablist(page);
  await tablist.getByRole('tab', { name: /e2e server/i }).click();
  await addRouteToActiveServer(page, { host: 'localhost', port: 3001 });

  // Wait for the route to appear in the UI — this confirms React has re-rendered with the
  // updated proxies state (from addProxy's refresh()) so deleteProxy's closure is not stale.
  await expect(page.getByText('http://localhost:3001')).toBeVisible({ timeout: 5000 });

  // Delete the only route
  await page.getByRole('button', { name: /^delete$/i }).click();
  const confirmModal = page.getByRole('dialog');
  await confirmModal.getByRole('button', { name: /^delete$/i }).click();
  // Wait for the dialog to close (ensures deleteProxy fully completed before conf check)
  await expect(confirmModal).not.toBeVisible({ timeout: 15000 });

  // conf.d must have the server block removed — the server tab disappears once syncConf
  // (3s poll) reads the cleaned conf.d and updates servers state to [].
  const conf = await readConf(page);
  expect(conf).not.toContain('# server: e2e-srv');

  await expect(page.getByRole('tab', { name: /e2e server/i })).not.toBeVisible({ timeout: 15000 });
});

test('port conflict: cannot add standalone proxy on a named server\'s port', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addServer(page, { key: 'e2e-srv', name: 'E2E Server', ports: [':19305'] });

  // Wait for syncConf to pick up the written server before opening "Add Proxy" —
  // addProxy's conflict check reads the servers state, which is only populated after
  // the 3s auto-refresh fires.
  const srvTablist = getServerTablist(page);
  await srvTablist.getByRole('tab', { name: /e2e server/i }).waitFor({ timeout: 10000 });

  // Try to add a standalone proxy on the same port
  await page.getByRole('button', { name: /add proxy/i }).first().click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel('External port').fill('19305');
  await modal.getByLabel(/target host/i).fill('localhost');
  await modal.locator('#target-port').fill('3000');
  await modal.getByRole('button', { name: /add proxy/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();

  // PF6 v6 Alert uses aria-live="polite" not role="alert" — use text locator
  await expect(modal.getByText(/already used by/i)).toBeVisible({ timeout: 5000 });
  // Dialog stays open; after an error the footer shows Back/Confirm (confirming step)
  await expect(modal).toBeVisible();
  await modal.getByRole('button', { name: /^back$/i }).click();
  await modal.getByRole('button', { name: /cancel/i }).click();
});

test('port conflict: cannot add named server on a standalone proxy\'s port', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addProxy(page, { port: 19306, target: 'localhost:3000' });
  // Wait for the auto-refresh (3s poll) to pick up the written proxy before testing conflict
  await expect(page.getByRole('link', { name: ':19306' })).toBeVisible({ timeout: 8000 });

  // Try to create a named server using the same port
  await page.getByRole('button', { name: /add server/i }).click();
  const modal = page.getByRole('dialog');
  await modal.getByLabel(/display name/i).fill('Conflict Server');
  await modal.getByLabel(/\+ add port/i).fill('19306');
  await modal.getByRole('button', { name: /\+ add port/i }).click();
  await modal.getByRole('button', { name: /add server/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();

  // PF6 v6 Alert uses aria-live="polite" not role="alert" — use text locator
  await expect(modal.getByText(/already used by/i)).toBeVisible({ timeout: 5000 });
  // Dialog stays open; after an error the footer shows Back/Confirm (confirming step)
  await expect(modal).toBeVisible();
  await modal.getByRole('button', { name: /^back$/i }).click();
  await modal.getByRole('button', { name: /cancel/i }).click();
});

test('edit server display name updates the tab label', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addServer(page, { key: 'e2e-srv', name: 'E2E Server', ports: [':19307'] });

  // Switch to the server tab and click Edit Server
  const tablist = getServerTablist(page);
  await tablist.getByRole('tab', { name: /e2e server/i }).click();
  await page.getByRole('button', { name: /edit server/i }).click();

  const modal = page.getByRole('dialog');
  await modal.getByLabel(/display name/i).clear();
  await modal.getByLabel(/display name/i).fill('Renamed Server');
  await modal.getByRole('button', { name: /save/i }).click();
  await modal.getByRole('button', { name: /^confirm$/i }).click();
  await expect(modal).not.toBeVisible({ timeout: 15000 });

  // Tab label should now say "Renamed Server"
  await expect(page.getByRole('tab', { name: /renamed server/i })).toBeVisible({ timeout: 5000 });
  await expect(page.getByRole('tab', { name: /^e2e server$/i })).not.toBeVisible();
});

test('delete server (with routes) removes all routes and the server tab', async ({ pluginPage: page }) => {
  await waitForToolbar(page);
  await addServer(page, { key: 'e2e-srv', name: 'E2E Server', ports: [':19308'] });

  // Add a route first so the server has content
  const tablist = getServerTablist(page);
  await tablist.getByRole('tab', { name: /e2e server/i }).click();
  await addRouteToActiveServer(page, { host: 'localhost', port: 3001 });

  // Delete the server
  await page.getByRole('button', { name: /delete server/i }).click();
  const confirmModal = page.getByRole('dialog');
  await confirmModal.getByRole('button', { name: /delete server/i }).click();
  // Wait for the dialog to close before checking conf (ensures deleteServer fully completed)
  await expect(confirmModal).not.toBeVisible({ timeout: 15000 });

  await expect(page.getByRole('tab', { name: /e2e server/i })).not.toBeVisible({ timeout: 10000 });

  const conf = await readConf(page);
  expect(conf).not.toContain('# server: e2e-srv');
  expect(conf).not.toContain('localhost:3001');
});
