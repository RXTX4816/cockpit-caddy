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
import type { Page } from '@playwright/test';

export const PROXY_CONF_PATH = '/etc/caddy/conf.d/cockpit-caddy.conf';
export const SERVERS_CONF_PATH = '/etc/caddy/conf.d/cockpit-caddy-servers.json';
export const CADDYFILE_PATH = '/etc/caddy/Caddyfile';
const CONF_HEADER = '# Managed by cockpit-caddy - edits to this file may be overwritten by user plugin actions';

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

/** Returns the parsed cockpit-caddy-servers.json array. */
export async function readServersJson(page: Page): Promise<object[]> {
  const raw = await readFile(page, SERVERS_CONF_PATH);
  return raw ? JSON.parse(raw) : [];
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
  await writeFile(page, SERVERS_CONF_PATH, '[]');
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
 * Add a named server definition (ServerDef) to the servers JSON file and
 * a matching Caddyfile block to the managed conf.d file, then reload Caddy.
 */
export async function addServer(page: Page, opts: ServerOpts): Promise<void> {
  // Write the server def to the JSON file so syncConf (via readServerDefs fallback)
  // picks it up and shows the server tab. We deliberately do NOT write a Caddyfile
  // block here: an empty block (:PORT {}) would cause Caddy to register a server on
  // that port, and addProxy would then fail with a port conflict when pushing the
  // JSON config via mergeNamedServer. The first route added via the UI triggers
  // surgicallyWriteServerBlock which writes the proper block.
  const raw = await readFile(page, SERVERS_CONF_PATH);
  const defs: object[] = raw ? JSON.parse(raw) : [];
  defs.push({
    key: opts.key,
    name: opts.name,
    listenAddresses: opts.ports,
    tls: opts.tls ?? false,
  });
  await writeFile(page, SERVERS_CONF_PATH, JSON.stringify(defs, null, 2));
  // No reloadCaddy — conf.d unchanged. Let the 3s auto-refresh pick up the new server def.
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
