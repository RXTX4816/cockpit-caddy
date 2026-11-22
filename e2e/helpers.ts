/**
 * E2E test helpers — fast test-data setup via cockpit APIs.
 *
 * All functions operate on an already-authenticated admin `pluginPage` from
 * fixtures.ts.  They bypass the UI entirely: files are written via
 * cockpit.file() and Caddy is reloaded so the Admin API reflects the new
 * state immediately.  The plugin page is then reloaded so the React tree
 * re-reads the fresh state.
 *
 * Port-range allocation (specs share one Caddy instance under `workers: 1` — pick a
 * new range here before adding a spec file so ports never collide):
 *   19100–19113 proxy-workflows            19340–19343 trusted-proxies-workflows
 *   19140–19159 redirect-workflows         19401–19402 server-detail-workflows
 *   19160–19179 static-workflows           19500–19513 acme-status/ca-modal/route-link
 *   19180–19199 respond-workflows          19700–19703 http3-workflows
 *   19200–19208 route-matcher-workflows    19800+      free
 *   19210–19211 health-monitor-workflows
 *   19300–19308 named-server/php-fastcgi/migrate
 *   19330–19331 request-body-limit-workflows
 */
import type { Locator, Page } from '@playwright/test';

export const PROXY_CONF_PATH = '/etc/caddy/conf.d/cockpit-caddy.conf';
export const CADDYFILE_PATH = '/etc/caddy/Caddyfile';
export const SNIPPETS_CONF_PATH = '/etc/caddy/conf.d/cockpit-caddy-snippets.conf';
/** Same text as CONF_HEADER in src/api/caddy.ts, so the plugin's first-load repair has nothing to rewrite. */
export const CONF_HEADER = '# Written by the Cockpit Caddy plugin. Hand edits are fine; saving a proxy in Cockpit rewrites only the block that holds it.';

// ---------------------------------------------------------------------------
// Low-level cockpit helpers (run inside the plugin page's browser context)
// ---------------------------------------------------------------------------

export function writeFile(page: Page, path: string, content: string): Promise<void> {
  return page.evaluate(
    ([p, c]) =>
      new Promise<void>((resolve, reject) =>
        (window as any).cockpit.file(p, { superuser: 'try' }).replace(c)
          .then(resolve)
          .catch(reject),
      ),
    [path, content] as [string, string],
  );
}

export function readFile(page: Page, path: string): Promise<string> {
  // Use cockpit.spawn(['cat', path]) rather than cockpit.file().read() because
  // cockpit's custom deferred doesn't always await properly inside page.evaluate.
  return page.evaluate(
    ([p]) =>
      new Promise<string>((resolve, reject) =>
        (window as any).cockpit.spawn(['cat', p], { superuser: 'try' })
          .then(resolve)
          .catch(reject),
      ),
    [path] as [string],
  );
}

/** Returns the raw content of cockpit-caddy.conf. Use this to assert Caddyfile output. */
export async function readConf(page: Page): Promise<string> {
  return (await readFile(page, PROXY_CONF_PATH)) ?? '';
}

export function spawnCmd(page: Page, args: string[]): Promise<string> {
  return page.evaluate(
    ([cmd]) =>
      new Promise<string>((resolve, reject) => {
        (window as any).cockpit.spawn(cmd, { superuser: 'try' }).then(resolve).catch(reject);
      }),
    [args] as [string[]],
  );
}

async function reloadCaddy(page: Page): Promise<void> {
  await spawnCmd(page, ['caddy', 'reload', '--config', CADDYFILE_PATH]);
}

// ---------------------------------------------------------------------------
// High-level test helpers
// ---------------------------------------------------------------------------

/**
 * Reset cockpit-caddy config to a clean slate.
 *
 * Writes empty managed files, reloads Caddy, then reloads the plugin page so
 * the React tree reflects the empty state.  Call this in a fixture or
 * beforeEach to guarantee test isolation.
 */
