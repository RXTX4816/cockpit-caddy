import type { CaddyConfig, ProxyEntry } from "./types";
import { reloadService as reloadSystemdService, restartService } from "@rxtx4816/cockpit-plugin-base-react/systemd";
import { applyDnsSecrets, dnsEnviron } from "./dnsChallenge";
import { i18n } from "@rxtx4816/cockpit-plugin-base-react/i18n";
import { getHost, mkdirp, HostError } from "@rxtx4816/cockpit-plugin-base-react/host";
import { applyConfigChange, type FileChange } from "./configChange";
import { listConfDFiles, readCaddyfile, writeCaddyfile } from "./systemd";
import { externalHostList } from "./externalHosts";
import { AdminRejectedError, switchAdminEndpoint, type AdminTarget } from "./adminSwitch";
import { withConfDImport, type RawBlock, extractRawBlocksFromCaddyfile, migrateCaddyfile, extractLogFilePaths, parseConfExternalAddresses, parseLabelsFromCaddyfile, CONF_HEADER, findGlobalBlock } from "./caddyfileDocument";
import { buildTrustedProxiesLines, buildProxyProtocolLines, buildServerExtrasLines, patchMainCaddyfile, type GlobalOptions, INTERNAL_LIFETIME_MARKER, parseGlobalOptions, buildGlobalOptionsPatch, METRICS_SITE_BEGIN, METRICS_SITE_END, buildMetricsSiteBlock, parseMetricsSiteBlock } from "./globalOptions";
import { buildExternalAddress, surgicallyWriteProxy, proxiesToCaddyfile, tlsSubjectHost, tlsSubjectHosts, namedServerIsHostless, parseServerDefsFromConf, surgicallyWriteServerBlock } from "./siteBlocks";
import { parseCertLifetimeDuration, parseProxies, subjectsInclude, findAutomationPolicy } from "./caddyJsonModel";

// Re-exported from the modules the Caddyfile and JSON logic now lives in.
export { CONF_D_IMPORT_LINE, withConfDImport, setBlockResult, extractRawBlocksFromCaddyfile, migrateCaddyfile, extractLogFilePaths, parseLegacyLabelsFromCaddyfile, parseConfExternalAddresses, parseConfTlsMap, parseConfTlsIssuerMap, parseConfTlsOnDemandMap, parseConfTlsDnsMap, parseConfCustomTlsCaMap, parseConfAccessLogMap, parseLabelsFromCaddyfile, CONF_HEADER, parseConfForwardAuthMap, surgicallyReplaceBlock, surgicallyRemoveBlock, hostsConflict, findServerBlock, deduplicateServerBlocks, surgicallyRemoveServerBlock, findGlobalBlock, parseDnsProviderDirective } from "./caddyfileDocument";
export type { RawBlock } from "./caddyfileDocument";
export { patchMainCaddyfile, dnsProviderLines, parseGlobalOptions, buildGlobalOptionsPatch, buildMetricsSiteBlock, parseMetricsSiteBlock, certIssuerError } from "./globalOptions";
export type { GlobalOptions, PreferredChains } from "./globalOptions";
export { caddyQuote, hasAnyMatcher, isPathOnlyMatcher, expandPlaceholderShorthands, proxyToBlock, surgicallyWriteProxy, surgicallyEditProxy, proxiesToCaddyfile, tlsSubjectHost, tlsSubjectHosts, routeHosts, namedServerIsHostless, parseServerDefsFromConf, serverDefToBlock, surgicallyWriteServerBlock } from "./siteBlocks";
export { collapsePlaceholderShorthands, parseProxies, standaloneProxyId, buildServerEntry, mergeProxy, removeProxy, mergeNamedServer, removeNamedServer } from "./caddyJsonModel";

/**
 * Thrown when a proxy config was written to disk successfully but the Caddy
 * Admin API rejected the resulting config (e.g. HTTP 500). Callers can use
 * `instanceof CaddyApiError` to distinguish this "soft" failure (the file is
 * saved; Caddy just didn't accept it) from a hard write-failure.
 */
export class CaddyApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaddyApiError";
  }
}

/** Thrown when the main Caddyfile cannot be updated (e.g. caddy validate rejects the result). */
export class CaddyfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaddyfileError";
  }
}

// The admin API is either on TCP (default :2019) or a Unix socket (Arch default).
// Both transports use curl via cockpit.spawn — cockpit.http() proved unreliable across
// distros (IPv4/IPv6 resolution differences). curl is available on all supported distros.
type Transport = "tcp" | "unix";

let tcpBase = "http://127.0.0.1:2019";
let unixSocket = "/run/caddy/admin.socket";

export const ADMIN_TCP_DEFAULT = "http://127.0.0.1:2019";
export const ADMIN_SOCKET_DEFAULT = "/run/caddy/admin.socket";

export function setAdminAddress(tcp: string, socket: string): void {
  tcpBase = tcp || ADMIN_TCP_DEFAULT;
  unixSocket = socket || ADMIN_SOCKET_DEFAULT;
}

let transport: Transport | null = null;

// Whether Caddy is installed as a local systemd service. Kept current by
// useCaddyStatus's poll — false means Caddy is only reachable via the Admin API
// (e.g. running in a container), so local `caddy`/`systemctl` calls are skipped
// in favor of Admin-API equivalents.
let caddyManaged = true;

export function setCaddyManaged(managed: boolean): void {
  caddyManaged = managed;
}

export function isCaddyManaged(): boolean {
  return caddyManaged;
}

async function tcpGet(path: string): Promise<string> {
  return cockpit.spawn(
    ["curl", "-sf", "--connect-timeout", "2", `${tcpBase}${path}`],
    { err: "ignore" },
  );
}

async function unixGet(path: string): Promise<string> {
  return cockpit.spawn(
    ["curl", "-sf", "--unix-socket", unixSocket, `http://localhost${path}`],
    { superuser: "try" },
  );
}

// POST helpers avoid curl -f so the response body is captured on HTTP errors.
// We append -w "\n%{http_code}" and split on the last newline to get status + body.
async function curlPost(
  curlArgs: string[],
  body: string,
  opts: object = {},
  contentType = "application/json",
): Promise<void> {
  const out = await cockpit.spawn(
    [...curlArgs, "-s", "-X", "POST", "-H", `Content-Type: ${contentType}`,
     "-d", body, "-w", "\n%{http_code}"],
    opts,
  );
  const nl = out.lastIndexOf("\n");
  const code = parseInt(out.slice(nl + 1).trim(), 10);
  if (code >= 400) {
    const raw = out.slice(0, nl).trim();
    let msg = raw;
    try { msg = (JSON.parse(raw) as { error?: string }).error ?? raw; } catch { /* keep raw */ }
    throw new AdminHttpError(msg || `HTTP ${code}`, code);
  }
}

/** The Admin API answered with an HTTP error; its message is the body's `error`. */
class AdminHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "AdminHttpError";
  }
}

async function tcpPost(path: string, body: string, contentType?: string): Promise<void> {
  await curlPost(["curl", `${tcpBase}${path}`], body, {}, contentType);
}

async function unixPost(path: string, body: string, contentType?: string): Promise<void> {
  await curlPost(
    ["curl", "--unix-socket", unixSocket, `http://localhost${path}`],
    body,
    { superuser: "try" },
    contentType,
  );
}

export async function pingCaddyUnixSocket(): Promise<boolean> {
  try {
    await unixGet("/config/");
    return true;
  } catch {
    return false;
  }
}

