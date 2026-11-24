import type { CaddyConfig, CaddyHandler, CaddyReverseProxyHandler, CaddyRoute, CaddyServer, CaddyTLSClientAuthentication, CaddyTLSConnectionPolicy, ProxyEntry } from "./types";
import { readFile as fsReadFile, writeFile as fsWriteFile } from "@rxtx4816/cockpit-plugin-base-react/lib/cockpit-fs";
import { reloadService as reloadSystemdService } from "@rxtx4816/cockpit-plugin-base-react/systemd";
import { i18n } from "@rxtx4816/cockpit-plugin-base-react/i18n";
import { listConfDFiles, readCaddyfile, writeCaddyfile } from "./systemd";
import { externalHostList } from "./externalHosts";

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

/**
 * Converts a Caddy duration value to a string.
 * Caddy stores durations as nanosecond integers in JSON when loaded from a
 * Caddyfile (e.g. "10s" becomes 10000000000). This normalises both forms to
 * a human-readable string like "10s", "2m", "1h".
 */
function parseDuration(val: unknown): string | undefined {
  if (typeof val === "string") return val || undefined;
  if (typeof val === "number" && val > 0) {
    const s = val / 1_000_000_000;
    if (s % 3600 === 0) return `${s / 3600}h`;
    if (s % 60 === 0) return `${s / 60}m`;
    return `${s}s`;
  }
  return undefined;
}

/**
 * Like parseDuration, but prefers day granularity first — certificate lifetimes
 * are commonly entered as "90d", and converting straight to hours (e.g. "2160h")
 * after a Caddyfile reload, while technically equivalent, doesn't match what the
 * user actually typed. Caddy's internal-issuer `lifetime` only accepts Go's
 * standard duration units (ns/us/ms/s/m/h) plus "d" — NOT "y" ("unknown unit y"),
 * so a year has to be expressed as days.
 */
function parseCertLifetimeDuration(val: unknown): string | undefined {
  if (typeof val === "string") return val || undefined;
  if (typeof val === "number" && val > 0) {
    const s = val / 1_000_000_000;
    if (s % 86_400 === 0) return `${s / 86_400}d`;
    return parseDuration(val);
  }
  return undefined;
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
    throw new Error(msg || `HTTP ${code}`);
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

/** The import line the plugin adds when the main Caddyfile doesn't import conf.d at all. */
export const CONF_D_IMPORT_LINE = "import /etc/caddy/conf.d/*.conf";

/** Any `import` line that pulls in something from conf.d, in whatever form the user wrote it. */
const ANY_CONF_D_IMPORT = /^[ \t]*import[ \t]+\S*conf\.d\//m;

/** `import [/etc/caddy/]conf.d/*` or `…/*.conf`, the globs whose files can be inlined. */
const CONF_D_GLOB_IMPORT = /^[ \t]*import[ \t]+(?:\/etc\/caddy\/)?conf\.d\/\*(\.conf)?[ \t]*$/m;

/**
 * Returns the main Caddyfile with the plugin's conf.d import added, but only when
 * there is no conf.d import yet. An import the user wrote (a bare `conf.d/*`, a
 * relative path, a single file) is left exactly as it is.
 */
export function withConfDImport(caddyfile: string): string {
  if (ANY_CONF_D_IMPORT.test(caddyfile)) return caddyfile;
  return caddyfile.trimEnd() + "\n" + CONF_D_IMPORT_LINE + "\n";
}

/**
 * Makes sure Caddy loads conf.d. Adds the plugin's import line only when the main
 * Caddyfile has no conf.d import at all; an import the user wrote stays untouched.
 */
export async function ensureConfDImported(): Promise<void> {
  const content = await readCaddyfile();
  if (isStockCaddyfile(content)) {
    // The distro's welcome site moves into conf.d on the first save (#256), no gate needed.
    const { caddyfile, confD } = migrateStockCaddyfile(content, await readProxyConf(), i18n.t("migration.welcome_label"));
    await cockpit.spawn(["mkdir", "-p", "/etc/caddy/conf.d"], { superuser: "try" });
    await fsWriteFile(PROXY_CONF_PATH, confD, "try");
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
  const main = (await fsReadFile(MAIN_CADDYFILE, "try")) ?? "";
  if (!CONF_D_GLOB_IMPORT.test(main)) return main;
  const paths = await listConfDFiles();
  const contents = await Promise.all(paths.map(p => fsReadFile(p, "try")));
  const files = paths.flatMap((path, i) => (contents[i] ? [{ path, content: contents[i] }] : []));
  return inlineConfDImport(main, files);
}

export async function applyCurrentCaddyfileViaApi(): Promise<void> {
  await applyCaddyfileViaApi(await buildFlattenedMainCaddyfile());
}

const PROXY_CONF_PATH = "/etc/caddy/conf.d/cockpit-caddy.conf";
/** Kept here, not in snippets.ts, so caddy.ts doesn't import its own importer. Must sort before PROXY_CONF_PATH. */
const SNIPPETS_CONF_PATH = "/etc/caddy/conf.d/cockpit-caddy-snippets.conf";

/**
 * Extracts the trailing `:PORT` from a block address, if any. Used to add a
 * port-keyed fallback entry to conf.d-derived metadata maps, since a proxy
 * that's the sole occupant of its port loses its host/scheme info once
 * round-tripped through Caddy's JSON config (Caddy omits the host matcher
 * when there's nothing else on that port to disambiguate) — the exact
 * `scheme://host:port` address key then no longer matches anything.
 */
function addressPortKey(address: string): string | undefined {
  const m = address.match(/:(\d+)$/);
  if (m) return m[1];
  return schemeOnlyPort(parseSiteAddresses(address))?.toString();
}

/**
 * The port of a header made only of hostless schemes, such as the distros' `http:// {`
 * welcome site (#256): 80 for `http://`, 443 for `https://`. Undefined for anything else.
 */
function schemeOnlyPort(addresses: SiteAddress[] | undefined): number | undefined {
  if (!addresses?.length || addresses.some(a => a.host || a.port !== undefined || a.path || !a.scheme)) return undefined;
  if (addresses.every(a => a.scheme === "http")) return 80;
  if (addresses.every(a => a.scheme === "https")) return 443;
  return undefined;
}

/**
 * Stores `value` under a block's address key, plus a port-number fallback key (see
 * addressPortKey). A hand-written multi-address header (#208) such as `a.com,b.com` or
 * `a.com b.com` is also stored under the `a.com, b.com` spelling that proxyAddressKeys
 * produces.
 */
export function setBlockResult<T>(result: Record<string, T>, block: RawBlock, value: T): void {
  result[block.address] = value;
  const canonical = block.address.split(/[\s,]+/).filter(Boolean).join(", ");
  if (canonical !== block.address && !(canonical in result)) result[canonical] = value;
  const portKey = block.port !== undefined ? String(block.port) : addressPortKey(block.address);
  if (portKey && !(portKey in result)) result[portKey] = value;
}

/** One address of a Caddyfile site block header. */
interface SiteAddress {
  scheme?: string;
  host?: string;
  port?: number;
  path?: string;
}

/**
 * Splits a site block header into its addresses. Caddy accepts several addresses per
 * block (#208), separated by commas and/or spaces. Returns undefined when any part
 * doesn't look like a site address (a snippet `(name)`, a named route `&(name)`, ...).
 */
function parseSiteAddresses(header: string): SiteAddress[] | undefined {
  const parts = header.split(/[\s,]+/).filter(Boolean);
  if (!parts.length) return undefined;
  const out: SiteAddress[] = [];
  for (const part of parts) {
    const m = part.match(/^(?:([A-Za-z][\w+.-]*):\/\/)?(\[[0-9A-Fa-f:.]+\]|[^\s:/()&{}[\]]*)(?::(\d+))?(\/\S*)?$/);
    if (!m) return undefined;
    out.push({
      scheme: m[1],
      host: m[2] || undefined,
      port: m[3] ? parseInt(m[3], 10) : undefined,
      path: m[4],
    });
  }
  return out;
}

export interface RawBlock {
  /** The complete original block text, header line through closing brace. */
  raw: string;
  /**
   * Full trimmed header text before the opening brace, e.g. ":8080",
   * "https://host.example.com:8080", or a bare hostname like "git.example.com".
   * Unique per top-level block — use this as the block's key, not `port`.
   */
  address: string;
  /** Parsed port, if the header contains one. Bare-hostname addresses have no port. */
  port?: number;
  label: string | null;
}

/**
 * Extracts top-level site-address blocks from a Caddyfile verbatim.
 * Only the global options block (a bare `{` with nothing before it) is skipped —
 * any other non-empty header text is a valid Caddyfile site address (port,
 * `ip:port`, `scheme://host[:port]`, bare host, or comma-separated list), with
 * or without a port.
 * Labels are taken from the first `# comment` line found inside each block.
 */
export function extractRawBlocksFromCaddyfile(content: string): RawBlock[] {
  const blocks: RawBlock[] = [];
  const lines = content.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#") || !trimmed.endsWith("{")) {
      i++;
      continue;
    }

    if (trimmed === "{") {
      // Global options block — consume and skip
      let depth = 1;
      i++;
      while (i < lines.length && depth > 0) {
        const t = lines[i].trim();
        depth += (t.match(/\{/g) ?? []).length - (t.match(/\}/g) ?? []).length;
        i++;
      }
      continue;
    }

    const address = trimmed.slice(0, -1).trim();
    const portMatch = trimmed.match(/:(\d+)[^{]*\{$/);
    const port = portMatch ? parseInt(portMatch[1], 10) : undefined;
    const blockLines: string[] = [line];
    let depth = 1;
    let label: string | null = null;
    i++;

    while (i < lines.length && depth > 0) {
      const inner = lines[i];
      const innerTrimmed = inner.trim();
      depth += (innerTrimmed.match(/\{/g) ?? []).length - (innerTrimmed.match(/\}/g) ?? []).length;
      if (label === null && depth > 0 && innerTrimmed.startsWith("#")) {
        const text = innerTrimmed.slice(1).trim();
        if (text) label = text;
      }
      blockLines.push(inner);
      i++;
    }

    blocks.push({ raw: blockLines.join("\n"), address, port, label });
  }

  return blocks;
}

/**
 * Migration (#267): the site blocks to move to conf.d, and the main Caddyfile without them.
 * Only real site blocks move. Snippets `(name) { }`, named routes, other imports and comments
 * stay where they were, so sites that `import` a snippet still find it. A conf.d import the
 * user already has (e.g. the distro's `import /etc/caddy/conf.d/*`) is kept as written; the
 * plugin's own import is added only when there is none.
 */
export function migrateCaddyfile(content: string): { blocks: RawBlock[]; caddyfile: string } {
  const blocks = extractRawBlocksFromCaddyfile(content).filter(b => parseSiteAddresses(b.address) !== undefined);
  let rest = content;
  for (const b of blocks) {
    const at = rest.indexOf(b.raw);
    if (at !== -1) rest = rest.slice(0, at) + rest.slice(at + b.raw.length);
  }
  rest = rest.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
  return { blocks, caddyfile: withConfDImport(rest.trimEnd() + "\n") };
}

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

export async function writeRawProxyConf(content: string): Promise<void> {
  await fsWriteFile(PROXY_CONF_PATH, content, "try");
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
  const original = (await fsReadFile(path, "try").catch(() => null)) ?? "";
  // Catches an unwritable log file path *before* ever saving it — see
  // checkLogFileWritable for why `caddy validate` succeeding isn't enough on its own.
  for (const logPath of new Set(extractLogFilePaths(content))) {
    const err = await checkLogFileWritable(logPath);
    if (err) throw new CaddyfileError(i18n.t("errors.log_file_not_writable", { path: logPath, error: err }));
  }
  await fsWriteFile(path, content, "try");
  try {
    await runCaddyValidate();
  } catch (e) {
    await fsWriteFile(path, original, "try");
    throw e;
  }
  await fixAccessLogFileOwnership(content);
}

/** The plugin's snippets file (#288); empty when it doesn't exist yet. */
export async function readSnippetsConf(): Promise<string> {
  try {
    return (await fsReadFile(SNIPPETS_CONF_PATH, "try")) ?? "";
  } catch {
    return "";
  }
}

/** Writes the snippets file, validates the whole Caddyfile, and restores the old file on an error. */
export async function writeSnippetsConfValidated(content: string): Promise<void> {
  await cockpit.spawn(["mkdir", "-p", "/etc/caddy/conf.d"], { superuser: "try" });
  await writeConfDFileValidated(SNIPPETS_CONF_PATH, content);
}

/** Every `output file <path>` target referenced anywhere in Caddyfile content, covering
 *  both the single-line and rotation-block (#155) forms. */
export function extractLogFilePaths(content: string): string[] {
  const paths: string[] = [];
  const re = /output\s+file\s+(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) paths.push(m[1]);
  return paths;
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
 * Parses labels from the legacy Caddyfile format where the label is a comment
 * inside the block (e.g. "# homarr" as first comment inside the block).
 * Keyed by the block's full address (see RawBlock.address).
 */
export function parseLegacyLabelsFromCaddyfile(content: string): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const block of extractRawBlocksFromCaddyfile(content)) {
    if (block.label) labels[block.address] = block.label;
  }
  return labels;
}

/**
 * Parses externalScheme and externalHost from block headers in the conf.d content.
 * Keyed by the block's full address (see RawBlock.address). Handles:
 *   scheme://host:PORT {   → { scheme, host }
 *   host:PORT {            → { host }
 *   host {                 → { host }  (bare hostname, no port)
 *   a:PORT, b:PORT {       → { host: "a, b" }  (several names, #208)
 *   :PORT {                → {}
 *   http://:PORT {         → {}
 * The scheme is kept only when every address carries the same one.
 */
export function parseConfExternalAddresses(content: string): Record<string, { scheme?: string; host?: string }> {
  const result: Record<string, { scheme?: string; host?: string }> = {};
  for (const block of extractRawBlocksFromCaddyfile(content)) {
    const addresses = parseSiteAddresses(block.address);
    if (!addresses) continue;
    const hosts = addresses.map(a => a.host).filter((h): h is string => !!h);
    if (!hosts.length) continue;
    const scheme = addresses[0].scheme;
    const host = [...new Set(hosts)].join(", ");
    setBlockResult(result, block, scheme && addresses.every(a => a.scheme === scheme) ? { scheme, host } : { host });
  }
  return result;
}

/**
 * Returns an address → tls map by reading raw block content from the conf.d file.
 * Detects TLS via `https://` block header or a `tls` directive (not `tls off`).
 * Used to supplement the JSON API when Caddy hasn't finished applying TLS
 * automation after a reload (race condition on hostname-based blocks).
 */
export function parseConfTlsMap(content: string): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const block of extractRawBlocksFromCaddyfile(content)) {
    let hasTls = block.address.startsWith("https://");
    if (!hasTls) {
      for (const line of block.raw.split("\n").slice(1)) {
        const t = line.trim();
        if ((t === "tls" || (t.startsWith("tls ") && !t.startsWith("tls off")))) {
          hasTls = true;
          break;
        }
      }
    }
    setBlockResult(result, block, hasTls);
  }
  return result;
}

/**
 * Returns address → certificate issuer (#246) for conf.d site blocks that serve TLS without a
 * certificate file of their own: "internal" when the block says `tls internal` or names the
 * internal issuer, "acme" when a public name relies on Caddy's automatic HTTPS (no issuer
 * named, or an ACME one). Blocks with plain HTTP, a cert file, or no public name are left out.
 */
export function parseConfTlsIssuerMap(content: string): Record<string, "acme" | "internal"> {
  const result: Record<string, "acme" | "internal"> = {};
  for (const block of extractRawBlocksFromCaddyfile(content)) {
    const addresses = parseSiteAddresses(block.address);
    if (!addresses?.length || addresses.some(a => a.scheme === "http")) continue;
    const body = block.raw.split("\n").slice(1).map(l => l.trim());
    if (body.some(t => t === "tls off")) continue;
    // `tls <cert> <key>` loads a certificate file: no issuer at all.
    if (body.some(t => /^tls\s+(?!internal\b)\S+\s+[^\s{]/.test(t))) continue;
    const internal = body.some(t => /^tls\s+internal\b/.test(t) || /^issuer\s+internal\b/.test(t));
    const publicName = addresses.some(a => !!a.host && !isCaddyInternalSubject(a.host));
    if (internal) setBlockResult(result, block, "internal");
    else if (publicName) setBlockResult(result, block, "acme");
  }
  return result;
}

/** Returns address → true for conf.d site blocks whose `tls { }` block turns on `on_demand` (#253). */
export function parseConfTlsOnDemandMap(content: string): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const block of extractRawBlocksFromCaddyfile(content)) {
    if (block.raw.split("\n").some(l => l.trim() === "on_demand")) setBlockResult(result, block, true);
  }
  return result;
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

/**
 * Returns address → CA bundle path by reading `# tls_ca_bundle: <path>` comments (#152)
 * from conf.d site blocks. Caddy has no field for this on a manually-loaded certificate —
 * it's stored as a comment purely so the UI can show it back to the user, the same way
 * `# label:` comments round-trip route labels that aren't part of Caddy's own JSON model.
 */
export function parseConfCustomTlsCaMap(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const block of extractRawBlocksFromCaddyfile(content)) {
    for (const line of block.raw.split("\n").slice(1)) {
      const m = line.trim().match(/^# tls_ca_bundle: (.+)$/);
      if (m) {
        setBlockResult(result, block, m[1].trim());
        break;
      }
    }
  }
  return result;
}

/**
 * Returns address → AccessLogConfig by reading `log { }` blocks from the conf.d
 * site blocks. Used as a fallback when the JSON API config was last pushed by
 * older code that didn't include the logging section.
 */
export function parseConfAccessLogMap(content: string): Record<string, import("./types").AccessLogConfig> {
  const result: Record<string, import("./types").AccessLogConfig> = {};
  for (const block of extractRawBlocksFromCaddyfile(content)) {
    const lines = block.raw.split("\n");
    let inLog = false;
    let depth = 0;
    const logLines: string[] = [];
    for (let i = 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!inLog && t === "log {") { inLog = true; depth = 1; continue; }
      if (!inLog && t.startsWith("log {")) { inLog = true; depth = 1; continue; }
      if (inLog) {
        depth += (t.match(/\{/g) ?? []).length - (t.match(/\}/g) ?? []).length;
        if (depth <= 0) break;
        logLines.push(t);
      }
    }
    if (!logLines.length) continue;

    let output: import("./types").AccessLogOutput = "stderr";
    let filePath: string | undefined;
    let format: import("./types").AccessLogFormat | undefined;
    let level: import("./types").AccessLogLevel | undefined;
    let rollSizeMb: number | undefined;
    let rollKeepCount: number | undefined;
    let rollKeepDays: number | undefined;
    let rollCompress: boolean | undefined;

    for (const line of logLines) {
      if (line === "roll_uncompressed") { rollCompress = false; continue; }
      const m = line.match(/^(\w+)\s+(.*)/);
      if (!m) continue;
      const [, key, val] = m;
      if (key === "output") {
        if (val.startsWith("file ")) {
          output = "file";
          // Strips a trailing "{" from the block form ("output file <path> {") — the
          // roll_* sub-directives are separate top-level lines within logLines already
          // (brace depth is tracked across the whole log block, not per output line).
          filePath = val.slice(5).replace(/\s*\{$/, "").trim();
        } else {
          output = val.trim() as import("./types").AccessLogOutput;
        }
      } else if (key === "format") {
        format = val.trim() as import("./types").AccessLogFormat;
      } else if (key === "level") {
        level = val.trim() as import("./types").AccessLogLevel;
      } else if (key === "roll_size") {
        const mb = val.trim().match(/^(\d+(?:\.\d+)?)MiB$/i);
        if (mb) rollSizeMb = Math.round(parseFloat(mb[1]));
      } else if (key === "roll_keep") {
        rollKeepCount = parseInt(val.trim(), 10);
      } else if (key === "roll_keep_for") {
        const hrs = val.trim().match(/^(\d+(?:\.\d+)?)h$/);
        if (hrs) rollKeepDays = Math.round(parseFloat(hrs[1]) / 24);
      }
    }
    setBlockResult(result, block, { output, filePath, format, level, rollSizeMb, rollKeepCount, rollKeepDays, rollCompress });
  }
  return result;
}