export async function resetConfig(page: Page): Promise<void> {
  await writeFile(page, PROXY_CONF_PATH, `${CONF_HEADER}\n`);
  // Snippets (#288) after the sites, so no site is left importing a snippet that's gone.
  await writeFile(page, SNIPPETS_CONF_PATH, '');
  // Standalone proxies' server-level timeouts/header limits/HTTP-3 opt-out (#51) live in
  // a managed section of the *main* Caddyfile (`# cockpit-caddy:begin`/`:end`), not
  // conf.d — strip any leftover section from a previous test so it doesn't leak into
  // this one (e.g. a stale `servers :PORT { protocols h1 h2 }` for a port this test
  // never touches).
  const mainConf = await readFile(page, CADDYFILE_PATH);
  const stripped = mainConf.replace(/[ \t]*# cockpit-caddy:begin[\s\S]*?# cockpit-caddy:end\n?/, '');
  if (stripped !== mainConf) await writeFile(page, CADDYFILE_PATH, stripped);
  await reloadCaddy(page);
  await page.reload({ waitUntil: 'networkidle' });
}

export interface ProxyOpts {
  port: number;
  target: string;
  label?: string;
  tls?: 'none' | 'self-signed' | 'internal' | 'acme';
  /** External hostname/subdomain (bind address) — omit to bind all interfaces on the bare port. */
  host?: string;
}

/**
 * Add a reverse-proxy entry to the managed conf.d file and reload Caddy.
 * The plugin page is reloaded so the new entry appears in the proxy list.
 */
export async function addProxy(page: Page, opts: ProxyOpts): Promise<void> {
  const tlsLine = opts.tls && opts.tls !== 'none' ? `  tls ${opts.tls}\n` : '';
  // Mirrors buildExternalAddress in src/api/caddy.ts: a bare port when hostless,
  // `http://host:port` when a host is set without TLS (so it stays HTTP, not
  // eligible for automatic HTTPS), matching what the plugin itself would write.
  const address = opts.host
    ? (opts.tls && opts.tls !== 'none' ? `${opts.host}:${opts.port}` : `http://${opts.host}:${opts.port}`)
    : `:${opts.port}`;
  const block = [
    opts.label ? `# label: ${opts.label}` : null,
    `${address} {`,
    tlsLine || null,
    `  reverse_proxy ${opts.target}`,
    `}`,
  ]
    .filter(Boolean)
    .join('\n');

  const current = (await readFile(page, PROXY_CONF_PATH)) ?? `${CONF_HEADER}\n`;
  await writeFile(page, PROXY_CONF_PATH, `${current.trimEnd()}\n\n${block}\n`);
  await reloadCaddy(page);
  // No page.reload() — let the 3-second auto-refresh in useProxies pick up the change
  // while the polkit session stays live. Tests must wait for UI state after this call.
}

export interface RedirectOpts {
  port: number;
  to: string;
  label?: string;
}

export async function addRedirect(page: Page, opts: RedirectOpts): Promise<void> {
  const block = [
    opts.label ? `# label: ${opts.label}` : null,
    `:${opts.port} {`,
    `  redir ${opts.to}`,
    `}`,
  ]
    .filter(Boolean)
    .join('\n');

  const current = (await readFile(page, PROXY_CONF_PATH)) ?? `${CONF_HEADER}\n`;
  await writeFile(page, PROXY_CONF_PATH, `${current.trimEnd()}\n\n${block}\n`);
  await reloadCaddy(page);
  await page.reload({ waitUntil: 'networkidle' });
}

export interface StaticOpts {
  port: number;
  root: string;
  label?: string;
}

export async function addStatic(page: Page, opts: StaticOpts): Promise<void> {
  const block = [
    opts.label ? `# label: ${opts.label}` : null,
    `:${opts.port} {`,
    `  root * ${opts.root}`,
    `  file_server`,
    `}`,
  ]
    .filter(Boolean)
    .join('\n');

  const current = (await readFile(page, PROXY_CONF_PATH)) ?? `${CONF_HEADER}\n`;
  await writeFile(page, PROXY_CONF_PATH, `${current.trimEnd()}\n\n${block}\n`);
  await reloadCaddy(page);
  await page.reload({ waitUntil: 'networkidle' });
}

export interface RespondOpts {
  port: number;
  status: number;
  body?: string;
  closeAfter?: boolean;
  label?: string;
}

export async function addRespond(page: Page, opts: RespondOpts): Promise<void> {
  // Mirrors buildRouteHandlerLines in src/api/caddy.ts: body (if any) comes before the
  // status code, and `close` only appears as a brace block when set.
  const respondLine = opts.body
    ? `  respond "${opts.body}" ${opts.status}`
    : `  respond ${opts.status}`;
  const block = [
    opts.label ? `# label: ${opts.label}` : null,
    `:${opts.port} {`,
    opts.closeAfter ? `${respondLine} {` : respondLine,
    opts.closeAfter ? '    close\n  }' : null,
    `}`,
  ]
    .filter(Boolean)
    .join('\n');

  const current = (await readFile(page, PROXY_CONF_PATH)) ?? `${CONF_HEADER}\n`;
  await writeFile(page, PROXY_CONF_PATH, `${current.trimEnd()}\n\n${block}\n`);
  await reloadCaddy(page);
  await page.reload({ waitUntil: 'networkidle' });
}

export interface ServerOpts {
  key: string;
  name: string;
  ports: string[];
  tls?: boolean;
}

/**
 * Add a named server with no routes yet, written the way the UI's "Add server"
 * writes it: a `# server:` / `# serverdef:` comment pair over an empty block in
 * the managed conf.d file.
 */
export async function addServer(page: Page, opts: ServerOpts): Promise<void> {
  const tls = opts.tls ?? false;
  // Same address rule as serverDefToBlock: TLS off forces http:// on every address.
  const addr = (tls ? opts.ports : opts.ports.map(p => `http://${p}`)).join(' ');
  const def = JSON.stringify({ name: opts.name, ...(tls ? { tls: true } : {}) });
  const block = [`# server: ${opts.key}`, `# serverdef: ${def}`, `${addr} {`, `}`].join('\n');

  const current = (await readFile(page, PROXY_CONF_PATH)) ?? `${CONF_HEADER}\n`;
  await writeFile(page, PROXY_CONF_PATH, `${current.trimEnd()}\n\n${block}\n`);
  // No reloadCaddy, as with the UI: Caddy only learns about the server once its first
  // route is added (mergeNamedServer). Let the 3s auto-refresh pick up the new server def.
}

// ---------------------------------------------------------------------------
// Live-backend helper (consolidates the nohup/fuser snippets that used to be
// hand-rolled separately in health-monitor/request-body-limit/trusted-proxies specs)
// ---------------------------------------------------------------------------

export interface BackendHandle {
  port: number;
  /** Stop the backend process. Idempotent — safe to call even if it never started. */
  stop(): Promise<void>;
}

/**
 * Starts a real HTTP backend (python's http.server) on the VM so tests can prove
 * traffic actually reaches it through Caddy, not just that a Caddyfile block was
 * written. Kills any stale listener on the port first, since a previous test's
 * process may still be winding down under the suite's `workers: 1` serialization.
 */
export async function startHttpBackend(page: Page, port: number): Promise<BackendHandle> {
  await spawnCmd(page, ['bash', '-c', `fuser -k ${port}/tcp 2>&1; true`]);
  await spawnCmd(page, ['bash', '-c',
    `nohup python3 -m http.server ${port} >/tmp/e2e-backend-${port}.log 2>&1 & disown`]);
  return {
    port,
    stop: () => spawnCmd(page, ['bash', '-c', `fuser -k ${port}/tcp 2>&1; true`]).then(() => undefined),
  };
}

/**
 * Sets up the minimal shared starting point most tests want: one already-known-good
 * standalone proxy on `proxyPort` backed by a real live HTTP server on `backendPort`.
 * `resetConfig` already runs automatically via the `pluginPage` fixture before every
 * test, so this does not repeat that — it only adds the "one proxy already exists"
 * state that a large fraction of tests below build on. Returns the backend handle so
 * callers can `.stop()` it in a `finally` block.
 */
export async function baseData(
  page: Page,
  opts: { proxyPort: number; backendPort: number },
): Promise<BackendHandle> {
  const backend = await startHttpBackend(page, opts.backendPort);
  await addProxy(page, { port: opts.proxyPort, target: `localhost:${opts.backendPort}` });
  return backend;
}

// ---------------------------------------------------------------------------
// Menus (#259): Add ▾, Tools ▾ and the row kebab
// ---------------------------------------------------------------------------

/** The Add split button's menu: 'Reverse proxy' | 'Redirect' | 'Static files' | 'Fixed response' | 'PHP site'. */
export async function openAddMenu(page: Page, item: string | RegExp): Promise<void> {
  await page.getByRole('button', { name: 'More site types' }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

/** The header's Tools menu: Check Config, Backup, Restore, Internal CA, ACME / Let's Encrypt. */
export async function openTool(page: Page, item: string | RegExp): Promise<void> {
  await page.getByRole('button', { name: 'Tools' }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

/** A site row's kebab: 'Duplicate' | 'Delete'. Edit stays a visible button named "Edit". */
export async function rowAction(row: Locator, item: 'Duplicate' | 'Delete'): Promise<void> {
  await row.getByRole('button', { name: 'More actions' }).click();
  await row.page().getByRole('menuitem', { name: item }).click();
}

// ---------------------------------------------------------------------------
// Proxy dialog tabs (#260)
// ---------------------------------------------------------------------------

const SECTIONS = {
  basicAuth: { tab: 'Security', toggle: /http basic auth/i },
  forwardAuth: { tab: 'Security', toggle: /forward authentication/i },
  tlsPolicy: { tab: 'Security', toggle: /tls policy/i },
  routeMatchers: { tab: 'Routing', toggle: /route matchers/i },
  rewrite: { tab: 'Routing', toggle: /uri rewrite/i },
  requestHeaders: { tab: 'Routing', toggle: /request headers/i },
  responseHeaders: { tab: 'Routing', toggle: /response headers/i },
  upstreams: { tab: 'Upstreams', toggle: /additional upstreams/i },
  lbRetry: { tab: 'Upstreams', toggle: /retry & failover tuning/i },
  upstreamTimeouts: { tab: 'Upstreams', toggle: /upstream timeouts/i },
  accessLog: { tab: 'Logging & errors', toggle: /access logging/i },
  errorHandlers: { tab: 'Logging & errors', toggle: /custom error handlers/i },
  serverTimeouts: { tab: 'Logging & errors', toggle: /server timeouts/i },
} as const;
export type DialogSection = keyof typeof SECTIONS;

/**
 * Show a settings section in a site dialog. The proxy dialogs put each section on a tab
 * (General, Security, Routing, Upstreams, Logging & errors); the other dialogs keep the
 * accordions, where this expands the section instead.
 */
export async function openSection(modal: Locator, section: DialogSection): Promise<void> {
  const { tab, toggle } = SECTIONS[section];
  await modal.waitFor();
  const tabButton = modal.getByRole('tab', { name: new RegExp(`^${tab}`) });
  if (await tabButton.count()) await tabButton.click();
  else await modal.getByRole('button', { name: toggle }).click();
}