export async function testTcpConnection(address: string): Promise<boolean> {
  try {
    await cockpit.spawn(
      ["curl", "-sf", "--connect-timeout", "2", `${address}/config/`],
      { err: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

export async function testUnixSocket(socketPath: string): Promise<boolean> {
  try {
    await cockpit.spawn(
      ["curl", "-sf", "--unix-socket", socketPath, "http://localhost/config/"],
      { superuser: "try" },
    );
    return true;
  } catch {
    return false;
  }
}

export async function pingCaddyApi(): Promise<boolean> {
  try {
    await tcpGet("/config/");
    transport = "tcp";
    return true;
  } catch { /* fall through */ }

  try {
    await unixGet("/config/");
    transport = "unix";
    return true;
  } catch { /* fall through */ }

  transport = null;
  return false;
}

export async function fetchCaddyConfig(): Promise<CaddyConfig> {
  const data = await (transport === "unix" ? unixGet("/config/") : tcpGet("/config/"));
  return (JSON.parse(data) as CaddyConfig) ?? {};
}

/**
 * The running config changed because of something the plugin did (#284). The config poll is
 * slow (every Admin API request is a line in Caddy's log), so every place that pushes,
 * loads or reloads a config announces it here and the config hook refetches right away.
 */
const configChangeListeners = new Set<() => unknown>();

export function onConfigChanged(listener: () => unknown): () => void {
  configChangeListeners.add(listener);
  return () => { configChangeListeners.delete(listener); };
}

/** Resolves once every listener's refetch has settled, so callers see the new config. */
export async function notifyConfigChanged(): Promise<void> {
  await Promise.allSettled([...configChangeListeners].map(l => l()));
}

export async function pushCaddyConfig(config: CaddyConfig): Promise<void> {
  const body = JSON.stringify(config);
  await (transport === "unix" ? unixPost("/config/", body) : tcpPost("/config/", body));
  await notifyConfigChanged();
}

/**
 * Loads a raw Caddyfile via Caddy's own `/load` endpoint (distinct from the
 * `/config/` JSON endpoint `pushCaddyConfig` uses), using `Content-Type:
 * text/caddyfile` so Caddy's own Caddyfile adapter validates and atomically
 * swaps in the config server-side — rejecting (with the old config left
 * running) if invalid. This is how validate+apply work when there's no local
 * `caddy` binary/systemd unit to shell out to (see `caddyManaged`).
 */
export async function applyCaddyfileViaApi(content: string): Promise<void> {
  try {
    await (transport === "unix"
      ? unixPost("/load", content, "text/caddyfile")
      : tcpPost("/load", content, "text/caddyfile"));
  } catch (e) {
    throw new CaddyfileError(e instanceof Error ? e.message : String(e));
  }
  await notifyConfigChanged();
}

/**
 * Adapts a Caddyfile through the Admin API's `/adapt` endpoint without loading it: what a check
 * can use when there is no local `caddy` binary. Throws CaddyfileError with Caddy's message when
 * the adapter rejects it, and the transport's own error when Caddy can't be reached.
 */
export async function adaptCaddyfileViaApi(content: string): Promise<void> {
  try {
    await (transport === "unix"
      ? unixPost("/adapt", content, "text/caddyfile")
      : tcpPost("/adapt", content, "text/caddyfile"));
  } catch (e) {
    if (e instanceof AdminHttpError) throw new CaddyfileError(e.message);
    throw e;
  }
}

/** `import [/etc/caddy/]conf.d/*` or `…/*.conf`, the globs whose files can be inlined. */
const CONF_D_GLOB_IMPORT = /^[ \t]*import[ \t]+(?:\/etc\/caddy\/)?conf\.d\/\*(\.conf)?[ \t]*$/m;

/**
 * Makes sure Caddy loads conf.d. Adds the plugin's import line only when the main
 * Caddyfile has no conf.d import at all; an import the user wrote stays untouched.
 */
export async function ensureConfDImported(): Promise<void> {
  const content = await readCaddyfile();
  if (isStockCaddyfile(content)) {
    // The distro's welcome site moves into conf.d on the first save (#256), no gate needed.
    const { caddyfile, confD } = migrateStockCaddyfile(content, await readProxyConf(), STOCK_WELCOME_LABEL);
    await ensureConfDDir();
    await getHost().writeFile(PROXY_CONF_PATH, confD, { superuser: "try" });
    await writeCaddyfile(caddyfile);
    return;
  }
  const next = withConfDImport(content);
  if (next !== content) await writeCaddyfile(next);
}

/**
 * Replaces a conf.d glob import with the contents of the files it matches, in name
 * order: `*.conf` takes only .conf files, a bare `*` takes all of them, as Caddy
 * would. Without such an import the Caddyfile comes back unchanged.
 */
export function inlineConfDImport(main: string, files: { path: string; content: string }[]): string {
  const m = CONF_D_GLOB_IMPORT.exec(main);
  if (!m) return main;
  const onlyConf = m[1] !== undefined;
  const inlined = files
    .filter(f => !onlyConf || f.path.endsWith(".conf"))
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(f => f.content)
    .join("\n\n");
  return main.slice(0, m.index) + inlined + main.slice(m.index + m[0].length);
}

/**
 * Caddy's `/load` endpoint disallows the `import` directive when adapting
 * content submitted directly over HTTP (it has no on-disk origin) — a
 * deliberate anti-SSRF safeguard, since otherwise anyone with Admin API
 * access could use `import` to read arbitrary files off the server.
 * Confirmed directly: posting the main Caddyfile as-is returns 200 but
 * `GET /config/apps` comes back null — the import silently loads nothing.
 * So conf.d files must be read and inlined here ourselves before posting.
 */
async function buildFlattenedMainCaddyfile(): Promise<string> {
  const main = (await getHost().readFile(MAIN_CADDYFILE, { superuser: "try" })) ?? "";
  if (!CONF_D_GLOB_IMPORT.test(main)) return main;
  const paths = await listConfDFiles();
  const contents = await Promise.all(paths.map(p => getHost().readFile(p, { superuser: "try" })));
  const files = paths.flatMap((path, i) => (contents[i] ? [{ path, content: contents[i] }] : []));
  return inlineConfDImport(main, files);
}

export async function applyCurrentCaddyfileViaApi(): Promise<void> {
  await applyCaddyfileViaApi(await buildFlattenedMainCaddyfile());
}

/** The main Caddyfile as it is on disk, e.g. to keep as a backup before a save. */
export async function readMainCaddyfile(): Promise<string> {
  return (await getHost().readFile(MAIN_CADDYFILE, { superuser: "try" })) ?? "";
}

/** POST /load over the address the plugin uses now; a refusal from Caddy is an AdminRejectedError. */
async function loadOverCurrentAddress(content: string): Promise<void> {
  try {
    await (transport === "unix" ? unixPost("/load", content, "text/caddyfile") : tcpPost("/load", content, "text/caddyfile"));
  } catch (e) {
    if (e instanceof AdminHttpError) throw new AdminRejectedError(e.message);
    throw e;
  }
}

/**
 * The reload for a save that moved the admin endpoint (#330). `backup` is the main Caddyfile
 * from before that save. With `restart`, Caddy is restarted instead of reloaded (the env file
 * changed too). See adminSwitch.ts for the steps.
 */
export async function reloadWithAdminSwitch(backup: string, target: AdminTarget, opts: { restart?: boolean } = {}): Promise<void> {
  try {
    await switchAdminEndpoint(target, {
      apply: async () => opts.restart ? restartService("caddy") : loadOverCurrentAddress(await buildFlattenedMainCaddyfile()),
      probe: t => t.transport === "unix" ? testUnixSocket(t.socket) : testTcpConnection(t.tcp),
      switchTo: t => {
        setAdminAddress(t.tcp, t.socket);
        transport = t.transport;
      },
      restore: async () => {
        await getHost().writeFile(MAIN_CADDYFILE, backup, { superuser: "try" });
        // The old endpoint still answers when Caddy refused the new config; otherwise only a
        // restart brings it back, since Caddy listens wherever the config it took says.
        try {
          await loadOverCurrentAddress(await buildFlattenedMainCaddyfile());
        } catch {
          await restartService("caddy");
        }
      },
    });
  } finally {
    await notifyConfigChanged();
  }
}

const PROXY_CONF_PATH = "/etc/caddy/conf.d/cockpit-caddy.conf";
/** Kept here, not in snippets.ts, so caddy.ts doesn't import its own importer. Must sort before PROXY_CONF_PATH. */
const SNIPPETS_CONF_PATH = "/etc/caddy/conf.d/cockpit-caddy-snippets.conf";

/**
 * The label the distro's welcome site gets in conf.d (#256). It's written into the file, so it
 * stays the same whatever language the UI is in.
 */
export const STOCK_WELCOME_LABEL = "Distro welcome page";

/** The addresses a distro's welcome site listens on: the plain-HTTP catch-all (#256). */
const STOCK_WELCOME_ADDRESSES = new Set([":80", "http://", "http://:80"]);

/** Strips `#` comments (outside quotes) and blank lines, leaving trimmed directive lines. */
function significantLines(text: string): string[] {
  return text.split("\n").map(stripLineComment).map(l => l.trim()).filter(Boolean);
}

function stripLineComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "`") quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

/**
 * True when the main Caddyfile is the one the distro package ships (#256): its only site
 * is the welcome page, a port-80 catch-all with nothing but `root [*] /usr/share/caddy` and
 * `file_server`. Comments, blank lines, the global options block and import lines don't
 * count; anything else (another site, a snippet, an extra directive) means it isn't stock.
 */
export function isStockCaddyfile(content: string): boolean {
  const { blocks, caddyfile: rest } = migrateCaddyfile(content);
  if (blocks.length !== 1) return false;
  const [site] = blocks;
  if (!STOCK_WELCOME_ADDRESSES.has(site.address)) return false;

  const body = significantLines(site.raw).slice(1, -1);
  const want = ["file_server", "root /usr/share/caddy"];
  const got = body.map(l => l.replace(/\s+/g, " ").replace(/^root \* /, "root ")).sort();
  if (got.length !== want.length || got.some((l, i) => l !== want[i])) return false;

  // Whatever is left besides the site: only the global options block and imports.
  const globalBlock = findGlobalBlock(rest);
  const outside = globalBlock ? rest.slice(0, globalBlock.open) + rest.slice(globalBlock.close + 1) : rest;
  return significantLines(outside).every(l => /^import\s/.test(l));
}

/**
 * Moves a stock Caddyfile's welcome site into conf.d (#256), labelled so it shows up as an
 * ordinary static site, and adds the conf.d import. Existing conf.d content stays as it is.
 */
export function migrateStockCaddyfile(
  content: string, existingConfD: string, label: string,
): { caddyfile: string; confD: string } {
  const { blocks, caddyfile } = migrateCaddyfile(content);
  return {
    caddyfile,
    confD: mergeMigratedConfContent(existingConfD, blocks.map(b => ({ ...b, label }))),
  };
}

/** Builds the conf.d file content from raw blocks, preserving all original syntax. */
export function buildMigratedConfContent(blocks: RawBlock[]): string {
  const header = CONF_HEADER + "\n";
  if (blocks.length === 0) return header + "\n";
  const parts = blocks.map(b => (b.label ? `# label: ${b.label}\n` : "") + b.raw);
  return header + "\n" + parts.join("\n\n") + "\n";
}

/**
 * Merges newly-extracted main-Caddyfile blocks into whatever conf.d already
 * manages, for the "Migrate" action. The existing conf.d content is kept
 * verbatim rather than round-tripped through extractRawBlocksFromCaddyfile:
 * that parser only understands the legacy inline-first-line label format
 * used for hand-authored blocks in the main Caddyfile, so re-parsing conf.d's
 * own `# label:`, `# server:`, and `# serverdef:` comments — which always
 * precede the block header, not follow it — through it would silently drop
 * them, deleting labels and de-registering named servers on migration.
 *
 * Appends only the new blocks' body (no extra header line) since the existing
 * content already carries one — otherwise repeated migrations pile up a fresh
 * CONF_HEADER comment every time.
 */
export function mergeMigratedConfContent(existingConfD: string, newBlocks: RawBlock[]): string {
  const trimmedExisting = existingConfD.trim();
  if (!trimmedExisting) return buildMigratedConfContent(newBlocks);
  if (newBlocks.length === 0) return `${trimmedExisting}\n`;
  const parts = newBlocks.map(b => (b.label ? `# label: ${b.label}\n` : "") + b.raw);
  return `${trimmedExisting}\n\n${parts.join("\n\n")}\n`;
}

/**
 * Leaves exactly one current CONF_HEADER at the place of the first header line:
 * old LEGACY_CONF_HEADER lines are replaced, and repeated headers (left by
 * migrations that used to append a fresh one each time) are dropped together
 * with the blank line after them. A file without any header is left alone.
 */
export function normalizeManagedHeader(content: string): { content: string; changed: boolean } {
  const lines = content.split("\n");
  let seenHeader = false;
  let changed = false;
  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === CONF_HEADER || line === LEGACY_CONF_HEADER) {
      if (seenHeader) {
        changed = true;
        if (lines[i + 1]?.trim() === "") i++; // also drop the blank line that follows it
        continue;
      }
      seenHeader = true;
      if (lines[i] !== CONF_HEADER) changed = true;
      result.push(CONF_HEADER);
      continue;
    }
    result.push(lines[i]);
  }
  return { content: result.join("\n"), changed };
}

/** Makes sure /etc/caddy/conf.d exists, where the plugin keeps its files. */
export function ensureConfDDir(): Promise<void> {
  return mkdirp(getHost(), "/etc/caddy/conf.d", { superuser: "try" });
}

export async function writeRawProxyConf(content: string): Promise<void> {
  await getHost().writeFile(PROXY_CONF_PATH, content, { superuser: "try" });
}

/**
 * Writes conf.d, then validates the full Caddyfile (which imports conf.d).
 * Reverts conf.d and throws CaddyfileError if validation fails.
 * Use this for named-server operations where a bad block (e.g. port conflict)
 * would make the Caddyfile invalid.
 */
export async function writeRawProxyConfValidated(content: string): Promise<void> {
  await writeConfDFileValidated(PROXY_CONF_PATH, content);
}

async function writeConfDFileValidated(path: string, content: string): Promise<void> {
  await applyCaddyConfig([{ path, content }]);
}

/**
 * Changes Caddyfile-side files as one: every changed file is written, `caddy validate` runs
 * once over the whole config, and a failure puts all of them back (see applyConfigChange).
 * Also refuses an unwritable log file path *before* anything is saved — see checkLogFileWritable
 * for why `caddy validate` succeeding isn't enough on its own — and gives validate's side
 * effects on log files back to the service user afterwards.
 */
async function applyCaddyConfig(changes: FileChange[]): Promise<void> {
  await applyConfigChange(changes, {
    check: async changed => {
      for (const logPath of new Set(changed.flatMap(c => extractLogFilePaths(c.content)))) {
        const err = await checkLogFileWritable(logPath);
        if (err) throw new CaddyfileError(i18n.t("errors.log_file_not_writable", { path: logPath, error: err }));
      }
    },
    validate: runCaddyValidate,
    afterCommit: async changed => { for (const c of changed) await fixAccessLogFileOwnership(c.content); },
  });
}

/** The plugin's snippets file (#288); empty when it doesn't exist yet. */
export async function readSnippetsConf(): Promise<string> {
  try {
    return (await getHost().readFile(SNIPPETS_CONF_PATH, { superuser: "try" })) ?? "";
  } catch {
    return "";
  }
}

/** Writes the snippets file, validates the whole Caddyfile, and restores the old file on an error. */
export async function writeSnippetsConfValidated(content: string): Promise<void> {
  await ensureConfDDir();
  await writeConfDFileValidated(SNIPPETS_CONF_PATH, content);
}

/**
 * `caddy validate` (run as root by runCaddyValidate, since it's a plain CLI invocation
 * via cockpit.spawn) fully provisions the app as a side effect of validating — including
 * opening any configured file-based access log — even though it's only meant to check
 * config *shape*. Verified against a live instance: validating a config with a brand-new
 * log file path creates that file as root:root mode 600, which then permanently blocks
 * the real caddy.service (running as its own unprivileged, systemd-confined user) from
 * ever writing to it on the actual reload that follows — the exact failure a user hit in
 * production. Chowning any referenced log file back to the service's real user/group
 * after every successful validate undoes this; a no-op when the file doesn't exist yet
 * or is already owned correctly.
 */
async function fixAccessLogFileOwnership(proxyConfContent: string): Promise<void> {
  const serviceUser = await getCaddyServiceUser();
  if (!serviceUser) return;
  const paths = new Set(extractLogFilePaths(proxyConfContent));
  for (const path of paths) {
    await cockpit.spawn(["chown", `${serviceUser.user}:${serviceUser.group}`, path], { superuser: "try", err: "ignore" }).catch(() => {});
  }
}

/**
 * The client-auth CA file in a site block: `trust_pool file <pem>`, or the deprecated
 * `trusted_ca_cert_file <pem>` (#255). The deprecated form reaches the running JSON only as an
 * inlined certificate, so the path survives a reload only in the conf.d text.
 */
export function parseClientAuthCaFile(siteBlock: string): string | undefined {
  const m = siteBlock.match(/^[ \t]*(?:trust_pool[ \t]+file|trusted_ca_cert_file)[ \t]+([^\s{}]+)/m);
  return m?.[1];
}

export async function readProxyConf(): Promise<string> {
  try {
    return (await getHost().readFile(PROXY_CONF_PATH, { superuser: "try" })) ?? "";
  } catch {
    return "";
  }
}

/** Header written before #237. It read as if the plugin kept the real config elsewhere. */
export const LEGACY_CONF_HEADER = "# Managed by cockpit-caddy - edits to this file may be overwritten by user plugin actions";

/**
 * Candidate on-disk conf.d address keys for a proxy, used to correlate a
 * JSON-API-parsed ProxyEntry with text-derived metadata maps (labels, TLS,
 * external address, access log, forward-auth — all keyed by RawBlock.address,
 * plus a port-number fallback key, see setBlockResult/addressPortKey).
 * A bare-hostname Caddyfile block (e.g. from a migrated config) has no explicit
 * port, so the plain host is tried in addition to the canonical `host:port` form.
 *
 * When the host *is* already known (recovered from the live JSON's Host matcher,
 * e.g. multiple routes sharing a port — #139) but the scheme isn't, every scheme
 * shape is tried against that host before ever falling back to the bare port key:
 * the saved Caddyfile address may carry an explicit scheme prefix (`https://host:port`)
 * that buildExternalAddress can't reproduce without already knowing the scheme, and
 * the port-only fallback key is ambiguous the moment a second host shares that port.
 *
 * The plain port is tried last: when a proxy is the sole occupant of its port,
 * Caddy's JSON config omits the host matcher entirely, so parseProxies can't
 * recover externalHost/externalScheme at all — the port-keyed fallback bridges
 * that gap, and is safe there precisely because nothing else could be using the port.
 */
export function proxyAddressKeys(p: Pick<ProxyEntry, "externalPort" | "externalScheme" | "externalHost" | "tls">): string[] {
  const keys = [buildExternalAddress(p)];
  const hosts = externalHostList(p.externalHost);
  if (hosts.length) {
    const each = (prefix: string) => hosts.map(h => `${prefix}${h}:${p.externalPort}`).join(", ");
    keys.push(each(""));
    keys.push(each("http://"));
    keys.push(each("https://"));
    keys.push(hosts.join(", "));
  }
  keys.push(String(p.externalPort));
  return keys;
}

export async function writeProxyConf(proxies: ProxyEntry[]): Promise<void> {
  await ensureConfDDir();
  await getHost().writeFile(PROXY_CONF_PATH, proxiesToCaddyfile(proxies), { superuser: "try" });
}

/** Per-hostname ACME/TLS issuer status (#141), derived from the live Caddy config. */
export interface AcmeHostStatus {
  host: string;
  /** Which issuer actually certifies this host, or "none" if TLS is explicitly disabled. */
  issuer: "internal" | "acme" | "none";
  /** Whether this came from an explicit apps.tls.automation.policies entry, or is
   *  inferred because Caddy's automatic HTTPS is on by default for public hostnames
   *  and nothing says otherwise. */
  source: "explicit-policy" | "caddy-default" | "explicit-skip";
}

/**
 * Classifies every public-looking hostname in the live config by how it actually gets
 * its TLS certificate (#141) — "ACME not extracted in webui": Caddy's automatic HTTPS
 * needs zero configuration, so a route with no explicit `tls`/email/CA setting is not
 * "not using TLS" — it's silently getting a Let's Encrypt cert from Caddy's built-in
 * defaults, and today there's no way to see that in this app at all.
 *
 * Three cases, in priority order:
 * 1. The host is in some server's `automatic_https.skip` list — Caddy's Caddyfile
 *    adapter emits this when a site's address used an explicit `http://` scheme
 *    (see buildExternalAddress) — TLS is genuinely, deliberately off.
 * 2. The host is named in an `apps.tls.automation.policies` entry's `subjects` — an
 *    explicit choice was made (internal issuer, or a custom ACME CA/email/EAB).
 * 3. Neither — the host is getting Caddy's default automatic HTTPS (a Let's Encrypt
 *    production cert with account defaults) with nothing in config to show for it.
 */
export function classifyAcmeHosts(config: CaddyConfig): AcmeHostStatus[] {
  const servers = config.apps?.http?.servers ?? {};
  const automationPolicies = config.apps?.tls?.automation?.policies;
  const hosts = new Map<string, AcmeHostStatus>();

  for (const server of Object.values(servers)) {
    const skip = new Set(server.automatic_https?.skip ?? []);
    const serverHosts = new Set<string>();
    for (const route of server.routes ?? []) {
      const match = route.match?.[0] as { host?: string[] } | undefined;
      match?.host?.forEach(h => serverHosts.add(h));
    }
    const listenAddr = server.listen?.[0] ?? "";
    const colonIdx = listenAddr.lastIndexOf(":");
    const rawHost = colonIdx > 0 ? listenAddr.slice(0, colonIdx) : "";
    if (rawHost) serverHosts.add(rawHost);

    for (const rawSubject of serverHosts) {
      const host = tlsSubjectHost(rawSubject);
      if (!host || hosts.has(host)) continue;

      if (skip.has(host)) {
        hosts.set(host, { host, issuer: "none", source: "explicit-skip" });
        continue;
      }
      // Once any host in the Caddyfile has a customized policy, Caddy's adapter must
      // explicitly enumerate every other host too, so it isn't accidentally caught by
      // that policy's scope — but a subjects-only entry with no issuers array is just
      // that bookkeeping, not an actual customization, and still means "default ACME".
      const policy = automationPolicies?.find(p => subjectsInclude(p.subjects, host));
      const module = policy?.issuers?.length ? policy.issuers[0].module : undefined;
      if (module) {
        hosts.set(host, { host, issuer: module === "internal" ? "internal" : "acme", source: "explicit-policy" });
      } else {
        hosts.set(host, { host, issuer: "acme", source: "caddy-default" });
      }
    }
  }

  return [...hosts.values()].sort((a, b) => a.host.localeCompare(b.host));
}

/**
 * Resolves a server's internal-issuer lifetime/renewal-window settings given its
 * *actual* hostname. Exported separately from parseProxies/parseTlsAdvanced because
 * a server that's the sole occupant of its port has no host matcher in the live
 * JSON config at all (Caddy omits it — nothing else on that listener to
 * disambiguate), so parseProxies can't resolve the host at the point it parses
 * tlsAdvanced. Callers that separately recover the host via a conf.d text fallback
 * (see useProxies.ts) should re-resolve with this function afterward, using the
 * corrected host, and merge the result into the already-parsed tlsAdvanced.
 */
export function resolveInternalIssuerSettings(
  config: CaddyConfig,
  host: string | undefined,
): { certLifetime?: string; renewalWindowRatio?: number } {
  const policy = findAutomationPolicy(config.apps?.tls?.automation?.policies, tlsSubjectHosts(host)[0]);
  return {
    certLifetime: parseCertLifetimeDuration(policy?.issuers?.[0]?.lifetime),
    renewalWindowRatio: policy?.renewal_window_ratio,
  };
}

/**
 * Forces tlsAdvanced.certLifetime to the shared internal-cert lifetime for a hostless
 * proxy/server, clearing any per-site renewalWindowRatio (hostless renewal window only
 * comes from the real global `renewal_window_ratio` option, never per-site — see
 * buildTlsCaddyLines). Hostname-scoped entries are returned unchanged: they get their
 * own independently-scoped policy and may set their own lifetime/ratio freely.
 * Every hostless proxy/server MUST go through this before being written, or their
 * automation policies will disagree and Caddy will refuse to reload.
 */
function forceHostlessLifetime(
  tlsAdvanced: import("./types").TlsAdvancedConfig | undefined,
  isHostless: boolean,
  internalCertLifetime: string | undefined,
): import("./types").TlsAdvancedConfig | undefined {
  if (!isHostless) return tlsAdvanced;
  const certLifetime = internalCertLifetime || undefined;
  if (!certLifetime && !tlsAdvanced) return undefined;
  return { ...tlsAdvanced, certLifetime, renewalWindowRatio: undefined };
}

/** Applies forceHostlessLifetime to a proxy, using its externalHost to determine hostlessness. */
export function applyGlobalInternalLifetimeToProxy(
  proxy: { externalHost?: string; tlsAdvanced?: import("./types").TlsAdvancedConfig },
  internalCertLifetime: string | undefined,
): import("./types").TlsAdvancedConfig | undefined {
  return forceHostlessLifetime(proxy.tlsAdvanced, !tlsSubjectHosts(proxy.externalHost).length, internalCertLifetime);
}

/** Applies forceHostlessLifetime to a named server, using its listen addresses to determine hostlessness. */
export function applyGlobalInternalLifetimeToServer(
  def: { listenAddresses: string[]; tlsAdvanced?: import("./types").TlsAdvancedConfig },
  internalCertLifetime: string | undefined,
): import("./types").TlsAdvancedConfig | undefined {
  return forceHostlessLifetime(def.tlsAdvanced, namedServerIsHostless(def.listenAddresses), internalCertLifetime);
}

/**
 * Hashes a basic-auth password with `caddy hash-password`. The password goes on stdin, not as
 * `--plaintext <pw>`: argv is readable by every local user in /proc/<pid>/cmdline (#255).
 * With stdin not a terminal, caddy reads one newline-terminated line (no confirmation prompt).
 */
export async function hashPassword(plaintext: string, algorithm?: "bcrypt" | "argon2id"): Promise<string> {
  // bcrypt is what `caddy hash-password` does without the flag, which older Caddy lacks (#337).
  const argv = algorithm === "argon2id" ? ["caddy", "hash-password", "--algorithm", "argon2id"] : ["caddy", "hash-password"];
  const proc = cockpit.spawn(argv, { superuser: "try", err: "message" });
  proc.input(`${plaintext}\n`);
  return (await proc).trim();
}

export async function fetchUpstreamStatus(): Promise<import("./types").UpstreamStatus[]> {
  try {
    const data = await (transport === "unix"
      ? unixGet("/reverse_proxy/upstreams")
      : tcpGet("/reverse_proxy/upstreams"));
    const parsed = JSON.parse(data) as import("./types").UpstreamStatus[] | null;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Named Server storage & generation — #49
// ---------------------------------------------------------------------------

/**
 * Named-server definitions used to be mirrored into this JSON file. They live only
 * in the `# serverdef:` comments in cockpit-caddy.conf now; the leftover file is
 * deleted on first load (see removeLegacyServerDefsFile).
 */
const LEGACY_SERVERS_JSON_PATH = "/etc/caddy/conf.d/cockpit-caddy-servers.json";

export async function removeLegacyServerDefsFile(): Promise<void> {
  await cockpit.spawn(["rm", "-f", LEGACY_SERVERS_JSON_PATH], { superuser: "try" }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Main Caddyfile global options — server-level timeouts & request limits
// ---------------------------------------------------------------------------

const MAIN_CADDYFILE = "/etc/caddy/Caddyfile";

/**
 * Runs `caddy validate` on MAIN_CADDYFILE. The error message comes from its output, which the
 * Host keeps even when Cockpit rejects with an empty message object.
 * Throws CaddyfileError with the relevant error line on failure.
 *
 * When Caddy isn't installed as a local systemd service (running in a
 * container, say), there's no local `caddy` binary to shell out to — instead,
 * push MAIN_CADDYFILE straight to the running instance via the Admin API,
 * which validates and applies atomically (see applyCaddyfileViaApi).
 */
async function runCaddyValidate(): Promise<void> {
  if (!caddyManaged) {
    await applyCurrentCaddyfileViaApi();
    return;
  }
  // DNS provider credentials (#261) live in the service's env file; a provider that checks them
  // while provisioning would fail validation without them. Passed as environment, not argv.
  const environ = await dnsEnviron();
  try {
    await getHost().run(
      ["caddy", "validate", "--config", MAIN_CADDYFILE, "--adapter", "caddyfile"],
      { superuser: "try", stderr: "out", environ: environ.length ? environ : undefined },
    );
  } catch (e) {
    // Extract the first "Error: ..." line from the combined output, or fall back to the full output.
    const output = (e instanceof HostError ? e.output || e.message : String(e)).trim();
    const errorLine = output.split("\n").find(l => /^Error:/i.test(l.trim())) ?? output;
    throw new CaddyfileError(errorLine.replace(/^Error:\s*/i, "").trim());
  }
}

/**
 * Reloads Caddy: `systemctl reload caddy` when it's a locally managed
 * service, or an Admin-API config push (applyCaddyfileViaApi) when it isn't
 * (see caddyManaged) — e.g. Caddy running in a container with no local unit
 * to reload.
 */
export async function reloadCaddy(): Promise<void> {
  if (!caddyManaged) {
    await applyCurrentCaddyfileViaApi();
    return;
  }
  await reloadSystemdService("caddy");
  await notifyConfigChanged();
}

/**
 * Build the `servers :PORT { timeouts { ... } protocols h1 h2 }` blocks for ports that
 * have timeouts, header limits, and/or HTTP/3 (#51) explicitly set on any of their
 * proxies. Proxies belonging to a named ServerDef are excluded — their timeouts are in
 * the ServerDef block.
 *
 * Grouped by port, not one block per proxy: Caddy rejects the global `servers` options
 * with "duplicate listener addresses" the moment two blocks name the same `:PORT` — which
 * happens the instant two standalone proxies share a port via distinct subdomains (#139)
 * and each independently has some server-level setting. Since these settings are
 * inherently per-listener in Caddy (shared by every host on that port, not scoped to one),
 * the merge take the first non-empty value per timeout field across the group, and
 * disables HTTP/3 for the whole port if *any* proxy on it asked to — an explicit opt-out
 * from one host is honored for the shared listener rather than silently dropped.
 */
function buildManagedServersBlocks(
  proxies: ProxyEntry[],
  trustedProxies?: import("./types").TrustedProxiesConfig,
  proxyProtocol?: import("./types").ProxyProtocolConfig,
): string {
  const relevant = proxies.filter(p => !p.namedServerKey &&
    (p.serverReadTimeout || p.serverReadHeaderTimeout || p.serverWriteTimeout || p.serverIdleTimeout || p.maxHeaderBytes || p.disableHttp3 || p.serverExtras));

  const byPort = new Map<number, ProxyEntry[]>();
  for (const p of relevant) {
    const group = byPort.get(p.externalPort);
    if (group) group.push(p);
    else byPort.set(p.externalPort, [p]);
  }

  const ports = [...byPort.keys()].sort((a, b) => a - b);
  return ports
    .map(port => {
      const group = byPort.get(port)!;
      const readTimeout = group.find(p => p.serverReadTimeout)?.serverReadTimeout;
      const readHeaderTimeout = group.find(p => p.serverReadHeaderTimeout)?.serverReadHeaderTimeout;
      const writeTimeout = group.find(p => p.serverWriteTimeout)?.serverWriteTimeout;
      const idleTimeout = group.find(p => p.serverIdleTimeout)?.serverIdleTimeout;
      const maxHeaderBytes = group.find(p => p.maxHeaderBytes)?.maxHeaderBytes;
      const disableHttp3 = group.some(p => p.disableHttp3);
      const extras: import("./types").ServerExtras = {
        keepaliveInterval: group.find(p => p.serverExtras?.keepaliveInterval)?.serverExtras?.keepaliveInterval,
        keepaliveIdle: group.find(p => p.serverExtras?.keepaliveIdle)?.serverExtras?.keepaliveIdle,
        readBodyIdle: group.find(p => p.serverExtras?.readBodyIdle)?.serverExtras?.readBodyIdle,
        strictSniHost: group.some(p => p.serverExtras?.strictSniHost),
        logCredentials: group.some(p => p.serverExtras?.logCredentials),
        enableFullDuplex: group.some(p => p.serverExtras?.enableFullDuplex),
      };

      const lines = [`\tservers :${port} {`];
      const tLines: string[] = [];
      if (readTimeout) tLines.push(`\t\t\tread_body ${readTimeout}`);
      if (extras.readBodyIdle) tLines.push(`\t\t\tread_body_idle ${extras.readBodyIdle}`);
      if (readHeaderTimeout) tLines.push(`\t\t\tread_header ${readHeaderTimeout}`);
      if (writeTimeout) tLines.push(`\t\t\twrite ${writeTimeout}`);
      if (idleTimeout) tLines.push(`\t\t\tidle ${idleTimeout}`);
      if (tLines.length) lines.push("\t\ttimeouts {", ...tLines, "\t\t}");
      if (maxHeaderBytes) lines.push(`\t\tmax_header_size ${maxHeaderBytes}`);
      // #51 — Caddy enables h1/h2/h3 by default; explicitly list h1+h2 only to opt out of
      // h3. `protocols` is only valid inside this global `servers` block, not per-site.
      if (disableHttp3) lines.push("\t\tprotocols h1 h2");
      lines.push(...buildServerExtrasLines(extras, "\t\t"));
      // #153 — this port already has its own `servers :PORT { }` block for other settings,
      // which means the global (portless) `servers { trusted_proxies ... }` block would be
      // completely ignored for it (verified against a live instance — no merging happens),
      // so trusted_proxies must be repeated here too.
      if (trustedProxies?.ranges.length) lines.push(...buildTrustedProxiesLines(trustedProxies, "\t\t"));
      // #157 — same reasoning as trusted_proxies above: a per-port block silently drops the
      // global listener_wrappers/proxy_protocol config too, so it must be repeated here.
      if (proxyProtocol) lines.push(...buildProxyProtocolLines(proxyProtocol, "\t\t"));
      lines.push("\t}");
      return lines.join("\n");
    })
    .join("\n");
}

/**
 * Writes server-level timeout settings for all proxies into the main Caddyfile's
 * global options block, then validates. Throws CaddyfileError on failure and
 * restores the original file content before throwing.
 */
export async function syncGlobalTimeouts(proxies: ProxyEntry[]): Promise<void> {
  const original = (await getHost().readFile(MAIN_CADDYFILE, { superuser: "try" })) ?? "";
  await applyCaddyConfig([{ path: MAIN_CADDYFILE, content: planGlobalTimeouts(original, proxies) }]);
}

/**
 * The main Caddyfile with the server-level timeouts for `proxies` in its global options.
 * #153 — re-merges the current global trusted_proxies setting into every per-port block this
 * rebuilds, since a bare regeneration would otherwise silently drop it for any port that also
 * has its own timeout/protocol override (see buildManagedServersBlocks). Read from the given
 * content rather than threaded through every caller — trusted_proxies itself is saved via the
 * separate syncGlobalOptions path.
 */
function planGlobalTimeouts(mainCaddyfile: string, proxies: ProxyEntry[]): string {
  const globalOpts = parseGlobalOptions(mainCaddyfile);
  const blocks = buildManagedServersBlocks(proxies, globalOpts.trustedProxies, globalOpts.proxyProtocol);
  return patchMainCaddyfile(mainCaddyfile, blocks);
}

/**
 * Saves a site change as one: the server-level timeouts for `proxies` in the main Caddyfile
 * and the new conf.d content, validated together. A failure leaves neither file touched, where
 * saving them one after the other left the new timeouts behind when the conf.d step failed.
 */
export async function saveSiteConfig(proxies: ProxyEntry[], proxyConfContent: string): Promise<void> {
  const main = (await getHost().readFile(MAIN_CADDYFILE, { superuser: "try" })) ?? "";
  await applyCaddyConfig([
    { path: MAIN_CADDYFILE, content: planGlobalTimeouts(main, proxies) },
    { path: PROXY_CONF_PATH, content: proxyConfContent },
  ]);
}

// ---------------------------------------------------------------------------
// PKI / Internal CA
// ---------------------------------------------------------------------------

export interface PkiCaInfo {
  id: string;
  name: string;
  rootCommonName: string;
  intermediateCommonName: string;
  rootPem: string;
  intermediatePem: string;
}

export interface CertDetails {
  notBefore: string;
  notAfter: string;
  fingerprint: string;
}

export async function fetchPkiCa(): Promise<PkiCaInfo> {
  const raw = await (transport === "unix" ? unixGet("/pki/ca/local") : tcpGet("/pki/ca/local"));
  const data = JSON.parse(raw) as {
    id: string;
    name: string;
    root_common_name: string;
    intermediate_common_name: string;
    root_certificate: string;
    intermediate_certificate: string;
  };
  return {
    id: data.id,
    name: data.name,
    rootCommonName: data.root_common_name,
    intermediateCommonName: data.intermediate_common_name,
    rootPem: data.root_certificate,
    intermediatePem: data.intermediate_certificate,
  };
}

export async function parseCertDetails(pem: string): Promise<CertDetails> {
  // cockpit.spawn has no `input` option (#315): the PEM goes to openssl's stdin.
  const proc = cockpit.spawn(["openssl", "x509", "-noout", "-dates", "-fingerprint", "-sha256"], { err: "out" });
  proc.input(pem);
  const out = await proc;
  const notBefore = out.match(/notBefore=(.+)/)?.[1]?.trim() ?? "";
  const notAfter = out.match(/notAfter=(.+)/)?.[1]?.trim() ?? "";
  const fingerprint = out.match(/SHA256 Fingerprint=(.+)/i)?.[1]?.trim() ?? "";
  return { notBefore, notAfter, fingerprint };
}

// ---------------------------------------------------------------------------
// Storage backend info (#46)
// ---------------------------------------------------------------------------

export interface StorageInfo {
  /** The effective storage root — the configured override, or Caddy's own default. */
  path: string;
  /** Whether `path` came from an explicit config override vs. Caddy's own default. */
  isDefault: boolean;
  /** Human-readable disk usage (e.g. "24M"), or undefined if it couldn't be determined
   *  (path doesn't exist yet, `du` unavailable, permission denied, etc). */
  diskUsage?: string;
  /** Number of `*.crt` files found under `<path>/certificates`, or undefined if that
   *  directory doesn't exist (e.g. no certificates issued yet). */
  certificateCount?: number;
}

/**
 * Caddy's own default storage root when nothing overrides it: `/var/lib/caddy` when
 * running under systemd with `StateDirectory=caddy` (the standard distro package
 * layout), otherwise `$XDG_DATA_HOME/caddy` / `$HOME/.local/share/caddy`.
 */
async function detectDefaultStoragePath(): Promise<string> {
  try {
    await cockpit.spawn(["test", "-d", "/var/lib/caddy"], { superuser: "try", err: "ignore" });
    return "/var/lib/caddy";
  } catch {
    // Not running under the systemd StateDirectory layout — fall through to the
    // user-data-dir default.
  }
  const user = await cockpit.user();
  return `${user.home}/.local/share/caddy`;
}

/**
 * Resolves the effective storage path and best-effort disk usage/certificate count for
 * the "Storage" panel (#46). Every probe is independently best-effort: an unreachable or
 * not-yet-created path (e.g. Caddy has never issued a certificate) is a normal state,
 * not an error, so failures there are swallowed rather than surfaced as load errors.
 */
export async function fetchStorageInfo(configuredPath: string | undefined): Promise<StorageInfo> {
  const path = configuredPath || await detectDefaultStoragePath();
  const info: StorageInfo = { path, isDefault: !configuredPath };

  try {
    const du = await cockpit.spawn(["du", "-sh", path], { superuser: "try", err: "ignore" });
    info.diskUsage = du.trim().split(/\s+/)[0];
  } catch {
    // Path doesn't exist yet, or du/permissions unavailable — leave undefined.
  }

  try {
    // Plain argv (no shell), so a user-supplied path can never be interpreted as a
    // shell command — path is joined into a single argument, not string-interpolated.
    const found = await cockpit.spawn(["find", `${path}/certificates`, "-name", "*.crt"], { superuser: "try", err: "ignore" });
    const trimmed = found.trim();
    info.certificateCount = trimmed ? trimmed.split("\n").length : 0;
  } catch {
    // No certificates directory yet — leave undefined.
  }

  return info;
}

/**
 * Reads the caddy.service unit's systemd `ReadWritePaths=` — when the service is sandboxed
 * with `ProtectSystem=strict`, the whole filesystem is read-only to the caddy process
 * *except* these explicitly listed paths, regardless of ordinary Unix permissions. Returns
 * `null` if this can't be determined (not systemd-managed, `systemctl` unavailable, etc.),
 * meaning the sandbox check should be skipped rather than treated as "no restrictions."
 */
async function getCaddyReadWritePaths(): Promise<string[] | null> {
  try {
    const out = await cockpit.spawn(
      ["systemctl", "show", "caddy", "--property=ReadWritePaths", "--value"],
      { superuser: "try", err: "ignore" }
    );
    const trimmed = out.trim();
    return trimmed ? trimmed.split(/\s+/) : [];
  } catch {
    return null;
  }
}

function isPathWithin(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
}

/**
 * Reads the caddy.service unit's `User=`/`Group=` — a path created fresh via `mkdir -p` as
 * root is root-owned (mode 755), which the service's actual, unprivileged user can't write
 * into even though the directory sits inside an allowed `ReadWritePaths=` prefix. Returns
 * `null` when the unit runs as root (`User=` unset) or this can't be determined, meaning no
 * chown/impersonated probe is needed.
 */
async function getCaddyServiceUser(): Promise<{ user: string; group: string } | null> {
  try {
    const out = await cockpit.spawn(
      ["systemctl", "show", "caddy", "--property=User", "--property=Group", "--value"],
      { superuser: "try", err: "ignore" }
    );
    const [user, group] = out.trim().split("\n");
    if (!user) return null;
    return { user, group: group || user };
  } catch {
    return null;
  }
}

/**
 * Checks that Caddy could actually write to a custom storage root before ever saving it
 * (#46). This matters because an unwritable path isn't caught by `caddy validate` —
 * validate only checks config *shape*, not whether the process can provision its PKI app
 * at that path — so a bad path would otherwise save successfully and only fail the next
 * time Caddy actually starts or reloads, by which point it can no longer provision
 * *anything* (breaking the whole service, not just one proxy) and the broken path is
 * already the only copy on disk. Returns an error message, or null if the path is usable.
 *
 * Ordinary Unix write-permission probes aren't enough: this check runs via `cockpit.spawn`
 * as root, which is not confined by the caddy.service's own systemd sandbox. A hardened
 * unit (`ProtectSystem=strict` + `ReadWritePaths=...`) makes the rest of the filesystem
 * read-only to the *actual* caddy process no matter what Unix permissions say — a probe
 * that mkdir/touch's successfully as root can still describe a path Caddy itself can never
 * write to. So the allowed `ReadWritePaths=` prefixes are checked first, before ever
 * touching disk.
 *
 * A second, subtler gap: even a path inside an allowed prefix can still be unusable if it's
 * freshly created by this root-run `mkdir -p`, since that leaves it root-owned — the
 * service's actual `User=`/`Group=` (e.g. a dedicated `caddy` user) then has no write access
 * to it despite the sandbox allowing the location. `chown` the directory to that user/group
 * after creating it, and probe the write itself via `runuser` as that same user rather than
 * as root, so the probe reflects exactly what the real caddy process can do.
 */
export async function checkStoragePathWritable(path: string): Promise<string | null> {
  const readWritePaths = await getCaddyReadWritePaths();
  if (readWritePaths && readWritePaths.length > 0 && !readWritePaths.some(p => isPathWithin(path, p))) {
    return i18n.t("errors.path_outside_sandbox", { allowed: readWritePaths.join(", "), path });
  }
  try {
    await cockpit.spawn(["mkdir", "-p", path], { superuser: "try", err: "message" });
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  const serviceUser = await getCaddyServiceUser();
  if (serviceUser) {
    try {
      await cockpit.spawn(["chown", "-R", `${serviceUser.user}:${serviceUser.group}`, path], { superuser: "try", err: "message" });
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }
  const probeFile = `${path}/.cockpit-caddy-write-test`;
  const touchArgv = serviceUser
    ? ["runuser", "-u", serviceUser.user, "--", "touch", probeFile]
    : ["touch", probeFile];
  try {
    await cockpit.spawn(touchArgv, { superuser: "try", err: "message" });
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  await cockpit.spawn(["rm", "-f", probeFile], { superuser: "try", err: "ignore" }).catch(() => {});
  return null;
}

/**
 * Same check as checkStoragePathWritable, adapted for a log *file* path rather than a
 * directory (#155/#158): `caddy validate` runs as root and silently provisions a brand-new
 * file-based log as a side effect, creating it root-owned — which then permanently blocks
 * the real (unprivileged, sandboxed) caddy.service from writing to it on the actual reload
 * that follows. Reproduced against a real production Caddyfile, not just the test VM. This
 * checks the log file's *parent directory* against ReadWritePaths= and mkdir's/chowns that
 * directory (not the file itself, and not recursively — an existing log directory may
 * already contain other files this shouldn't touch), then probes writing the exact target
 * file as the caddy service user.
 */
export async function checkLogFileWritable(filePath: string): Promise<string | null> {
  const lastSlash = filePath.lastIndexOf("/");
  const dir = lastSlash > 0 ? filePath.slice(0, lastSlash) : "/";

  const readWritePaths = await getCaddyReadWritePaths();
  if (readWritePaths && readWritePaths.length > 0 && !readWritePaths.some(p => isPathWithin(filePath, p))) {
    return i18n.t("errors.path_outside_sandbox", { allowed: readWritePaths.join(", "), path: filePath });
  }
  try {
    await cockpit.spawn(["mkdir", "-p", dir], { superuser: "try", err: "message" });
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  const serviceUser = await getCaddyServiceUser();
  if (serviceUser) {
    try {
      await cockpit.spawn(["chown", `${serviceUser.user}:${serviceUser.group}`, dir], { superuser: "try", err: "message" });
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }
  const touchArgv = serviceUser
    ? ["runuser", "-u", serviceUser.user, "--", "touch", filePath]
    : ["touch", filePath];
  try {
    await cockpit.spawn(touchArgv, { superuser: "try", err: "message" });
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  // Ensure the just-created (or already-existing but possibly root-owned from a prior
  // poisoned validate) file itself is owned by the service user, not whoever ran the probe.
  if (serviceUser) {
    await cockpit.spawn(["chown", `${serviceUser.user}:${serviceUser.group}`, filePath], { superuser: "try", err: "ignore" }).catch(() => {});
  }
  return null;
}

/**
 * Rewrites every hostless proxy/server's own tls block so its internal-issuer
 * lifetime matches the shared value exactly — every hostless site must carry
 * byte-for-byte identical issuer config or Caddy refuses to reload (see
 * buildTlsCaddyLines/forceHostlessLifetime). Hostname-scoped proxies/servers are
 * left untouched; they scope their own lifetime independently. If Caddy's admin
 * API isn't reachable, hostnames can't be resolved from the live config, so this
 * skips propagation entirely — existing hostless proxies keep their previous
 * lifetime until their next individual edit re-applies the current shared value.
 */
async function applyInternalLifetimeToProxyConf(content: string, internalCertLifetime: string | undefined): Promise<string> {
  let config: CaddyConfig;
  try {
    config = await fetchCaddyConfig();
  } catch {
    return content;
  }

  const serverDefs = parseServerDefsFromConf(content);
  const proxies = parseProxies(config, serverDefs);
  // parseProxies never populates .label (that's a UI-layer merge over `# label:` comments,
  // done in useProxies) — without re-attaching it here, rewriting a standalone proxy's
  // block below would silently drop its label comment.
  const labels = parseLabelsFromCaddyfile(content);

  let updated = content;
  for (const p of proxies) {
    if (!p.tls || p.namedServerKey) continue;
    const label = proxyAddressKeys(p).map(k => labels[k]).find(Boolean);
    updated = surgicallyWriteProxy(updated, { ...p, label, tlsAdvanced: applyGlobalInternalLifetimeToProxy(p, internalCertLifetime) });
  }
  for (const def of serverDefs) {
    if (!def.tls) continue;
    const routes = proxies.filter(p => p.namedServerKey === def.key);
    updated = surgicallyWriteServerBlock(updated, { ...def, tlsAdvanced: applyGlobalInternalLifetimeToServer(def, internalCertLifetime) }, routes);
  }
  return updated;
}

/**
 * Strips the dedicated metrics site block (see buildMetricsSiteBlock) out of conf.d content.
 * That block is intentionally a bare `:PORT { }` address with no TLS directive — the same
 * shape scanConfigIssues' "missing http:// scheme" check exists to flag for actual proxies
 * — but it isn't a proxy this app tracks/toggles TLS for at all, so scanning it produces a
 * bogus finding whose "fix" rewrites the block header to `http://:PORT`, which
 * parseMetricsSiteBlock then reads back as an invalid metricsListenAddress (bug #161).
 */
function stripMetricsSiteBlock(content: string): string {
  const bi = content.indexOf(METRICS_SITE_BEGIN);
  const ei = content.indexOf(METRICS_SITE_END);
  if (bi === -1 || ei === -1) return content;
  return content.slice(0, bi) + content.slice(ei + METRICS_SITE_END.length);
}

/**
 * Generic pure helper: inserts/replaces/removes a marked section delimited by
 * `beginMarker`/`endMarker` at the top level of a conf.d file (i.e. not nested inside the
 * main Caddyfile's `{ }` global options block, unlike patchManagedSection). `body` is the
 * new content between the markers (empty string = remove the section).
 */
function patchTopLevelMarkedSection(content: string, beginMarker: string, endMarker: string, body: string): string {
  const bi = content.indexOf(beginMarker);
  const ei = content.indexOf(endMarker);

  if (bi !== -1 && ei !== -1) {
    if (!body) {
      const before = content.slice(0, bi).replace(/\n[ \t]*\n?$/, "\n");
      const after = content.slice(ei + endMarker.length).replace(/^[ \t]*\n/, "");
      return before.trimEnd() + "\n\n" + after.trimStart();
    }
    return content.slice(0, bi + beginMarker.length) + "\n" + body + "\n" + content.slice(ei);
  }

  if (!body) return content;
  const base = content.trim() ? content.trimEnd() : CONF_HEADER;
  return base + "\n\n" + beginMarker + "\n" + body + "\n" + endMarker + "\n";
}

/**
 * Saves the global options. `dnsSecrets` (#261) are DNS provider credentials for the root-only
 * env file, applied first so validation sees them. `restartNeeded` is true when that env
 * changed: Caddy only reads it on a restart, not on a reload.
 */
export async function syncGlobalOptions(
  opts: GlobalOptions,
  dnsSecrets?: { set: Record<string, string>; remove: string[] },
): Promise<{ restartNeeded: boolean }> {
  await ensureConfDImported(); // a stock Caddyfile is migrated first (#256)
  // New values first, so validation sees them; removals only once the Caddyfile no longer
  // references them (a failed save must not leave an acme_dns block without its credentials).
  const applied = dnsSecrets ? await applyDnsSecrets(dnsSecrets.set, []) : null;
  try {
    await writeGlobalOptions(opts);
  } catch (e) {
    // #316: the env file goes back to what it held before this save.
    await applied?.restore();
    throw e;
  }
  const removed = dnsSecrets?.remove.length ? (await applyDnsSecrets({}, dnsSecrets.remove)).changed : false;
  return { restartNeeded: (applied?.changed ?? false) || removed };
}

/** Writes and validates the main Caddyfile and conf.d for syncGlobalOptions, restoring both on failure. */
async function writeGlobalOptions(opts: GlobalOptions): Promise<void> {
  const diskContent = (await getHost().readFile(MAIN_CADDYFILE, { superuser: "try" })) ?? "";
  let patched = buildGlobalOptionsPatch(diskContent, opts);

  // #153 — trusted_proxies must also be re-merged into every per-port managed servers
  // block (see buildManagedServersBlocks' comment), not just the global servers{} block
  // buildGlobalOptionsPatch just wrote above, since Caddy's per-port `servers :PORT{}`
  // fully replaces (doesn't merge with) the global block's settings for that port.
  try {
    const config = await fetchCaddyConfig();
    const serverDefs = parseServerDefsFromConf((await getHost().readFile(PROXY_CONF_PATH, { superuser: "try" })) ?? "");
    const proxies = parseProxies(config, serverDefs);
    patched = patchMainCaddyfile(patched, buildManagedServersBlocks(proxies, opts.trustedProxies, opts.proxyProtocol));
  } catch {
    // Admin API unreachable — existing per-port blocks (if any) keep whatever
    // trusted_proxies they last had; they'll refresh next time a proxy is added/edited.
  }

  const proxyConfDisk = (await getHost().readFile(PROXY_CONF_PATH, { superuser: "try" })) ?? "";
  let proxyConfPatched = await applyInternalLifetimeToProxyConf(proxyConfDisk, opts.internalCertLifetime);
  proxyConfPatched = patchTopLevelMarkedSection(proxyConfPatched, METRICS_SITE_BEGIN, METRICS_SITE_END, buildMetricsSiteBlock(opts));

  if (patched === diskContent && proxyConfPatched === proxyConfDisk) return;

  // #158's runtime logger lives in the main Caddyfile's global options, not conf.d: applyCaddyConfig
  // checks the log paths of both files.
  await applyCaddyConfig([
    { path: MAIN_CADDYFILE, content: patched },
    { path: PROXY_CONF_PATH, content: proxyConfPatched },
  ]);
}

/**
 * Runs a site save with its own DNS credentials (#289). New values go to the env file first
 * and Caddy restarts, since it only reads that file at start: the reload that follows the
 * save would otherwise provision the provider without them. A failed save puts the env file
 * back as it was (#316), except after a CaddyApiError, when the Caddyfile is already saved.
 * Variables the site no longer uses go once the save is through.
 */
export async function saveWithDnsSecrets<T>(
  secrets: { set: Record<string, string>; remove: string[] } | undefined,
  save: () => Promise<T>,
): Promise<T> {
  const applied = secrets && Object.keys(secrets.set).length ? await applyDnsSecrets(secrets.set, []) : null;
  let result: T;
  try {
    if (applied?.changed && caddyManaged) await restartService("caddy");
    result = await save();
  } catch (e) {
    if (!(e instanceof CaddyApiError)) await applied?.restore();
    throw e;
  }
  if (secrets?.remove.length) await applyDnsSecrets({}, secrets.remove);
  return result;
}

/** Read current global options from the main Caddyfile, merged with the metrics site
 *  block's own listen address/path/format read back out of conf.d. */
export async function readGlobalOptions(): Promise<GlobalOptions> {
  const content = (await getHost().readFile(MAIN_CADDYFILE, { superuser: "try" })) ?? "";
  const opts = parseGlobalOptions(content);
  const proxyConf = (await getHost().readFile(PROXY_CONF_PATH, { superuser: "try" })) ?? "";
  return { ...opts, ...parseMetricsSiteBlock(proxyConf) };
}

// ---------------------------------------------------------------------------
// Config health check ("Fix Config" maintenance action)
// ---------------------------------------------------------------------------

export interface ConfigFinding {
  id: string;
  title: string;
  explanation: string;
  before: string;
  after: string;
  /** Applies just this one finding. Pure — callers chain these over the current file contents. */
  fix: (main: string, proxyConf: string) => { main: string; proxyConf: string };
}

/** Strips a leading "http://"/"https://" (or any scheme://) from an address, if present. */
function stripScheme(addr: string): string {
  return addr.replace(/^\w[\w+.-]*:\/\//, "");
}

/** Replaces just the header line of a raw block/section, preserving everything after it. */
function replaceHeaderLine(raw: string, newHeaderLine: string): string {
  const idx = raw.indexOf("\n");
  return idx === -1 ? newHeaderLine : newHeaderLine + raw.slice(idx);
}

/**
 * Scans the current Caddyfile + conf.d for known-stale configuration shapes left over
 * by older versions of this plugin (or hand-editing), each traced to a specific Caddy
 * reload failure this app has hit in the past. Detection and fixes are both pure text
 * operations — no live Caddy connection required — so this works even when the config
 * is currently broken and Caddy won't reload at all.
 */
export function scanConfigIssues(mainContent: string, proxyConfContent: string): ConfigFinding[] {
  const findings: ConfigFinding[] = [];

  // --- Stale literal `cert_issuer internal { lifetime X }` global directive ---
  // Caddy rejects this the moment any hostless proxy also sets its own TLS lifetime,
  // since it sees two different definitions of the same default certificate policy.
  const certIssuerMatch = mainContent.match(/[ \t]*cert_issuer\s+internal\s*\{\s*\n[ \t]*lifetime\s+(\S+)\s*\n[ \t]*\}\n?/);
  let effectiveLifetime = parseGlobalOptions(mainContent).internalCertLifetime;
  if (certIssuerMatch) {
    const lifetime = certIssuerMatch[1];
    effectiveLifetime = lifetime;
    findings.push({
      id: "stale-cert-issuer-directive",
      title: i18n.t("config_check.cert_issuer_title"),
      explanation: i18n.t("config_check.cert_issuer_explanation", { lifetime }),
      before: certIssuerMatch[0].trim(),
      after: `${INTERNAL_LIFETIME_MARKER} ${lifetime}`,
      fix: (main, proxyConf) => {
        const stripped = main.replace(certIssuerMatch[0], "");
        const opts = { ...parseGlobalOptions(stripped), internalCertLifetime: lifetime };
        return { main: buildGlobalOptionsPatch(stripped, opts), proxyConf };
      },
    });
  }

  const serverDefs = parseServerDefsFromConf(proxyConfContent);
  const serverKeyByPort = new Map<string, string>();
  for (const def of serverDefs) {
    for (const addr of def.listenAddresses) {
      const port = addr.match(/:(\d+)$/)?.[1];
      if (port) serverKeyByPort.set(port, def.key);
    }
  }
  const defByKey = new Map(serverDefs.map(d => [d.key, d]));
  const externalMap = parseConfExternalAddresses(proxyConfContent);

  // Unlike parseConfTlsMap, this does NOT treat an "https://" address as TLS-enabled —
  // that shortcut is exactly wrong for detecting the bug this check exists to find (an
  // https:// address with no actual tls directive backing it, which used to happen
  // whenever the protocol dropdown and the TLS toggle disagreed).
  function hasExplicitTlsDirective(raw: string): boolean {
    for (const line of raw.split("\n").slice(1)) {
      const t = line.trim();
      if (t === "tls" || (t.startsWith("tls ") && !t.startsWith("tls off"))) return true;
    }
    return false;
  }

  // Applies both checks (missing http:// scheme, hostless lifetime drift) to a single raw
  // block — used for both standalone proxy blocks and named-server blocks alike, since a
  // named server's block is textually the same shape, just with a `# server:` key.
  function checkBlock(block: RawBlock, tlsEnabled: boolean, isHostless: boolean, label: string, idSuffix: string) {
    // Every address of a multi-host header (#208) needs its own http://.
    const parts = block.address.split(/[\s,]+/).filter(Boolean);
    if (!tlsEnabled && !parts.every(a => a.startsWith("http://"))) {
      const newHeaderLine = `${parts.map(a => `http://${stripScheme(a)}`).join(", ")} {`;
      findings.push({
        id: `missing-http-scheme:${idSuffix}`,
        title: i18n.t("config_check.http_scheme_title", { target: label }),
        explanation: i18n.t("config_check.http_scheme_explanation"),
        before: `${block.address} {`,
        after: newHeaderLine,
        fix: (main, proxyConf) => ({
          main,
          proxyConf: proxyConf.replace(block.raw, replaceHeaderLine(block.raw, newHeaderLine)),
        }),
      });
    }

    if (tlsEnabled && isHostless) {
      const lifetimeMatch = block.raw.match(/issuer internal \{\s*\n[ \t]*lifetime\s+(\S+)/);
      const current = lifetimeMatch?.[1];
      if ((current ?? "") !== (effectiveLifetime ?? "")) {
        const fixedRaw = effectiveLifetime
          ? (lifetimeMatch
            ? block.raw.replace(/(issuer internal \{\s*\n[ \t]*lifetime\s+)(\S+)/, `$1${effectiveLifetime}`)
            : block.raw.replace(/\bissuer internal\b(?!\s*\{)/, `issuer internal {\n\t\t\tlifetime ${effectiveLifetime}\n\t\t}`))
          : block.raw.replace(/issuer internal \{\s*\n[ \t]*lifetime\s+\S+\s*\n[ \t]*\}/, "issuer internal");
        findings.push({
          id: `lifetime-drift:${idSuffix}`,
          title: i18n.t("config_check.lifetime_drift_title", { target: label }),
          explanation: i18n.t("config_check.lifetime_drift_explanation", {
            current: current ? `"${current}"` : i18n.t("config_check.lifetime_drift_current_none"),
            shared: effectiveLifetime ? `"${effectiveLifetime}"` : i18n.t("config_check.lifetime_drift_shared_none"),
          }),
          before: current ? `lifetime ${current}` : i18n.t("config_check.no_explicit_lifetime"),
          after: effectiveLifetime ? `lifetime ${effectiveLifetime}` : i18n.t("config_check.no_explicit_lifetime"),
          fix: (main, proxyConf) => ({ main, proxyConf: proxyConf.replace(block.raw, fixedRaw) }),
        });
      }
    }
  }

  for (const block of extractRawBlocksFromCaddyfile(stripMetricsSiteBlock(proxyConfContent))) {
    const serverKey = block.port !== undefined ? serverKeyByPort.get(String(block.port)) : undefined;
    if (serverKey) {
      const def = defByKey.get(serverKey);
      if (def) checkBlock(block, def.tls, namedServerIsHostless(def.listenAddresses), i18n.t("config_check.target_server", { name: def.name }), `server:${def.key}`);
      continue;
    }
    const tlsEnabled = hasExplicitTlsDirective(block.raw);
    const host = externalMap[block.address]?.host;
    checkBlock(block, tlsEnabled, !tlsSubjectHosts(host).length, `"${block.address}"`, block.address);
  }

  return findings;
}

/** Applies the selected findings (by id) in sequence, starting from the given file contents. */
export function applyConfigFindings(
  findings: ConfigFinding[],
  selectedIds: Set<string>,
  mainContent: string,
  proxyConfContent: string,
): { main: string; proxyConf: string } {
  let main = mainContent;
  let proxyConf = proxyConfContent;
  for (const finding of findings) {
    if (!selectedIds.has(finding.id)) continue;
    ({ main, proxyConf } = finding.fix(main, proxyConf));
  }
  return { main, proxyConf };
}

/**
 * Runs scanConfigIssues against the files on disk, applies the selected findings,
 * validates, and writes both files atomically — reverting both on validation failure.
 */
export async function runConfigFixes(selectedIds: Set<string>): Promise<ConfigFinding[]> {
  const mainDisk = (await getHost().readFile(MAIN_CADDYFILE, { superuser: "try" })) ?? "";
  const proxyConfDisk = (await getHost().readFile(PROXY_CONF_PATH, { superuser: "try" })) ?? "";
  const findings = scanConfigIssues(mainDisk, proxyConfDisk);
  const { main, proxyConf } = applyConfigFindings(findings, selectedIds, mainDisk, proxyConfDisk);

  if (main === mainDisk && proxyConf === proxyConfDisk) return findings;

  const logPaths = new Set([
    ...(main !== mainDisk ? extractLogFilePaths(main) : []),
    ...(proxyConf !== proxyConfDisk ? extractLogFilePaths(proxyConf) : []),
  ]);
  for (const logPath of logPaths) {
    const err = await checkLogFileWritable(logPath);
    if (err) throw new CaddyfileError(i18n.t("errors.log_file_not_writable", { path: logPath, error: err }));
  }
  await getHost().writeFile(MAIN_CADDYFILE, main, { superuser: "try" });
  await getHost().writeFile(PROXY_CONF_PATH, proxyConf, { superuser: "try" });
  try {
    await runCaddyValidate();
  } catch (e) {
    await getHost().writeFile(MAIN_CADDYFILE, mainDisk, { superuser: "try" });
    await getHost().writeFile(PROXY_CONF_PATH, proxyConfDisk, { superuser: "try" });
    throw e;
  }
  await fixAccessLogFileOwnership(main);
  await fixAccessLogFileOwnership(proxyConf);
  return findings;
}