/** Parses `# label: X` comments preceding a block header. Keyed by the block's full address. */
export function parseLabelsFromCaddyfile(content: string): Record<string, string> {
  const labels: Record<string, string> = {};
  let pendingLabel: string | null = null;
  for (const line of content.split("\n")) {
    const labelMatch = line.match(/^#\s*label:\s*(.+)$/);
    if (labelMatch) {
      pendingLabel = labelMatch[1].trim();
      continue;
    }
    const trimmed = line.trim();
    // Any block header (not the bare global-options `{`) counts as an addressable block.
    if (trimmed.endsWith("{") && trimmed !== "{" && pendingLabel !== null) {
      const address = trimmed.slice(0, -1).trim();
      labels[address] = pendingLabel;
      const portKey = addressPortKey(address);
      if (portKey && !(portKey in labels)) labels[portKey] = pendingLabel;
    }
    if (trimmed !== "") pendingLabel = null;
  }
  return labels;
}

export async function readProxyConf(): Promise<string> {
  try {
    return (await fsReadFile(PROXY_CONF_PATH, "try")) ?? "";
  } catch {
    return "";
  }
}

/**
 * First line of cockpit-caddy.conf. Plain information for anyone opening the file:
 * nothing parses it, apart from normalizeManagedHeader keeping a single copy.
 */
export const CONF_HEADER = "# Written by the Cockpit Caddy plugin. Hand edits are fine; saving a proxy in Cockpit rewrites only the block that holds it.";

/** Header written before #237. It read as if the plugin kept the real config elsewhere. */
export const LEGACY_CONF_HEADER = "# Managed by cockpit-caddy - edits to this file may be overwritten by user plugin actions";

/** Converts Caddyfile short placeholders to JSON API long form. */
function caddyPlaceholderToJson(s: string): string {
  return s
    .replace(/\{host\}/g, "{http.request.host}")
    .replace(/\{uri\}/g, "{http.request.uri}")
    .replace(/\{scheme\}/g, "{http.request.scheme}")
    .replace(/\{remote_host\}/g, "{http.request.remote.host}");
}

/** Converts JSON API long placeholders back to Caddyfile short form. */
function jsonPlaceholderToCaddy(s: string): string {
  return s
    .replace(/\{http\.request\.host\}/g, "{host}")
    .replace(/\{http\.request\.uri\}/g, "{uri}")
    .replace(/\{http\.request\.scheme\}/g, "{scheme}")
    .replace(/\{http\.request\.remote\.host\}/g, "{remote_host}");
}

// ---------------------------------------------------------------------------
// Caddyfile quoting — #251
// ---------------------------------------------------------------------------

/**
 * Turns a user-entered value into exactly one Caddyfile token that Caddy reads back verbatim.
 * Plain values stay as they are (unless `always`); otherwise double quotes with `\"` escapes.
 * Caddy's lexer has no escape for a backslash, so a value with `\` right before a quote or at
 * the end uses backticks (no escapes at all), and a value with newlines, or one that fits
 * neither form, uses a heredoc whose marker occurs nowhere in the value. The body and marker sit at column 0, so Caddy strips
 * no indentation from it.
 */
export function caddyQuote(value: string, opts: { always?: boolean } = {}): string {
  const needsQuotes = opts.always || value === "" || /[\s"`\\]/.test(value) || value.startsWith("#") || value === "{" || value === "}";
  if (!value.includes("\n") && !value.includes("\r")) {
    if (!needsQuotes) return value;
    if (!/\\("|$)/.test(value)) return `"${value.replace(/"/g, '\\"')}"`;
    if (!value.includes("`")) return `\`${value}\``;
  }
  // Caddy's lexer ends a heredoc as soon as the text read so far ends with the marker, even
  // mid-line, so the marker must not occur anywhere in the value.
  let marker = "END";
  for (let i = 1; value.includes(marker); i++) marker = `END${i}`;
  return `<<${marker}\n${value}\n${marker}`;
}

/**
 * One `header` / `header_up` line for a header operation, values quoted for Caddy (#251). `defer` writes a set as `>Name`: the Caddyfile adapter defers only `-`, `?`,
 * `>` and `defer`, so on a proxied route a plain set runs before reverse_proxy adds the upstream's
 * header and both reach the client (#255, checked with `caddy adapt` on 2.11.7).
 */
function headerOpLine(prefix: string, h: import("./types").HeaderOperation, opts: { quoteSet?: boolean; defer?: boolean } = {}): string {
  if (h.op === "delete") return `${prefix} -${h.name}`;
  if (h.op === "add") return `${prefix} +${h.name} ${caddyQuote(h.value ?? "")}`;
  return `${prefix} ${opts.defer ? ">" : ""}${h.name} ${caddyQuote(h.value ?? "", { always: opts.quoteSet })}`;
}

// ---------------------------------------------------------------------------
// Route Matcher helpers — #48
// ---------------------------------------------------------------------------

/** RouteMatch stores "must be present" as an empty value list; Caddy spells it "*". */
function presenceValues(vals: string[] | null | undefined): string[] {
  return vals?.length ? vals : ["*"];
}

/** Reverse of presenceValues: a lone "*" (or null/empty) becomes the empty "present" list. */
function fromPresenceValues(fields: Record<string, string[] | null>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = !v?.length || (v.length === 1 && v[0] === "*") ? [] : v;
  return out;
}

/** The matcher-field lines (path, host, ...) shared by a named matcher and its `not` block. */
function matcherFieldLines(m: import("./types").RouteMatchFields, indent: string): string[] {
  const lines: string[] = [];
  if (m.path?.length) lines.push(`${indent}path ${m.path.join(" ")}`);
  if (m.host?.length) lines.push(`${indent}host ${m.host.join(" ")}`);
  if (m.method?.length) lines.push(`${indent}method ${m.method.join(" ")}`);
  // Caddy's Caddyfile syntax has no bare "present" form for either matcher (#250): presence is
  // the "*" value, and query takes `param=value` pairs.
  if (m.header) {
    for (const [hdr, vals] of Object.entries(m.header)) {
      lines.push(`${indent}header ${hdr} ${presenceValues(vals).map(v => caddyQuote(v)).join(" ")}`);
    }
  }
  if (m.query) {
    const pairs = Object.entries(m.query).flatMap(([param, vals]) => presenceValues(vals).map(v => caddyQuote(`${param}=${v}`)));
    if (pairs.length) lines.push(`${indent}query ${pairs.join(" ")}`);
  }
  if (m.remote_ip?.ranges.length) {
    lines.push(`${indent}remote_ip ${m.remote_ip.ranges.join(" ")}`);
  }
  return lines;
}

/**
 * Generates named-matcher lines for a Caddyfile block.
 * Uses block form `@name { ... }` always (more stable for round-trips than inline form).
 */
function buildMatcherCaddyLines(m: import("./types").RouteMatch, name: string, indent: string): string[] {
  const lines: string[] = [`${indent}@${name} {`, ...matcherFieldLines(m, `${indent}\t`)];
  const notLines = m.not ? matcherFieldLines(m.not, `${indent}\t\t`) : [];
  if (notLines.length) lines.push(`${indent}\tnot {`, ...notLines, `${indent}\t}`);
  if (m.expression?.trim()) lines.push(`${indent}\texpression ${caddyQuote(m.expression.trim(), { always: true })}`);
  lines.push(`${indent}}`);
  return lines;
}

/** Caddy JSON for the plain matcher fields. */
function matcherFieldsJson(m: import("./types").RouteMatchFields): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  if (m.path?.length) obj.path = m.path;
  if (m.host?.length) obj.host = m.host;
  if (m.method?.length) obj.method = m.method;
  if (m.header && Object.keys(m.header).length) {
    const h: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(m.header)) h[k] = presenceValues(v);
    obj.header = h;
  }
  if (m.query && Object.keys(m.query).length) {
    const q: Record<string, string[]> = {};
    // An empty list never matches in Caddy's query matcher; "*" means "present".
    for (const [k, v] of Object.entries(m.query)) q[k] = presenceValues(v);
    obj.query = q;
  }
  if (m.remote_ip?.ranges.length) obj.remote_ip = { ranges: m.remote_ip.ranges };
  return obj;
}

/** Converts RouteMatch to Caddy JSON match object. */
function buildMatcherJson(m: import("./types").RouteMatch): Record<string, unknown> {
  const obj = matcherFieldsJson(m);
  const not = m.not ? matcherFieldsJson(m.not) : {};
  if (Object.keys(not).length) obj.not = [not];
  // The Caddyfile adapter expands placeholder shorthands; JSON pushed directly must do the same.
  if (m.expression?.trim()) obj.expression = { expr: expandPlaceholderShorthands(m.expression.trim()) };
  return obj;
}

/** Parses the plain matcher fields of a Caddy JSON match object. */
function parseMatcherFieldsJson(match: Record<string, unknown>): import("./types").RouteMatchFields {
  const m: import("./types").RouteMatchFields = {};
  if (Array.isArray(match.path) && match.path.length) m.path = match.path as string[];
  if (Array.isArray(match.host) && match.host.length) m.host = match.host as string[];
  if (Array.isArray(match.method) && match.method.length) m.method = match.method as string[];
  if (match.header && typeof match.header === "object") {
    const h = match.header as Record<string, string[]>;
    if (Object.keys(h).length) m.header = fromPresenceValues(h);
  }
  if (match.query && typeof match.query === "object") {
    const q = match.query as Record<string, string[]>;
    if (Object.keys(q).length) m.query = fromPresenceValues(q);
  }
  if (match.remote_ip && typeof match.remote_ip === "object") {
    const ri = (match.remote_ip as { ranges?: string[] }).ranges;
    if (ri?.length) m.remote_ip = { ranges: ri };
  }
  return m;
}

/** Parses a Caddy JSON match object back to RouteMatch. Returns undefined if empty/missing. */
function parseMatcherJson(match: Record<string, unknown> | undefined): import("./types").RouteMatch | undefined {
  if (!match || !Object.keys(match).length) return undefined;
  const m: import("./types").RouteMatch = parseMatcherFieldsJson(match);
  // Only one exclude group is supported (#287); Caddy's `not` is a list of matcher sets.
  if (Array.isArray(match.not) && match.not[0] && typeof match.not[0] === "object") {
    const not = parseMatcherFieldsJson(match.not[0] as Record<string, unknown>);
    if (Object.keys(not).length) m.not = not;
  }
  // Caddy accepts the expression as a string or as {expr, name}; the adapter writes the object.
  const rawExpr = typeof match.expression === "string" ? match.expression
    : (match.expression as { expr?: unknown } | undefined)?.expr;
  if (typeof rawExpr === "string" && rawExpr.trim()) m.expression = collapsePlaceholderShorthands(rawExpr);
  return Object.keys(m).length ? m : undefined;
}

/** True when any matcher (include, exclude or expression) is set. */
export function hasAnyMatcher(m: import("./types").RouteMatch | undefined): m is import("./types").RouteMatch {
  return !!m && Object.keys(buildMatcherJson(m)).length > 0;
}

/** Returns true when only path matchers are set (needed for handle_path eligibility). */
export function isPathOnlyMatcher(m: import("./types").RouteMatch | undefined): boolean {
  return !!m && !!(m.path?.length) && !m.host?.length && !m.method?.length && !m.header && !m.query && !m.remote_ip
    && !(m.not && Object.keys(matcherFieldsJson(m.not)).length) && !m.expression?.trim();
}

/** True when the matcher is a host list and nothing else (a hostname-only site block). */
function isHostOnlyMatcher(m: import("./types").RouteMatch | undefined): m is import("./types").RouteMatch & { host: string[] } {
  return !!m?.host?.length && !m.path && !m.method && !m.header && !m.query && !m.remote_ip && !m.not && !m.expression;
}

// Caddyfile placeholder shorthands (#287), as Caddy 2.11's adapter expands them. Exact ones first,
// then prefixes; collapsing tries the longest long form first so `{http.request.uri.path.dir}`
// becomes `{dir}`, not `{path.dir}`.
const PLACEHOLDER_SHORTHANDS: Array<[string, string]> = [
  ["host", "http.request.host"],
  ["hostport", "http.request.hostport"],
  ["port", "http.request.port"],
  ["orig_method", "http.request.orig_method"],
  ["orig_uri", "http.request.orig_uri"],
  ["orig_path", "http.request.orig_uri.path"],
  ["orig_dir", "http.request.orig_uri.path.dir"],
  ["orig_file", "http.request.orig_uri.path.file"],
  ["orig_query", "http.request.orig_uri.query"],
  ["method", "http.request.method"],
  ["uri", "http.request.uri"],
  ["path", "http.request.uri.path"],
  ["dir", "http.request.uri.path.dir"],
  ["file", "http.request.uri.path.file"],
  ["query", "http.request.uri.query"],
  ["remote", "http.request.remote"],
  ["remote_host", "http.request.remote.host"],
  ["remote_port", "http.request.remote.port"],
  ["scheme", "http.request.scheme"],
  ["uuid", "http.request.uuid"],
  ["tls_cipher", "http.request.tls.cipher_suite"],
  ["tls_version", "http.request.tls.version"],
  ["tls_client_fingerprint", "http.request.tls.client.fingerprint"],
  ["tls_client_issuer", "http.request.tls.client.issuer"],
  ["tls_client_serial", "http.request.tls.client.serial"],
  ["tls_client_subject", "http.request.tls.client.subject"],
  ["tls_client_certificate_pem", "http.request.tls.client.certificate_pem"],
  ["tls_client_certificate_der_base64", "http.request.tls.client.certificate_der_base64"],
  ["upstream_hostport", "http.reverse_proxy.upstream.hostport"],
  ["client_ip", "http.vars.client_ip"],
];
const PLACEHOLDER_PREFIXES: Array<[string, string]> = [
  ["header.", "http.request.header."],
  ["cookie.", "http.request.cookie."],
  ["labels.", "http.request.host.labels."],
  ["path.", "http.request.uri.path."],
  ["file.", "http.request.uri.path.file."],
  ["query.", "http.request.uri.query."],
  ["re.", "http.regexp."],
  ["vars.", "http.vars."],
  ["rp.", "http.reverse_proxy."],
  ["resp.", "http.intercept."],
  ["err.", "http.error."],
  ["file_match.", "http.matchers.file."],
];

function mapPlaceholders(text: string, fn: (name: string) => string): string {
  return text.replace(/\{([^{}\s]+)\}/g, (_, name: string) => `{${fn(name)}}`);
}

/** `{path}` → `{http.request.uri.path}`, the way Caddy's Caddyfile adapter expands shorthands. */
export function expandPlaceholderShorthands(text: string): string {
  return mapPlaceholders(text, name => {
    const exact = PLACEHOLDER_SHORTHANDS.find(([s]) => s === name);
    if (exact) return exact[1];
    const prefix = PLACEHOLDER_PREFIXES.find(([s]) => name.startsWith(s));
    return prefix ? prefix[1] + name.slice(prefix[0].length) : name;
  });
}

/** Reverse of expandPlaceholderShorthands, so an expression reads back as it was written. */
export function collapsePlaceholderShorthands(text: string): string {
  return mapPlaceholders(text, name => {
    const exact = PLACEHOLDER_SHORTHANDS.find(([, l]) => l === name);
    if (exact) return exact[0];
    const prefix = PLACEHOLDER_PREFIXES
      .filter(([, l]) => name.startsWith(l))
      .sort((a, b) => b[1].length - a[1].length)[0];
    return prefix ? prefix[0] + name.slice(prefix[1].length) : name;
  });
}

/** Derives the strip-prefix value from the first path pattern, e.g. "/api/*" → "/api". */
/** The prefix handle_path strips for one path: `/api/*` and `/api*` both strip `/api`. */
const handlePathPrefix = (path: string) => path.replace(/\/\*$/, "").replace(/\*$/, "");

function handlePathStripPrefix(matchers: import("./types").RouteMatch | undefined): string | undefined {
  if (matchers?.path?.length !== 1 || !isPathOnlyMatcher(matchers)) return undefined;
  return handlePathPrefix(matchers.path[0]) || undefined;
}

/**
 * Caddy's handle_path accepts a single path (#255). For several strip-prefix paths the plugin
 * writes the named matcher and `uri path_regexp <this> /`, which strips whichever prefix matched
 * and keeps the leading slash, as handle_path's strip_path_prefix does. Longest prefix first, so
 * `/a` doesn't win over `/ab`. Checked live with Caddy 2.11.7: /a/x → /x, /apix → /x.
 */
function multiPathStripRegex(matchers: import("./types").RouteMatch | undefined): string | undefined {
  if (!matchers?.path || matchers.path.length < 2 || !isPathOnlyMatcher(matchers)) return undefined;
  const prefixes = matchers.path.map(handlePathPrefix).filter(Boolean);
  if (!prefixes.length) return undefined;
  const escaped = [...new Set(prefixes)].sort((a, b) => b.length - a.length).map(p => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return `^(?:${escaped.join("|")})/?`;
}

/** Builds the rewrite handler for handle_path semantics: strip_path_prefix, or the regex strip for several paths. */
function buildHandlePathRewriteJson(matchers: import("./types").RouteMatch | undefined): CaddyHandler | undefined {
  const regex = multiPathStripRegex(matchers);
  if (regex) return { handler: "rewrite", path_regexp: [{ find: regex, replace: "/" }] } as CaddyHandler;
  const prefix = handlePathStripPrefix(matchers);
  if (!prefix) return undefined;
  return { handler: "rewrite", strip_path_prefix: prefix } as CaddyHandler;
}


// ---------------------------------------------------------------------------
// Forward authentication helpers
// ---------------------------------------------------------------------------

function buildForwardAuthCaddyLines(fa: import("./types").ForwardAuthConfig): string[] {
  if (!fa.upstreamUrl.trim()) return [];
  const lines = [`\tforward_auth ${fa.upstreamUrl} {`];
  lines.push(`\t\turi ${fa.uri || "/"}`);
  if (fa.copyHeaders.length) lines.push(`\t\tcopy_headers ${fa.copyHeaders.join(" ")}`);
  lines.push("\t}");
  return lines;
}

/** Splits a forward_auth URL into Caddy's dial address (default port filled in) and TLS flag. */
function forwardAuthDial(url: string): { dial: string; tls: boolean } {
  const tls = /^https:\/\//i.test(url.trim());
  const hostPort = url.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  const hasPort = /:\d+$/.test(hostPort) && !/^\[[^\]]*\]$/.test(hostPort);
  return { dial: hasPort ? hostPort : `${hostPort}:${tls ? 443 : 80}`, tls };
}

const RP_HEADER_PLACEHOLDER = /^\{http\.reverse_proxy\.header\.(.+)\}$/;

/**
 * Builds the same JSON as Caddy's own forward_auth Caddyfile adapter (#248): on a 2xx from
 * the auth service, each copied header is first deleted from the client's request and then
 * set from the auth response, so the backend sees who logged in and a client can't forge
 * `Remote-User`. An `https://` auth URL gets a TLS transport.
 */
function buildForwardAuthHandler(fa: import("./types").ForwardAuthConfig): CaddyHandler | null {
  if (!fa.upstreamUrl.trim()) return null;
  const { dial, tls } = forwardAuthDial(fa.upstreamUrl);
  const responseRoutes: Array<Record<string, unknown>> = [{ handle: [{ handler: "vars" }] }];
  for (const name of [...fa.copyHeaders].sort()) {
    const placeholder = `{http.reverse_proxy.header.${name}}`;
    responseRoutes.push({ handle: [{ handler: "headers", request: { delete: [name] } }] });
    responseRoutes.push({
      handle: [{ handler: "headers", request: { set: { [name]: [placeholder] } } }],
      match: [{ not: [{ vars: { [placeholder]: [""] } }] }],
    });
  }
  const rp: Record<string, unknown> = {
    handle_response: [{ match: { status_code: [2] }, routes: responseRoutes }],
    handler: "reverse_proxy",
    headers: {
      request: {
        set: {
          "X-Forwarded-Method": ["{http.request.method}"],
          "X-Forwarded-Uri": ["{http.request.uri}"],
        },
      },
    },
    rewrite: { method: "GET", uri: fa.uri || "/" },
    ...(tls ? { transport: { protocol: "http", tls: {} } } : {}),
    upstreams: [{ dial }],
  };
  return { handler: "subroute", routes: [{ handle: [rp as CaddyHandler] }] } as CaddyHandler;
}

type ResponseRoute = { handle?: Array<Record<string, unknown>>; match?: unknown };

function forwardAuthResponseRoutes(rp: CaddyReverseProxyHandler): ResponseRoute[] | undefined {
  const resp = (rp.handle_response as Array<Record<string, unknown>> | undefined)?.[0];
  const match = resp?.match as Record<string, unknown> | undefined;
  if ((match?.status_code as number[] | undefined)?.[0] !== 2) return undefined;
  return (resp?.routes as ResponseRoute[] | undefined) ?? [];
}

/**
 * A forward_auth guard: a reverse_proxy whose 2xx handle_response either copies headers into
 * the request (Caddy's adapter shape, a leading `vars` handler) or, in configs pushed by older
 * plugin versions, uses `copy_response_headers`.
 */
function isForwardAuthProxy(rp: CaddyReverseProxyHandler): boolean {
  const routes = forwardAuthResponseRoutes(rp);
  if (!routes) return false;
  return routes.some(r =>
    (r.handle ?? []).some(h => h.handler === "copy_response_headers" || h.handler === "vars"),
  );
}

function extractForwardAuthFromProxy(rp: CaddyReverseProxyHandler): import("./types").ForwardAuthConfig {
  const raw = rp as Record<string, unknown>;
  const dial = rp.upstreams?.[0]?.dial ?? "";
  const tls = !!(raw.transport as { tls?: unknown } | undefined)?.tls;
  const scheme = tls ? "https" : "http";
  const defaultPort = tls ? ":443" : ":80";
  const hostPort = /^https?:\/\//.test(dial) ? dial.replace(/^https?:\/\//, "") : dial;
  const upstreamUrl = `${scheme}://${hostPort.endsWith(defaultPort) ? hostPort.slice(0, -defaultPort.length) : hostPort}`;
  const uri = raw.rewrite as { uri?: string } | undefined;
  const handles = (forwardAuthResponseRoutes(rp) ?? []).flatMap(r => r.handle ?? []);
  const copyHandle = handles.find(h => h.handler === "copy_response_headers") as { include?: string[] } | undefined;
  const fromSets = handles.flatMap(h => {
    const set = (h.request as { set?: Record<string, string[]> } | undefined)?.set ?? {};
    return Object.entries(set).filter(([, v]) => RP_HEADER_PLACEHOLDER.test(v?.[0] ?? "")).map(([k]) => k);
  });
  return { upstreamUrl, uri: uri?.uri, copyHeaders: copyHandle?.include ?? fromSets };
}

function detectForwardAuth(handles: AnyHandler[]): import("./types").ForwardAuthConfig | undefined {
  for (const h of handles) {
    if (h.handler === "reverse_proxy" && isForwardAuthProxy(h as CaddyReverseProxyHandler)) {
      return extractForwardAuthFromProxy(h as CaddyReverseProxyHandler);
    }
    if (h.handler === "subroute" && h.routes) {
      for (const route of h.routes as Array<{ handle?: AnyHandler[] }>) {
        for (const subH of (route.handle ?? []) as AnyHandler[]) {
          if (subH.handler === "reverse_proxy" && isForwardAuthProxy(subH as CaddyReverseProxyHandler)) {
            return extractForwardAuthFromProxy(subH as CaddyReverseProxyHandler);
          }
        }
      }
    }
  }
  return undefined;
}

/** Parse the forward_auth block from within a single conf.d site block (raw text). */
function parseForwardAuthFromBlockRaw(raw: string): import("./types").ForwardAuthConfig | undefined {
  const lines = raw.split("\n");
  let inFa = false;
  let depth = 0;
  let upstreamUrl = "";
  let uri: string | undefined;
  let copyHeaders: string[] = [];

  for (let i = 1; i < lines.length - 1; i++) {
    const t = lines[i].trim();
    if (!inFa) {
      const m = t.match(/^forward_auth\s+(\S+)(?:\s+\{)?$/);
      if (m) {
        upstreamUrl = m[1];
        inFa = true;
        depth = t.endsWith("{") ? 1 : 0;
        continue;
      }
    } else {
      depth += (t.match(/\{/g) ?? []).length - (t.match(/\}/g) ?? []).length;
      if (depth <= 0) break;
      const uriMatch = t.match(/^uri\s+(\S+)$/);
      if (uriMatch) { uri = uriMatch[1]; continue; }
      const hdrsMatch = t.match(/^copy_headers\s+(.+)$/);
      if (hdrsMatch) { copyHeaders = hdrsMatch[1].trim().split(/\s+/); }
    }
  }

  return upstreamUrl ? { upstreamUrl, uri, copyHeaders } : undefined;
}

/** Returns an address → ForwardAuthConfig map by scanning conf.d site blocks. */
export function parseConfForwardAuthMap(content: string): Record<string, import("./types").ForwardAuthConfig> {
  const result: Record<string, import("./types").ForwardAuthConfig> = {};
  for (const block of extractRawBlocksFromCaddyfile(content)) {
    const fa = parseForwardAuthFromBlockRaw(block.raw);
    if (fa) setBlockResult(result, block, fa);
  }
  return result;
}

function buildEncodeHandler(): CaddyHandler {
  return { handler: "encode", encodings: { gzip: {}, zstd: {} } };
}

/** Caps the request body size (#154). Must be the first handle in a route so it runs
 *  before whatever actually reads the body (reverse_proxy, file_server upload, etc). */
function buildRequestBodyHandler(maxSize: number): CaddyHandler {
  return { handler: "request_body", max_size: maxSize };
}

function buildBasicAuthCaddyLines(accounts: { username: string; passwordHash: string }[]): string[] {
  return ["\tbasic_auth {", ...accounts.map(a => `\t\t${a.username} ${a.passwordHash}`), "\t}"];
}

function buildBasicAuthHandler(accounts: { username: string; passwordHash: string }[]): CaddyHandler {
  return {
    handler: "authentication",
    providers: {
      http_basic: {
        accounts: accounts.map(a => ({ username: a.username, password: a.passwordHash })),
      },
    },
  };
}

function parseBasicAuthJson(h: AnyHandler): { username: string; passwordHash: string }[] | undefined {
  const providers = (h as { providers?: Record<string, unknown> }).providers;
  const httpBasic = providers?.["http_basic"] as { accounts?: Array<{ username: string; password: string }> } | undefined;
  if (!httpBasic?.accounts?.length) return undefined;
  return httpBasic.accounts.map(a => ({ username: a.username, passwordHash: a.password }));
}

function buildRewriteHandler(rewrite: import("./types").RewriteConfig): CaddyHandler {
  if (rewrite.type === "strip_prefix") {
    return { handler: "rewrite", strip_path_prefix: rewrite.value };
  }
  if (rewrite.type === "add_prefix") {
    return { handler: "rewrite", uri: `${rewrite.value}{http.request.uri}` };
  }
  // Caddy's adapter leaves an empty replacement out; match it so both apply paths agree (#254).
  return { handler: "rewrite", path_regexp: [{ find: rewrite.find, ...(rewrite.replace ? { replace: rewrite.replace } : {}) }] };
}

function parseRewriteFromHandle(h: AnyHandler): import("./types").RewriteConfig | undefined {
  if (h.handler !== "rewrite") return undefined;
  const rw = h as { handler: string; strip_path_prefix?: string; uri?: string; path_regexp?: Array<{ find: string; replace: string }> };
  if (rw.strip_path_prefix) return { type: "strip_prefix", value: rw.strip_path_prefix };
  if (rw.uri) {
    const m = rw.uri.match(/^(.+)\{http\.request\.uri\}$/);
    if (m) return { type: "add_prefix", value: m[1] };
  }
  if (rw.path_regexp?.[0]) {
    const { find, replace } = rw.path_regexp[0];
    return { type: "regex", find, replace: replace ?? "" };
  }
  return undefined;
}

function buildRewriteCaddyLines(rewrite: import("./types").RewriteConfig, indent = "\t"): string[] {
  if (rewrite.type === "strip_prefix") return [`${indent}uri strip_prefix ${rewrite.value}`];
  if (rewrite.type === "add_prefix") return [`${indent}rewrite ${rewrite.value}{uri}`];
  // `uri path_regexp` replaces the matching part of the path, like the JSON rewrite handler's
  // path_regexp; a `path_regexp` matcher + `rewrite` replaced the whole URI instead (#254).
  // Both use Go's $1 backreferences.
  return [`${indent}uri path_regexp ${caddyQuote(rewrite.find)} ${caddyQuote(rewrite.replace)}`];
}

type TransportProps = Pick<ProxyEntry, "targetScheme" | "tlsSkipVerify" | "dialTimeout" | "responseHeaderTimeout">;

function buildTransportLines(p: TransportProps): string[] {
  const needsSkipVerify = p.targetScheme === "https" && p.tlsSkipVerify;
  const hasTimeouts = !!(p.dialTimeout || p.responseHeaderTimeout);
  if (!needsSkipVerify && !hasTimeouts) return [];

  const inner: string[] = [];
  if (needsSkipVerify) inner.push("\t\t\ttls_insecure_skip_verify");
  if (p.dialTimeout) inner.push(`\t\t\tdial_timeout ${p.dialTimeout}`);
  if (p.responseHeaderTimeout) inner.push(`\t\t\tresponse_header_timeout ${p.responseHeaderTimeout}`);
  return ["\t\ttransport http {", ...inner, "\t\t}"];
}

function buildTransport(p: TransportProps): import("./types").CaddyHttpTransport | undefined {
  const hasTls = p.targetScheme === "https";
  const hasTimeouts = !!(p.dialTimeout || p.responseHeaderTimeout);
  if (!hasTls && !hasTimeouts) return undefined;

  const t: import("./types").CaddyHttpTransport = { protocol: "http" };
  if (hasTls) t.tls = p.tlsSkipVerify ? { insecure_skip_verify: true } : {};
  if (p.dialTimeout) t.dial_timeout = p.dialTimeout;
  if (p.responseHeaderTimeout) t.response_header_timeout = p.responseHeaderTimeout;
  return t;
}

function buildUpstreamList(p: Pick<ProxyEntry, "targetScheme" | "targetHost" | "targetPort" | "extraUpstreams">): string[] {
  const scheme = p.targetScheme === "https" ? "https://" : "http://";
  const primary = `${scheme}${p.targetHost}:${p.targetPort}`;
  const extra = (p.extraUpstreams ?? []).map(u => `${scheme}${u.host}:${u.port}`);
  return [primary, ...extra];
}

const LB_POLICY_MAP: Record<string, string> = {
  round_robin: "round_robin",
  random: "random",
  least_conn: "least_conn",
  first: "first",
};

/** Builds the reverse_proxy directive lines for a proxy (tab-indented). */
function buildLbRetryLines(lbRetry: import("./types").LbRetryConfig | undefined): string[] {
  if (!lbRetry) return [];
  const lines: string[] = [];
  if (lbRetry.retries != null) lines.push(`\t\tlb_retries ${lbRetry.retries}`);
  if (lbRetry.tryDuration) lines.push(`\t\tlb_try_duration ${lbRetry.tryDuration}`);
  if (lbRetry.tryInterval) lines.push(`\t\tlb_try_interval ${lbRetry.tryInterval}`);
  // Passive checks are off in Caddy without fail_duration (#252), so the options that only
  // feed them are written only alongside it.
  if (lbRetry.failDuration) {
    lines.push(`\t\tfail_duration ${lbRetry.failDuration}`);
    if (lbRetry.maxFails != null) lines.push(`\t\tmax_fails ${lbRetry.maxFails}`);
    if (lbRetry.unhealthyStatus?.length) lines.push(`\t\tunhealthy_status ${lbRetry.unhealthyStatus.join(" ")}`);
  }
  if (lbRetry.healthUri) {
    lines.push(`\t\thealth_uri ${lbRetry.healthUri}`);
    if (lbRetry.healthInterval) lines.push(`\t\thealth_interval ${lbRetry.healthInterval}`);
    if (lbRetry.healthTimeout) lines.push(`\t\thealth_timeout ${lbRetry.healthTimeout}`);
    if (lbRetry.healthStatus) lines.push(`\t\thealth_status ${lbRetry.healthStatus}`);
  }
  return lines;
}

function buildReverseProxyLines(
  p: Pick<ProxyEntry, "targetScheme" | "targetHost" | "targetPort" | "tlsSkipVerify" | "requestHeaders" | "dialTimeout" | "responseHeaderTimeout" | "extraUpstreams" | "lbPolicy" | "lbRetry" | "replaceUpstreamErrors">,
  errorHandlers?: import("./types").ErrorHandlerConfig[],
): string[] {
  const upstreams = buildUpstreamList(p);

  const headerLines = (p.requestHeaders ?? []).map(h => {
    return headerOpLine("\t\theader_up", h);
  });

  const transportLines = buildTransportLines(p);
  const lbLines = (p.lbPolicy && upstreams.length > 1 && LB_POLICY_MAP[p.lbPolicy])
    ? [`\t\tlb_policy ${LB_POLICY_MAP[p.lbPolicy]}`]
    : [];
  const lbRetryLines = buildLbRetryLines(p.lbRetry);

  // With "also replace the app's own error pages" on (#255), intercept upstream HTTP error
  // responses and re-raise them as Caddy errors so that handle_errors blocks fire. Without it
  // only Caddy's own errors reach handle_errors, as in plain Caddy, and the app's JSON 404s or
  // a 401 with WWW-Authenticate pass through untouched.
  // A category (4xx/5xx) uses the two-argument `error "<msg>" {rp.status_code}`, which keeps the
  // upstream's real code (checked live with Caddy 2.11.7: 404, 418 and 503 stay as they are).
  // The one-argument `error {rp.status_code}` doesn't: Caddy reads a non-integer single argument
  // as the message and the status falls back to 500. Exact codes stay literal.
  const errorPassthroughLines: string[] = [];
  if (p.replaceUpstreamErrors && errorHandlers?.length) {
    const codes = errorHandlerResponseCodes(errorHandlers);
    codes.forEach((c, i) => {
      const statusToken = c < 10 ? `${c}xx` : String(c);
      errorPassthroughLines.push(
        `\t\t@upstream_error${i} status ${statusToken}`,
        `\t\thandle_response @upstream_error${i} {`,
        c < 10 ? `\t\t\terror "${UPSTREAM_ERROR_MESSAGE}" {rp.status_code}` : `\t\t\terror ${c}`,
        `\t\t}`,
      );
    });
  }

  const needsBlock = transportLines.length > 0 || headerLines.length > 0 || lbLines.length > 0 || lbRetryLines.length > 0 || errorPassthroughLines.length > 0;
  if (!needsBlock) return [`\treverse_proxy ${upstreams.join(" ")}`];

  return [`\treverse_proxy ${upstreams.join(" ")} {`, ...lbLines, ...lbRetryLines, ...transportLines, ...headerLines, ...errorPassthroughLines, "\t}"];
}

/**
 * `https://` (or any scheme implying TLS) in a Caddyfile site address triggers Caddy's
 * automatic HTTPS on its own, independent of anything else in the block — so a proxy
 * with externalScheme="https" but tls=false would still get an implicit, ungoverned
 * internal-issuer policy from Caddy, which then conflicts with any hostless proxy that
 * *does* have an explicit shared lifetime ("automation policy from site block is also
 * default/catch-all policy ... in conflict"). Only honor the scheme when TLS is
 * actually enabled, so the address never implies more than our own config does.
 *
 * Conversely, a TLS-disabled site with NO scheme prefix at all is *also* not safe:
 * Caddy's own `isAllHTTP()` check (caddyconfig/httpcaddyfile/directives.go) only skips
 * automation-policy handling for a site when its address explicitly says `http://` —
 * a bare `:port` with no scheme still counts as eligible for automatic HTTPS and can
 * silently claim the shared catch-all policy with no issuer configured at all, which
 * then conflicts with any other hostless site that has an explicit custom lifetime.
 * So TLS-disabled sites always get an explicit `http://`, never a bare address.
 */
function buildExternalAddress(p: Pick<ProxyEntry, "externalPort" | "externalScheme" | "externalHost" | "tls">): string {
  const hosts = externalHostList(p.externalHost);
  if (!hosts.length) return p.tls ? `:${p.externalPort}` : `http://:${p.externalPort}`;
  // Several names (#208) share one site block: every address carries the same scheme
  // and port, since Caddy would otherwise default a portless name to :443.
  const prefix = !p.tls ? "http://" : p.externalScheme ? `${p.externalScheme}://` : "";
  return hosts.map(h => `${prefix}${h}:${p.externalPort}`).join(", ");
}

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

/**
 * Computes the status code tokens needed for a `handle_response` or `handle_errors`
 * matcher that covers all configured error handlers.
 * Returns single-digit prefixes (4 = 4xx, 5 = 5xx) or exact codes (404, 502, …).
 */
function errorHandlerResponseCodes(handlers: import("./types").ErrorHandlerConfig[]): number[] {
  const prefixes = new Set<number>();
  const exact = new Set<number>();
  for (const h of handlers) {
    if (h.matchType === "all")     { prefixes.add(4); prefixes.add(5); break; }
    if (h.matchType === "4xx")     prefixes.add(4);
    if (h.matchType === "5xx")     prefixes.add(5);
    if (h.matchType === "specific") h.codes?.forEach(c => exact.add(c));
  }
  const result = [...prefixes];
  for (const c of exact) {
    if (!prefixes.has(Math.floor(c / 100))) result.push(c);
  }
  return result;
}

/** Converts a list of error handler configs to `handle_errors` Caddyfile lines. */
function buildErrorHandlerCaddyLines(handlers: import("./types").ErrorHandlerConfig[]): string[] {
  const lines: string[] = [];
  for (const h of handlers) {
    const matchSuffix =
      h.matchType === "specific" && h.codes?.length
        ? " " + h.codes.join(" ")
        : h.matchType === "4xx" ? " 4xx"
        : h.matchType === "5xx" ? " 5xx"
        : "";
    lines.push(`\thandle_errors${matchSuffix} {`);
    if (h.type === "redirect") {
      lines.push(`\t\tredir ${h.redirectTo ?? "/"} ${h.redirectCode ?? 302}`);
    } else if (h.type === "static") {
      lines.push(`\t\trewrite * /{http.error.status_code}.html`);
      lines.push(`\t\tfile_server {`);
      lines.push(`\t\t\troot ${caddyQuote(h.filePath ?? "/var/www/errors")}`);
      lines.push(`\t\t}`);
    } else {
      const body = h.body ?? "{http.error.status_code} {http.error.status_text}";
      const sc = h.statusCode ? ` ${h.statusCode}` : "";
      lines.push(`\t\trespond ${caddyQuote(body, { always: true })}${sc}`);
    }
    lines.push("\t}");
  }
  return lines;
}

/** Generates the Caddyfile block for a single proxy (label comment + block body). */
/**
 * Rotation sub-directives (#155) — only meaningful for a file output. `roll_size` takes an
 * explicit MiB unit since a bare number is parsed as *bytes*, not megabytes (verified
 * against a live instance: `roll_size 100` produced `roll_size_mb: 1`, not 100).
 */
function buildLogRollLines(log: import("./types").AccessLogConfig, indent: string): string[] {
  const lines: string[] = [];
  if (log.rollSizeMb) lines.push(`${indent}roll_size ${log.rollSizeMb}MiB`);
  if (log.rollKeepCount) lines.push(`${indent}roll_keep ${log.rollKeepCount}`);
  if (log.rollKeepDays) lines.push(`${indent}roll_keep_for ${log.rollKeepDays * 24}h`);
  if (log.rollCompress === false) lines.push(`${indent}roll_uncompressed`);
  return lines;
}

/**
 * Trusted proxy config lines for a `servers { }` block (#153) — used both for the global
 * (portless) block and merged into each per-port managed servers block, since Caddy's
 * per-port `servers :PORT { }` fully replaces (doesn't merge with) the global block's
 * settings for that port, verified against a live instance.
 */
function buildTrustedProxiesLines(tp: import("./types").TrustedProxiesConfig, indent: string): string[] {
  const lines: string[] = [];
  if (tp.ranges.length) lines.push(`${indent}trusted_proxies static ${tp.ranges.join(" ")}`);
  if (tp.strict) lines.push(`${indent}trusted_proxies_strict`);
  if (tp.headers?.length) lines.push(`${indent}client_ip_headers ${tp.headers.join(" ")}`);
  return lines;
}

/**
 * PROXY protocol config lines for a `servers { }` block (#157) — same global/per-port-block
 * duplication requirement as buildTrustedProxiesLines, for the identical reason (a per-port
 * `servers :PORT { }` block fully replaces the global block's settings for that port).
 */
function buildProxyProtocolLines(pp: import("./types").ProxyProtocolConfig, indent: string): string[] {
  const inner: string[] = [];
  if (pp.timeout) inner.push(`${indent}\t\ttimeout ${pp.timeout}`);
  if (pp.allow?.length) inner.push(`${indent}\t\tallow ${pp.allow.join(" ")}`);
  const lines = [`${indent}listener_wrappers {`];
  if (inner.length) {
    lines.push(`${indent}\tproxy_protocol {`, ...inner, `${indent}\t}`);
  } else {
    lines.push(`${indent}\tproxy_protocol`);
  }
  lines.push(`${indent}}`);
  return lines;
}

function buildLogCaddyLines(log: import("./types").AccessLogConfig): string[] {
  const lines = ["\tlog {"];
  const rollLines = log.output === "file" ? buildLogRollLines(log, "\t\t\t") : [];
  if (log.output === "file" && log.filePath) {
    if (rollLines.length) {
      lines.push(`\t\toutput file ${log.filePath} {`, ...rollLines, "\t\t}");
    } else {
      lines.push(`\t\toutput file ${log.filePath}`);
    }
  } else {
    lines.push(`\t\toutput ${log.output}`);
  }
  if (log.format) lines.push(`\t\tformat ${log.format}`);
  if (log.level) lines.push(`\t\tlevel ${log.level}`);
  lines.push("\t}");
  return lines;
}

/**
 * Builds the per-site `tls { }` Caddyfile block.
 *
 * `certLifetime` for a HOSTLESS proxy/server must always be the exact same value
 * across every hostless site in the whole Caddyfile — Caddy forces every hostless
 * site's automation policy to be the same object as the shared catch-all, then
 * rejects the config if a site's own (freshly-parsed) issuer isn't `reflect.DeepEqual`
 * to what's already there, even for a bare `tls internal` with no lifetime of its own
 * ("automation policy from site block is also default/catch-all policy ... in
 * conflict"). Callers (useProxies.ts) are responsible for stamping the current shared
 * value (from GlobalOptions.internalCertLifetime) onto every hostless proxy/server's
 * tlsAdvanced before calling this — this function just emits whatever it's given.
 *
 * `renewalWindowRatio` has no such conflict (Caddy applies it unconditionally, last
 * write wins, no error) but is still suppressed here for hostless proxies to avoid
 * that silent, order-dependent overwrite — hostless renewal window only comes from
 * the real global `renewal_window_ratio` Caddyfile option instead.
 */
function buildTlsCaddyLines(p: Pick<ProxyEntry, "tls" | "tlsIssuer" | "tlsOnDemand" | "tlsAdvanced" | "mtls" | "customTls">, hostless: boolean): string[] {
  if (!p.tls) return [];
  const adv = p.tlsAdvanced;
  const mtls = p.mtls;
  const custom = p.customTls;
  const hasCustomCert = !!(custom?.certFile?.trim() && custom?.keyFile?.trim());

  // A manually-loaded certificate (#152) has no issuer of its own — protocols/ciphers/
  // curves/client_auth still apply to the connection, but certLifetime/renewalWindowRatio
  // (internal-issuer-only settings) never do, so they're deliberately excluded here.
  const certLifetime = hasCustomCert ? undefined : adv?.certLifetime;
  const renewalWindowRatio = (hostless || hasCustomCert) ? undefined : adv?.renewalWindowRatio;
  const hasAdvanced = adv && (
    adv.protocolMin || adv.protocolMax || adv.cipherSuites?.length || adv.curves?.length
    || certLifetime || renewalWindowRatio !== undefined
  );
  const hasMtls = mtls?.mode;
  // #253: a certificate file has nothing to obtain, so on_demand only goes with an issuer.
  const onDemandLines = p.tlsOnDemand ? ["\t\ton_demand"] : [];

  if (hasCustomCert) {
    const certLine = `\ttls ${custom!.certFile.trim()} ${custom!.keyFile.trim()}`;
    // Caddy has no field for a separate CA bundle/intermediate chain on a manually-loaded
    // certificate — stash the path in a comment (like route labels) purely so the UI can
    // show it back to the user; it plays no role in Caddy's own TLS behavior.
    const caComment = custom!.caFile?.trim() ? [`\t# tls_ca_bundle: ${custom!.caFile.trim()}`] : [];
    if (!hasAdvanced && !hasMtls) return [certLine, ...caComment];
    const lines: string[] = [`${certLine} {`];
    lines.push(...buildTlsPolicyBlockLines(adv, mtls));
    lines.push("\t}");
    lines.push(...caComment);
    return lines;
  }

  // Automatic HTTPS (#246): Caddy's default issuers (ACME) apply when the block names no
  // issuer at all. It needs a public name, so a hostless site keeps the internal CA. The
  // internal-issuer settings (lifetime, renewal ratio) don't apply here.
  if (p.tlsIssuer === "acme" && !hostless) {
    const policy = [...buildTlsPolicyBlockLines(adv, mtls), ...onDemandLines];
    return policy.length ? ["\ttls {", ...policy, "\t}"] : [];
  }

  if (!hasAdvanced && !hasMtls && !onDemandLines.length) return ["\ttls internal"];

  const lines: string[] = ["\ttls {"];
  if (certLifetime) {
    lines.push("\t\tissuer internal {");
    lines.push(`\t\t\tlifetime ${certLifetime}`);
    lines.push("\t\t}");
  } else {
    lines.push("\t\tissuer internal");
  }
  if (renewalWindowRatio !== undefined) {
    lines.push(`\t\trenewal_window_ratio ${renewalWindowRatio}`);
  }
  lines.push(...buildTlsPolicyBlockLines(adv, mtls));
  lines.push(...onDemandLines);
  lines.push("\t}");
  return lines;
}

/** Shared protocols/ciphers/curves/client_auth sub-directive lines, used inside both the
 *  internal-issuer `tls { }` block and the custom-certificate `tls cert key { }` block. */
function buildTlsPolicyBlockLines(
  adv: import("./types").TlsAdvancedConfig | undefined,
  mtls: import("./types").MtlsConfig | undefined,
): string[] {
  const lines: string[] = [];
  if (adv?.protocolMin) {
    lines.push(adv.protocolMax
      ? `\t\tprotocols ${adv.protocolMin} ${adv.protocolMax}`
      : `\t\tprotocols ${adv.protocolMin}`);
  } else if (adv?.protocolMax) {
    lines.push(`\t\tprotocols tls1.2 ${adv.protocolMax}`);
  }
  if (adv?.cipherSuites?.length) {
    lines.push(`\t\tciphers ${adv.cipherSuites.join(" ")}`);
  }
  if (adv?.curves?.length) {
    lines.push(`\t\tcurves ${adv.curves.join(" ")}`);
  }
  if (mtls?.mode) {
    lines.push("\t\tclient_auth {");
    lines.push(`\t\t\tmode ${mtls.mode}`);
    if (mtls.trustedCaFile?.trim()) {
      // trust_pool replaces the deprecated trusted_ca_cert_file (#255), and unlike it keeps the
      // path in the adapted JSON instead of inlining the certificate.
      lines.push(`\t\t\ttrust_pool file ${mtls.trustedCaFile.trim()}`);
    }
    lines.push("\t\t}");
  }
  return lines;
}

/** True when a static site has any `file_server` sub-directive set (#262). */
function hasFileServerOptions(fs: import("./types").FileServerConfig): boolean {
  return !!(fs.index?.length || fs.hide?.length || fs.precompressed?.length);
}

/**
 * `root`, the SPA fallback and `file_server` with its options for a static site (#262). A site
 * without the new options writes exactly the lines it always did.
 */
function buildFileServerLines(fs: import("./types").FileServerConfig, indent: string): string[] {
  const lines = [`${indent}root * ${caddyQuote(fs.root)}`];
  if (fs.spa) lines.push(`${indent}try_files {path} /index.html`);
  const head = fs.browse ? `${indent}file_server browse` : `${indent}file_server`;
  if (!hasFileServerOptions(fs)) {
    lines.push(head);
    return lines;
  }
  lines.push(`${head} {`);
  if (fs.index?.length) lines.push(`${indent}\tindex ${fs.index.map(v => caddyQuote(v)).join(" ")}`);
  if (fs.hide?.length) lines.push(`${indent}\thide ${fs.hide.map(v => caddyQuote(v)).join(" ")}`);
  if (fs.precompressed?.length) lines.push(`${indent}\tprecompressed ${fs.precompressed.join(" ")}`);
  lines.push(`${indent}}`);
  return lines;
}

/**
 * `root` + `php_fastcgi` + `file_server` for a PHP site. php_fastcgi only proxies `*.php` and
 * rewrites other existing files to themselves, so without file_server nothing serves CSS, JS or
 * images (#247). Caddy's docs say it "should almost always be paired with" both.
 */
function buildPhpFastcgiLines(php: import("./types").PhpFastcgiConfig, indent: string): string[] {
  const lines = [`${indent}root * ${caddyQuote(php.root)}`];
  if (php.tryFiles?.trim()) lines.push(`${indent}try_files ${php.tryFiles.trim()}`);
  const { upstream, index, splitPath, env } = php;
  const envEntries = env ? Object.entries(env) : [];
  if (index || splitPath?.length || envEntries.length) {
    lines.push(`${indent}php_fastcgi ${upstream} {`);
    if (index) lines.push(`${indent}\tindex ${index}`);
    if (splitPath?.length) lines.push(`${indent}\tsplit ${splitPath.join(" ")}`);
    for (const [k, v] of envEntries) lines.push(`${indent}\tenv ${k} ${caddyQuote(v)}`);
    lines.push(`${indent}}`);
  } else {
    lines.push(`${indent}php_fastcgi ${upstream}`);
  }
  lines.push(`${indent}file_server`);
  return lines;
}

/** `import <snippet>` lines at the top of a site block (#288). */
function buildImportLines(p: Pick<ProxyEntry, "imports">): string[] {
  return (p.imports ?? []).map(name => `\timport ${name}`);
}

/** `import name` of a snippet, as opposed to `import path/or/*glob`. */
function isSnippetImportLine(trimmed: string): boolean {
  return /^import\s+[A-Za-z0-9][A-Za-z0-9_.-]*\s*$/.test(trimmed);
}

/** Builds handler lines for a route, at the given indent level (default single-tab). */
function buildRouteHandlerLines(p: ProxyEntry, indent: string): string[] {
  const lines: string[] = [];
  // request_body must run before the handler that actually consumes the body (#154) —
  // static_response/redir never read the body at all, so the limit is skipped there.
  if (p.requestBodyMaxSize && !p.staticResponse && !p.redirect) {
    lines.push(`${indent}request_body {`, `${indent}\tmax_size ${p.requestBodyMaxSize}`, `${indent}}`);
  }
  if (p.staticResponse) {
    const { statusCode, body, close } = p.staticResponse;
    if (body && close) {
      lines.push(`${indent}respond ${caddyQuote(body, { always: true })} ${statusCode} {`);
      lines.push(`${indent}\tclose`);
      lines.push(`${indent}}`);
    } else if (body) {
      lines.push(`${indent}respond ${caddyQuote(body, { always: true })} ${statusCode}`);
    } else if (close) {
      lines.push(`${indent}respond ${statusCode} {`);
      lines.push(`${indent}\tclose`);
      lines.push(`${indent}}`);
    } else {
      lines.push(`${indent}respond ${statusCode}`);
    }
  } else if (p.redirect) {
    lines.push(`${indent}redir ${p.redirect.to} ${p.redirect.code}`);
  } else if (p.fileServer) {
    if (p.compress) lines.push(`${indent}encode gzip zstd`);
    if (p.basicAuth?.length) {
      lines.push(`${indent}basic_auth {`);
      for (const a of p.basicAuth) lines.push(`${indent}\t${a.username} ${a.passwordHash}`);
      lines.push(`${indent}}`);
    }
    for (const h of p.responseHeaders ?? []) {
      lines.push(headerOpLine(`${indent}header`, h, { quoteSet: true }));
    }
    lines.push(...buildFileServerLines(p.fileServer, indent));
  } else if (p.phpFastcgi) {
    if (p.compress) lines.push(`${indent}encode gzip zstd`);
    if (p.basicAuth?.length) {
      lines.push(`${indent}basic_auth {`);
      for (const a of p.basicAuth) lines.push(`${indent}\t${a.username} ${a.passwordHash}`);
      lines.push(`${indent}}`);
    }
    for (const h of p.responseHeaders ?? []) {
      lines.push(headerOpLine(`${indent}header`, h, { quoteSet: true }));
    }
    lines.push(...buildPhpFastcgiLines(p.phpFastcgi, indent));
  } else {
    if (p.compress) lines.push(`${indent}encode gzip zstd`);
    if (p.basicAuth?.length) {
      lines.push(`${indent}basic_auth {`);
      for (const a of p.basicAuth) lines.push(`${indent}\t${a.username} ${a.passwordHash}`);
      lines.push(`${indent}}`);
    }
    for (const h of p.responseHeaders ?? []) {
      lines.push(headerOpLine(`${indent}header`, h, { quoteSet: true, defer: true }));
    }
    if (p.rewrite) lines.push(...buildRewriteCaddyLines(p.rewrite, indent));
    if (p.forwardAuth) {
      // forward_auth needs slightly adjusted indentation relative to base
      const faLines = buildForwardAuthCaddyLines(p.forwardAuth).map(l => indent + l.replace(/^\t/, ""));
      lines.push(...faLines);
    }
    lines.push(...buildReverseProxyLines(p, p.errorHandlers).map(l => indent + l.replace(/^\t/, "")));
  }
  return lines;
}

export function proxyToBlock(p: ProxyEntry): string {
  // Plain-port redirect/respond blocks force http:// even when tls is on, since a
  // redirect/static response has no need for its own cert. buildExternalAddress already
  // forces http:// unconditionally whenever tls is off, so this only needs to handle the
  // tls-on case here — applying it regardless of p.tls would double up the prefix.
  const isPlainHttp = p.tls && !p.externalScheme && !p.externalHost && (p.redirect || p.staticResponse);
  const hostless = !tlsSubjectHosts(p.externalHost).length;
  const rawAddr = buildExternalAddress(p);
  const header = isPlainHttp ? `http://${rawAddr}` : rawAddr;
  const lines = p.label ? [`# label: ${p.label}`, `${header} {`] : [`${header} {`];
  lines.push(...buildImportLines(p));
  lines.push(...buildBindLines(p));

  if (hasAnyMatcher(p.matchers)) {
    const matcherName = `m${p.externalPort}`;
    const useHandlePath = p.handlePath && isPathOnlyMatcher(p.matchers) && !!(p.matchers.path?.length);
    // handle_path takes one path only (#255); several get a named matcher + a regex strip.
    const stripRegex = useHandlePath ? multiPathStripRegex(p.matchers) : undefined;
    const singleHandlePath = useHandlePath && !stripRegex;

    // handle_path strips the matched prefix itself and needs no named matcher.
    if (!singleHandlePath) lines.push(...buildMatcherCaddyLines(p.matchers, matcherName, "\t"));
    if (!p.staticResponse && !p.redirect) lines.push(...buildTlsCaddyLines(p, hostless));
    if (p.accessLog) lines.push(...buildLogCaddyLines(p.accessLog));
    lines.push(singleHandlePath ? `\thandle_path ${p.matchers.path!.join(" ")} {` : `\thandle @${matcherName} {`);
    if (stripRegex) lines.push(`\t\turi path_regexp ${caddyQuote(stripRegex)} /`);
    lines.push(...buildRouteHandlerLines(p, "\t\t"));
    lines.push("\t}");
  } else {
    // No matchers — original flat structure
    if (p.staticResponse) {
      if (p.accessLog) lines.push(...buildLogCaddyLines(p.accessLog));
      lines.push(...buildRouteHandlerLines(p, "\t"));
    } else if (p.redirect) {
      if (p.accessLog) lines.push(...buildLogCaddyLines(p.accessLog));
      lines.push(...buildRouteHandlerLines(p, "\t"));
    } else if (p.fileServer) {
      lines.push(...buildTlsCaddyLines(p, hostless));
      if (p.accessLog) lines.push(...buildLogCaddyLines(p.accessLog));
      lines.push(...buildRouteHandlerLines(p, "\t"));
    } else {
      lines.push(...buildTlsCaddyLines(p, hostless));
      if (p.accessLog) lines.push(...buildLogCaddyLines(p.accessLog));
      lines.push(...buildRouteHandlerLines(p, "\t"));
    }
  }

  if (p.errorHandlers?.length) lines.push(...buildErrorHandlerCaddyLines(p.errorHandlers));
  lines.push("}");
  return lines.join("\n");
}

/**
 * Patches a raw existing block in-place: preserves the header line and any custom
 * directives, while replacing only the top-level `tls` and `reverse_proxy` entries
 * with values from `proxy`. Used when the block was not created by this plugin
 * (e.g. migrated from a Caddyfile with `https://host:PORT {` headers).
 */
function patchRawBlock(raw: string, proxy: ProxyEntry): string {
  const lines = raw.split("\n");
  const closingIdx = lines.length - 1;
  const kept: string[] = [lines[0]]; // preserve header exactly as-is
  let i = 1;
  let nestDepth = 0;
  const braces = (t: string) => (t.match(/\{/g) ?? []).length - (t.match(/\}/g) ?? []).length;
  /** Drops the directive at line i together with its nested `{ ... }` block, if it has one. */
  const skipDirective = () => {
    let depth = braces(lines[i].trim());
    i++;
    while (i < closingIdx && depth > 0) {
      depth += braces(lines[i].trim());
      i++;
    }
  };
  const isDirective = (trimmed: string, name: string) =>
    trimmed === name || trimmed.startsWith(`${name} `) || trimmed.startsWith(`${name}\t`) || trimmed === `${name}{`;

  // The directives the plugin writes again below are dropped here, each with its whole block.
  const rewritten = ["tls", "encode", "root", "file_server", "header", "basic_auth", "forward_auth", "reverse_proxy", "php_fastcgi"];
  // try_files belongs to the static and PHP forms (#262); on any other site it's the user's.
  if (proxy.fileServer || proxy.phpFastcgi) rewritten.push("try_files");

  while (i < closingIdx) {
    const line = lines[i];
    const trimmed = line.trim();

    if (nestDepth === 0 && rewritten.some(name => isDirective(trimmed, name))) {
      skipDirective();
      continue;
    }
    // Snippet imports (#288) follow proxy.imports; file and glob imports are the user's and stay.
    if (nestDepth === 0 && isSnippetImportLine(trimmed)) {
      i++;
      continue;
    }

    nestDepth += braces(trimmed);
    kept.push(line);
    i++;
  }

  // An IP host binds that IP (#254). A `bind` that only repeats the block's old IP header is the
  // one the plugin wrote, so it follows the host field; any other bind is the user's and stays.
  const oldHeader = parseSiteAddresses(lines[0].trim().replace(/\{$/, "").trim());
  const oldIp = oldHeader?.length === 1 && oldHeader[0].host && isIpAddress(oldHeader[0].host) ? oldHeader[0].host : undefined;
  const isOwnBind = (l: string) => !!oldIp && l.trim() === `bind ${oldIp}`;
  for (let k = kept.length - 1; k >= 1; k--) if (isOwnBind(kept[k])) kept.splice(k, 1);
  if (!kept.slice(1).some(l => /^\s*bind(\s|$)/.test(l))) kept.splice(1, 0, ...buildBindLines(proxy));
  kept.splice(1, 0, ...buildImportLines(proxy));
  // Re-add updated directives before closing brace
  kept.push(...buildTlsCaddyLines(proxy, !tlsSubjectHosts(proxy.externalHost).length));
  if (proxy.fileServer) {
    if (proxy.compress) kept.push("\tencode gzip zstd");
    if (proxy.basicAuth?.length) kept.push(...buildBasicAuthCaddyLines(proxy.basicAuth));
    for (const h of proxy.responseHeaders ?? []) {
      kept.push(headerOpLine(`\theader`, h, { quoteSet: true }));
    }
    kept.push(...buildFileServerLines(proxy.fileServer, "\t"));
  } else if (proxy.phpFastcgi) {
    // A hand-written PHP site (#247): its root/php_fastcgi/file_server were skipped above.
    if (proxy.compress) kept.push("\tencode gzip zstd");
    if (proxy.basicAuth?.length) kept.push(...buildBasicAuthCaddyLines(proxy.basicAuth));
    for (const h of proxy.responseHeaders ?? []) kept.push(headerOpLine("\theader", h, { quoteSet: true }));
    kept.push(...buildPhpFastcgiLines(proxy.phpFastcgi, "\t"));
  } else {
    if (proxy.compress) kept.push("\tencode gzip zstd");
    if (proxy.basicAuth?.length) kept.push(...buildBasicAuthCaddyLines(proxy.basicAuth));
    // `header` lines were dropped above with the other rewritten directives.
    for (const h of proxy.responseHeaders ?? []) kept.push(headerOpLine("\theader", h, { quoteSet: true, defer: true }));
    if (proxy.forwardAuth) kept.push(...buildForwardAuthCaddyLines(proxy.forwardAuth));
    kept.push(...buildReverseProxyLines(proxy, proxy.errorHandlers));
  }
  if (proxy.errorHandlers?.length) kept.push(...buildErrorHandlerCaddyLines(proxy.errorHandlers));
  kept.push(lines[closingIdx]); // closing }
  return kept.join("\n");
}

/**
 * Writes a proxy to the conf.d content surgically:
 * - If the block doesn't exist yet: appends a fresh plugin-format block.
 * - If the block was created by this plugin (`:PORT {` header): replaces it entirely.
 * - If the block was migrated (e.g. `https://host:PORT {` header): patches only the
 *   `tls` and `reverse_proxy` directives, preserving the header and any other directives.
 */
export function surgicallyWriteProxy(content: string, proxy: ProxyEntry): string {
  const lines = content.split("\n");
  const pos = findMatchingBlock(findBlockPositions(lines), proxy.externalPort, proxy.externalHost);

  if (!pos) {
    const base = content.trim() ? content.trimEnd() : CONF_HEADER;
    return base + "\n\n" + proxyToBlock(proxy) + "\n";
  }

  const start = pos.labelLine ?? pos.headerLine;
  const headerLine = lines[pos.headerLine].trim();
  // Recognizes every shape buildExternalAddress can produce for this port — bare
  // `:PORT`, `http://:PORT`, `host:PORT`, and `scheme://host:PORT`, or a list of
  // them for several names (#208) — so a header the plugin previously wrote with a
  // hostname/scheme is still safe to fully regenerate (needed to let a later edit
  // clear the hostname/scheme again; otherwise it looked like a hand-edited block
  // and was preserved verbatim).
  const headerAddresses = parseSiteAddresses(headerLine.replace(/\{$/, "").trim());
  const isPluginFormat = !!headerAddresses?.every(a => a.port === proxy.externalPort && !a.path);

  let body: string;
  if (isPluginFormat) {
    body = proxyToBlock(proxy);
  } else {
    const existingRaw = lines.slice(pos.headerLine, pos.closingLine + 1).join("\n");
    let patchedBody = patchRawBlock(existingRaw, proxy);
    // A hand-written header stays as written while it still names the same hosts;
    // once the names change, it is the old address and gets replaced (#208).
    if (!sameHostSet(pos.hosts, externalHostList(proxy.externalHost))) {
      const nl = patchedBody.indexOf("\n");
      patchedBody = `${buildExternalAddress(proxy)} {` + (nl === -1 ? "" : patchedBody.slice(nl));
    }
    body = proxy.label ? `# label: ${proxy.label}\n${patchedBody}` : patchedBody;
  }

  return [
    ...lines.slice(0, start),
    body,
    ...lines.slice(pos.closingLine + 1),
  ].join("\n");
}

/**
 * conf.d content after editing a standalone proxy. While the edited site still shares a
 * name with the original (or both are hostless), surgicallyWriteProxy finds and rewrites
 * the original block in place, so a name added to or dropped from the list (#208) keeps
 * the block where it was. A new port or an unrelated name removes the old block and
 * writes the site afresh.
 */
export function surgicallyEditProxy(
  content: string,
  original: Pick<ProxyEntry, "externalPort" | "externalHost" | "matchers"> | undefined,
  entry: ProxyEntry,
): string {
  const originalPort = original?.externalPort ?? entry.externalPort;
  const originalHosts = original ? routeHosts(original) : undefined;
  let updated = content;
  if (originalPort !== entry.externalPort || !hostsConflict(originalHosts, routeHosts(entry))) {
    updated = surgicallyRemoveBlock(updated, originalPort, originalHosts?.join(", "));
  }
  return surgicallyWriteProxy(updated, entry);
}

export function proxiesToCaddyfile(proxies: ProxyEntry[]): string {
  if (proxies.length === 0) return CONF_HEADER + "\n\n";
  return CONF_HEADER + "\n\n" + proxies.map(proxyToBlock).join("\n\n") + "\n";
}

// ---------------------------------------------------------------------------
// Surgical per-block conf.d editing
// ---------------------------------------------------------------------------

interface BlockPosition {
  labelLine: number | null;     // index of the "# label:" line above this block, if any
  serverKeyLine: number | null; // index of the "# server: key" comment line (#49)
  headerLine: number;           // index of the block opener line
  closingLine: number;          // index of the closing "}"
  port: number;
  hosts: string[];              // hostnames in the block's address, empty when hostless (#139, #208)
  serverKey: string | null;     // set when a "# server: key" comment precedes this block (#49)
}

/**
 * Picks the block that a write/remove targeting (port, host) should act on. An exact
 * (port, host) match is always preferred — needed once multiple blocks share a port with
 * different hosts (#139), so a write for one host never touches another's block.
 *
 * When no exact match exists but exactly one block occupies that port, fall back to it
 * ONLY if that block's host would actually conflict with the new one (hostsConflict) —
 * i.e. this looks like the same logical site being renamed/rescoped (a host clear, scheme
 * toggle, or hostname change on an existing single-occupant port), preserving pre-#139
 * behavior for edits. If the lone existing block's host is genuinely distinct and would
 * coexist fine (no conflict), this is a *new*, different site joining the port — falling
 * back would silently clobber it instead of adding a second block, exactly the #139 bug.
 * With multiple blocks already on the port and no exact host match, there's no safe single
 * block to guess either way — return undefined so the caller appends/no-ops instead.
 */
function findMatchingBlock(positions: BlockPosition[], port: number, host: string | undefined): BlockPosition | undefined {
  const portMatches = positions.filter(p => p.port === port);
  if (portMatches.length === 0) return undefined;
  const wanted = externalHostList(host);
  const exact = portMatches.find(p => sameHostSet(p.hosts, wanted));
  if (exact) return exact;
  const overlapping = portMatches.filter(p => hostsConflict(p.hosts.length ? p.hosts : undefined, wanted.length ? wanted : undefined));
  if (portMatches.length === 1) return overlapping[0];
  // A site whose name list grew or shrank (#208) still shares a name with its old block,
  // and with that block only: two blocks claiming the same name would not load in Caddy.
  if (wanted.length && overlapping.length === 1 && overlapping[0].hosts.length) return overlapping[0];
  return undefined;
}

function sameHostSet(a: string[], b: string[]): boolean {
  const norm = (l: string[]) => [...new Set(l.map(h => h.toLowerCase()))].sort().join(",");
  return norm(a) === norm(b);
}

/**
 * Port and hostnames of a top-level block header, or undefined when the block isn't a
 * site block this plugin can address. A header without an explicit port counts when
 * every address names a host (`git.example.com {`, `a.com, b.com {`): Caddy serves it
 * on 443, or 80 for an explicit `http://`.
 */
function blockHeaderTarget(header: string): { port: number; hosts: string[] } | undefined {
  const addresses = parseSiteAddresses(header.replace(/\{$/, "").trim());
  const portMatch = header.match(/:(\d+)[^{]*\{$/);
  if (portMatch) {
    const port = parseInt(portMatch[1], 10);
    if (isNaN(port)) return undefined;
    if (addresses) {
      return { port, hosts: [...new Set(addresses.map(a => a.host).filter((h): h is string => !!h))] };
    }
    // Recognizes every shape buildExternalAddress can produce for one address: bare
    // `:PORT`, `http://:PORT`, `host:PORT`, and `scheme://host:PORT`.
    const hostMatch = header.match(/^(?:[\w+.-]+:\/\/)?([^\s{:]*):\d+[^{]*\{$/);
    return { port, hosts: hostMatch?.[1] ? [hostMatch[1]] : [] };
  }
  const schemePort = schemeOnlyPort(addresses);
  if (schemePort !== undefined) return { port: schemePort, hosts: [] };
  if (!addresses || addresses.some(a => !a.host || a.port !== undefined)) return undefined;
  const port = addresses.every(a => a.scheme === "http") ? 80 : 443;
  return { port, hosts: [...new Set(addresses.map(a => a.host!))] };
}

function findBlockPositions(lines: string[]): BlockPosition[] {
  const positions: BlockPosition[] = [];
  let i = 0;
  let pendingLabelLine: number | null = null;
  let pendingServerKeyLine: number | null = null;
  let pendingServerKey: string | null = null;

  while (i < lines.length) {
    const trimmed = lines[i].trim();

    if (!trimmed) { i++; continue; }

    if (trimmed.match(/^#\s*label:/)) {
      pendingLabelLine = i; i++; continue;
    }

    if (trimmed.match(/^#\s*server:/)) {
      pendingServerKey = trimmed.replace(/^#\s*server:\s*/, "").trim() || null;
      pendingServerKeyLine = i;
      i++; continue;
    }

    // # serverdef: is a continuation annotation for the server block — don't clear pending state
    if (trimmed.match(/^#\s*serverdef:/)) {
      i++; continue;
    }

    if (!trimmed.endsWith("{")) {
      // Any non-empty non-opener line (including other comments) clears pending state
      pendingLabelLine = null; pendingServerKey = null; pendingServerKeyLine = null; i++; continue;
    }

    const target = blockHeaderTarget(trimmed);
    if (!target) {
      // Not a site block (e.g. global options or snippet) — skip entire block
      pendingLabelLine = null; pendingServerKey = null; pendingServerKeyLine = null;
      let depth = (trimmed.match(/\{/g) ?? []).length - (trimmed.match(/\}/g) ?? []).length;
      i++;
      while (i < lines.length && depth > 0) {
        const t = lines[i].trim();
        depth += (t.match(/\{/g) ?? []).length - (t.match(/\}/g) ?? []).length;
        i++;
      }
      continue;
    }

    const { port, hosts } = target;
    const headerLine = i;
    let depth = 1;
    i++;
    while (i < lines.length && depth > 0) {
      const t = lines[i].trim();
      depth += (t.match(/\{/g) ?? []).length - (t.match(/\}/g) ?? []).length;
      i++;
    }
    const closingLine = i - 1;

    positions.push({ labelLine: pendingLabelLine, serverKeyLine: pendingServerKeyLine, headerLine, closingLine, port, hosts, serverKey: pendingServerKey });
    pendingLabelLine = null;
    pendingServerKey = null;
    pendingServerKeyLine = null;
  }

  return positions;
}

/**
 * Replaces the block for `port` with `newBlock` in-place, preserving all other
 * blocks verbatim. If no block for `port` exists, appends `newBlock` at the end.
 */
export function surgicallyReplaceBlock(content: string, port: number, newBlock: string): string {
  const lines = content.split("\n");
  const pos = findBlockPositions(lines).find(p => p.port === port);

  if (!pos) {
    const base = content.trim() ? content.trimEnd() : CONF_HEADER;
    return base + "\n\n" + newBlock + "\n";
  }

  const start = pos.labelLine ?? pos.headerLine;
  return [
    ...lines.slice(0, start),
    newBlock,
    ...lines.slice(pos.closingLine + 1),
  ].join("\n");
}

/**
 * Removes the block for `port` (and its preceding label comment) from the content,
 * preserving all other blocks verbatim. Pass `host` when the port may be shared by
 * multiple blocks with different hosts (#139), so only the matching one is removed.
 */
export function surgicallyRemoveBlock(content: string, port: number, host?: string): string {
  const lines = content.split("\n");
  const pos = findMatchingBlock(findBlockPositions(lines), port, host);
  if (!pos) return content;

  const start = pos.labelLine ?? pos.headerLine;
  // Also eat any blank separator line immediately after the closing brace
  let end = pos.closingLine;
  while (end + 1 < lines.length && lines[end + 1].trim() === "") end++;

  return [...lines.slice(0, start), ...lines.slice(end + 1)].join("\n");
}

export async function writeProxyConf(proxies: ProxyEntry[]): Promise<void> {
  await cockpit.spawn(["mkdir", "-p", "/etc/caddy/conf.d"], { superuser: "try" });
  await fsWriteFile(PROXY_CONF_PATH, proxiesToCaddyfile(proxies), "try");
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

type AnyHandler = { handler: string; routes?: Array<{ handle?: AnyHandler[]; [key: string]: unknown }>; [key: string]: unknown };

/**
 * Detects Caddy's `php_fastcgi` Caddyfile-macro expansion from a group of routes (#35).
 * The macro isn't a single JSON handler — it expands into up to four separate routes
 * (a `vars` handler setting root, a trailing-slash redirect, a `rewrite`, and finally a
 * `reverse_proxy` with a `fastcgi` transport), verified empirically via `caddy adapt`
 * against a live instance. `routes` should be either a server's own top-level routes (the
 * hostless `:PORT { php_fastcgi ... }` case, where Caddy emits these 4 routes directly on
 * the server) or a `subroute` handler's inner routes (the host-matched case, where Caddy
 * wraps the same 4 routes in one subroute) — either shape preserves each route's own
 * `match`, which the generic subroute-flattening elsewhere in this file (which only
 * collects `.handle` arrays) would otherwise discard, losing the custom index filename.
 */
type JsonRoute = { match?: Array<Record<string, unknown>>; handle?: AnyHandler[] };

/**
 * The user's `try_files` (#262) from the routes Caddy adapts it to: a `file` matcher with the
 * candidate list plus a rewrite to `{http.matchers.file.relative}` and, per candidate group, the
 * part of the target after it (`?{query}`). php_fastcgi's own file routes (with `split_path`)
 * and the trailing-slash redirect aren't the user's and are skipped. Subroute handlers are
 * searched too, so the plugin's own JSON form is found as well.
 */
function findTryFiles(routes: JsonRoute[]): string | undefined {
  const parts: string[] = [];
  const visit = (rs: JsonRoute[]) => {
    for (const r of rs) {
      const file = r.match?.[0]?.file as { try_files?: string[]; split_path?: unknown; try_policy?: unknown } | undefined;
      const rewrite = (r.handle ?? []).find(h => h.handler === "rewrite") as { uri?: string } | undefined;
      if (file?.try_files?.length && !file.split_path && !file.try_policy && rewrite?.uri?.startsWith("{http.matchers.file.relative}")) {
        const suffix = rewrite.uri.slice("{http.matchers.file.relative}".length);
        parts.push(...file.try_files.map(f => collapsePlaceholderShorthands(f + suffix)));
      }
      for (const h of r.handle ?? []) {
        const sub = (h as { routes?: JsonRoute[] }).routes;
        if (h.handler === "subroute" && sub) visit(sub);
      }
    }
  };
  visit(routes);
  return parts.length ? parts.join(" ") : undefined;
}

/** Top-level routes that together make one hostless static site: one file_server, no hosts, no proxy. */
function isHostlessStaticGroup(routes: JsonRoute[]): boolean {
  const handles = routes.flatMap(r => r.handle ?? []);
  return handles.filter(h => h.handler === "file_server").length === 1
    && !handles.some(h => h.handler === "reverse_proxy" || h.handler === "static_response" || h.handler === "subroute")
    && routes.every(r => !(r.match ?? []).some(m => "host" in m));
}

/** A path Caddy adds to `hide` itself: the file the site block came from. */
function isConfigSourcePath(p: string): boolean {
  return /(^|\/)Caddyfile$/.test(p) || (p.startsWith("/") && /\.(conf|caddyfile)$/.test(p));
}

/** The `file_server` options (#262) of a static site, from its JSON handler and routes. */
function parseFileServerOptions(
  fsHandle: Record<string, unknown>, routes: JsonRoute[],
): Pick<import("./types").FileServerConfig, "spa" | "index" | "hide" | "precompressed"> {
  const out: Pick<import("./types").FileServerConfig, "spa" | "index" | "hide" | "precompressed"> = {};
  if (findTryFiles(routes) === "{path} /index.html") out.spa = true;
  const index = fsHandle.index_names;
  if (Array.isArray(index) && index.length) out.index = index as string[];
  const hide = Array.isArray(fsHandle.hide) ? (fsHandle.hide as string[]).filter(h => !isConfigSourcePath(h)) : [];
  if (hide.length) out.hide = hide;
  const order = fsHandle.precompressed_order;
  const pre = fsHandle.precompressed;
  if (Array.isArray(order) && order.length) out.precompressed = order as string[];
  else if (pre && typeof pre === "object" && Object.keys(pre).length) out.precompressed = Object.keys(pre);
  return out;
}

function detectPhpFastcgiFromRoutes(
  routes: Array<{ match?: Array<Record<string, unknown>>; handle?: AnyHandler[] }>,
): import("./types").PhpFastcgiConfig | undefined {
  const allHandles = routes.flatMap(r => (r.handle ?? []) as AnyHandler[]);
  const rp = allHandles.find(h => h.handler === "reverse_proxy" && (h.transport as { protocol?: string } | undefined)?.protocol === "fastcgi");
  if (!rp) return undefined;

  const varsH = allHandles.find(h => h.handler === "vars" && typeof h.root === "string");
  // php_fastcgi's own rewrite carries split_path; a user's try_files (#262) adapts to rewrites without it.
  const rewriteRoute = routes.find(r =>
    (r.handle ?? []).some(h => h.handler === "rewrite") && !!(r.match?.[0]?.file as { split_path?: unknown } | undefined)?.split_path,
  ) ?? routes.find(r => (r.handle ?? []).some(h => h.handler === "rewrite"));
  const userTryFiles = findTryFiles(routes);
  const tryFiles = (rewriteRoute?.match?.[0]?.file as { try_files?: string[] } | undefined)?.try_files;
  const index = tryFiles?.length ? tryFiles[tryFiles.length - 1] : undefined;

  const transport = rp.transport as { split_path?: string[]; env?: Record<string, string> } | undefined;
  const splitPath = transport?.split_path;
  const isDefaultSplit = Array.isArray(splitPath) && splitPath.length === 1 && splitPath[0] === ".php";
  const env = transport?.env;

  return {
    upstream: (rp.upstreams as Array<{ dial?: string }> | undefined)?.[0]?.dial ?? "",
    root: (varsH?.root as string | undefined) ?? "/",
    index: index && index !== "index.php" ? index : undefined,
    splitPath: Array.isArray(splitPath) && !isDefaultSplit ? splitPath : undefined,
    env: env && Object.keys(env).length ? env : undefined,
    ...(userTryFiles ? { tryFiles: userTryFiles } : {}),
  };
}

/** Reads back the request_body handler's max_size, if present (#154). */
function parseRequestBodyMaxSize(handles: AnyHandler[]): number | undefined {
  const h = handles.find(h => h.handler === "request_body") as { max_size?: number } | undefined;
  return typeof h?.max_size === "number" ? h.max_size : undefined;
}

/** Mirrors buildLbRetryLines' health-check part as Caddy JSON (#252). */
function buildHealthChecksJson(lbRetry: import("./types").LbRetryConfig | undefined): Record<string, unknown> | undefined {
  if (!lbRetry) return undefined;
  const out: Record<string, unknown> = {};
  if (lbRetry.failDuration) {
    out.passive = {
      fail_duration: lbRetry.failDuration,
      ...(lbRetry.maxFails != null ? { max_fails: lbRetry.maxFails } : {}),
      ...(lbRetry.unhealthyStatus?.length ? { unhealthy_status: lbRetry.unhealthyStatus } : {}),
    };
  }
  if (lbRetry.healthUri) {
    const cls = lbRetry.healthStatus?.match(/^([1-5])xx$/i);
    out.active = {
      uri: lbRetry.healthUri,
      ...(lbRetry.healthInterval ? { interval: lbRetry.healthInterval } : {}),
      ...(lbRetry.healthTimeout ? { timeout: lbRetry.healthTimeout } : {}),
      ...(lbRetry.healthStatus ? { expect_status: cls ? parseInt(cls[1], 10) : parseInt(lbRetry.healthStatus, 10) } : {}),
    };
  }
  return Object.keys(out).length ? out : undefined;
}

function parseLbRetry(rp: CaddyReverseProxyHandler): import("./types").LbRetryConfig | undefined {
  const lb = rp.load_balancing as { retries?: number; try_duration?: number | string; try_interval?: number | string } | undefined;
  type Passive = { fail_duration?: number | string; max_fails?: number; unhealthy_status?: number[] };
  type Active = { uri?: string; interval?: number | string; timeout?: number | string; expect_status?: number };
  const hc = rp.health_checks as { passive?: Passive; active?: Active } | undefined;
  const unhealthyStatus = hc?.passive?.unhealthy_status;
  const expect = hc?.active?.expect_status;
  const cfg: import("./types").LbRetryConfig = {
    retries: lb?.retries,
    tryDuration: parseDuration(lb?.try_duration) || undefined,
    tryInterval: parseDuration(lb?.try_interval) || undefined,
    failDuration: parseDuration(hc?.passive?.fail_duration) || undefined,
    maxFails: hc?.passive?.max_fails,
    unhealthyStatus: unhealthyStatus?.length ? unhealthyStatus : undefined,
    healthUri: hc?.active?.uri || undefined,
    healthInterval: parseDuration(hc?.active?.interval) || undefined,
    healthTimeout: parseDuration(hc?.active?.timeout) || undefined,
    // Caddy stores a status class ("2xx") as its first digit.
    healthStatus: expect == null ? undefined : expect < 10 ? `${expect}xx` : String(expect),
  };
  for (const k of Object.keys(cfg) as Array<keyof typeof cfg>) if (cfg[k] == null) delete cfg[k];
  return Object.keys(cfg).length ? cfg : undefined;
}

function findReverseProxy(handles: AnyHandler[]): CaddyReverseProxyHandler | undefined {
  for (const h of handles) {
    if (h.handler === "reverse_proxy") {
      // Skip forward_auth proxies — they're auth guards, not the main upstream
      if (!isForwardAuthProxy(h as CaddyReverseProxyHandler)) return h as CaddyReverseProxyHandler;
      continue;
    }
    if (h.handler === "subroute" && h.routes) {
      // Skip subroutes that are the forward_auth wrapper
      const isAuthSubroute = (h.routes as Array<{ handle?: AnyHandler[] }>).some(r =>
        (r.handle ?? []).some(sh => sh.handler === "reverse_proxy" && isForwardAuthProxy(sh as CaddyReverseProxyHandler)),
      );
      if (isAuthSubroute) continue;
      for (const sub of h.routes) {
        const found = findReverseProxy((sub.handle ?? []) as AnyHandler[]);
        if (found) return found;
      }
    }
  }
  return undefined;
}

/** Parse a single Caddy route + server context into a ProxyEntry. Returns undefined if unrecognized. */
function parseRouteToEntry(
  route: CaddyRoute,
  key: string,
  externalPort: number,
  externalHost: string | undefined,
  server: CaddyServer,
  accessLog: import("./types").AccessLogConfig | undefined,
  serverReadTimeout: string | undefined,
  serverReadHeaderTimeout: string | undefined,
  serverWriteTimeout: string | undefined,
  serverIdleTimeout: string | undefined,
  maxHeaderBytes: number | undefined,
  routeId: string,
  namedServerKey: string | undefined,
  automationPolicies: import("./types").CaddyAutomationPolicy[] | undefined,
  certLoadFiles: import("./types").CaddyCertLoadFile[] | undefined,
): ProxyEntry | undefined {
  const handles = (route.handle ?? []) as AnyHandler[];
  let matchers = route.match?.[0] ? parseMatcherJson(route.match[0]) : undefined;

  // A route whose only matcher is a host list is how Caddy represents a
  // hostname-only Caddyfile site block (no explicit port) sharing an implicit
  // :443/:80 server with other sites. Promote it to externalHost so the UI shows
  // the real address instead of a blank host with an opaque matcher chip. A site
  // block with several names (`a.com, b.com {`, #208) lists all of them here.
  if (!externalHost && isHostOnlyMatcher(matchers)) {
    externalHost = matchers.host.join(", ");
    matchers = undefined;
  }

  // #51 — Caddy enables h1/h2/h3 by default; an explicit protocols list omitting h3 is
  // how a user opted out of HTTP/3.
  const disableHttp3 = Array.isArray(server.protocols) && !server.protocols.includes("h3") || undefined;

  // Unwrap subroute handlers emitted by Caddy's Caddyfile adapter.
  // When Caddy reloads from Caddyfile, `handle { ... }` blocks become:
  //   { handler: "subroute", routes: [{ handle: [...actual handlers...] }] }
  const subrouteH = handles.find(h => h.handler === "subroute") as
    { handler: string; routes?: Array<{ handle?: AnyHandler[] }> } | undefined;
  const effectiveHandles: AnyHandler[] = subrouteH?.routes?.length
    ? subrouteH.routes.flatMap(r => (r.handle ?? []) as AnyHandler[])
    : handles;

  // Detect php_fastcgi (#35) — must run before the redirect/static_response checks below,
  // since php_fastcgi's own trailing-slash-redirect route is itself a static_response with
  // a Location header and would otherwise be misdetected as a plain redirect proxy. Uses
  // the subroute's own inner routes (not effectiveHandles) so each route's `match` survives
  // long enough to recover a custom index filename — see detectPhpFastcgiFromRoutes.
  const phpFastcgi = detectPhpFastcgiFromRoutes(subrouteH?.routes?.length ? subrouteH.routes : [route]);
  if (phpFastcgi) {
    const phpTls = serverHasTls(server, automationPolicies, externalHost);
    const phpTlsPolicy = Array.isArray(server.tls_connection_policies) ? server.tls_connection_policies[0] : undefined;
    return {
      id: routeId,
      externalPort,
      externalHost,
      targetHost: "localhost",
      targetPort: 0,
      targetScheme: "http",
      tls: phpTls,
      tlsSkipVerify: false,
      serverKey: key,
      namedServerKey,
      phpFastcgi,
      requestBodyMaxSize: parseRequestBodyMaxSize(effectiveHandles),
      matchers,
      serverReadTimeout, serverReadHeaderTimeout, serverWriteTimeout, serverIdleTimeout, maxHeaderBytes, disableHttp3, accessLog,
      errorHandlers: parseErrorHandlers(server),
      tlsAdvanced: phpTlsPolicy ? parseTlsAdvanced(phpTlsPolicy, automationPolicies, tlsSubjectHosts(externalHost)[0]) : undefined,
      mtls: phpTlsPolicy ? parseMtls(phpTlsPolicy) : undefined,
    };
  }

  // Detect redirect (static_response with Location header)
  const staticResp = effectiveHandles.find(h => h.handler === "static_response") as
    { handler: string; headers?: Record<string, string[]>; status_code?: number; body?: string; close?: boolean } | undefined;
  const locationHeader = staticResp?.headers?.["Location"]?.[0];
  if (staticResp && locationHeader) {
    const code = (staticResp.status_code ?? 302) as 301 | 302 | 307 | 308;
    return {
      id: routeId,
      externalPort,
      externalHost,
      targetHost: "localhost",
      targetPort: 0,
      targetScheme: "http",
      tls: false,
      tlsSkipVerify: false,
      serverKey: key,
      namedServerKey,
      redirect: { to: jsonPlaceholderToCaddy(locationHeader), code },
      matchers,
      serverReadTimeout, serverReadHeaderTimeout, serverWriteTimeout, serverIdleTimeout, maxHeaderBytes, disableHttp3, accessLog,
      errorHandlers: parseErrorHandlers(server),
    };
  }

  // Detect static response (static_response without Location header)
  if (staticResp && !locationHeader) {
    return {
      id: routeId,
      externalPort,
      externalHost,
      targetHost: "localhost",
      targetPort: 0,
      targetScheme: "http",
      tls: false,
      tlsSkipVerify: false,
      serverKey: key,
      namedServerKey,
      staticResponse: {
        statusCode: staticResp.status_code ?? 200,
        body: staticResp.body || undefined,
        close: staticResp.close || undefined,
      },
      matchers,
      serverReadTimeout, serverReadHeaderTimeout, serverWriteTimeout, serverIdleTimeout, maxHeaderBytes, disableHttp3, accessLog,
      errorHandlers: parseErrorHandlers(server),
    };
  }

  // Detect file_server
  const fsHandle = effectiveHandles.find(h => h.handler === "file_server") as
    { handler: string; root?: string; browse?: Record<string, unknown>; [k: string]: unknown } | undefined;
  if (fsHandle) {
    const fsCompress = effectiveHandles.some(h => h.handler === "encode");
    const fsAuthHandle = effectiveHandles.find(h => h.handler === "authentication");
    const fsBasicAuth = fsAuthHandle ? parseBasicAuthJson(fsAuthHandle) : undefined;
    // The Caddyfile adapter emits one headers handler per `header` line, so read them all.
    const fsResponseHeaders = effectiveHandles.flatMap(parseResponseHeadersJson);
    const fsTls = serverHasTls(server, automationPolicies, externalHost);
    const fsTlsPolicy = Array.isArray(server.tls_connection_policies) ? server.tls_connection_policies[0] : undefined;
    return {
      id: routeId,
      externalPort,
      externalHost,
      targetHost: "localhost",
      targetPort: 0,
      targetScheme: "http",
      tls: fsTls,
      tlsSkipVerify: false,
      serverKey: key,
      namedServerKey,
      // The Caddyfile adapter turns `root * <dir>` into a separate `vars` handler and
      // leaves file_server without a root (#245). Never fall back to "/": saving that
      // back would serve the whole filesystem; an empty root fails the required field instead.
      fileServer: {
        root: fsHandle.root
          ?? (effectiveHandles.find(h => h.handler === "vars" && typeof (h as { root?: unknown }).root === "string") as { root?: string } | undefined)?.root
          ?? "",
        browse: fsHandle.browse !== undefined,
        ...parseFileServerOptions(fsHandle, subrouteH?.routes?.length ? subrouteH.routes : [route]),
      },
      requestBodyMaxSize: parseRequestBodyMaxSize(effectiveHandles),
      compress: fsCompress || undefined,
      basicAuth: fsBasicAuth?.length ? fsBasicAuth : undefined,
      responseHeaders: fsResponseHeaders.length ? fsResponseHeaders : undefined,
      matchers,
      serverReadTimeout, serverReadHeaderTimeout, serverWriteTimeout, serverIdleTimeout, maxHeaderBytes, disableHttp3, accessLog,
      errorHandlers: parseErrorHandlers(server),
      tlsAdvanced: fsTlsPolicy ? parseTlsAdvanced(fsTlsPolicy, automationPolicies, tlsSubjectHosts(externalHost)[0]) : undefined,
      mtls: fsTlsPolicy ? parseMtls(fsTlsPolicy) : undefined,
    };
  }

  // Detect invoke (named route call)
  const invokeHandle = effectiveHandles.find(h => h.handler === "invoke") as
    { handler: string; name?: string } | undefined;
  if (invokeHandle?.name) {
    return {
      id: routeId,
      externalPort,
      externalHost,
      targetHost: "localhost",
      targetPort: 0,
      targetScheme: "http",
      tls: false,
      tlsSkipVerify: false,
      serverKey: key,
      namedServerKey,
      isNamedRoute: true,
      namedRouteName: invokeHandle.name,
      matchers,
      serverReadTimeout, serverReadHeaderTimeout, serverWriteTimeout, serverIdleTimeout, maxHeaderBytes, disableHttp3, accessLog,
    };
  }

  const forwardAuth = detectForwardAuth(effectiveHandles);
  const rp = findReverseProxy(effectiveHandles);
  if (!rp) return undefined;

  const dial = rp.upstreams?.[0]?.dial ?? "";
  const lastColon = dial.lastIndexOf(":");
  const targetHost = lastColon > 0 ? dial.slice(0, lastColon) : dial;
  const targetPort = lastColon > 0 ? parseInt(dial.slice(lastColon + 1), 10) : 80;

  const extraUpstreams = (rp.upstreams ?? []).slice(1).map(u => {
    const d = u.dial ?? "";
    const c = d.lastIndexOf(":");
    return { host: c > 0 ? d.slice(0, c) : d, port: c > 0 ? parseInt(d.slice(c + 1), 10) : 80 };
  });
  const lbRaw = (rp.load_balancing as { selection_policy?: { policy?: string } } | undefined)?.selection_policy?.policy;
  const lbPolicy = (lbRaw && lbRaw in LB_POLICY_MAP) ? lbRaw as import("./types").LbPolicy : undefined;
  const lbRetry = parseLbRetry(rp);

  const targetScheme: "http" | "https" = rp.transport?.tls !== undefined ? "https" : "http";
  const tlsSkipVerify = rp.transport?.tls?.insecure_skip_verify ?? false;
  const dialTimeout = parseDuration(rp.transport?.dial_timeout);
  const responseHeaderTimeout = parseDuration(rp.transport?.response_header_timeout);

  const tls = serverHasTls(server, automationPolicies, externalHost);
  const tlsPolicy = Array.isArray(server.tls_connection_policies) ? server.tls_connection_policies[0] : undefined;
  const customTls = parseCustomTls(tlsPolicy, certLoadFiles);

  const compress = effectiveHandles.some(h => h.handler === "encode");
  const authHandle = effectiveHandles.find(h => h.handler === "authentication");
  const basicAuth = authHandle ? parseBasicAuthJson(authHandle) : undefined;
  const rewriteHandle = effectiveHandles.find(h => h.handler === "rewrite");
  const rewrite = rewriteHandle ? parseRewriteFromHandle(rewriteHandle) : undefined;
  const responseHeadersParsed = effectiveHandles.flatMap(parseResponseHeadersJson);
  const requestHeaders = parseRequestHeadersJson(rp.headers as Record<string, unknown> | undefined);

  // Detect handle_path pattern: a strip_prefix rewrite whose value matches the path matcher prefix
  let handlePath: true | undefined;
  let finalRewrite = rewrite;
  if (rewrite?.type === "strip_prefix" && matchers?.path?.length && isPathOnlyMatcher(matchers)) {
    const expectedPrefix = handlePathStripPrefix(matchers);
    if (expectedPrefix && rewrite.value === expectedPrefix) {
      handlePath = true;
      finalRewrite = undefined;
    }
  } else if (rewrite?.type === "regex" && rewrite.replace === "/" && rewrite.find === multiPathStripRegex(matchers)) {
    // The several-paths form of handle_path (#255).
    handlePath = true;
    finalRewrite = undefined;
  }

  return {
    id: routeId,
    externalPort,
    externalHost,
    targetHost: targetHost || "localhost",
    targetPort: isNaN(targetPort) ? 80 : targetPort,
    targetScheme,
    tls,
    tlsSkipVerify,
    serverKey: key,
    namedServerKey,
    compress: compress || undefined,
    requestBodyMaxSize: parseRequestBodyMaxSize(effectiveHandles),
    basicAuth: basicAuth?.length ? basicAuth : undefined,
    dialTimeout: dialTimeout || undefined,
    responseHeaderTimeout: responseHeaderTimeout || undefined,
    rewrite: finalRewrite,
    requestHeaders: requestHeaders.length ? requestHeaders : undefined,
    responseHeaders: responseHeadersParsed.length ? responseHeadersParsed : undefined,
    extraUpstreams: extraUpstreams.length ? extraUpstreams : undefined,
    lbPolicy,
    lbRetry,
    matchers,
    handlePath,
    serverReadTimeout, serverReadHeaderTimeout, serverWriteTimeout, serverIdleTimeout, maxHeaderBytes, disableHttp3, accessLog,
    errorHandlers: parseErrorHandlers(server),
    replaceUpstreamErrors: reraisesUpstreamErrors(rp) || undefined,
    forwardAuth,
    tlsAdvanced: tlsPolicy ? parseTlsAdvanced(tlsPolicy, automationPolicies, tlsSubjectHosts(externalHost)[0]) : undefined,
    mtls: tlsPolicy ? parseMtls(tlsPolicy) : undefined,
    customTls,
  };
}

export function parseProxies(config: CaddyConfig, serverDefs?: import("./types").ServerDef[]): ProxyEntry[] {
  const servers = config.apps?.http?.servers ?? {};
  const automationPolicies = config.apps?.tls?.automation?.policies;
  const certLoadFiles = config.apps?.tls?.certificates?.load_files;
  const proxies: ProxyEntry[] = [];

  for (const [key, server] of Object.entries(servers)) {
    // Handle :9393, localhost:9393, https://localhost:9393
    const listenAddr = server.listen?.[0] ?? "";
    const portMatch = listenAddr.match(/:(\d+)$/);
    if (!portMatch) continue;
    const externalPort = parseInt(portMatch[1], 10);
    if (isNaN(externalPort)) continue;
    const colonIdx = listenAddr.lastIndexOf(":");
    const rawHost = colonIdx > 0 ? listenAddr.slice(0, colonIdx) : "";
    const externalHost = rawHost || undefined;

    // Server-level timeouts and size limits — Caddy returns nanoseconds as integers after
    // a Caddyfile reload, so parseDuration handles both string ("10s") and number forms.
    const serverReadTimeout = parseDuration(server.read_timeout);
    const serverReadHeaderTimeout = parseDuration(server.read_header_timeout);
    const serverWriteTimeout = parseDuration(server.write_timeout);
    const serverIdleTimeout = parseDuration(server.idle_timeout);
    const maxHeaderBytes = typeof server.max_header_bytes === "number" ? server.max_header_bytes : undefined;

    // Access log — look up logger by name in config.logging.logs
    const loggerName = (server.logs as { default_logger_name?: string } | undefined)?.default_logger_name;
    let accessLog: import("./types").AccessLogConfig | undefined;
    if (loggerName) {
      const loggerCfg = config.logging?.logs?.[loggerName];
      if (loggerCfg) {
        const output = (loggerCfg.writer?.output ?? "stderr") as import("./types").AccessLogOutput;
        accessLog = {
          output,
          filePath: loggerCfg.writer?.filename,
          format: loggerCfg.encoder?.format as import("./types").AccessLogFormat | undefined,
          level: loggerCfg.level as import("./types").AccessLogLevel | undefined,
          rollSizeMb: loggerCfg.writer?.roll_size_mb,
          rollKeepCount: loggerCfg.writer?.roll_keep,
          rollKeepDays: loggerCfg.writer?.roll_keep_days,
          rollCompress: loggerCfg.writer?.roll_gzip === false ? false : undefined,
        };
      }
    }

    const routes = server.routes ?? [];

    // Determine whether this is a named server (multiple content routes, not from named_routes)
    // Skip routes that come from the `named_routes` map (invoke placeholders are already loaded)
    const contentRoutes = routes.filter(r => {
      const handles = (r.handle ?? []) as AnyHandler[];
      return handles.length > 0;
    });

    // Identify a matching ServerDef — first by JSON key, then by listen address.
    // After Caddy reloads from Caddyfile it reassigns its own server keys (e.g. "srv0")
    // so key-only matching would misclassify named-server routes as standalone.
    const listenAddrs = server.listen ?? [];
    const defByKey = serverDefs?.find(s => s.key === key);
    const defByAddr = (!defByKey && serverDefs?.length)
      ? serverDefs.find(s => s.listenAddresses.some(a => listenAddrs.includes(a)))
      : undefined;
    const namedDef = defByKey ?? defByAddr;
    const isNamedServer = !key.includes(":") && namedDef != null;

    // Detect a hostless `:PORT { php_fastcgi ... }` standalone site (#35) before the
    // generic branching below — Caddy expands that Caddyfile macro into up to 4 separate
    // top-level routes directly on the server (no host matcher to wrap them in a single
    // subroute, unlike the host-matched case which parseRouteToEntry already handles),
    // so contentRoutes.length is never <= 1 for it and it would otherwise be misparsed as
    // several unrelated, broken partial routes by the "multiple content routes" branch.
    // A hostless proxy is always the sole occupant of its port (two can't coexist per
    // #139), so grouping all of contentRoutes together here is safe and unambiguous.
    const phpFastcgiGroup = !namedDef && contentRoutes.length > 1 ? detectPhpFastcgiFromRoutes(contentRoutes) : undefined;
    if (phpFastcgiGroup) {
      // #51 — Caddy enables h1/h2/h3 by default; an explicit protocols list omitting h3 is
      // how a user opted out of HTTP/3.
      const phpDisableHttp3 = Array.isArray(server.protocols) && !server.protocols.includes("h3") || undefined;
      proxies.push({
        id: String(externalPort),
        externalPort,
        externalHost,
        targetHost: "localhost",
        targetPort: 0,
        targetScheme: "http",
        tls: serverHasTls(server, automationPolicies, externalHost),
        tlsSkipVerify: false,
        serverKey: key,
        phpFastcgi: phpFastcgiGroup,
        requestBodyMaxSize: parseRequestBodyMaxSize(contentRoutes.flatMap(r => (r.handle ?? []) as AnyHandler[])),
        serverReadTimeout, serverReadHeaderTimeout, serverWriteTimeout, serverIdleTimeout, maxHeaderBytes,
        disableHttp3: phpDisableHttp3, accessLog,
        errorHandlers: parseErrorHandlers(server),
      });
      continue;
    }

    // A hostless static site with try_files (#262) adapts to several top-level routes too
    // (root vars, the file-matcher rewrite, file_server). Parse them as one site, as if they
    // were the subroute a host-matched block gets.
    const staticGroup = !namedDef && contentRoutes.length > 1 && isHostlessStaticGroup(contentRoutes);
    if (staticGroup) {
      const entry = parseRouteToEntry(
        { handle: [{ handler: "subroute", routes: contentRoutes } as CaddyHandler] } as CaddyRoute, key, externalPort, externalHost, server, accessLog,
        serverReadTimeout, serverReadHeaderTimeout, serverWriteTimeout, serverIdleTimeout, maxHeaderBytes,
        String(externalPort), undefined, automationPolicies, certLoadFiles,
      );
      if (entry) proxies.push(entry);
      continue;
    }

    if (namedDef) {
      // Named server (#49) — use def.key for IDs so they stay consistent after Caddy key changes
      for (let i = 0; i < contentRoutes.length; i++) {
        const entry = parseRouteToEntry(
          contentRoutes[i], key, externalPort, externalHost, server, accessLog,
          serverReadTimeout, serverReadHeaderTimeout, serverWriteTimeout, serverIdleTimeout, maxHeaderBytes,
          `${namedDef.key}:${i}`, isNamedServer ? namedDef.key : undefined, automationPolicies, certLoadFiles,
        );
        if (entry) proxies.push(entry);
      }
    } else if (contentRoutes.length <= 1) {
      // Standalone single-route server (the common case)
      const route = contentRoutes[0];
      if (!route) continue;
      const entry = parseRouteToEntry(
        route, key, externalPort, externalHost, server, accessLog,
        serverReadTimeout, serverReadHeaderTimeout, serverWriteTimeout, serverIdleTimeout, maxHeaderBytes,
        String(externalPort), undefined, automationPolicies, certLoadFiles,
      );
      if (entry) proxies.push(entry);
    } else {
      // Multiple content routes sharing one implicit-port server with no matching
      // ServerDef — e.g. several hostname-only Caddyfile site blocks (no explicit
      // port) that Caddy automatically groups onto the same shared :443/:80 server.
      // Each route is its own independent proxy; key by its host matcher when
      // present so the id stays stable across Caddy's own server-key reassignment.
      for (let i = 0; i < contentRoutes.length; i++) {
        const routeHost = (contentRoutes[i].match?.[0]?.host as string[] | undefined)?.[0];
        const entry = parseRouteToEntry(
          contentRoutes[i], key, externalPort, externalHost, server, accessLog,
          serverReadTimeout, serverReadHeaderTimeout, serverWriteTimeout, serverIdleTimeout, maxHeaderBytes,
          routeHost ? `host:${routeHost}` : `${key}:${i}`, undefined, automationPolicies, certLoadFiles,
        );
        if (entry) proxies.push(entry);
      }
    }
  }

  return proxies.sort((a, b) => {
    if (a.externalPort !== b.externalPort) return a.externalPort - b.externalPort;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// Building / patching server entries
// ---------------------------------------------------------------------------

function buildRequestHeadersJson(ops: import("./types").HeaderOperation[] | undefined): Record<string, unknown> | undefined {
  if (!ops?.length) return undefined;
  const set: Record<string, string[]> = {};
  const add: Record<string, string[]> = {};
  const del: string[] = [];
  for (const h of ops) {
    if (h.op === "delete") { del.push(h.name); continue; }
    const val = [caddyPlaceholderToJson(h.value ?? "")];
    if (h.op === "add") add[h.name] = val;
    else set[h.name] = val;
  }
  const req: Record<string, unknown> = {};
  if (Object.keys(set).length) req["set"] = set;
  if (Object.keys(add).length) req["add"] = add;
  if (del.length) req["delete"] = del;
  return Object.keys(req).length ? { request: req } : undefined;
}

function parseRequestHeadersJson(headers: Record<string, unknown> | undefined): import("./types").HeaderOperation[] {
  if (!headers) return [];
  const req = headers["request"] as Record<string, unknown> | undefined;
  if (!req) return [];
  const ops: import("./types").HeaderOperation[] = [];
  const set = req["set"] as Record<string, string[]> | undefined;
  const add = req["add"] as Record<string, string[]> | undefined;
  const del = req["delete"] as string[] | undefined;
  for (const [name, vals] of Object.entries(set ?? {}))
    ops.push({ op: "set", name, value: jsonPlaceholderToCaddy(vals[0] ?? "") });
  for (const [name, vals] of Object.entries(add ?? {}))
    ops.push({ op: "add", name, value: jsonPlaceholderToCaddy(vals[0] ?? "") });
  for (const name of del ?? [])
    ops.push({ op: "delete", name });
  return ops;
}

function buildResponseHeadersHandler(ops: import("./types").HeaderOperation[]): CaddyHandler {
  const set: Record<string, string[]> = {};
  const add: Record<string, string[]> = {};
  const del: string[] = [];
  for (const h of ops) {
    if (h.op === "delete") { del.push(h.name); continue; }
    const val = [h.value ?? ""];
    if (h.op === "add") add[h.name] = val;
    else set[h.name] = val;
  }
  // "deferred" makes response header rewriting apply just before the response is
  // actually written, after reverse_proxy has copied the upstream's headers in;
  // without it a set runs too early and the upstream's own value is added next to it.
  // The Caddyfile adapter does NOT set this for a plain `header Name value`: it defers
  // only `-`, `?`, `>` and `defer` (#255, checked with `caddy adapt` on 2.11.7), which is
  // why the Caddyfile writer spells a set on a proxied route `>Name` (headerOpLine).
  const resp: Record<string, unknown> = { deferred: true };
  if (Object.keys(set).length) resp["set"] = set;
  if (Object.keys(add).length) resp["add"] = add;
  if (del.length) resp["delete"] = del;
  return { handler: "headers", response: resp };
}

function parseResponseHeadersJson(h: AnyHandler): import("./types").HeaderOperation[] {
  if (h.handler !== "headers") return [];
  const resp = (h as { handler: string; response?: Record<string, unknown> }).response;
  if (!resp) return [];
  const ops: import("./types").HeaderOperation[] = [];
  const set = resp["set"] as Record<string, string[]> | undefined;
  const add = resp["add"] as Record<string, string[]> | undefined;
  const del = resp["delete"] as string[] | undefined;
  for (const [name, vals] of Object.entries(set ?? {})) ops.push({ op: "set", name, value: vals[0] ?? "" });
  for (const [name, vals] of Object.entries(add ?? {})) ops.push({ op: "add", name, value: vals[0] ?? "" });
  for (const name of del ?? []) ops.push({ op: "delete", name });
  return ops;
}

/** The error message upstream errors are re-raised with (#255); handle_errors sees it as {err.message}. */
const UPSTREAM_ERROR_MESSAGE = "upstream error";

function buildReverseProxyHandler(
  proxy: Pick<ProxyEntry, "targetHost" | "targetPort" | "targetScheme" | "tlsSkipVerify" | "requestHeaders" | "dialTimeout" | "responseHeaderTimeout" | "extraUpstreams" | "lbPolicy" | "lbRetry" | "replaceUpstreamErrors">,
  errorHandlers?: import("./types").ErrorHandlerConfig[],
): CaddyReverseProxyHandler {
  const primaryDial = `${proxy.targetHost}:${proxy.targetPort}`;
  const extraDials = (proxy.extraUpstreams ?? []).map(u => ({ dial: `${u.host}:${u.port}` }));
  const rp: CaddyReverseProxyHandler = {
    handler: "reverse_proxy",
    upstreams: [{ dial: primaryDial }, ...extraDials],
  };
  const transport = buildTransport(proxy);
  if (transport) rp.transport = transport;
  const hdrs = buildRequestHeadersJson(proxy.requestHeaders);
  if (hdrs) rp.headers = hdrs;
  if (proxy.lbPolicy && (proxy.extraUpstreams?.length ?? 0) > 0 && LB_POLICY_MAP[proxy.lbPolicy]) {
    rp.load_balancing = { selection_policy: { policy: proxy.lbPolicy } };
  }
  const lbRetry = proxy.lbRetry;
  if (lbRetry?.retries != null || lbRetry?.tryDuration || lbRetry?.tryInterval) {
    rp.load_balancing = {
      ...(rp.load_balancing as Record<string, unknown> | undefined),
      ...(lbRetry.retries != null ? { retries: lbRetry.retries } : {}),
      ...(lbRetry.tryDuration ? { try_duration: lbRetry.tryDuration } : {}),
      ...(lbRetry.tryInterval ? { try_interval: lbRetry.tryInterval } : {}),
    };
  }
  const healthChecks = buildHealthChecksJson(lbRetry);
  if (healthChecks) rp.health_checks = healthChecks;

  if (proxy.replaceUpstreamErrors && errorHandlers?.length) {
    const codes = errorHandlerResponseCodes(errorHandlers);
    if (codes.length) {
      // Same as the Caddyfile path (buildReverseProxyLines), in the form Caddy adapts it to. The
      // placeholder needs its full name here: {rp.*} is a Caddyfile-only shorthand, and the JSON
      // status_code field does resolve a full placeholder at runtime.
      rp.handle_response = codes.map(c => ({
        match: { status_code: [c] },
        routes: [{ handle: [c < 10
          ? { handler: "error", error: UPSTREAM_ERROR_MESSAGE, status_code: "{http.reverse_proxy.status_code}" }
          : { handler: "error", status_code: c }] }],
      }));
    }
  }
  return rp;
}

type TimeoutProxy = Pick<ProxyEntry, "serverReadTimeout" | "serverReadHeaderTimeout" | "serverWriteTimeout" | "serverIdleTimeout" | "maxHeaderBytes" | "disableHttp3">;

function applyServerTimeouts(server: CaddyServer, proxy: TimeoutProxy): CaddyServer {
  if (proxy.serverReadTimeout) server.read_timeout = proxy.serverReadTimeout;
  else delete server.read_timeout;
  if (proxy.serverReadHeaderTimeout) server.read_header_timeout = proxy.serverReadHeaderTimeout;
  else delete server.read_header_timeout;
  if (proxy.serverWriteTimeout) server.write_timeout = proxy.serverWriteTimeout;
  else delete server.write_timeout;
  if (proxy.serverIdleTimeout) server.idle_timeout = proxy.serverIdleTimeout;
  else delete server.idle_timeout;
  if (proxy.maxHeaderBytes) server.max_header_bytes = proxy.maxHeaderBytes;
  else delete server.max_header_bytes;
  // #51 — Caddy enables h1/h2/h3 by default; explicitly list h1+h2 only to opt out of h3.
  if (proxy.disableHttp3) server.protocols = ["h1", "h2"];
  else delete server.protocols;
  return server;
}

/** Returns true only for numeric IP addresses — these are valid TCP bind targets. Hostnames are site labels in Caddyfile, not bind interfaces. */
function isIpAddress(host: string): boolean {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || host.startsWith("[");
}

/**
 * Host matcher for a proxy whose site address lists several names (#208), the shape
 * Caddy's Caddyfile adapter gives `a.com, b.com { }`. A single-host or hostless proxy
 * gets none, as before, and an explicit Route Matcher (#48) always wins.
 */
function siteHostMatch(proxy: Pick<ProxyEntry, "externalHost" | "matchers">): Array<Record<string, unknown>> | undefined {
  if (proxy.matchers) return undefined;
  const hosts = externalHostList(proxy.externalHost);
  return hosts.length > 1 ? [{ host: hosts }] : undefined;
}

function isMultiHostOnlyMatch(match: Array<Record<string, unknown>> | undefined): boolean {
  if (match?.length !== 1) return false;
  const keys = Object.keys(match[0]);
  return keys.length === 1 && keys[0] === "host" && Array.isArray(match[0].host) && match[0].host.length > 1;
}

/** True when the host field is one IP address, which the plugin treats as the bind address. */
function bindsToIp(proxy: { externalHost?: string }): boolean {
  return !!proxy.externalHost && externalHostList(proxy.externalHost).length === 1 && isIpAddress(proxy.externalHost);
}

/**
 * An IP site address only matches the Host header in a Caddyfile and still listens on every
 * interface; `bind` is what restricts the listener, as the instant-apply JSON's `IP:port`
 * listen address does (#254).
 */
function buildBindLines(proxy: { externalHost?: string }): string[] {
  return bindsToIp(proxy) ? [`\tbind ${proxy.externalHost}`] : [];
}

function buildListenAddr(proxy: { externalHost?: string; externalPort: number }): string {
  // Several names (#208) can't share one bind address, so they listen on every interface.
  return bindsToIp(proxy)
    ? `${proxy.externalHost}:${proxy.externalPort}`
    : `:${proxy.externalPort}`;
}

/**
 * Mirrors certmagic.SubjectIsInternal (github.com/caddyserver/certmagic), which Caddy
 * itself uses to decide whether a hostname can get its own scoped automation policy.
 * Hosts that match this are folded into the shared catch-all/default policy no matter
 * what — giving them a `subjects`-scoped policy of our own would fight Caddy's own
 * classification and produce "automation policy from site block is also default/
 * catch-all policy ... in conflict" at reload. localhost/.local/.internal/.home.arpa
 * and private IPs all count, not just literal IP addresses.
 */
function isCaddyInternalSubject(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === "localhost"
    || h.endsWith(".localhost")
    || h.endsWith(".local")
    || h.endsWith(".internal")
    || h.endsWith(".home.arpa")
    || isIpAddress(h);
}

/** A hostname usable as an automation-policy `subjects` entry — a real public-looking domain. */
export function tlsSubjectHost(host: string | undefined): string | undefined {
  return host && !isCaddyInternalSubject(host) ? host : undefined;
}

/**
 * The public-looking names of a proxy's externalHost, which may list several (#208).
 * Empty means the proxy is hostless as far as TLS automation is concerned.
 */
export function tlsSubjectHosts(externalHost: string | undefined): string[] {
  return externalHostList(externalHost).filter(h => !isCaddyInternalSubject(h));
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
 * The hostname(s) a proxy actually answers on: its Host matcher (#48) if one was set
 * explicitly, otherwise its externalHost (the bind address typed into Add/Edit Proxy).
 * Returns undefined when the proxy has no host restriction at all — it then catches
 * every request on its port, same as a bare `:port` Caddyfile block.
 */
export function routeHosts(p: Pick<ProxyEntry, "externalHost" | "matchers">): string[] | undefined {
  if (p.matchers?.host?.length) return p.matchers.host;
  const hosts = externalHostList(p.externalHost);
  return hosts.length ? hosts : undefined;
}

/**
 * True when two routes claiming the same port would collide in Caddy. Two routes with
 * distinct, non-overlapping hosts on the same port coexist fine (ordinary SNI/Host-header
 * virtual hosting — the same thing Caddy does for any two site blocks sharing a port in a
 * plain Caddyfile). A route with no host restriction is a real conflict against anything
 * else on the port, since it would catch all of that port's traffic itself (today's
 * pre-#139 behavior, unchanged for the common single-route-per-port case).
 */
export function hostsConflict(existingHosts: string[] | undefined, newHosts: string[] | undefined): boolean {
  if (!existingHosts?.length || !newHosts?.length) return true;
  return existingHosts.some(h => newHosts.includes(h));
}

/**
 * Stable id for a standalone proxy: `host:<host>` when a hostname/subdomain is set,
 * matching the id parseProxies already assigns when re-reading multiple host-matched
 * routes sharing one port after a reload (#139) — keeps the id from changing out from
 * under the UI once the config round-trips. Bare `String(port)` otherwise, unchanged
 * from before #139 (the single-route-per-port case parseProxies also expects).
 */
export function standaloneProxyId(entry: Pick<ProxyEntry, "externalPort" | "externalHost" | "matchers">): string {
  const host = routeHosts(entry)?.[0];
  return host ? `host:${host}` : String(entry.externalPort);
}

/**
 * Exact membership check for a `subjects` list. Written as `.some(s => s === host)` rather
 * than `.includes(host)` — both are equivalent here (subjects is a plain string[], not a URL
 * being substring-matched), but static analysis tools that flag "incomplete URL substring
 * sanitization" on any `.includes()` call don't distinguish the two, so this form avoids
 * tripping that check entirely.
 */
function subjectsInclude(subjects: string[] | undefined, host: string): boolean {
  return !!subjects?.some(s => s === host);
}

/**
 * Whether a route's server actually has TLS enabled. Usually determined by the
 * presence of `tls_connection_policies` on the server — but a server shared by
 * multiple hosts with identical TLS settings (#139, e.g. two subdomains both using
 * `tls internal` with no advanced options) doesn't get an explicit connection
 * policy from Caddy's Caddyfile adapter; each host is simply listed as a `subjects`
 * entry in a shared `apps.tls.automation.policies` policy instead. Fall back to
 * that so shared-listener routes aren't misdetected as plain HTTP.
 *
 * A third case (#171): a site with a public-looking hostname and no explicit `tls`
 * config at all is still served over HTTPS — Caddy's automatic HTTPS turns it on by
 * default, the same "Caddy-default ACME" case classifyAcmeHosts (#141) already
 * detects. Only a host Caddy's adapter put in `automatic_https.skip` (an explicit
 * `http://` scheme) or a non-public host (localhost/IP) is genuinely plain HTTP.
 */
function serverHasTls(
  server: { tls_connection_policies?: CaddyTLSConnectionPolicy[]; automatic_https?: { skip?: string[] } },
  automationPolicies: import("./types").CaddyAutomationPolicy[] | undefined,
  externalHost: string | undefined,
): boolean {
  if (Array.isArray(server.tls_connection_policies) && server.tls_connection_policies.length > 0) return true;
  const hosts = externalHostList(externalHost);
  if (hosts.some(h => automationPolicies?.some(p => subjectsInclude(p.subjects, h)))) return true;
  return tlsSubjectHosts(externalHost).some(h => !server.automatic_https?.skip?.includes(h));
}

/** Extracts a usable subject hostname from a named server's first listen address, if any (e.g. "example.com:443"). */
function namedServerSubjectHost(def: { listenAddresses: string[] }): string | undefined {
  const addr = def.listenAddresses[0];
  if (!addr) return undefined;
  const colonIdx = addr.lastIndexOf(":");
  const host = colonIdx > 0 ? addr.slice(0, colonIdx) : "";
  return tlsSubjectHost(host || undefined);
}

/** True if none of a named server's listen addresses have a real (non-IP) hostname. Used by the TLS UI to warn that a lifetime/renewal-window setting is shared across every hostless internal-TLS proxy/server. */
export function namedServerIsHostless(listenAddresses: string[]): boolean {
  return !namedServerSubjectHost({ listenAddresses });
}

/** Stable logger name for a proxy's access log, keyed by port. */
function accessLoggerName(port: number): string {
  return `cockpit-access-${port}`;
}

function applyAccessLog(server: CaddyServer, proxy: { externalPort: number; accessLog?: import("./types").AccessLogConfig }): void {
  if (proxy.accessLog) {
    server.logs = { default_logger_name: accessLoggerName(proxy.externalPort) };
  } else {
    delete (server as Record<string, unknown>).logs;
  }
}

/** Recursively flattens subroute handlers so we can find the actual leaf handler. */
function flattenErrorHandles(handles: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  for (const h of handles) {
    if (h.handler === "subroute") {
      const routes = (h.routes as Array<{ handle?: unknown[] }> | undefined) ?? [];
      for (const r of routes) {
        result.push(...flattenErrorHandles((r.handle ?? []) as Array<Record<string, unknown>>));
      }
    } else {
      result.push(h);
    }
  }
  return result;
}

/**
 * Finds the automation policy that governs certs for this hostname: the policy
 * whose `subjects` includes it, falling back to the shared subject-less policy
 * (Caddy allows at most one policy with no subjects; it's the catch-all default).
 * With no host (this app addresses most servers by port, not domain), only the
 * default policy can apply — Caddy has no other way to scope automation policies.
 */
function findAutomationPolicy(
  automationPolicies: import("./types").CaddyAutomationPolicy[] | undefined,
  host: string | undefined,
): import("./types").CaddyAutomationPolicy | undefined {
  if (!automationPolicies) return undefined;
  if (host) {
    const scoped = automationPolicies.find(p => subjectsInclude(p.subjects, host));
    if (scoped) return scoped;
  }
  return automationPolicies.find(p => !p.subjects?.length);
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

function parseTlsAdvanced(
  policy: CaddyTLSConnectionPolicy,
  automationPolicies: import("./types").CaddyAutomationPolicy[] | undefined,
  host: string | undefined,
): import("./types").TlsAdvancedConfig | undefined {
  const cfg: import("./types").TlsAdvancedConfig = {};
  let hasData = false;
  if (policy.protocol_min) { cfg.protocolMin = policy.protocol_min as import("./types").TlsProtocolVersion; hasData = true; }
  if (policy.protocol_max) { cfg.protocolMax = policy.protocol_max as import("./types").TlsProtocolVersion; hasData = true; }
  if (Array.isArray(policy.cipher_suites) && policy.cipher_suites.length) { cfg.cipherSuites = policy.cipher_suites as string[]; hasData = true; }
  if (Array.isArray(policy.curves) && policy.curves.length) { cfg.curves = policy.curves as string[]; hasData = true; }
  const automationPolicy = findAutomationPolicy(automationPolicies, host);
  const lifetime = parseCertLifetimeDuration(automationPolicy?.issuers?.[0]?.lifetime);
  if (lifetime) { cfg.certLifetime = lifetime; hasData = true; }
  if (automationPolicy?.renewal_window_ratio !== undefined) { cfg.renewalWindowRatio = automationPolicy.renewal_window_ratio; hasData = true; }
  return hasData ? cfg : undefined;
}

function parseMtls(policy: CaddyTLSConnectionPolicy): import("./types").MtlsConfig | undefined {
  const ca = policy.client_authentication;
  if (!ca?.mode) return undefined;
  const fromPool = ca.ca?.provider === "file" ? ca.ca.pem_files?.[0] : undefined;
  const trustedCaFile = fromPool || ca.trusted_ca_certs_pem_files?.[0] || undefined;
  return { mode: ca.mode as import("./types").MtlsMode, trustedCaFile };
}

/** Resolves a manually-loaded certificate (#152) from a connection policy's
 *  `certificate_selection.any_tag` reference into `apps.tls.certificates.load_files`.
 *  caFile isn't part of Caddy's JSON model at all — it's recovered separately from a
 *  Caddyfile comment fallback (see parseConfCustomTlsCaMap) and layered on in useProxies. */
function parseCustomTls(
  policy: CaddyTLSConnectionPolicy | undefined,
  certLoadFiles: import("./types").CaddyCertLoadFile[] | undefined,
): import("./types").CustomTlsConfig | undefined {
  const tag = policy?.certificate_selection?.any_tag?.[0];
  if (!tag) return undefined;
  const entry = certLoadFiles?.find(f => f.tags?.includes(tag));
  if (!entry) return undefined;
  return { certFile: entry.certificate, keyFile: entry.key };
}

function hasCustomInternalIssuer(adv: import("./types").TlsAdvancedConfig | undefined): boolean {
  return !!(adv?.certLifetime || adv?.renewalWindowRatio !== undefined);
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

/** Stable tag identifying a proxy's manually-loaded certificate (#152) in
 *  apps.tls.certificates.load_files — derived the same way as the proxy's own identity
 *  (host, or port when hostless) so it survives edits to unrelated fields. */
function customCertTag(proxy: Pick<ProxyEntry, "externalPort" | "externalHost" | "matchers">): string {
  return `custom:${standaloneProxyId(proxy)}`;
}

function buildTlsPolicy(
  proxy: {
    tlsAdvanced?: import("./types").TlsAdvancedConfig;
    mtls?: import("./types").MtlsConfig;
    customTls?: import("./types").CustomTlsConfig;
    externalPort?: number;
    externalHost?: string;
    matchers?: import("./types").RouteMatch;
  },
): CaddyTLSConnectionPolicy {
  const policy: CaddyTLSConnectionPolicy = {};
  if (proxy.tlsAdvanced) {
    if (proxy.tlsAdvanced.protocolMin) policy.protocol_min = proxy.tlsAdvanced.protocolMin;
    if (proxy.tlsAdvanced.protocolMax) policy.protocol_max = proxy.tlsAdvanced.protocolMax;
    if (proxy.tlsAdvanced.cipherSuites?.length) policy.cipher_suites = proxy.tlsAdvanced.cipherSuites;
    if (proxy.tlsAdvanced.curves?.length) policy.curves = proxy.tlsAdvanced.curves;
  }
  if (proxy.mtls) {
    const ca: CaddyTLSClientAuthentication = { mode: proxy.mtls.mode };
    if (proxy.mtls.trustedCaFile?.trim()) {
      ca.ca = { provider: "file", pem_files: [proxy.mtls.trustedCaFile.trim()] };
    }
    policy.client_authentication = ca;
  }
  if (proxy.customTls?.certFile?.trim() && proxy.customTls?.keyFile?.trim() && proxy.externalPort !== undefined) {
    policy.certificate_selection = {
      any_tag: [customCertTag({ externalPort: proxy.externalPort, externalHost: proxy.externalHost, matchers: proxy.matchers })],
    };
  }
  return policy;
}

/**
 * Rebuilds apps.tls.automation.policies after a single server (identified by
 * changedServerKey, addressed by changedHosts if it has real hostnames) was
 * added/edited.
 *
 * Caddy can only scope an automation policy by `subjects` (hostnames) — there
 * is no "tags"-style field for arbitrary per-server scoping. So:
 *  - A server with real (non-IP) hostnames gets its own policy scoped by
 *    `subjects` listing all of them (#208), independent of every other server.
 *  - A hostless server (the common case here, since this app addresses most
 *    proxies by port) has no way to get its own distinct policy — Caddy allows
 *    only one policy without subjects. Its custom lifetime/ratio is merged
 *    directly into that single shared default policy instead; if more than one
 *    hostless server customizes it, the most recently saved one wins.
 */
function rebuildTlsAutomationPolicies(
  config: CaddyConfig,
  servers: Record<string, { tls_connection_policies?: CaddyTLSConnectionPolicy[] }>,
  changedServerKey: string,
  changedAdv: import("./types").TlsAdvancedConfig | undefined,
  changedHosts: string[],
): import("./types").CaddyTlsApp | undefined {
  const hasTls = Object.values(servers).some(
    s => Array.isArray(s.tls_connection_policies) && s.tls_connection_policies.length > 0,
  );
  if (!hasTls) return undefined;

  const isChangedServerLive = !!servers[changedServerKey]?.tls_connection_policies?.length;
  const existing = config.apps?.tls?.automation?.policies ?? [];
  const otherSubjectPolicies = existing.filter(p => p.subjects?.length && !changedHosts.some(h => subjectsInclude(p.subjects, h)));

  // A hostless proxy/server always carries the current shared internal-cert lifetime
  // in its own tlsAdvanced by the time it reaches here (useProxies.ts stamps it on
  // before every write — see GlobalOptions.internalCertLifetime), so it's safe to
  // apply directly to the shared default policy: every hostless site is guaranteed to
  // agree on the same value by construction, unlike a raw per-proxy field would be.
  // renewal_window_ratio is deliberately left alone here — it comes only from the
  // real global `renewal_window_ratio` Caddyfile option, which the next reload applies.
  let defaultPolicy: import("./types").CaddyAutomationPolicy =
    existing.find(p => !p.subjects?.length) ?? { issuers: [{ module: "internal" }] };

  if (!changedHosts.length && isChangedServerLive) {
    const issuer: { module: string; lifetime?: string } = { module: "internal" };
    if (changedAdv?.certLifetime) issuer.lifetime = changedAdv.certLifetime;
    defaultPolicy = { ...defaultPolicy, issuers: [issuer] };
  }

  const policies: import("./types").CaddyAutomationPolicy[] = [defaultPolicy, ...otherSubjectPolicies];

  if (changedHosts.length && isChangedServerLive && hasCustomInternalIssuer(changedAdv)) {
    const issuer: { module: string; lifetime?: string } = { module: "internal" };
    if (changedAdv?.certLifetime) issuer.lifetime = changedAdv.certLifetime;
    policies.push({
      subjects: changedHosts,
      issuers: [issuer],
      ...(changedAdv?.renewalWindowRatio !== undefined ? { renewal_window_ratio: changedAdv.renewalWindowRatio } : {}),
    });
  }

  return { automation: { policies } };
}

/** True when the reverse_proxy re-raises upstream responses as errors (the #255 switch). */
function reraisesUpstreamErrors(rp: CaddyReverseProxyHandler): boolean {
  const responses = (rp.handle_response as Array<{ routes?: Array<{ handle?: Array<{ handler?: string }> }> }> | undefined) ?? [];
  return responses.some(r => r.routes?.some(route => route.handle?.some(h => h.handler === "error")));
}

function parseErrorHandlers(server: CaddyServer): import("./types").ErrorHandlerConfig[] | undefined {
  const errRoutes = (server.errors as { routes?: unknown[] } | undefined)?.routes;
  if (!errRoutes?.length) return undefined;

  const handlers: import("./types").ErrorHandlerConfig[] = [];
  for (const route of errRoutes as Array<Record<string, unknown>>) {
    const matchArr = (route.match as Array<Record<string, unknown>> | undefined) ?? [];
    const firstMatch = matchArr[0] ?? {};

    let matchType: import("./types").ErrorMatchType = "all";
    let codes: number[] | undefined;

    if (typeof firstMatch.expression === "string") {
      const expr = firstMatch.expression;
      const inMatch = expr.match(/in \[([0-9, ]+)\]/);
      if (inMatch) {
        codes = inMatch[1].split(",").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
        matchType = "specific";
      } else if (expr.includes(">= 400") || expr.includes("< 500")) {
        matchType = "4xx";
      } else if (expr.includes(">= 500") || expr.includes("< 600")) {
        matchType = "5xx";
      }
    }

    // Caddy's Caddyfile adapter wraps handlers in a subroute — flatten before searching.
    const rawHandles = (route.handle as Array<Record<string, unknown>> | undefined) ?? [];
    const handles = flattenErrorHandles(rawHandles);

    const fsHandle = handles.find(h => h.handler === "file_server");
    if (fsHandle) {
      handlers.push({ matchType, codes, type: "static", filePath: typeof fsHandle.root === "string" ? fsHandle.root : undefined });
      continue;
    }
    const srHandle = handles.find(h => h.handler === "static_response") as
      { handler: string; status_code?: number; body?: string; headers?: Record<string, string[]> } | undefined;
    if (srHandle) {
      const location = srHandle.headers?.["Location"]?.[0];
      if (location) {
        handlers.push({ matchType, codes, type: "redirect", redirectTo: location, redirectCode: (srHandle.status_code ?? 302) as 301 | 302 | 307 | 308 });
      } else {
        handlers.push({ matchType, codes, type: "respond", body: srHandle.body, statusCode: srHandle.status_code });
      }
    }
  }
  return handlers.length ? handlers : undefined;
}

function buildErrorRoutes(handlers: import("./types").ErrorHandlerConfig[]): { routes: unknown[] } | undefined {
  if (!handlers.length) return undefined;
  const routes = handlers.map(h => {
    let match: unknown[] | undefined;
    if (h.matchType === "specific" && h.codes?.length) {
      const codes = h.codes.join(", ");
      match = [{ expression: `{http.error.status_code} in [${codes}]` }];
    } else if (h.matchType === "4xx") {
      match = [{ expression: "{http.error.status_code} >= 400 && {http.error.status_code} < 500" }];
    } else if (h.matchType === "5xx") {
      match = [{ expression: "{http.error.status_code} >= 500 && {http.error.status_code} < 600" }];
    }

    let handle: Record<string, unknown>[];
    if (h.type === "redirect") {
      handle = [{ handler: "static_response", status_code: h.redirectCode ?? 302, headers: { Location: [h.redirectTo ?? "/"] } }];
    } else if (h.type === "static") {
      handle = [
        { handler: "rewrite", uri: "/{http.error.status_code}.html" },
        { handler: "file_server", root: h.filePath ?? "/var/www/errors" },
      ];
    } else {
      const r: Record<string, unknown> = { handler: "static_response" };
      if (h.statusCode) r.status_code = h.statusCode;
      if (h.body) r.body = h.body;
      handle = [r];
    }

    const route: Record<string, unknown> = { handle };
    if (match) route.match = match;
    return route;
  });
  return { routes };
}

function applyErrorHandlers(server: CaddyServer, proxy: { errorHandlers?: import("./types").ErrorHandlerConfig[] }): void {
  const built = proxy.errorHandlers?.length ? buildErrorRoutes(proxy.errorHandlers) : undefined;
  if (built) {
    (server as Record<string, unknown>).errors = built;
  } else {
    delete (server as Record<string, unknown>).errors;
  }
}

export function buildServerEntry(proxy: Omit<ProxyEntry, "id" | "serverKey">): CaddyServer {
  const listenAddr = buildListenAddr(proxy);
  // A route with matchers is NOT terminal — allow fallthrough to subsequent routes.
  const isTerminal = !proxy.matchers;
  const matchArr = proxy.matchers ? [buildMatcherJson(proxy.matchers)] : siteHostMatch(proxy);

  if (proxy.staticResponse) {
    const h: Record<string, unknown> = {
      handler: "static_response",
      status_code: proxy.staticResponse.statusCode,
    };
    if (proxy.staticResponse.body) h.body = proxy.staticResponse.body;
    if (proxy.staticResponse.close) h.close = true;
    const route: CaddyRoute = { handle: [h as CaddyHandler], terminal: isTerminal };
    if (matchArr) route.match = matchArr;
    const server: CaddyServer = { listen: [listenAddr], routes: [route] };
    applyAccessLog(server, proxy);
    applyErrorHandlers(server, proxy);
    return applyServerTimeouts(server, proxy);
  }
  if (proxy.redirect) {
    const route: CaddyRoute = {
      handle: [{
        handler: "static_response",
        headers: { Location: [caddyPlaceholderToJson(proxy.redirect.to)] },
        status_code: proxy.redirect.code,
      }],
      terminal: isTerminal,
    };
    if (matchArr) route.match = matchArr;
    const server: CaddyServer = { listen: [listenAddr], routes: [route] };
    applyAccessLog(server, proxy);
    applyErrorHandlers(server, proxy);
    return applyServerTimeouts(server, proxy);
  }
  if (proxy.fileServer) {
    const fsHandles: CaddyHandler[] = [];
    if (proxy.requestBodyMaxSize) fsHandles.push(buildRequestBodyHandler(proxy.requestBodyMaxSize));
    if (proxy.compress) fsHandles.push(buildEncodeHandler());
    if (proxy.basicAuth?.length) fsHandles.push(buildBasicAuthHandler(proxy.basicAuth));
    if (proxy.responseHeaders?.length) fsHandles.push(buildResponseHeadersHandler(proxy.responseHeaders));
    fsHandles.push(buildFileServerJson(proxy.fileServer));
    const route: CaddyRoute = { handle: withSpaFallback(proxy.fileServer, fsHandles), terminal: isTerminal };
    if (matchArr) route.match = matchArr;
    const server: CaddyServer = { listen: [listenAddr], routes: [route] };
    if (proxy.tls) server.tls_connection_policies = [buildTlsPolicy(proxy)];
    applyAccessLog(server, proxy);
    applyErrorHandlers(server, proxy);
    return applyServerTimeouts(server, proxy);
  }
  const handles: CaddyHandler[] = [];
  if (proxy.requestBodyMaxSize) handles.push(buildRequestBodyHandler(proxy.requestBodyMaxSize));
  const handlePathRwSingle = proxy.handlePath ? buildHandlePathRewriteJson(proxy.matchers) : undefined;
  if (handlePathRwSingle) handles.push(handlePathRwSingle);
  if (proxy.compress) handles.push(buildEncodeHandler());
  if (proxy.basicAuth?.length) handles.push(buildBasicAuthHandler(proxy.basicAuth));
  if (proxy.responseHeaders?.length) handles.push(buildResponseHeadersHandler(proxy.responseHeaders));
  if (proxy.rewrite) handles.push(buildRewriteHandler(proxy.rewrite));
  if (proxy.forwardAuth) {
    const faH = buildForwardAuthHandler(proxy.forwardAuth);
    if (faH) handles.push(faH);
  }
  handles.push(buildReverseProxyHandler(proxy, proxy.errorHandlers));
  const route: CaddyRoute = { handle: handles, terminal: isTerminal };
  if (matchArr) route.match = matchArr;
  const server: CaddyServer = { listen: [listenAddr], routes: [route] };
  if (proxy.tls) server.tls_connection_policies = [buildTlsPolicy(proxy)];
  applyAccessLog(server, proxy);
  applyErrorHandlers(server, proxy);
  return applyServerTimeouts(server, proxy);
}

/** The `file_server` handler with its options (#262). */
function buildFileServerJson(fs: import("./types").FileServerConfig): CaddyHandler {
  const h: Record<string, unknown> = { handler: "file_server", root: fs.root };
  if (fs.browse) h.browse = {};
  if (fs.index?.length) h.index_names = fs.index;
  if (fs.hide?.length) h.hide = fs.hide;
  if (fs.precompressed?.length) {
    h.precompressed = Object.fromEntries(fs.precompressed.map(e => [e, {}]));
    h.precompressed_order = fs.precompressed;
  }
  return h as CaddyHandler;
}

/**
 * SPA mode (#262) the way `try_files` adapts: a subroute whose first route rewrites to the
 * first existing file of `{path}` / `/index.html`, then the site's own handlers.
 */
function withSpaFallback(fs: import("./types").FileServerConfig, handles: CaddyHandler[]): CaddyHandler[] {
  if (!fs.spa) return handles;
  return [{
    handler: "subroute",
    routes: [
      {
        match: [{ file: { root: fs.root, try_files: ["{http.request.uri.path}", "/index.html"] } }],
        handle: [{ handler: "rewrite", uri: "{http.matchers.file.relative}" }],
      },
      { handle: handles },
    ],
  } as CaddyHandler];
}

/** Patch handles in-place: update reverse_proxy and rewrite handlers, leave everything else untouched. */
function patchHandles(handles: CaddyHandler[], proxy: ProxyEntry): CaddyHandler[] {
  if (proxy.fileServer) {
    const fsHandles: CaddyHandler[] = [];
    if (proxy.requestBodyMaxSize) fsHandles.push(buildRequestBodyHandler(proxy.requestBodyMaxSize));
    if (proxy.compress) fsHandles.push(buildEncodeHandler());
    if (proxy.basicAuth?.length) fsHandles.push(buildBasicAuthHandler(proxy.basicAuth));
    if (proxy.responseHeaders?.length) fsHandles.push(buildResponseHeadersHandler(proxy.responseHeaders));
    fsHandles.push(buildFileServerJson(proxy.fileServer));
    return withSpaFallback(proxy.fileServer, fsHandles);
  }
  let found = false;
  // Strip any existing encode/authentication/rewrite/headers/file_server/forward_auth/
  // request_body handlers; we'll re-add the correct ones below
  const withoutRewrite = handles.filter(h => {
    if (h.handler === "rewrite" || h.handler === "headers" || h.handler === "encode" || h.handler === "authentication" || h.handler === "file_server" || h.handler === "request_body") return false;
    if (h.handler === "subroute") {
      const isAuthSubroute = (h.routes as Array<{ handle?: AnyHandler[] }> | undefined)?.some(r =>
        (r.handle ?? []).some(sh => sh.handler === "reverse_proxy" && isForwardAuthProxy(sh as CaddyReverseProxyHandler)),
      );
      if (isAuthSubroute) return false;
    }
    return true;
  });
  const patched = withoutRewrite.map(h => {
    if (h.handler === "reverse_proxy") {
      found = true;
      return buildReverseProxyHandler(proxy, proxy.errorHandlers);
    }
    // Recurse into subroute
    const anyH = h as AnyHandler;
    if (anyH.handler === "subroute" && anyH.routes) {
      return {
        ...h,
        routes: anyH.routes.map(r => ({
          ...r,
          handle: r.handle ? patchHandles(r.handle as CaddyHandler[], proxy) : r.handle,
        })),
      };
    }
    return h;
  });
  if (!found) {
    patched.push(buildReverseProxyHandler(proxy, proxy.errorHandlers));
  }
  // Prepend request_body/encode/auth/response-headers/rewrite/forward_auth handlers if
  // configured — request_body must run first, before anything that reads the body.
  const prefix: CaddyHandler[] = [];
  if (proxy.requestBodyMaxSize) prefix.push(buildRequestBodyHandler(proxy.requestBodyMaxSize));
  if (proxy.compress) prefix.push(buildEncodeHandler());
  if (proxy.basicAuth?.length) prefix.push(buildBasicAuthHandler(proxy.basicAuth));
  if (proxy.responseHeaders?.length) prefix.push(buildResponseHeadersHandler(proxy.responseHeaders));
  if (proxy.rewrite) prefix.push(buildRewriteHandler(proxy.rewrite));
  if (proxy.forwardAuth) {
    const faH = buildForwardAuthHandler(proxy.forwardAuth);
    if (faH) prefix.push(faH);
  }
  return [...prefix, ...patched] as CaddyHandler[];
}

/** Patch only the fields we manage; preserve everything else in the original server. */
function patchServer(original: CaddyServer, proxy: ProxyEntry): CaddyServer {
  const server = { ...original };

  server.listen = [buildListenAddr(proxy)];

  if (proxy.tls) {
    server.tls_connection_policies = [buildTlsPolicy(proxy)];
  } else {
    delete server.tls_connection_policies;
  }

  const siteMatch = siteHostMatch(proxy);
  server.routes = (original.routes ?? []).map(route => {
    const patched: CaddyRoute = { ...route, handle: patchHandles((route.handle ?? []) as CaddyHandler[], proxy) };
    if (siteMatch) patched.match = siteMatch;
    // A name list set by an earlier multi-host save would otherwise outlive the edit
    // that took the proxy back to one name (or none).
    else if (!proxy.matchers && isMultiHostOnlyMatch(route.match)) delete patched.match;
    return patched;
  });

  applyAccessLog(server, proxy);
  applyErrorHandlers(server, proxy);

  return applyServerTimeouts(server, proxy);
}

function buildLoggingWriter(accessLog: import("./types").AccessLogConfig): import("./types").CaddyLogWriter {
  if (accessLog.output !== "file" || !accessLog.filePath) return { output: accessLog.output };
  const writer: import("./types").CaddyLogWriter = { output: "file", filename: accessLog.filePath };
  if (accessLog.rollSizeMb) writer.roll_size_mb = accessLog.rollSizeMb;
  if (accessLog.rollKeepCount) writer.roll_keep = accessLog.rollKeepCount;
  if (accessLog.rollKeepDays) writer.roll_keep_days = accessLog.rollKeepDays;
  if (accessLog.rollCompress === false) writer.roll_gzip = false;
  return writer;
}

/** Update config.logging.logs: swap out the old logger for this proxy (if any) and add/remove the new one. */
function patchLoggingLogs(
  config: CaddyConfig,
  originalServer: CaddyServer | undefined,
  proxy: ProxyEntry,
): CaddyConfig["logging"] {
  const existingLogs = { ...(config.logging?.logs ?? {}) };

  // Remove the old logger for this server slot (it may be auto-named by Caddy or our own name)
  const oldLoggerName = (originalServer?.logs as { default_logger_name?: string } | undefined)?.default_logger_name;
  if (oldLoggerName) {
    delete existingLogs[oldLoggerName];
    const excKey = `http.log.access.${oldLoggerName}`;
    if (existingLogs.default?.exclude) {
      const filtered = existingLogs.default.exclude.filter(e => e !== excKey);
      existingLogs.default = filtered.length
        ? { ...existingLogs.default, exclude: filtered }
        : Object.fromEntries(Object.entries(existingLogs.default).filter(([k]) => k !== "exclude")) as typeof existingLogs.default;
      if (existingLogs.default && !Object.keys(existingLogs.default).length) delete existingLogs.default;
    }
  }

  if (proxy.accessLog) {
    const loggerName = accessLoggerName(proxy.externalPort);
    const incKey = `http.log.access.${loggerName}`;
    const logEntry: import("./types").CaddyLoggerConfig = {
      writer: buildLoggingWriter(proxy.accessLog),
      include: [incKey],
    };
    if (proxy.accessLog.format) logEntry.encoder = { format: proxy.accessLog.format };
    if (proxy.accessLog.level) logEntry.level = proxy.accessLog.level;
    existingLogs[loggerName] = logEntry;

    // Keep the default logger from flooding its output with access log lines
    const defExcludes = new Set<string>(existingLogs.default?.exclude ?? []);
    defExcludes.add(incKey);
    existingLogs.default = { ...(existingLogs.default ?? {}), exclude: [...defExcludes] };
  }

  return Object.keys(existingLogs).length > 0 ? { logs: existingLogs } : undefined;
}

/**
 * Rebuilds apps.tls.certificates.load_files after a single proxy was added/edited —
 * mirrors rebuildTlsAutomationPolicies's "filter out this proxy's old entry, re-add if
 * still applicable" pattern, keyed by the proxy's own stable identity tag rather than by
 * cert content, so switching to a different cert file (or disabling TLS/reverting to
 * ACME/internal) cleanly replaces or drops the old load_files entry instead of leaking it.
 */
/**
 * The tls app after a JSON push (#253): only the automation policies and the loaded
 * certificate files are rebuilt by the plugin. Everything else in apps.tls stays, above all
 * automation.on_demand (the global ask permission): dropping it left on-demand sites with no
 * permission check until the next reload.
 */
function mergeTlsApp(
  prev: import("./types").CaddyTlsApp | undefined,
  rebuilt: import("./types").CaddyTlsApp | undefined,
  certificates?: Pick<import("./types").CaddyTlsApp, "certificates">,
): import("./types").CaddyTlsApp | undefined {
  const without = (obj: unknown, key: string): Record<string, unknown> =>
    Object.fromEntries(Object.entries((obj ?? {}) as Record<string, unknown>).filter(([k]) => k !== key));
  const { automation: prevAutomation, certificates: prevCertificates, ...rest } = (prev ?? {}) as import("./types").CaddyTlsApp & Record<string, unknown>;
  const automationRest = without(prevAutomation, "policies");
  const certificatesRest = without(prevCertificates, "load_files");
  const out: Record<string, unknown> = { ...rest };
  const policies = rebuilt?.automation?.policies;
  if (policies?.length || Object.keys(automationRest).length) {
    out.automation = { ...automationRest, ...(policies?.length ? { policies } : {}) };
  }
  const loadFiles = certificates?.certificates?.load_files;
  if (loadFiles?.length || Object.keys(certificatesRest).length) {
    out.certificates = { ...certificatesRest, ...(loadFiles?.length ? { load_files: loadFiles } : {}) };
  }
  return Object.keys(out).length ? out as import("./types").CaddyTlsApp : undefined;
}

function rebuildTlsCertificates(
  config: CaddyConfig,
  proxy: Pick<ProxyEntry, "tls" | "customTls" | "externalPort" | "externalHost" | "matchers">,
): Pick<import("./types").CaddyTlsApp, "certificates"> | undefined {
  const tag = customCertTag(proxy);
  const existing = config.apps?.tls?.certificates?.load_files ?? [];
  const filtered = existing.filter(e => !e.tags?.includes(tag));
  const custom = proxy.tls ? proxy.customTls : undefined;
  const loadFiles = (custom?.certFile?.trim() && custom?.keyFile?.trim())
    ? [...filtered, { certificate: custom.certFile.trim(), key: custom.keyFile.trim(), tags: [tag] }]
    : filtered;
  return loadFiles.length ? { certificates: { load_files: loadFiles } } : undefined;
}

export function mergeProxy(config: CaddyConfig, proxy: ProxyEntry): CaddyConfig {
  const servers = { ...(config.apps?.http?.servers ?? {}) };
  const original = servers[proxy.serverKey];
  servers[proxy.serverKey] = (original && !proxy.redirect && !proxy.staticResponse) ? patchServer(original, proxy) : buildServerEntry(proxy);

  const logging = patchLoggingLogs(config, original, proxy);
  const automation = rebuildTlsAutomationPolicies(config, servers, proxy.serverKey, proxy.tlsAdvanced, tlsSubjectHosts(proxy.externalHost));
  const certificates = rebuildTlsCertificates(config, proxy);

  return {
    ...config,
    logging,
    apps: {
      ...config.apps,
      http: { ...config.apps?.http, servers },
      tls: mergeTlsApp(config.apps?.tls, automation, certificates),
    },
  };
}

/**
 * Hashes a basic-auth password with `caddy hash-password`. The password goes on stdin, not as
 * `--plaintext <pw>`: argv is readable by every local user in /proc/<pid>/cmdline (#255).
 * With stdin not a terminal, caddy reads one newline-terminated line (no confirmation prompt).
 */
export async function hashPassword(plaintext: string): Promise<string> {
  const proc = cockpit.spawn(["caddy", "hash-password"], { superuser: "try", err: "message" });
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

export function removeProxy(config: CaddyConfig, serverKey: string): CaddyConfig {
  const servers = { ...(config.apps?.http?.servers ?? {}) };
  const removedServer = servers[serverKey];
  delete servers[serverKey];

  const hasTls = Object.values(servers).some(
    s => Array.isArray(s.tls_connection_policies) && s.tls_connection_policies.length > 0,
  );

  // Clean up the access logger for the removed server
  const removedLoggerName = (removedServer?.logs as { default_logger_name?: string } | undefined)?.default_logger_name;
  let logging = config.logging;
  if (removedLoggerName && config.logging?.logs) {
    const logs = { ...config.logging.logs };
    delete logs[removedLoggerName];
    const excKey = `http.log.access.${removedLoggerName}`;
    if (logs.default?.exclude) {
      const filtered = logs.default.exclude.filter(e => e !== excKey);
      logs.default = filtered.length
        ? { ...logs.default, exclude: filtered }
        : Object.fromEntries(Object.entries(logs.default).filter(([k]) => k !== "exclude")) as typeof logs.default;
      if (logs.default && !Object.keys(logs.default).length) delete logs.default;
    }
    logging = Object.keys(logs).length > 0 ? { logs } : undefined;
  }

  return {
    ...config,
    logging,
    apps: {
      ...config.apps,
      http: { ...config.apps?.http, servers },
      tls: hasTls ? config.apps?.tls : undefined,
    },
  };
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

export function parseServerDefsFromConf(content: string): import("./types").ServerDef[] {
  const defs: import("./types").ServerDef[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const keyMatch = lines[i].match(/^# server: (.+)$/);
    if (!keyMatch) continue;
    const key = keyMatch[1].trim();

    // Optional embedded serverdef comment on the very next line
    const nextLine = lines[i + 1] ?? "";
    const defMatch = nextLine.match(/^# serverdef: (.+)$/);

    // Resolve listen addresses from the first non-comment, non-blank block header line
    const listenAddresses: string[] = [];
    const scanFrom = defMatch ? i + 2 : i + 1;
    for (let j = scanFrom; j < lines.length; j++) {
      const line = lines[j].trim();
      if (!line || line.startsWith("#")) continue;
      const m = line.match(/^(.+?)\s*\{/);
      if (m) {
        // Strip the http:// forced onto a TLS-disabled server's addresses (see
        // serverDefToBlock) — listenAddresses itself never carries a scheme.
        const parts = m[1].trim().split(/\s+/).map(p => p.replace(/^https?:\/\//, ""));
        listenAddresses.push(...parts.filter(p => /:\d+/.test(p)));
      }
      break;
    }

    if (defMatch) {
      try {
        const p = JSON.parse(defMatch[1]) as Partial<import("./types").ServerDef>;
        defs.push({
          key,
          name: p.name ?? key,
          listenAddresses,
          tls: p.tls ?? false,
          tlsAdvanced: p.tlsAdvanced,
          mtls: p.mtls,
          serverReadTimeout: p.serverReadTimeout,
          serverReadHeaderTimeout: p.serverReadHeaderTimeout,
          serverWriteTimeout: p.serverWriteTimeout,
          serverIdleTimeout: p.serverIdleTimeout,
          maxHeaderBytes: p.maxHeaderBytes,
          disableHttp3: p.disableHttp3,
          accessLog: p.accessLog,
          errorHandlers: p.errorHandlers,
          routeLabels: p.routeLabels,
        });
      } catch {
        defs.push({ key, name: key, listenAddresses, tls: false });
      }
    } else {
      // Legacy block without embedded comment — minimal def
      defs.push({ key, name: key, listenAddresses, tls: false });
    }
  }
  return defs;
}

/** Builds a single route's handler lines for use inside a server block (at depth-2). */
function buildRouteBodyForServer(route: ProxyEntry): string[] {
  return buildRouteHandlerLines(route, "\t\t");
}

/**
 * Generates the complete Caddyfile block for a named multi-route server.
 * Returns the block string (including `# server: key` comment header).
 * Named routes (isNamedRoute=true) are also emitted as snippet preamble.
 */
export function serverDefToBlock(def: import("./types").ServerDef, routes: ProxyEntry[]): { preamble: string; block: string } {
  const snippets: string[] = [];
  const namedRoutes = routes.filter(r => r.isNamedRoute && r.namedRouteName);
  const normalRoutes = routes.filter(r => !r.isNamedRoute);

  // Snippets go before the server block in the conf.d file
  for (const nr of namedRoutes) {
    snippets.push(`&(${nr.namedRouteName!}) {`);
    snippets.push(...buildRouteBodyForServer(nr));
    snippets.push("}");
  }

  if (def.listenAddresses.length === 0) {
    throw new Error(`Server '${def.key}' has no listen addresses — cannot generate Caddyfile block`);
  }
  // A schemeless address with TLS off is still eligible for Caddy's automatic HTTPS
  // (only an explicit http:// scheme is excluded — see buildExternalAddress), so it can
  // silently claim the shared internal-issuer catch-all policy and conflict with any
  // other hostless site that has an explicit custom lifetime. Force http:// on every
  // listen address when TLS is disabled, same as buildExternalAddress does for proxies.
  const addr = def.tls
    ? def.listenAddresses.join(" ")
    : def.listenAddresses.map(a => `http://${a}`).join(" ");
  // Embed server def as a comment so syncConf can reconstruct it without a separate JSON file.
  // Keys with undefined values are omitted by JSON.stringify.
  const defPayload = {
    name: def.name,
    tls: def.tls || undefined,
    tlsAdvanced: def.tlsAdvanced,
    mtls: def.mtls,
    serverReadTimeout: def.serverReadTimeout,
    serverReadHeaderTimeout: def.serverReadHeaderTimeout,
    serverWriteTimeout: def.serverWriteTimeout,
    serverIdleTimeout: def.serverIdleTimeout,
    maxHeaderBytes: def.maxHeaderBytes,
    disableHttp3: def.disableHttp3 || undefined,
    accessLog: def.accessLog,
    errorHandlers: def.errorHandlers?.length ? def.errorHandlers : undefined,
    routeLabels: def.routeLabels && Object.keys(def.routeLabels).length ? def.routeLabels : undefined,
  };
  const lines: string[] = [`# server: ${def.key}`, `# serverdef: ${JSON.stringify(defPayload)}`, `${addr} {`];

  // Server-level TLS
  if (def.tls) {
    const tlsMock = { tls: def.tls, tlsAdvanced: def.tlsAdvanced, mtls: def.mtls };
    lines.push(...buildTlsCaddyLines(tlsMock, namedServerIsHostless(def.listenAddresses)));
  }
  // Server-level access log
  if (def.accessLog) lines.push(...buildLogCaddyLines(def.accessLog));

  // Routes: matcher routes first, catch-all last
  const matcherRoutes = normalRoutes.filter(r => hasAnyMatcher(r.matchers));
  const catchAllRoutes = normalRoutes.filter(r => !hasAnyMatcher(r.matchers));

  for (let i = 0; i < matcherRoutes.length; i++) {
    const route = matcherRoutes[i];
    const matcherName = `r${i}`;
    const useHandlePath = route.handlePath && isPathOnlyMatcher(route.matchers!) && !!(route.matchers!.path?.length);
    const stripRegex = useHandlePath ? multiPathStripRegex(route.matchers) : undefined;
    if (useHandlePath && !stripRegex) {
      const paths = route.matchers!.path!.join(" ");
      lines.push(`\thandle_path ${paths} {`);
      lines.push(...buildRouteBodyForServer(route));
      lines.push("\t}");
    } else {
      lines.push(...buildMatcherCaddyLines(route.matchers!, matcherName, "\t"));
      lines.push(`\thandle @${matcherName} {`);
      // handle_path takes one path only (#255); several get a regex strip.
      if (stripRegex) lines.push(`\t\turi path_regexp ${caddyQuote(stripRegex)} /`);
      lines.push(...buildRouteBodyForServer(route));
      lines.push("\t}");
    }
  }

  for (const route of catchAllRoutes) {
    lines.push("\thandle {");
    lines.push(...buildRouteBodyForServer(route));
    lines.push("\t}");
  }

  // Named-route invoke directives
  for (const nr of namedRoutes) {
    if (hasAnyMatcher(nr.matchers)) {
      const matcherName = `nr_${nr.namedRouteName!}`;
      lines.push(...buildMatcherCaddyLines(nr.matchers, matcherName, "\t"));
      lines.push(`\thandle @${matcherName} {`);
      lines.push(`\t\tinvoke ${nr.namedRouteName!}`);
      lines.push("\t}");
    } else {
      lines.push(`\tinvoke ${nr.namedRouteName!}`);
    }
  }

  // Server-level error handlers
  if (def.errorHandlers?.length) lines.push(...buildErrorHandlerCaddyLines(def.errorHandlers));

  lines.push("}");

  return {
    preamble: snippets.join("\n"),
    block: lines.join("\n"),
  };
}

/**
 * Finds the block for a named server (identified by `# server: key` comment).
 * Returns undefined if not found.
 */
export function findServerBlock(lines: string[], serverKey: string): BlockPosition | undefined {
  const positions = findBlockPositions(lines);
  return positions.find(p => p.serverKey === serverKey);
}

/**
 * Writes (inserts or replaces) a named server block in conf.d content.
 * Removes ALL existing blocks for the key first (deduplicates from past append bugs),
 * then appends the freshly generated block.
 */
export function surgicallyWriteServerBlock(content: string, def: import("./types").ServerDef, routes: ProxyEntry[]): string {
  const { preamble, block } = serverDefToBlock(def, routes);
  const fullBlock = preamble ? `${preamble}\n\n${block}` : block;

  // Remove every existing block for this key so we never produce duplicates
  let cleaned = content;
  while (findServerBlock(cleaned.split("\n"), def.key)) {
    cleaned = surgicallyRemoveServerBlock(cleaned, def.key);
  }

  const base = cleaned.trim() ? cleaned.trimEnd() : CONF_HEADER;
  return base + "\n\n" + fullBlock + "\n";
}

/**
 * Removes duplicate named server blocks from conf.d content.
 * When the old append bug caused multiple blocks for the same key, this removes all but the last.
 * Returns the cleaned content and a flag indicating whether any changes were made.
 */
export function deduplicateServerBlocks(content: string): { content: string; changed: boolean } {
  const lines = content.split("\n");
  const positions = findBlockPositions(lines);

  const counts = new Map<string, number>();
  for (const pos of positions) {
    if (pos.serverKey) counts.set(pos.serverKey, (counts.get(pos.serverKey) ?? 0) + 1);
  }

  let cleaned = content;
  let changed = false;
  for (const [key, count] of counts) {
    if (count > 1) {
      for (let i = 0; i < count - 1; i++) {
        const next = surgicallyRemoveServerBlock(cleaned, key);
        if (next !== cleaned) { cleaned = next; changed = true; }
      }
    }
  }
  return { content: cleaned, changed };
}

/**
 * Removes a named server block from conf.d content, identified by `# server: key` comment.
 */
export function surgicallyRemoveServerBlock(content: string, serverKey: string): string {
  const lines = content.split("\n");
  const pos = findServerBlock(lines, serverKey);
  if (!pos) return content;

  const start = pos.serverKeyLine ?? pos.labelLine ?? pos.headerLine;
  let end = pos.closingLine;
  while (end + 1 < lines.length && lines[end + 1].trim() === "") end++;
  return [...lines.slice(0, start), ...lines.slice(end + 1)].join("\n");
}

/**
 * Builds/patches the Caddy JSON config for a named server (multiple routes).
 * All routes belonging to the same namedServerKey are combined into one CaddyServer entry.
 */
export function mergeNamedServer(
  config: CaddyConfig,
  def: import("./types").ServerDef,
  routes: ProxyEntry[],
): CaddyConfig {
  const servers = { ...(config.apps?.http?.servers ?? {}) };

  const caddyRoutes: CaddyRoute[] = [];
  const namedRoutesMap: Record<string, { handle: CaddyHandler[] }> = {};
  const normalRoutes = routes.filter(r => !r.isNamedRoute);
  const namedRoutes = routes.filter(r => r.isNamedRoute && r.namedRouteName);

  // Named routes go into named_routes map; their server route just invokes
  for (const nr of namedRoutes) {
    const handles = buildRouteHandlesForEntry(nr);
    namedRoutesMap[nr.namedRouteName!] = { handle: handles };
    const invokeRoute: CaddyRoute = { handle: [{ handler: "invoke", name: nr.namedRouteName! }] };
    if (nr.matchers) invokeRoute.match = [buildMatcherJson(nr.matchers)];
    caddyRoutes.push(invokeRoute);
  }

  // Sort normal routes: matcher routes first, catch-all last
  const matcherRoutes = normalRoutes.filter(r => hasAnyMatcher(r.matchers));
  const catchAllRoutes = normalRoutes.filter(r => !hasAnyMatcher(r.matchers));

  for (const route of [...matcherRoutes, ...catchAllRoutes]) {
    const handles = buildRouteHandlesForEntry(route);
    const cRoute: CaddyRoute = { handle: handles, terminal: !route.matchers };
    if (route.matchers) cRoute.match = [buildMatcherJson(route.matchers)];
    caddyRoutes.push(cRoute);
  }

  const listenAddrs = def.listenAddresses.length ? def.listenAddresses : [`:${routes[0]?.externalPort ?? 80}`];

  // Caddy assigns its own generated names (srv0, srv1, ...) to servers it loads
  // straight from the Caddyfile on disk. If this named server's first live JSON
  // push happens after such a reload, the auto-generated entry for the same
  // block is still sitting in `servers` under a different key and claims the
  // same listen address — drop it so the two don't collide (#129).
  for (const [otherKey, otherServer] of Object.entries(servers)) {
    if (otherKey !== def.key && otherServer.listen?.some(addr => listenAddrs.includes(addr))) {
      delete servers[otherKey];
    }
  }

  const server: CaddyServer = {
    listen: listenAddrs,
    routes: caddyRoutes,
  };
  if (def.tls) server.tls_connection_policies = [buildTlsPolicy(def)];
  if (Object.keys(namedRoutesMap).length) {
    (server as Record<string, unknown>).named_routes = namedRoutesMap;
  }

  // Apply server-level settings from ServerDef
  if (def.serverReadTimeout) server.read_timeout = def.serverReadTimeout;
  if (def.serverReadHeaderTimeout) server.read_header_timeout = def.serverReadHeaderTimeout;
  if (def.serverWriteTimeout) server.write_timeout = def.serverWriteTimeout;
  if (def.serverIdleTimeout) server.idle_timeout = def.serverIdleTimeout;
  if (def.maxHeaderBytes) server.max_header_bytes = def.maxHeaderBytes;
  // #51 — Caddy enables h1/h2/h3 by default; explicitly list h1+h2 only to opt out of h3.
  if (def.disableHttp3) server.protocols = ["h1", "h2"];

  if (def.accessLog) {
    const loggerName = `cockpit-server-${def.key}`;
    (server as Record<string, unknown>).logs = { default_logger_name: loggerName };
  }

  if (def.errorHandlers?.length) {
    const built = buildErrorRoutes(def.errorHandlers);
    if (built) (server as Record<string, unknown>).errors = built;
  }

  servers[def.key] = server;

  // Build access log config entry
  let logging = config.logging;
  if (def.accessLog) {
    const loggerName = `cockpit-server-${def.key}`;
    const existingLogs = { ...(config.logging?.logs ?? {}) };
    existingLogs[loggerName] = {
      writer: buildLoggingWriter(def.accessLog),
      ...(def.accessLog.format ? { encoder: { format: def.accessLog.format } } : {}),
      ...(def.accessLog.level ? { level: def.accessLog.level } : {}),
    };
    const defExcludes = new Set<string>(existingLogs.default?.exclude ?? []);
    defExcludes.add(`http.log.access.${loggerName}`);
    existingLogs.default = { ...(existingLogs.default ?? {}), exclude: [...defExcludes] };
    logging = { logs: existingLogs };
  }

  return {
    ...config,
    logging,
    apps: {
      ...config.apps,
      http: { ...config.apps?.http, servers },
      tls: mergeTlsApp(config.apps?.tls, rebuildTlsAutomationPolicies(config, servers, def.key, def.tlsAdvanced, externalHostList(namedServerSubjectHost(def))), config.apps?.tls),
    },
  };
}

/** Removes a named server and all its routes from the JSON config. */
export function removeNamedServer(config: CaddyConfig, serverKey: string): CaddyConfig {
  const servers = { ...(config.apps?.http?.servers ?? {}) };
  delete servers[serverKey];
  const hasTls = Object.values(servers).some(
    s => Array.isArray(s.tls_connection_policies) && s.tls_connection_policies.length > 0,
  );
  const loggerName = `cockpit-server-${serverKey}`;
  let logging = config.logging;
  if (config.logging?.logs) {
    const logs = { ...config.logging.logs };
    delete logs[loggerName];
    const excKey = `http.log.access.${loggerName}`;
    if (logs.default?.exclude) {
      const filtered = logs.default.exclude.filter(e => e !== excKey);
      logs.default = filtered.length
        ? { ...logs.default, exclude: filtered }
        : Object.fromEntries(Object.entries(logs.default).filter(([k]) => k !== "exclude")) as typeof logs.default;
      if (logs.default && !Object.keys(logs.default).length) delete logs.default;
    }
    logging = Object.keys(logs).length > 0 ? { logs } : undefined;
  }
  return {
    ...config,
    logging,
    apps: {
      ...config.apps,
      http: { ...config.apps?.http, servers },
      tls: hasTls ? config.apps?.tls : undefined,
    },
  };
}

/** Builds the CaddyHandler list for a single ProxyEntry (used by mergeNamedServer). */
function buildRouteHandlesForEntry(proxy: ProxyEntry): CaddyHandler[] {
  const handlePathRw = proxy.handlePath ? buildHandlePathRewriteJson(proxy.matchers) : undefined;

  if (proxy.staticResponse) {
    const h: Record<string, unknown> = {
      handler: "static_response",
      status_code: proxy.staticResponse.statusCode,
    };
    if (proxy.staticResponse.body) h.body = proxy.staticResponse.body;
    if (proxy.staticResponse.close) h.close = true;
    const result: CaddyHandler[] = [];
    if (handlePathRw) result.push(handlePathRw);
    result.push(h as CaddyHandler);
    return result;
  }
  if (proxy.redirect) {
    const result: CaddyHandler[] = [];
    if (handlePathRw) result.push(handlePathRw);
    result.push({
      handler: "static_response",
      headers: { Location: [caddyPlaceholderToJson(proxy.redirect.to)] },
      status_code: proxy.redirect.code,
    });
    return result;
  }
  if (proxy.fileServer) {
    const handles: CaddyHandler[] = [];
    if (handlePathRw) handles.push(handlePathRw);
    if (proxy.compress) handles.push(buildEncodeHandler());
    if (proxy.basicAuth?.length) handles.push(buildBasicAuthHandler(proxy.basicAuth));
    if (proxy.responseHeaders?.length) handles.push(buildResponseHeadersHandler(proxy.responseHeaders));
    handles.push(buildFileServerJson(proxy.fileServer));
    return withSpaFallback(proxy.fileServer, handles);
  }
  const handles: CaddyHandler[] = [];
  if (handlePathRw) handles.push(handlePathRw);
  if (proxy.compress) handles.push(buildEncodeHandler());
  if (proxy.basicAuth?.length) handles.push(buildBasicAuthHandler(proxy.basicAuth));
  if (proxy.responseHeaders?.length) handles.push(buildResponseHeadersHandler(proxy.responseHeaders));
  if (proxy.rewrite) handles.push(buildRewriteHandler(proxy.rewrite));
  if (proxy.forwardAuth) {
    const faH = buildForwardAuthHandler(proxy.forwardAuth);
    if (faH) handles.push(faH);
  }
  handles.push(buildReverseProxyHandler(proxy, proxy.errorHandlers));
  return handles;
}

// ---------------------------------------------------------------------------
// Main Caddyfile global options — server-level timeouts & request limits
// ---------------------------------------------------------------------------

const MAIN_CADDYFILE = "/etc/caddy/Caddyfile";
const GLOBAL_MANAGED_BEGIN = "# cockpit-caddy:begin";
const GLOBAL_MANAGED_END = "# cockpit-caddy:end";
const GLOBAL_OPTS_BEGIN = "# cockpit-caddy:opts:begin";
const GLOBAL_OPTS_END = "# cockpit-caddy:opts:end";

/**
 * Runs `caddy validate` on MAIN_CADDYFILE. Streams output so the error message
 * is available even if cockpit.spawn rejects with an empty message object.
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
  let output = "";
  const proc = cockpit.spawn(
    ["caddy", "validate", "--config", MAIN_CADDYFILE, "--adapter", "caddyfile"],
    { superuser: "try", err: "out" },
  ).stream(chunk => { output += chunk; });
  try {
    await proc;
  } catch {
    // Extract the first "Error: ..." line from the combined output, or fall back to the full output.
    const errorLine = output.split("\n").find(l => /^Error:/i.test(l.trim())) ?? output.trim();
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
 * Find the top-level global options block { } in a Caddyfile.
 * Returns the indices of the opening and closing braces, or null if absent.
 * The global options block must be the first non-comment, non-whitespace token.
 */
export function findGlobalBlock(content: string): { open: number; close: number } | null {
  let i = 0;
  while (i < content.length) {
    const ch = content[i];
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") { i++; continue; }
    if (ch === "#") { while (i < content.length && content[i] !== "\n") i++; continue; }
    if (ch !== "{") return null; // First token is not {, no global block
    const open = i++;
    let depth = 1;
    while (i < content.length && depth > 0) {
      if (content[i] === "{") depth++;
      else if (content[i] === "}") depth--;
      i++;
    }
    return { open, close: i - 1 };
  }
  return null;
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
    (p.serverReadTimeout || p.serverReadHeaderTimeout || p.serverWriteTimeout || p.serverIdleTimeout || p.maxHeaderBytes || p.disableHttp3));

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

      const lines = [`\tservers :${port} {`];
      const tLines: string[] = [];
      if (readTimeout) tLines.push(`\t\t\tread_body ${readTimeout}`);
      if (readHeaderTimeout) tLines.push(`\t\t\tread_header ${readHeaderTimeout}`);
      if (writeTimeout) tLines.push(`\t\t\twrite ${writeTimeout}`);
      if (idleTimeout) tLines.push(`\t\t\tidle ${idleTimeout}`);
      if (tLines.length) lines.push("\t\ttimeouts {", ...tLines, "\t\t}");
      if (maxHeaderBytes) lines.push(`\t\tmax_header_size ${maxHeaderBytes}`);
      // #51 — Caddy enables h1/h2/h3 by default; explicitly list h1+h2 only to opt out of
      // h3. `protocols` is only valid inside this global `servers` block, not per-site.
      if (disableHttp3) lines.push("\t\tprotocols h1 h2");
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
 * Generic pure helper: inserts/replaces/removes a named managed section (delimited
 * by `beginMarker` / `endMarker`) inside the main Caddyfile global options block.
 * `body` is the new content between the markers (empty string = remove the section).
 */
function patchManagedSection(content: string, beginMarker: string, endMarker: string, body: string): string {
  const bi = content.indexOf(beginMarker);
  const ei = content.indexOf(endMarker);

  if (bi !== -1 && ei !== -1) {
    if (!body) {
      const before = content.slice(0, bi).replace(/\n[ \t]*\n?$/, "\n");
      const after = content.slice(ei + endMarker.length).replace(/^[ \t]*\n/, "");
      const joined = before.trimEnd() + "\n" + after.trimStart();
      // If the global block is now entirely empty, remove it
      const gb = findGlobalBlock(joined);
      if (gb && !joined.slice(gb.open + 1, gb.close).trim()) {
        return joined.slice(0, gb.open).trimEnd() + "\n" + joined.slice(gb.close + 1).trimStart();
      }
      return joined;
    }
    return (
      content.slice(0, bi + beginMarker.length) +
      "\n" + body + "\n" +
      content.slice(ei)
    );
  }

  if (!body) return content;

  const managed = `${beginMarker}\n${body}\n${endMarker}`;
  const gb = findGlobalBlock(content);
  if (gb) {
    return content.slice(0, gb.close) + "\n" + managed + "\n" + content.slice(gb.close);
  }
  return "{\n" + managed + "\n}\n" + content;
}

/**
 * Pure function: inserts/replaces/removes the cockpit-caddy server-timeouts managed
 * section. `blocks` is the new servers block content (empty = remove).
 */
export function patchMainCaddyfile(content: string, blocks: string): string {
  return patchManagedSection(content, GLOBAL_MANAGED_BEGIN, GLOBAL_MANAGED_END, blocks);
}

/**
 * Writes server-level timeout settings for all proxies into the main Caddyfile's
 * global options block, then validates. Throws CaddyfileError on failure and
 * restores the original file content before throwing.
 */
export async function syncGlobalTimeouts(proxies: ProxyEntry[]): Promise<void> {
  const original = (await fsReadFile(MAIN_CADDYFILE, "try")) ?? "";
  // #153 — re-merge the current global trusted_proxies setting into every per-port block
  // this rebuilds, since a bare `mkdir -p`-style regeneration would otherwise silently
  // drop it for any port that also has its own timeout/protocol override (see
  // buildManagedServersBlocks). Read fresh from disk rather than threading it through every
  // caller — trusted_proxies itself is saved via the separate syncGlobalOptions path.
  const globalOpts = parseGlobalOptions(original);
  const blocks = buildManagedServersBlocks(proxies, globalOpts.trustedProxies, globalOpts.proxyProtocol);
  const patched = patchMainCaddyfile(original, blocks);
  if (patched === original) return;

  await fsWriteFile(MAIN_CADDYFILE, patched, "try");
  try {
    await runCaddyValidate();
  } catch (e) {
    await fsWriteFile(MAIN_CADDYFILE, original, "try");
    throw e;
  }
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
  // cockpit.spawn supports `input` at runtime; the TypeScript types omit it
  const spawn = cockpit.spawn as (args: string[], opts: { input?: string; err?: string }) => Promise<string>;
  const out = await spawn(
    ["openssl", "x509", "-noout", "-dates", "-fingerprint", "-sha256"],
    { input: pem, err: "out" },
  );
  const notBefore = out.match(/notBefore=(.+)/)?.[1]?.trim() ?? "";
  const notAfter = out.match(/notAfter=(.+)/)?.[1]?.trim() ?? "";
  const fingerprint = out.match(/SHA256 Fingerprint=(.+)/)?.[1]?.trim() ?? "";
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

// ---------------------------------------------------------------------------
// Global Caddy options (http_port, https_port, debug, grace_period, shutdown_delay)
// ---------------------------------------------------------------------------

export interface GlobalOptions {
  httpPort?: number;
  httpsPort?: number;
  debug?: boolean;
  gracePeriod?: string;
  shutdownDelay?: string;
  /** ACME registration email address */
  email?: string;
  /** ACME CA directory URL */
  acmeCA?: string;
  /** Path to a PEM file of trusted roots for connecting to the ACME CA (optional) */
  acmeCARoot?: string;
  /** External Account Binding key ID */
  acmeEabKeyId?: string;
  /** External Account Binding MAC key */
  acmeEabMacKey?: string;
  /** Enable on-demand TLS certificate provisioning */
  onDemandEnabled?: boolean;
  /** Authorization URL Caddy queries before issuing an on-demand certificate */
  onDemandAsk?: string;
  /** Rate limit window for on-demand certificate issuance (Go duration, e.g. "2m") */
  onDemandInterval?: string;
  /** Maximum certificates that may be issued per rate-limit interval */
  onDemandBurst?: number;
  /**
   * Validity duration for internal-issuer certificates on hostless proxies/servers
   * (Caddy duration, e.g. "90d"). Stored as a comment marker (not a real Caddy
   * directive) and stamped identically onto every hostless proxy/server's own
   * `tls { issuer internal { lifetime } } }` block — see applyHostlessLifetime and
   * the comment on INTERNAL_LIFETIME_MARKER for why it can't be a real global option.
   */
  internalCertLifetime?: string;
  /** Global `renewal_window_ratio` (0-1): fraction of lifetime remaining before Caddy renews. */
  renewalWindowRatio?: number;
  /** Custom root path for the `file_system` certificate/config storage backend (#46).
   *  Unset means Caddy's own default ($XDG_DATA_HOME/caddy, /var/lib/caddy under systemd). */
  storagePath?: string;
  /**
   * Prometheus-compatible metrics endpoint (#43). Enabling this writes two things: the
   * global `metrics` option (turns on request-level `caddy_http_*` instrumentation across
   * every server — without it, `/metrics` only ever shows admin/Go-runtime metrics, not
   * anything about actual proxied traffic) and a small dedicated site block exposing the
   * endpoint at `metricsListenAddress`. A listen address is required whenever this is
   * enabled: the admin API here runs on a Unix socket, so metrics can't "share the admin
   * port" the way they could if admin were on TCP.
   */
  metricsEnabled?: boolean;
  /** Listen address for the dedicated metrics site, e.g. ":2019" or "127.0.0.1:2019". */
  metricsListenAddress?: string;
  /** Path the metrics endpoint is served at. Defaults to "/metrics" when unset. */
  metricsPath?: string;
  /**
   * Maps to Caddy's `disable_openmetrics` on the `metrics` handler — switches the response
   * from OpenMetrics format to plain Prometheus text exposition format. Doesn't remove any
   * metrics (Go runtime/process metrics are always included; Caddy has no toggle for
   * those), just a slightly less verbose wire format.
   */
  metricsPlainFormat?: boolean;
  /**
   * Caddy's own runtime/error log (#158) — startup messages, reload results, TLS/ACME
   * errors, config errors — as opposed to per-site access logs (AccessLogConfig on each
   * ProxyEntry/ServerDef). Written to the reserved `logging.logs.default` entry. Reuses
   * AccessLogConfig's shape since the JSON writer/level/rotation fields are identical.
   */
  runtimeLog?: import("./types").AccessLogConfig;
  /** Trusted proxy ranges / client IP header config (#153) — see TrustedProxiesConfig. */
  trustedProxies?: import("./types").TrustedProxiesConfig;
  /** Accept the PROXY protocol on incoming connections (#157) — see ProxyProtocolConfig. */
  proxyProtocol?: import("./types").ProxyProtocolConfig;
}

/**
 * Directive keywords recognized by parseOptionLines/buildGlobalOptionsLines.
 * Used to strip pre-existing top-level directives before inserting the managed
 * section for the first time, so a save never produces duplicate directives.
 */
const KNOWN_GLOBAL_OPTION_KEYS = new Set([
  "http_port", "https_port", "debug", "grace_period", "shutdown_delay",
  "email", "acme_ca", "acme_ca_root", "acme_eab", "on_demand_tls",
  "renewal_window_ratio", "storage", "metrics", "log",
]);

/**
 * Comment marker for the shared hostless-proxy cert lifetime. This is deliberately
 * NOT a real Caddy directive (unlike the rest of GlobalOptions): Caddy's Caddyfile
 * adapter forces every hostless site's own `tls internal` onto the same catch-all
 * automation policy object as a global `cert_issuer` option, then rejects the config
 * if that site's (freshly-parsed, lifetime-less) issuer doesn't exactly equal the
 * global one — unconditionally, even for a bare `tls internal` with no lifetime of
 * its own ("automation policy from site block is also default/catch-all policy...
 * in conflict"). The only way to share one lifetime across hostless proxies without
 * hitting that is to stamp the *identical* `tls { issuer internal { lifetime } } }`
 * onto every hostless proxy/server's own block — this comment is just where that
 * shared value is stored so it can be applied uniformly (see applyHostlessLifetime).
 */
const INTERNAL_LIFETIME_MARKER = "# cockpit-caddy:internal-cert-lifetime";

/** Parse the recognized global option directives out of a block of Caddyfile lines. */
function parseOptionLines(lines: string[]): GlobalOptions {
  const opts: GlobalOptions = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    const m = line.match(/^(\S+)(?:\s+(.+))?$/);
    if (!m) { i++; continue; }
    const [, key, val] = m;
    if (key === "http_port" && val) opts.httpPort = parseInt(val, 10);
    else if (key === "https_port" && val) opts.httpsPort = parseInt(val, 10);
    else if (key === "debug") opts.debug = true;
    else if (key === "grace_period" && val) opts.gracePeriod = val;
    else if (key === "shutdown_delay" && val) opts.shutdownDelay = val;
    else if (key === "email" && val) opts.email = val;
    else if (key === "acme_ca" && val) opts.acmeCA = val;
    else if (key === "acme_ca_root" && val) opts.acmeCARoot = val;
    else if (key === "acme_eab" && line.endsWith("{")) {
      i++;
      while (i < lines.length) {
        const inner = lines[i].trim();
        if (inner === "}") break;
        const im = inner.match(/^(\S+)\s+(.+)$/);
        if (im) {
          if (im[1] === "key_id") opts.acmeEabKeyId = im[2];
          else if (im[1] === "mac_key") opts.acmeEabMacKey = im[2];
        }
        i++;
      }
    } else if (key === "on_demand_tls" && line.endsWith("{")) {
      opts.onDemandEnabled = true;
      i++;
      while (i < lines.length) {
        const inner = lines[i].trim();
        if (inner === "}") break;
        const im = inner.match(/^(\S+)\s+(.+)$/);
        if (im) {
          if (im[1] === "ask") opts.onDemandAsk = im[2];
          else if (im[1] === "interval") opts.onDemandInterval = im[2];
          else if (im[1] === "burst") opts.onDemandBurst = parseInt(im[2], 10);
        }
        i++;
      }
    } else if (line.startsWith(INTERNAL_LIFETIME_MARKER)) {
      const marked = line.slice(INTERNAL_LIFETIME_MARKER.length).trim();
      if (marked) opts.internalCertLifetime = marked;
    } else if (key === "renewal_window_ratio" && val) {
      opts.renewalWindowRatio = parseFloat(val);
    } else if (key === "storage" && val?.startsWith("file_system") && line.endsWith("{")) {
      i++;
      while (i < lines.length) {
        const inner = lines[i].trim();
        if (inner === "}") break;
        const im = inner.match(/^(\S+)\s+(.+)$/);
        if (im && im[1] === "root") opts.storagePath = im[2];
        i++;
      }
    } else if (key === "metrics") {
      opts.metricsEnabled = true;
      if (line.endsWith("{")) {
        i++;
        while (i < lines.length && lines[i].trim() !== "}") i++;
      }
    } else if (key === "log" && line.endsWith("{")) {
      // #158 — Caddy's own runtime/error logger (the *unnamed* `log` global option),
      // distinct from a per-site access log. Same writer/level/rotation shape.
      const runtimeLog: import("./types").AccessLogConfig = { output: "stderr" };
      i++;
      let depth = 1;
      while (i < lines.length) {
        const inner = lines[i].trim();
        depth += (inner.match(/\{/g) ?? []).length - (inner.match(/\}/g) ?? []).length;
        if (depth <= 0) break;
        if (inner === "}") { i++; continue; }
        if (inner === "roll_uncompressed") { runtimeLog.rollCompress = false; i++; continue; }
        const im = inner.match(/^(\S+)(?:\s+(.*))?$/);
        if (im) {
          const [, ik, iv] = im;
          if (ik === "output") {
            if (iv?.startsWith("file ")) {
              runtimeLog.output = "file";
              runtimeLog.filePath = iv.slice(5).replace(/\s*\{$/, "").trim();
            } else if (iv) {
              runtimeLog.output = iv.trim() as import("./types").AccessLogOutput;
            }
          } else if (ik === "level" && iv) {
            runtimeLog.level = iv.trim() as import("./types").AccessLogLevel;
          } else if (ik === "format" && iv) {
            runtimeLog.format = iv.trim() as import("./types").AccessLogFormat;
          } else if (ik === "roll_size" && iv) {
            const mb = iv.trim().match(/^(\d+(?:\.\d+)?)MiB$/i);
            if (mb) runtimeLog.rollSizeMb = Math.round(parseFloat(mb[1]));
          } else if (ik === "roll_keep" && iv) {
            runtimeLog.rollKeepCount = parseInt(iv.trim(), 10);
          } else if (ik === "roll_keep_for" && iv) {
            const hrs = iv.trim().match(/^(\d+(?:\.\d+)?)h$/);
            if (hrs) runtimeLog.rollKeepDays = Math.round(parseFloat(hrs[1]) / 24);
          }
        }
        i++;
      }
      opts.runtimeLog = runtimeLog;
    } else if (line === "servers {") {
      // #153/#157 — the bare (portless) global `servers { trusted_proxies ...
      // listener_wrappers { proxy_protocol { ... } } }` block. Matched on the exact trimmed
      // line (not just `key === "servers"`) so a per-port `servers :PORT { ... }` block (a
      // *different* feature — #51's timeouts/protocols, its own separate managed section)
      // is left alone here, not misparsed as this one.
      const tp: import("./types").TrustedProxiesConfig = { ranges: [] };
      let pp: import("./types").ProxyProtocolConfig | undefined;
      i++;
      let depth = 1;
      let inListenerWrappers = false;
      let inProxyProtocol = false;
      while (i < lines.length) {
        const inner = lines[i].trim();
        depth += (inner.match(/\{/g) ?? []).length - (inner.match(/\}/g) ?? []).length;
        if (depth <= 0) break;

        if (inProxyProtocol) {
          if (inner === "}") { inProxyProtocol = false; i++; continue; }
          const pm = inner.match(/^(\S+)(?:\s+(.*))?$/);
          if (pm) {
            const [, pk, pv] = pm;
            if (pk === "timeout" && pv) pp!.timeout = pv.trim();
            else if (pk === "allow" && pv) pp!.allow = pv.trim().split(/\s+/);
          }
          i++;
          continue;
        }
        if (inListenerWrappers) {
          if (inner === "}") { inListenerWrappers = false; i++; continue; }
          if (inner === "proxy_protocol" || inner === "proxy_protocol {") {
            pp = pp ?? {};
            if (inner === "proxy_protocol {") inProxyProtocol = true;
          }
          i++;
          continue;
        }
        if (inner === "}") { i++; continue; }
        if (inner === "listener_wrappers {") { inListenerWrappers = true; i++; continue; }
        if (inner === "trusted_proxies_strict") { tp.strict = true; i++; continue; }
        const im = inner.match(/^(\S+)(?:\s+(.*))?$/);
        if (im) {
          const [, ik, iv] = im;
          if (ik === "trusted_proxies" && iv?.startsWith("static ")) {
            tp.ranges = iv.slice(7).trim().split(/\s+/);
          } else if (ik === "client_ip_headers" && iv) {
            tp.headers = iv.trim().split(/\s+/);
          }
        }
        i++;
      }
      if (tp.ranges.length) opts.trustedProxies = tp;
      if (pp) opts.proxyProtocol = pp;
    }
    i++;
  }
  return opts;
}

/**
 * Parse global options from a Caddyfile string. Prefers the cockpit-caddy:opts
 * managed section; if absent, falls back to scanning the real top-level global
 * options block so pre-existing/hand-written directives (or directives from a
 * Caddyfile that predates the plugin) are still reflected instead of showing
 * as blank.
 */
export function parseGlobalOptions(content: string): GlobalOptions {
  const bi = content.indexOf(GLOBAL_OPTS_BEGIN);
  const ei = content.indexOf(GLOBAL_OPTS_END);
  if (bi !== -1 && ei !== -1) {
    const section = content.slice(bi + GLOBAL_OPTS_BEGIN.length, ei);
    return parseOptionLines(section.split("\n"));
  }
  const gb = findGlobalBlock(content);
  if (!gb) return {};
  return parseOptionLines(content.slice(gb.open + 1, gb.close).split("\n"));
}

/**
 * Removes any top-level directives matching KNOWN_GLOBAL_OPTION_KEYS (single-line
 * or brace-delimited) from a global options block's inner content. Used before
 * inserting the managed opts section for the first time, so directives that
 * already exist outside the markers aren't duplicated (which `caddy validate`
 * would reject).
 */
function stripKnownGlobalOptionLines(blockInner: string): string {
  const lines = blockInner.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    const key = trimmed.split(/\s+/)[0];
    if (KNOWN_GLOBAL_OPTION_KEYS.has(key)) {
      if (trimmed.endsWith("{")) {
        let depth = 1;
        i++;
        while (i < lines.length && depth > 0) {
          const t = lines[i].trim();
          depth += (t.match(/\{/g) ?? []).length - (t.match(/\}/g) ?? []).length;
          i++;
        }
      } else {
        i++;
      }
      continue;
    }
    out.push(lines[i]);
    i++;
  }
  return out.join("\n");
}

function buildGlobalOptionsLines(opts: GlobalOptions): string {
  const lines: string[] = [];
  if (opts.httpPort) lines.push(`\thttp_port ${opts.httpPort}`);
  if (opts.httpsPort) lines.push(`\thttps_port ${opts.httpsPort}`);
  if (opts.debug) lines.push("\tdebug");
  if (opts.gracePeriod) lines.push(`\tgrace_period ${opts.gracePeriod}`);
  if (opts.shutdownDelay) lines.push(`\tshutdown_delay ${opts.shutdownDelay}`);
  if (opts.email) lines.push(`\temail ${opts.email}`);
  if (opts.acmeCA) lines.push(`\tacme_ca ${opts.acmeCA}`);
  if (opts.acmeCARoot) lines.push(`\tacme_ca_root ${opts.acmeCARoot}`);
  if (opts.acmeEabKeyId && opts.acmeEabMacKey) {
    lines.push("\tacme_eab {");
    lines.push(`\t\tkey_id ${opts.acmeEabKeyId}`);
    lines.push(`\t\tmac_key ${opts.acmeEabMacKey}`);
    lines.push("\t}");
  }
  if (opts.onDemandEnabled) {
    lines.push("\ton_demand_tls {");
    if (opts.onDemandAsk) lines.push(`\t\task ${opts.onDemandAsk}`);
    if (opts.onDemandInterval) lines.push(`\t\tinterval ${opts.onDemandInterval}`);
    if (opts.onDemandBurst) lines.push(`\t\tburst ${opts.onDemandBurst}`);
    lines.push("\t}");
  }
  if (opts.internalCertLifetime) {
    lines.push(`\t${INTERNAL_LIFETIME_MARKER} ${opts.internalCertLifetime}`);
  }
  if (opts.renewalWindowRatio !== undefined) lines.push(`\trenewal_window_ratio ${opts.renewalWindowRatio}`);
  if (opts.storagePath) {
    lines.push("\tstorage file_system {");
    lines.push(`\t\troot ${opts.storagePath}`);
    lines.push("\t}");
  }
  // Turns on request-level `caddy_http_*` instrumentation across every server — the
  // dedicated site block that actually exposes /metrics is written separately into
  // conf.d (see buildMetricsSiteBlock), since a bare global option can't also declare
  // a listener. per_host/observe_catchall_hosts/otlp sub-options aren't exposed here.
  if (opts.metricsEnabled) lines.push("\tmetrics");
  // #158 — Caddy's own runtime/error logger. buildLogCaddyLines already emits exactly the
  // one-tab-indented `log { ... }` shape this global-options block needs.
  if (opts.runtimeLog) lines.push(buildLogCaddyLines(opts.runtimeLog).join("\n"));
  // #153/#157 — global (portless) `servers { }` block: trusted_proxies and/or
  // listener_wrappers/proxy_protocol. Also merged into every per-port managed servers block
  // by buildManagedServersBlocks, since a port with its own HTTP/3/timeout override would
  // otherwise silently lose these (see buildTrustedProxiesLines/buildProxyProtocolLines).
  const serversLines: string[] = [];
  if (opts.proxyProtocol) serversLines.push(...buildProxyProtocolLines(opts.proxyProtocol, "\t\t"));
  if (opts.trustedProxies?.ranges.length) serversLines.push(...buildTrustedProxiesLines(opts.trustedProxies, "\t\t"));
  if (serversLines.length) {
    lines.push(["\tservers {", ...serversLines, "\t}"].join("\n"));
  }
  return lines.join("\n");
}

/**
 * Writes global Caddy options into the main Caddyfile's managed opts section,
 * validates, and restores on failure. Throws CaddyfileError on validation failure.
 */
/**
 * Pure function: computes the patched main Caddyfile content for the given
 * global options. If the managed section doesn't exist yet, pre-existing
 * top-level directives for the same keys are stripped first, so the first
 * save doesn't produce duplicate global options (which caddy validate rejects).
 */
export function buildGlobalOptionsPatch(diskContent: string, opts: GlobalOptions): string {
  const body = buildGlobalOptionsLines(opts);
  let base = diskContent;
  const hasMarkers = diskContent.includes(GLOBAL_OPTS_BEGIN) && diskContent.includes(GLOBAL_OPTS_END);
  if (!hasMarkers) {
    const gb = findGlobalBlock(diskContent);
    if (gb) {
      const inner = stripKnownGlobalOptionLines(diskContent.slice(gb.open + 1, gb.close));
      base = diskContent.slice(0, gb.open + 1) + inner + diskContent.slice(gb.close);
    }
  }
  return patchManagedSection(base, GLOBAL_OPTS_BEGIN, GLOBAL_OPTS_END, body);
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

const METRICS_SITE_BEGIN = "# cockpit-caddy:metrics:begin";
const METRICS_SITE_END = "# cockpit-caddy:metrics:end";

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
 * Builds the dedicated site block that exposes the Prometheus metrics endpoint (#43).
 * A bare `metrics` directive with no path matcher matches *every* path on that listener
 * (verified against a live instance — it's the sole unmatched route on the block), so the
 * path is always written explicitly to keep the endpoint scoped to just that one path.
 */
export function buildMetricsSiteBlock(opts: GlobalOptions): string {
  if (!opts.metricsEnabled || !opts.metricsListenAddress) return "";
  const path = opts.metricsPath || "/metrics";
  const lines = [`${opts.metricsListenAddress} {`];
  if (opts.metricsPlainFormat) {
    lines.push(`\tmetrics ${path} {`, "\t\tdisable_openmetrics", "\t}");
  } else {
    lines.push(`\tmetrics ${path}`);
  }
  lines.push("}");
  return lines.join("\n");
}

/** Reads the metrics site block's listen address/path/format back out of conf.d content. */
export function parseMetricsSiteBlock(content: string): Pick<GlobalOptions, "metricsListenAddress" | "metricsPath" | "metricsPlainFormat"> {
  const bi = content.indexOf(METRICS_SITE_BEGIN);
  const ei = content.indexOf(METRICS_SITE_END);
  if (bi === -1 || ei === -1) return {};
  const lines = content.slice(bi + METRICS_SITE_BEGIN.length, ei).split("\n").map(l => l.trim()).filter(Boolean);
  const headerLine = lines.find(l => l.endsWith("{") && !l.startsWith("metrics"));
  if (!headerLine) return {};
  const metricsLine = lines.find(l => l.startsWith("metrics "));
  if (!metricsLine) return { metricsListenAddress: headerLine.slice(0, -1).trim() };
  const path = metricsLine.replace(/^metrics\s+/, "").replace(/\s*\{$/, "").trim();
  return {
    metricsListenAddress: headerLine.slice(0, -1).trim(),
    metricsPath: path,
    metricsPlainFormat: lines.includes("disable_openmetrics") || undefined,
  };
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

export async function syncGlobalOptions(opts: GlobalOptions): Promise<void> {
  await ensureConfDImported(); // a stock Caddyfile is migrated first (#256)
  const diskContent = (await fsReadFile(MAIN_CADDYFILE, "try")) ?? "";
  let patched = buildGlobalOptionsPatch(diskContent, opts);

  // #153 — trusted_proxies must also be re-merged into every per-port managed servers
  // block (see buildManagedServersBlocks' comment), not just the global servers{} block
  // buildGlobalOptionsPatch just wrote above, since Caddy's per-port `servers :PORT{}`
  // fully replaces (doesn't merge with) the global block's settings for that port.
  try {
    const config = await fetchCaddyConfig();
    const serverDefs = parseServerDefsFromConf((await fsReadFile(PROXY_CONF_PATH, "try")) ?? "");
    const proxies = parseProxies(config, serverDefs);
    patched = patchMainCaddyfile(patched, buildManagedServersBlocks(proxies, opts.trustedProxies, opts.proxyProtocol));
  } catch {
    // Admin API unreachable — existing per-port blocks (if any) keep whatever
    // trusted_proxies they last had; they'll refresh next time a proxy is added/edited.
  }

  const proxyConfDisk = (await fsReadFile(PROXY_CONF_PATH, "try")) ?? "";
  let proxyConfPatched = await applyInternalLifetimeToProxyConf(proxyConfDisk, opts.internalCertLifetime);
  proxyConfPatched = patchTopLevelMarkedSection(proxyConfPatched, METRICS_SITE_BEGIN, METRICS_SITE_END, buildMetricsSiteBlock(opts));

  if (patched === diskContent && proxyConfPatched === proxyConfDisk) return;

  // #158's runtime logger lives in the main Caddyfile's global options, not conf.d — check
  // both files for log paths that would otherwise get poisoned by validate (see
  // checkLogFileWritable).
  const logPaths = new Set([
    ...(patched !== diskContent ? extractLogFilePaths(patched) : []),
    ...(proxyConfPatched !== proxyConfDisk ? extractLogFilePaths(proxyConfPatched) : []),
  ]);
  for (const logPath of logPaths) {
    const err = await checkLogFileWritable(logPath);
    if (err) throw new CaddyfileError(i18n.t("errors.log_file_not_writable", { path: logPath, error: err }));
  }
  await fsWriteFile(MAIN_CADDYFILE, patched, "try");
  if (proxyConfPatched !== proxyConfDisk) await fsWriteFile(PROXY_CONF_PATH, proxyConfPatched, "try");
  try {
    await runCaddyValidate();
  } catch (e) {
    await fsWriteFile(MAIN_CADDYFILE, diskContent, "try");
    if (proxyConfPatched !== proxyConfDisk) await fsWriteFile(PROXY_CONF_PATH, proxyConfDisk, "try");
    throw e;
  }
  await fixAccessLogFileOwnership(patched);
  if (proxyConfPatched !== proxyConfDisk) await fixAccessLogFileOwnership(proxyConfPatched);
}

/** Read current global options from the main Caddyfile, merged with the metrics site
 *  block's own listen address/path/format read back out of conf.d. */
export async function readGlobalOptions(): Promise<GlobalOptions> {
  const content = (await fsReadFile(MAIN_CADDYFILE, "try")) ?? "";
  const opts = parseGlobalOptions(content);
  const proxyConf = (await fsReadFile(PROXY_CONF_PATH, "try")) ?? "";
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
  const mainDisk = (await fsReadFile(MAIN_CADDYFILE, "try")) ?? "";
  const proxyConfDisk = (await fsReadFile(PROXY_CONF_PATH, "try")) ?? "";
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
  await fsWriteFile(MAIN_CADDYFILE, main, "try");
  await fsWriteFile(PROXY_CONF_PATH, proxyConf, "try");
  try {
    await runCaddyValidate();
  } catch (e) {
    await fsWriteFile(MAIN_CADDYFILE, mainDisk, "try");
    await fsWriteFile(PROXY_CONF_PATH, proxyConfDisk, "try");
    throw e;
  }
  await fixAccessLogFileOwnership(main);
  await fixAccessLogFileOwnership(proxyConf);
  return findings;
}
