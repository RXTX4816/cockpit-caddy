import type { CaddyConfig, CaddyHandler, CaddyReverseProxyHandler, CaddyRoute, CaddyServer, CaddyTLSClientAuthentication, CaddyTLSConnectionPolicy, ProxyEntry } from "./types";
import { readFile as fsReadFile, writeFile as fsWriteFile } from "@rxtx4816/cockpit-plugin-base-react/lib/cockpit-fs";

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
async function curlPost(curlArgs: string[], body: string, opts: object = {}): Promise<void> {
  const out = await cockpit.spawn(
    [...curlArgs, "-s", "-X", "POST", "-H", "Content-Type: application/json",
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

async function tcpPost(path: string, body: string): Promise<void> {
  await curlPost(["curl", `${tcpBase}${path}`], body);
}

async function unixPost(path: string, body: string): Promise<void> {
  await curlPost(
    ["curl", "--unix-socket", unixSocket, `http://localhost${path}`],
    body,
    { superuser: "try" },
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

export async function pushCaddyConfig(config: CaddyConfig): Promise<void> {
  const body = JSON.stringify(config);
  await (transport === "unix" ? unixPost("/config/", body) : tcpPost("/config/", body));
}

const PROXY_CONF_PATH = "/etc/caddy/conf.d/cockpit-caddy.conf";

export interface RawBlock {
  /** The complete original block text, header line through closing brace. */
  raw: string;
  port: number;
  label: string | null;
}

/**
 * Extracts top-level port-based blocks from a Caddyfile verbatim.
 * Global-options blocks and non-port blocks are skipped.
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

    const portMatch = trimmed.match(/:(\d+)[^{]*\{$/);
    if (!portMatch) {
      // Non-port block (global options, etc.) — consume and skip
      let depth = (trimmed.match(/\{/g) ?? []).length - (trimmed.match(/\}/g) ?? []).length;
      i++;
      while (i < lines.length && depth > 0) {
        const t = lines[i].trim();
        depth += (t.match(/\{/g) ?? []).length - (t.match(/\}/g) ?? []).length;
        i++;
      }
      continue;
    }

    const port = parseInt(portMatch[1], 10);
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

    if (!isNaN(port)) blocks.push({ raw: blockLines.join("\n"), port, label });
  }

  return blocks;
}

/** Builds the conf.d file content from raw blocks, preserving all original syntax. */
export function buildMigratedConfContent(blocks: RawBlock[]): string {
  const header = "# Managed by cockpit-caddy - edits to this file may be overwritten by user plugin actions\n";
  if (blocks.length === 0) return header + "\n";
  const parts = blocks.map(b => (b.label ? `# label: ${b.label}\n` : "") + b.raw);
  return header + "\n" + parts.join("\n\n") + "\n";
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
  const original = await readProxyConf();
  await fsWriteFile(PROXY_CONF_PATH, content, "try");
  try {
    await runCaddyValidate();
  } catch (e) {
    await fsWriteFile(PROXY_CONF_PATH, original, "try");
    throw e;
  }
}

/**
 * Parses labels from the legacy Caddyfile format where the label is a comment
 * inside the block (e.g. "# homarr" as first comment inside ":PORT {").
 */
export function parseLegacyLabelsFromCaddyfile(content: string): Record<number, string> {
  const labels: Record<number, string> = {};
  const lines = content.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();
    // Match any block opener that contains a port: :PORT {, host:PORT {, https://...:PORT {
    const portMatch = line.match(/:(\d+)[^{]*\{$/);

    if (portMatch) {
      const port = parseInt(portMatch[1], 10);
      let depth = 1;
      let label: string | null = null;
      i++;

      while (i < lines.length && depth > 0) {
        const inner = lines[i].trim();
        depth += (inner.match(/\{/g) ?? []).length - (inner.match(/\}/g) ?? []).length;
        if (label === null && depth > 0 && inner.startsWith("#")) {
          const text = inner.slice(1).trim();
          if (text) label = text;
        }
        i++;
      }

      if (!isNaN(port) && label) labels[port] = label;
    } else {
      i++;
    }
  }

  return labels;
}

/**
 * Parses externalScheme and externalHost from block headers in the conf.d content.
 * Handles:
 *   scheme://host:PORT {   → { scheme, host }
 *   host:PORT {            → { host }
 *   :PORT {                → {}
 */
export function parseConfExternalAddresses(content: string): Record<number, { scheme?: string; host?: string }> {
  const result: Record<number, { scheme?: string; host?: string }> = {};
  for (const block of extractRawBlocksFromCaddyfile(content)) {
    const firstLine = block.raw.split("\n")[0].trim();
    const schemeHostMatch = firstLine.match(/^(\w[\w+\-.]*):\/\/([^:/\s]+):/);
    if (schemeHostMatch) {
      result[block.port] = { scheme: schemeHostMatch[1], host: schemeHostMatch[2] };
    } else {
      const hostMatch = firstLine.match(/^([^:/\s]+):/);
      if (hostMatch) result[block.port] = { host: hostMatch[1] };
    }
  }
  return result;
}

/**
 * Returns a port → tls map by reading raw block content from the conf.d file.
 * Detects TLS via `https://` block header or a `tls` directive (not `tls off`).
 * Used to supplement the JSON API when Caddy hasn't finished applying TLS
 * automation after a reload (race condition on hostname-based blocks).
 */
export function parseConfTlsMap(content: string): Record<number, boolean> {
  const result: Record<number, boolean> = {};
  for (const block of extractRawBlocksFromCaddyfile(content)) {
    const firstLine = block.raw.split("\n")[0].trim();
    let hasTls = firstLine.startsWith("https://");
    if (!hasTls) {
      for (const line of block.raw.split("\n").slice(1)) {
        const t = line.trim();
        if ((t === "tls" || (t.startsWith("tls ") && !t.startsWith("tls off")))) {
          hasTls = true;
          break;
        }
      }
    }
    result[block.port] = hasTls;
  }
  return result;
}

/**
 * Returns port → AccessLogConfig by reading `log { }` blocks from the conf.d
 * site blocks. Used as a fallback when the JSON API config was last pushed by
 * older code that didn't include the logging section.
 */
export function parseConfAccessLogMap(content: string): Record<number, import("./types").AccessLogConfig> {
  const result: Record<number, import("./types").AccessLogConfig> = {};
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

    for (const line of logLines) {
      const m = line.match(/^(\w+)\s+(.*)/);
      if (!m) continue;
      const [, key, val] = m;
      if (key === "output") {
        if (val.startsWith("file ")) {
          output = "file";
          filePath = val.slice(5).trim();
        } else {
          output = val.trim() as import("./types").AccessLogOutput;
        }
      } else if (key === "format") {
        format = val.trim() as import("./types").AccessLogFormat;
      } else if (key === "level") {
        level = val.trim() as import("./types").AccessLogLevel;
      }
    }
    result[block.port] = { output, filePath, format, level };
  }
  return result;
}

export function parseLabelsFromCaddyfile(content: string): Record<number, string> {
  const labels: Record<number, string> = {};
  let pendingLabel: string | null = null;
  for (const line of content.split("\n")) {
    const labelMatch = line.match(/^#\s*label:\s*(.+)$/);
    if (labelMatch) {
      pendingLabel = labelMatch[1].trim();
      continue;
    }
    // Match :PORT anywhere in the line — handles both `:PORT {` and `host:PORT {`
    const portMatch = line.match(/:(\d+)[^{]*\{/);
    if (portMatch && pendingLabel !== null) {
      labels[parseInt(portMatch[1], 10)] = pendingLabel;
    }
    if (line.trim() !== "") pendingLabel = null;
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

const CONF_HEADER = "# Managed by cockpit-caddy - edits to this file may be overwritten by user plugin actions";

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

/** Converts $1/$2 backreferences (JSON regex format) to Caddyfile {re.rw.N} form. */
function regexReplaceToCaddy(replace: string): string {
  return replace.replace(/\$(\d+)/g, "{re.rw.$1}");
}

// ---------------------------------------------------------------------------
// Route Matcher helpers — #48
// ---------------------------------------------------------------------------

/**
 * Generates named-matcher lines for a Caddyfile block.
 * Uses block form `@name { ... }` always (more stable for round-trips than inline form).
 */
function buildMatcherCaddyLines(m: import("./types").RouteMatch, name: string, indent: string): string[] {
  const lines: string[] = [`${indent}@${name} {`];
  if (m.path?.length) lines.push(`${indent}\tpath ${m.path.join(" ")}`);
  if (m.host?.length) lines.push(`${indent}\thost ${m.host.join(" ")}`);
  if (m.method?.length) lines.push(`${indent}\tmethod ${m.method.join(" ")}`);
  if (m.header) {
    for (const [hdr, vals] of Object.entries(m.header)) {
      lines.push(vals.length ? `${indent}\theader ${hdr} ${vals.join(" ")}` : `${indent}\theader ${hdr}`);
    }
  }
  if (m.query) {
    for (const [param, vals] of Object.entries(m.query)) {
      lines.push(vals.length ? `${indent}\tquery ${param} ${vals.join(" ")}` : `${indent}\tquery ${param}`);
    }
  }
  if (m.remote_ip?.ranges.length) {
    lines.push(`${indent}\tremote_ip ${m.remote_ip.ranges.join(" ")}`);
  }
  lines.push(`${indent}}`);
  return lines;
}

/** Converts RouteMatch to Caddy JSON match object. */
function buildMatcherJson(m: import("./types").RouteMatch): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  if (m.path?.length) obj.path = m.path;
  if (m.host?.length) obj.host = m.host;
  if (m.method?.length) obj.method = m.method;
  if (m.header && Object.keys(m.header).length) {
    const h: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(m.header)) h[k] = v;
    obj.header = h;
  }
  if (m.query && Object.keys(m.query).length) {
    const q: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(m.query)) q[k] = v;
    obj.query = q;
  }
  if (m.remote_ip?.ranges.length) obj.remote_ip = { ranges: m.remote_ip.ranges };
  return obj;
}

/** Parses a Caddy JSON match object back to RouteMatch. Returns undefined if empty/missing. */
function parseMatcherJson(match: Record<string, unknown> | undefined): import("./types").RouteMatch | undefined {
  if (!match || !Object.keys(match).length) return undefined;
  const m: import("./types").RouteMatch = {};
  if (Array.isArray(match.path) && match.path.length) m.path = match.path as string[];
  if (Array.isArray(match.host) && match.host.length) m.host = match.host as string[];
  if (Array.isArray(match.method) && match.method.length) m.method = match.method as string[];
  if (match.header && typeof match.header === "object") {
    const h = match.header as Record<string, string[]>;
    if (Object.keys(h).length) m.header = h;
  }
  if (match.query && typeof match.query === "object") {
    const q = match.query as Record<string, string[]>;
    if (Object.keys(q).length) m.query = q;
  }
  if (match.remote_ip && typeof match.remote_ip === "object") {
    const ri = (match.remote_ip as { ranges?: string[] }).ranges;
    if (ri?.length) m.remote_ip = { ranges: ri };
  }
  return Object.keys(m).length ? m : undefined;
}

/** Returns true when only path matchers are set (needed for handle_path eligibility). */
function isPathOnlyMatcher(m: import("./types").RouteMatch): boolean {
  return !!(m.path?.length) && !m.host && !m.method && !m.header && !m.query && !m.remote_ip;
}

/** Derives the strip-prefix value from the first path pattern, e.g. "/api/*" → "/api". */
function handlePathStripPrefix(matchers: import("./types").RouteMatch | undefined): string | undefined {
  if (!matchers?.path?.length || !isPathOnlyMatcher(matchers)) return undefined;
  const prefix = matchers.path[0].replace(/\/\*$/, "").replace(/\*$/, "");
  return prefix || undefined;
}

/** Builds the rewrite handler that strip_path_prefix uses for handle_path semantics. */
function buildHandlePathRewriteJson(matchers: import("./types").RouteMatch | undefined): CaddyHandler | undefined {
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

function buildForwardAuthHandler(fa: import("./types").ForwardAuthConfig): CaddyHandler | null {
  if (!fa.upstreamUrl.trim()) return null;
  const dial = fa.upstreamUrl.replace(/^https?:\/\//, "");
  const rp: Record<string, unknown> = {
    handler: "reverse_proxy",
    upstreams: [{ dial }],
    headers: {
      request: {
        set: {
          "X-Forwarded-Method": ["{http.request.method}"],
          "X-Forwarded-Uri": ["{http.request.uri}"],
        },
      },
    },
    handle_response: [{
      match: { status_code: [2] },
      routes: [{
        handle: [{
          handler: "copy_response_headers",
          ...(fa.copyHeaders.length ? { include: fa.copyHeaders } : {}),
        }],
      }],
    }],
  };
  if (fa.uri) rp.rewrite = { method: "GET", uri: fa.uri };
  return { handler: "subroute", routes: [{ handle: [rp as CaddyHandler] }] } as CaddyHandler;
}

function isForwardAuthProxy(rp: CaddyReverseProxyHandler): boolean {
  const resp = (rp.handle_response as Array<Record<string, unknown>> | undefined)?.[0];
  if (!resp) return false;
  const match = resp.match as Record<string, unknown> | undefined;
  if ((match?.status_code as number[] | undefined)?.[0] !== 2) return false;
  const routes = (resp.routes as Array<{ handle?: unknown[] }> | undefined) ?? [];
  return routes.some(r =>
    (r.handle ?? []).some(h => (h as { handler?: string })?.handler === "copy_response_headers"),
  );
}

function extractForwardAuthFromProxy(rp: CaddyReverseProxyHandler): import("./types").ForwardAuthConfig {
  const dial = rp.upstreams?.[0]?.dial ?? "";
  const upstreamUrl = /^https?:\/\//.test(dial) ? dial : `http://${dial}`;
  const uri = (rp as Record<string, unknown>).rewrite as { uri?: string } | undefined;
  const resp = (rp.handle_response as Array<Record<string, unknown>> | undefined)?.[0];
  const routes = (resp?.routes as Array<{ handle?: unknown[] }> | undefined) ?? [];
  const copyHandle = routes.flatMap(r => r.handle ?? [])
    .find(h => (h as { handler?: string })?.handler === "copy_response_headers") as
    { handler: string; include?: string[] } | undefined;
  return { upstreamUrl, uri: uri?.uri, copyHeaders: copyHandle?.include ?? [] };
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

/** Returns a port → ForwardAuthConfig map by scanning conf.d site blocks. */
export function parseConfForwardAuthMap(content: string): Record<number, import("./types").ForwardAuthConfig> {
  const result: Record<number, import("./types").ForwardAuthConfig> = {};
  for (const block of extractRawBlocksFromCaddyfile(content)) {
    const fa = parseForwardAuthFromBlockRaw(block.raw);
    if (fa) result[block.port] = fa;
  }
  return result;
}

function buildEncodeHandler(): CaddyHandler {
  return { handler: "encode", encodings: { gzip: {}, zstd: {} } };
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
  return { handler: "rewrite", path_regexp: [{ find: rewrite.find, replace: rewrite.replace }] };
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
    return { type: "regex", find, replace };
  }
  return undefined;
}

function buildRewriteCaddyLines(rewrite: import("./types").RewriteConfig, port: number, indent = "\t"): string[] {
  if (rewrite.type === "strip_prefix") return [`${indent}uri strip_prefix ${rewrite.value}`];
  if (rewrite.type === "add_prefix") return [`${indent}rewrite ${rewrite.value}{uri}`];
  return [
    `${indent}@rw${port} path_regexp rw ${rewrite.find}`,
    `${indent}rewrite @rw${port} ${regexReplaceToCaddy(rewrite.replace)}`,
  ];
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
function buildReverseProxyLines(
  p: Pick<ProxyEntry, "targetScheme" | "targetHost" | "targetPort" | "tlsSkipVerify" | "requestHeaders" | "dialTimeout" | "responseHeaderTimeout" | "extraUpstreams" | "lbPolicy">,
  errorHandlers?: import("./types").ErrorHandlerConfig[],
): string[] {
  const upstreams = buildUpstreamList(p);

  const headerLines = (p.requestHeaders ?? []).map(h => {
    if (h.op === "delete") return `\t\theader_up -${h.name}`;
    if (h.op === "add") return `\t\theader_up +${h.name} ${h.value ?? ""}`;
    return `\t\theader_up ${h.name} ${h.value ?? ""}`;
  });

  const transportLines = buildTransportLines(p);
  const lbLines = (p.lbPolicy && upstreams.length > 1 && LB_POLICY_MAP[p.lbPolicy])
    ? [`\t\tlb_policy ${LB_POLICY_MAP[p.lbPolicy]}`]
    : [];

  // When error handlers are configured, intercept upstream HTTP error responses and
  // re-raise them as Caddy errors so that handle_errors blocks fire.
  const errorPassthroughLines: string[] = [];
  if (errorHandlers?.length) {
    const codes = errorHandlerResponseCodes(errorHandlers);
    if (codes.length) {
      const statusTokens = codes.map(c => (c < 10 ? `${c}xx` : String(c))).join(" ");
      errorPassthroughLines.push(
        `\t\t@upstream_error status ${statusTokens}`,
        `\t\thandle_response @upstream_error {`,
        `\t\t\terror {rp.status_code}`,
        `\t\t}`,
      );
    }
  }

  const needsBlock = transportLines.length > 0 || headerLines.length > 0 || lbLines.length > 0 || errorPassthroughLines.length > 0;
  if (!needsBlock) return [`\treverse_proxy ${upstreams.join(" ")}`];

  return [`\treverse_proxy ${upstreams.join(" ")} {`, ...lbLines, ...transportLines, ...headerLines, ...errorPassthroughLines, "\t}"];
}

function buildExternalAddress(p: Pick<ProxyEntry, "externalPort" | "externalScheme" | "externalHost">): string {
  if (p.externalScheme && p.externalHost) return `${p.externalScheme}://${p.externalHost}:${p.externalPort}`;
  if (p.externalHost) return `${p.externalHost}:${p.externalPort}`;
  return `:${p.externalPort}`;
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
      lines.push(`\t\t\troot ${h.filePath ?? "/var/www/errors"}`);
      lines.push(`\t\t}`);
    } else {
      const body = h.body ?? "{http.error.status_code} {http.error.status_text}";
      const sc = h.statusCode ? ` ${h.statusCode}` : "";
      lines.push(`\t\trespond "${body}"${sc}`);
    }
    lines.push("\t}");
  }
  return lines;
}

/** Generates the Caddyfile block for a single proxy (label comment + block body). */
function buildLogCaddyLines(log: import("./types").AccessLogConfig): string[] {
  const lines = ["\tlog {"];
  if (log.output === "file" && log.filePath) {
    lines.push(`\t\toutput file ${log.filePath}`);
  } else {
    lines.push(`\t\toutput ${log.output}`);
  }
  if (log.format) lines.push(`\t\tformat ${log.format}`);
  if (log.level) lines.push(`\t\tlevel ${log.level}`);
  lines.push("\t}");
  return lines;
}

function buildTlsCaddyLines(p: Pick<ProxyEntry, "tls" | "tlsAdvanced" | "mtls">): string[] {
  if (!p.tls) return [];
  const adv = p.tlsAdvanced;
  const mtls = p.mtls;
  const hasAdvanced = adv && (adv.protocolMin || adv.protocolMax || adv.cipherSuites?.length || adv.curves?.length);
  const hasMtls = mtls?.mode;
  if (!hasAdvanced && !hasMtls) return ["\ttls internal"];

  const lines: string[] = ["\ttls {", "\t\tissuer internal"];
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
      lines.push(`\t\t\ttrusted_ca_cert_file ${mtls.trustedCaFile.trim()}`);
    }
    lines.push("\t\t}");
  }
  lines.push("\t}");
  return lines;
}

/** Builds handler lines for a route, at the given indent level (default single-tab). */
function buildRouteHandlerLines(p: ProxyEntry, indent: string): string[] {
  const lines: string[] = [];
  if (p.staticResponse) {
    const { statusCode, body, close } = p.staticResponse;
    if (body && close) {
      lines.push(`${indent}respond "${body}" ${statusCode} {`);
      lines.push(`${indent}\tclose`);
      lines.push(`${indent}}`);
    } else if (body) {
      lines.push(`${indent}respond "${body}" ${statusCode}`);
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
      if (h.op === "delete") lines.push(`${indent}header -${h.name}`);
      else if (h.op === "add") lines.push(`${indent}header +${h.name} ${h.value ?? ""}`);
      else lines.push(`${indent}header ${h.name} "${h.value ?? ""}"`);
    }
    lines.push(`${indent}root * ${p.fileServer.root}`);
    lines.push(p.fileServer.browse ? `${indent}file_server browse` : `${indent}file_server`);
  } else {
    if (p.compress) lines.push(`${indent}encode gzip zstd`);
    if (p.basicAuth?.length) {
      lines.push(`${indent}basic_auth {`);
      for (const a of p.basicAuth) lines.push(`${indent}\t${a.username} ${a.passwordHash}`);
      lines.push(`${indent}}`);
    }
    for (const h of p.responseHeaders ?? []) {
      if (h.op === "delete") lines.push(`${indent}header -${h.name}`);
      else if (h.op === "add") lines.push(`${indent}header +${h.name} ${h.value ?? ""}`);
      else lines.push(`${indent}header ${h.name} "${h.value ?? ""}"`);
    }
    if (p.rewrite) lines.push(...buildRewriteCaddyLines(p.rewrite, p.externalPort, indent));
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
  // Plain-port redirect/respond blocks must use http:// prefix to avoid Caddy TLS automation policy conflicts
  // when other unnamed blocks use `tls internal` (which creates a catch-all InternalIssuer policy).
  const isPlainHttp = !p.externalScheme && !p.externalHost && (p.redirect || p.staticResponse);
  const rawAddr = buildExternalAddress(p);
  const header = isPlainHttp ? `http://${rawAddr}` : rawAddr;
  const lines = p.label ? [`# label: ${p.label}`, `${header} {`] : [`${header} {`];

  if (p.matchers && Object.keys(buildMatcherJson(p.matchers)).length > 0) {
    const matcherName = `m${p.externalPort}`;
    const useHandlePath = p.handlePath && isPathOnlyMatcher(p.matchers) && !!(p.matchers.path?.length);

    if (useHandlePath) {
      // handle_path strips the matched prefix automatically — no explicit matcher declaration needed
      const paths = p.matchers.path!.join(" ");
      if (p.staticResponse) {
        if (p.accessLog) lines.push(...buildLogCaddyLines(p.accessLog));
        lines.push(`\thandle_path ${paths} {`);
        lines.push(...buildRouteHandlerLines(p, "\t\t"));
        lines.push("\t}");
      } else if (p.redirect) {
        if (p.accessLog) lines.push(...buildLogCaddyLines(p.accessLog));
        lines.push(`\thandle_path ${paths} {`);
        lines.push(...buildRouteHandlerLines(p, "\t\t"));
        lines.push("\t}");
      } else if (p.fileServer) {
        lines.push(...buildTlsCaddyLines(p));
        if (p.accessLog) lines.push(...buildLogCaddyLines(p.accessLog));
        lines.push(`\thandle_path ${paths} {`);
        lines.push(...buildRouteHandlerLines(p, "\t\t"));
        lines.push("\t}");
      } else {
        lines.push(...buildTlsCaddyLines(p));
        if (p.accessLog) lines.push(...buildLogCaddyLines(p.accessLog));
        lines.push(`\thandle_path ${paths} {`);
        lines.push(...buildRouteHandlerLines(p, "\t\t"));
        lines.push("\t}");
      }
    } else {
      // Standard named matcher + handle block
      lines.push(...buildMatcherCaddyLines(p.matchers, matcherName, "\t"));
      if (p.staticResponse) {
        if (p.accessLog) lines.push(...buildLogCaddyLines(p.accessLog));
        lines.push(`\thandle @${matcherName} {`);
        lines.push(...buildRouteHandlerLines(p, "\t\t"));
        lines.push("\t}");
      } else if (p.redirect) {
        if (p.accessLog) lines.push(...buildLogCaddyLines(p.accessLog));
        lines.push(`\thandle @${matcherName} {`);
        lines.push(...buildRouteHandlerLines(p, "\t\t"));
        lines.push("\t}");
      } else if (p.fileServer) {
        lines.push(...buildTlsCaddyLines(p));
        if (p.accessLog) lines.push(...buildLogCaddyLines(p.accessLog));
        lines.push(`\thandle @${matcherName} {`);
        lines.push(...buildRouteHandlerLines(p, "\t\t"));
        lines.push("\t}");
      } else {
        lines.push(...buildTlsCaddyLines(p));
        if (p.accessLog) lines.push(...buildLogCaddyLines(p.accessLog));
        lines.push(`\thandle @${matcherName} {`);
        lines.push(...buildRouteHandlerLines(p, "\t\t"));
        lines.push("\t}");
      }
    }
  } else {
    // No matchers — original flat structure
    if (p.staticResponse) {
      if (p.accessLog) lines.push(...buildLogCaddyLines(p.accessLog));
      lines.push(...buildRouteHandlerLines(p, "\t"));
    } else if (p.redirect) {
      if (p.accessLog) lines.push(...buildLogCaddyLines(p.accessLog));
      lines.push(...buildRouteHandlerLines(p, "\t"));
    } else if (p.fileServer) {
      lines.push(...buildTlsCaddyLines(p));
      if (p.accessLog) lines.push(...buildLogCaddyLines(p.accessLog));
      lines.push(...buildRouteHandlerLines(p, "\t"));
    } else {
      lines.push(...buildTlsCaddyLines(p));
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

  while (i < closingIdx) {
    const line = lines[i];
    const trimmed = line.trim();
    const opens = (trimmed.match(/\{/g) ?? []).length;
    const closes = (trimmed.match(/\}/g) ?? []).length;

    if (nestDepth === 0) {
      // Skip top-level `tls` directive (tls internal, tls email, etc. but not tls_)
      if (trimmed === "tls" || (trimmed.startsWith("tls ") && !trimmed.startsWith("tls_"))) {
        nestDepth += opens - closes;
        i++;
        continue;
      }

      // Skip top-level `encode` directive
      if (trimmed === "encode" || trimmed.startsWith("encode ")) {
        nestDepth += opens - closes;
        i++;
        continue;
      }

      // Skip top-level `root`, `file_server`, and `header` directives
      if (trimmed.startsWith("root ") || trimmed === "file_server" || trimmed.startsWith("file_server ")
        || trimmed === "header" || trimmed.startsWith("header ") || trimmed.startsWith("header\t")) {
        nestDepth += opens - closes;
        i++;
        continue;
      }

      // Skip top-level `basic_auth` block
      if (trimmed === "basic_auth" || trimmed.startsWith("basic_auth ")) {
        nestDepth += opens - closes;
        i++;
        while (i < closingIdx && nestDepth > 0) {
          const t = lines[i].trim();
          nestDepth += (t.match(/\{/g) ?? []).length - (t.match(/\}/g) ?? []).length;
          i++;
        }
        continue;
      }

      // Skip top-level `forward_auth` block
      if (trimmed.startsWith("forward_auth ")) {
        nestDepth += opens - closes;
        i++;
        while (i < closingIdx && nestDepth > 0) {
          const t = lines[i].trim();
          nestDepth += (t.match(/\{/g) ?? []).length - (t.match(/\}/g) ?? []).length;
          i++;
        }
        continue;
      }

      // Skip top-level `reverse_proxy` directive, including any nested { } block
      if (trimmed.startsWith("reverse_proxy") && (trimmed.length === 13 || trimmed[13] === " ")) {
        nestDepth += opens - closes;
        i++;
        while (i < closingIdx && nestDepth > 0) {
          const t = lines[i].trim();
          nestDepth += (t.match(/\{/g) ?? []).length - (t.match(/\}/g) ?? []).length;
          i++;
        }
        continue;
      }
    }

    nestDepth += opens - closes;
    kept.push(line);
    i++;
  }

  // Re-add updated directives before closing brace
  kept.push(...buildTlsCaddyLines(proxy));
  if (proxy.fileServer) {
    if (proxy.compress) kept.push("\tencode gzip zstd");
    if (proxy.basicAuth?.length) kept.push(...buildBasicAuthCaddyLines(proxy.basicAuth));
    for (const h of proxy.responseHeaders ?? []) {
      if (h.op === "delete") kept.push(`\theader -${h.name}`);
      else if (h.op === "add") kept.push(`\theader +${h.name} ${h.value ?? ""}`);
      else kept.push(`\theader ${h.name} "${h.value ?? ""}"`);
    }
    kept.push(`\troot * ${proxy.fileServer.root}`);
    kept.push(proxy.fileServer.browse ? "\tfile_server browse" : "\tfile_server");
  } else {
    if (proxy.compress) kept.push("\tencode gzip zstd");
    if (proxy.basicAuth?.length) kept.push(...buildBasicAuthCaddyLines(proxy.basicAuth));
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
  const pos = findBlockPositions(lines).find(p => p.port === proxy.externalPort);

  if (!pos) {
    const base = content.trim() ? content.trimEnd() : CONF_HEADER;
    return base + "\n\n" + proxyToBlock(proxy) + "\n";
  }

  const start = pos.labelLine ?? pos.headerLine;
  const headerLine = lines[pos.headerLine].trim();
  const isPluginFormat = new RegExp(`^(?:http://)?:${proxy.externalPort}[\\s{]`).test(headerLine)
    || headerLine === `:${proxy.externalPort}{`
    || headerLine === `http://:${proxy.externalPort}{`;

  let body: string;
  if (isPluginFormat) {
    body = proxyToBlock(proxy);
  } else {
    const existingRaw = lines.slice(pos.headerLine, pos.closingLine + 1).join("\n");
    const patchedBody = patchRawBlock(existingRaw, proxy);
    body = proxy.label ? `# label: ${proxy.label}\n${patchedBody}` : patchedBody;
  }

  return [
    ...lines.slice(0, start),
    body,
    ...lines.slice(pos.closingLine + 1),
  ].join("\n");
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
  serverKey: string | null;     // set when a "# server: key" comment precedes this block (#49)
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

    const portMatch = trimmed.match(/:(\d+)[^{]*\{$/);
    if (!portMatch) {
      // Non-port block (e.g. global options or snippet) — skip entire block
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

    const port = parseInt(portMatch[1], 10);
    const headerLine = i;
    let depth = 1;
    i++;
    while (i < lines.length && depth > 0) {
      const t = lines[i].trim();
      depth += (t.match(/\{/g) ?? []).length - (t.match(/\}/g) ?? []).length;
      i++;
    }
    const closingLine = i - 1;

    if (!isNaN(port)) {
      positions.push({ labelLine: pendingLabelLine, serverKeyLine: pendingServerKeyLine, headerLine, closingLine, port, serverKey: pendingServerKey });
    }
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
 * preserving all other blocks verbatim.
 */
export function surgicallyRemoveBlock(content: string, port: number): string {
  const lines = content.split("\n");
  const pos = findBlockPositions(lines).find(p => p.port === port);
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
): ProxyEntry | undefined {
  const handles = (route.handle ?? []) as AnyHandler[];
  const matchers = route.match?.[0] ? parseMatcherJson(route.match[0]) : undefined;

  // Unwrap subroute handlers emitted by Caddy's Caddyfile adapter.
  // When Caddy reloads from Caddyfile, `handle { ... }` blocks become:
  //   { handler: "subroute", routes: [{ handle: [...actual handlers...] }] }
  const subrouteH = handles.find(h => h.handler === "subroute") as
    { handler: string; routes?: Array<{ handle?: AnyHandler[] }> } | undefined;
  const effectiveHandles: AnyHandler[] = subrouteH?.routes?.length
    ? subrouteH.routes.flatMap(r => (r.handle ?? []) as AnyHandler[])
    : handles;

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
      serverReadTimeout, serverReadHeaderTimeout, serverWriteTimeout, serverIdleTimeout, maxHeaderBytes, accessLog,
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
      serverReadTimeout, serverReadHeaderTimeout, serverWriteTimeout, serverIdleTimeout, maxHeaderBytes, accessLog,
      errorHandlers: parseErrorHandlers(server),
    };
  }

  // Detect file_server
  const fsHandle = effectiveHandles.find(h => h.handler === "file_server") as
    { handler: string; root?: string; browse?: Record<string, unknown> } | undefined;
  if (fsHandle) {
    const fsCompress = effectiveHandles.some(h => h.handler === "encode");
    const fsAuthHandle = effectiveHandles.find(h => h.handler === "authentication");
    const fsBasicAuth = fsAuthHandle ? parseBasicAuthJson(fsAuthHandle) : undefined;
    const fsHeadersHandle = effectiveHandles.find(h => h.handler === "headers");
    const fsResponseHeaders = fsHeadersHandle ? parseResponseHeadersJson(fsHeadersHandle) : [];
    const fsTls = Array.isArray(server.tls_connection_policies) && server.tls_connection_policies.length > 0;
    const fsTlsPolicy = fsTls ? server.tls_connection_policies![0] : undefined;
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
      fileServer: { root: fsHandle.root ?? "/", browse: fsHandle.browse !== undefined },
      compress: fsCompress || undefined,
      basicAuth: fsBasicAuth?.length ? fsBasicAuth : undefined,
      responseHeaders: fsResponseHeaders.length ? fsResponseHeaders : undefined,
      matchers,
      serverReadTimeout, serverReadHeaderTimeout, serverWriteTimeout, serverIdleTimeout, maxHeaderBytes, accessLog,
      errorHandlers: parseErrorHandlers(server),
      tlsAdvanced: fsTlsPolicy ? parseTlsAdvanced(fsTlsPolicy) : undefined,
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
      serverReadTimeout, serverReadHeaderTimeout, serverWriteTimeout, serverIdleTimeout, maxHeaderBytes, accessLog,
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

  const targetScheme: "http" | "https" = rp.transport?.tls !== undefined ? "https" : "http";
  const tlsSkipVerify = rp.transport?.tls?.insecure_skip_verify ?? false;
  const dialTimeout = parseDuration(rp.transport?.dial_timeout);
  const responseHeaderTimeout = parseDuration(rp.transport?.response_header_timeout);

  const tls = Array.isArray(server.tls_connection_policies) && server.tls_connection_policies.length > 0;
  const tlsPolicy = tls ? server.tls_connection_policies![0] : undefined;

  const compress = effectiveHandles.some(h => h.handler === "encode");
  const authHandle = effectiveHandles.find(h => h.handler === "authentication");
  const basicAuth = authHandle ? parseBasicAuthJson(authHandle) : undefined;
  const rewriteHandle = effectiveHandles.find(h => h.handler === "rewrite");
  const rewrite = rewriteHandle ? parseRewriteFromHandle(rewriteHandle) : undefined;
  const headersHandle = effectiveHandles.find(h => h.handler === "headers");
  const responseHeadersParsed = headersHandle ? parseResponseHeadersJson(headersHandle) : [];
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
    basicAuth: basicAuth?.length ? basicAuth : undefined,
    dialTimeout: dialTimeout || undefined,
    responseHeaderTimeout: responseHeaderTimeout || undefined,
    rewrite: finalRewrite,
    requestHeaders: requestHeaders.length ? requestHeaders : undefined,
    responseHeaders: responseHeadersParsed.length ? responseHeadersParsed : undefined,
    extraUpstreams: extraUpstreams.length ? extraUpstreams : undefined,
    lbPolicy,
    matchers,
    handlePath,
    serverReadTimeout, serverReadHeaderTimeout, serverWriteTimeout, serverIdleTimeout, maxHeaderBytes,
    errorHandlers: parseErrorHandlers(server),
    forwardAuth,
    tlsAdvanced: tlsPolicy ? parseTlsAdvanced(tlsPolicy) : undefined,
    mtls: tlsPolicy ? parseMtls(tlsPolicy) : undefined,
  };
}

export function parseProxies(config: CaddyConfig, serverDefs?: import("./types").ServerDef[]): ProxyEntry[] {
  const servers = config.apps?.http?.servers ?? {};
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
    const isNamedServer = !key.includes(":") && (
      serverDefs ? namedDef != null : contentRoutes.length > 1
    );
    const namedServerKey = isNamedServer ? namedDef!.key : undefined;

    if (!isNamedServer) {
      // Standalone single-route server (the common case)
      const route = contentRoutes[0];
      if (!route) continue;
      const entry = parseRouteToEntry(
        route, key, externalPort, externalHost, server, accessLog,
        serverReadTimeout, serverReadHeaderTimeout, serverWriteTimeout, serverIdleTimeout, maxHeaderBytes,
        String(externalPort), undefined,
      );
      if (entry) proxies.push(entry);
    } else {
      // Named server (#49) — use def.key for IDs so they stay consistent after Caddy key changes
      for (let i = 0; i < contentRoutes.length; i++) {
        const entry = parseRouteToEntry(
          contentRoutes[i], key, externalPort, externalHost, server, accessLog,
          serverReadTimeout, serverReadHeaderTimeout, serverWriteTimeout, serverIdleTimeout, maxHeaderBytes,
          `${namedDef!.key}:${i}`, namedServerKey,
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
  const resp: Record<string, unknown> = {};
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

function buildReverseProxyHandler(
  proxy: Pick<ProxyEntry, "targetHost" | "targetPort" | "targetScheme" | "tlsSkipVerify" | "requestHeaders" | "dialTimeout" | "responseHeaderTimeout" | "extraUpstreams" | "lbPolicy">,
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
  if (errorHandlers?.length) {
    const codes = errorHandlerResponseCodes(errorHandlers);
    if (codes.length) {
      rp.handle_response = [{
        match: { status_code: codes },
        routes: [{ handle: [{ handler: "error", status_code: "{rp.status_code}" }] }],
      }];
    }
  }
  return rp;
}

type TimeoutProxy = Pick<ProxyEntry, "serverReadTimeout" | "serverReadHeaderTimeout" | "serverWriteTimeout" | "serverIdleTimeout" | "maxHeaderBytes">;

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
  return server;
}

/** Returns true only for numeric IP addresses — these are valid TCP bind targets. Hostnames are site labels in Caddyfile, not bind interfaces. */
function isIpAddress(host: string): boolean {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || host.startsWith("[");
}

function buildListenAddr(proxy: { externalHost?: string; externalPort: number }): string {
  return proxy.externalHost && isIpAddress(proxy.externalHost)
    ? `${proxy.externalHost}:${proxy.externalPort}`
    : `:${proxy.externalPort}`;
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

function parseTlsAdvanced(policy: CaddyTLSConnectionPolicy): import("./types").TlsAdvancedConfig | undefined {
  const cfg: import("./types").TlsAdvancedConfig = {};
  let hasData = false;
  if (policy.protocol_min) { cfg.protocolMin = policy.protocol_min as import("./types").TlsProtocolVersion; hasData = true; }
  if (policy.protocol_max) { cfg.protocolMax = policy.protocol_max as import("./types").TlsProtocolVersion; hasData = true; }
  if (Array.isArray(policy.cipher_suites) && policy.cipher_suites.length) { cfg.cipherSuites = policy.cipher_suites as string[]; hasData = true; }
  if (Array.isArray(policy.curves) && policy.curves.length) { cfg.curves = policy.curves as string[]; hasData = true; }
  return hasData ? cfg : undefined;
}

function parseMtls(policy: CaddyTLSConnectionPolicy): import("./types").MtlsConfig | undefined {
  const ca = policy.client_authentication;
  if (!ca?.mode) return undefined;
  const trustedCaFile = ca.trusted_ca_certs_pem_files?.[0] || undefined;
  return { mode: ca.mode as import("./types").MtlsMode, trustedCaFile };
}

function buildTlsPolicy(proxy: { tlsAdvanced?: import("./types").TlsAdvancedConfig; mtls?: import("./types").MtlsConfig }): CaddyTLSConnectionPolicy {
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
      ca.trusted_ca_certs_pem_files = [proxy.mtls.trustedCaFile.trim()];
    }
    policy.client_authentication = ca;
  }
  return policy;
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
  const matchArr = proxy.matchers ? [buildMatcherJson(proxy.matchers)] : undefined;
  // A route with matchers is NOT terminal — allow fallthrough to subsequent routes.
  const isTerminal = !matchArr;

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
    if (proxy.compress) fsHandles.push(buildEncodeHandler());
    if (proxy.basicAuth?.length) fsHandles.push(buildBasicAuthHandler(proxy.basicAuth));
    if (proxy.responseHeaders?.length) fsHandles.push(buildResponseHeadersHandler(proxy.responseHeaders));
    const fsHandler: Record<string, unknown> = { handler: "file_server", root: proxy.fileServer.root };
    if (proxy.fileServer.browse) fsHandler["browse"] = {};
    fsHandles.push(fsHandler as CaddyHandler);
    const route: CaddyRoute = { handle: fsHandles, terminal: isTerminal };
    if (matchArr) route.match = matchArr;
    const server: CaddyServer = { listen: [listenAddr], routes: [route] };
    if (proxy.tls) server.tls_connection_policies = [buildTlsPolicy(proxy)];
    applyAccessLog(server, proxy);
    applyErrorHandlers(server, proxy);
    return applyServerTimeouts(server, proxy);
  }
  const handles: CaddyHandler[] = [];
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

/** Patch handles in-place: update reverse_proxy and rewrite handlers, leave everything else untouched. */
function patchHandles(handles: CaddyHandler[], proxy: ProxyEntry): CaddyHandler[] {
  if (proxy.fileServer) {
    const fsHandles: CaddyHandler[] = [];
    if (proxy.compress) fsHandles.push(buildEncodeHandler());
    if (proxy.basicAuth?.length) fsHandles.push(buildBasicAuthHandler(proxy.basicAuth));
    if (proxy.responseHeaders?.length) fsHandles.push(buildResponseHeadersHandler(proxy.responseHeaders));
    const fsHandler: Record<string, unknown> = { handler: "file_server", root: proxy.fileServer.root };
    if (proxy.fileServer.browse) fsHandler["browse"] = {};
    fsHandles.push(fsHandler as CaddyHandler);
    return fsHandles;
  }
  let found = false;
  // Strip any existing encode/authentication/rewrite/headers/file_server/forward_auth handlers; we'll re-add the correct ones below
  const withoutRewrite = handles.filter(h => {
    if (h.handler === "rewrite" || h.handler === "headers" || h.handler === "encode" || h.handler === "authentication" || h.handler === "file_server") return false;
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
  // Prepend encode/auth/response-headers/rewrite/forward_auth handlers if configured
  const prefix: CaddyHandler[] = [];
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

  server.routes = (original.routes ?? []).map(route => ({
    ...route,
    handle: patchHandles((route.handle ?? []) as CaddyHandler[], proxy),
  }));

  applyAccessLog(server, proxy);
  applyErrorHandlers(server, proxy);

  return applyServerTimeouts(server, proxy);
}

function buildLoggingWriter(accessLog: import("./types").AccessLogConfig): import("./types").CaddyLogWriter {
  return accessLog.output === "file" && accessLog.filePath
    ? { output: "file", filename: accessLog.filePath }
    : { output: accessLog.output };
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

export function mergeProxy(config: CaddyConfig, proxy: ProxyEntry): CaddyConfig {
  const servers = { ...(config.apps?.http?.servers ?? {}) };
  const original = servers[proxy.serverKey];
  servers[proxy.serverKey] = (original && !proxy.redirect && !proxy.staticResponse) ? patchServer(original, proxy) : buildServerEntry(proxy);

  const hasTls = Object.values(servers).some(
    s => Array.isArray(s.tls_connection_policies) && s.tls_connection_policies.length > 0,
  );

  const logging = patchLoggingLogs(config, original, proxy);

  return {
    ...config,
    logging,
    apps: {
      ...config.apps,
      http: { ...config.apps?.http, servers },
      tls: hasTls
        ? { automation: { policies: [{ issuers: [{ module: "internal" }] }] } }
        : config.apps?.tls,
    },
  };
}

export async function hashPassword(plaintext: string): Promise<string> {
  const out = await cockpit.spawn(
    ["caddy", "hash-password", "--plaintext", plaintext],
    { superuser: "try", err: "message" },
  );
  return out.trim();
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

const SERVERS_CONF_PATH = "/etc/caddy/conf.d/cockpit-caddy-servers.json";

export async function readServerDefs(): Promise<import("./types").ServerDef[]> {
  try {
    const raw = await fsReadFile(SERVERS_CONF_PATH, "try");
    if (!raw) return [];
    return JSON.parse(raw) as import("./types").ServerDef[];
  } catch {
    return [];
  }
}

export async function writeServerDefs(defs: import("./types").ServerDef[]): Promise<void> {
  await cockpit.spawn(["mkdir", "-p", "/etc/caddy/conf.d"], { superuser: "try" });
  await fsWriteFile(SERVERS_CONF_PATH, JSON.stringify(defs, null, 2), "try");
}

/**
 * Parses ServerDef objects from conf.d content by reading embedded `# serverdef: {...}` comments.
 * Falls back to a minimal def (key + listen addresses only) for legacy blocks that predate the
 * embedded-comment format. This is the primary source of server defs — no separate file needed.
 */
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
        const parts = m[1].trim().split(/\s+/);
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
  const addr = def.listenAddresses.join(" ");
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
    accessLog: def.accessLog,
    errorHandlers: def.errorHandlers?.length ? def.errorHandlers : undefined,
    routeLabels: def.routeLabels && Object.keys(def.routeLabels).length ? def.routeLabels : undefined,
  };
  const lines: string[] = [`# server: ${def.key}`, `# serverdef: ${JSON.stringify(defPayload)}`, `${addr} {`];

  // Server-level TLS
  if (def.tls) {
    const tlsMock = { tls: def.tls, tlsAdvanced: def.tlsAdvanced, mtls: def.mtls };
    lines.push(...buildTlsCaddyLines(tlsMock));
  }
  // Server-level access log
  if (def.accessLog) lines.push(...buildLogCaddyLines(def.accessLog));

  // Routes: matcher routes first, catch-all last
  const matcherRoutes = normalRoutes.filter(r => r.matchers && Object.keys(buildMatcherJson(r.matchers)).length > 0);
  const catchAllRoutes = normalRoutes.filter(r => !r.matchers || !Object.keys(buildMatcherJson(r.matchers)).length);

  for (let i = 0; i < matcherRoutes.length; i++) {
    const route = matcherRoutes[i];
    const matcherName = `r${i}`;
    const useHandlePath = route.handlePath && isPathOnlyMatcher(route.matchers!) && !!(route.matchers!.path?.length);
    if (useHandlePath) {
      const paths = route.matchers!.path!.join(" ");
      lines.push(`\thandle_path ${paths} {`);
      lines.push(...buildRouteBodyForServer(route));
      lines.push("\t}");
    } else {
      lines.push(...buildMatcherCaddyLines(route.matchers!, matcherName, "\t"));
      lines.push(`\thandle @${matcherName} {`);
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
    if (nr.matchers && Object.keys(buildMatcherJson(nr.matchers)).length > 0) {
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
  const matcherRoutes = normalRoutes.filter(r => r.matchers && Object.keys(buildMatcherJson(r.matchers)).length > 0);
  const catchAllRoutes = normalRoutes.filter(r => !r.matchers || !Object.keys(buildMatcherJson(r.matchers)).length);

  for (const route of [...matcherRoutes, ...catchAllRoutes]) {
    const handles = buildRouteHandlesForEntry(route);
    const cRoute: CaddyRoute = { handle: handles, terminal: !route.matchers };
    if (route.matchers) cRoute.match = [buildMatcherJson(route.matchers)];
    caddyRoutes.push(cRoute);
  }

  const listenAddrs = def.listenAddresses.length ? def.listenAddresses : [`:${routes[0]?.externalPort ?? 80}`];

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

  if (def.accessLog) {
    const loggerName = `cockpit-server-${def.key}`;
    (server as Record<string, unknown>).logs = { default_logger_name: loggerName };
  }

  if (def.errorHandlers?.length) {
    const built = buildErrorRoutes(def.errorHandlers);
    if (built) (server as Record<string, unknown>).errors = built;
  }

  servers[def.key] = server;

  const hasTls = Object.values(servers).some(
    s => Array.isArray(s.tls_connection_policies) && s.tls_connection_policies.length > 0,
  );

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
      tls: hasTls
        ? { automation: { policies: [{ issuers: [{ module: "internal" }] }] } }
        : config.apps?.tls,
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
    const fsH: Record<string, unknown> = { handler: "file_server", root: proxy.fileServer.root };
    if (proxy.fileServer.browse) fsH["browse"] = {};
    handles.push(fsH as CaddyHandler);
    return handles;
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
 */
async function runCaddyValidate(): Promise<void> {
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
 * Find the top-level global options block { } in a Caddyfile.
 * Returns the indices of the opening and closing braces, or null if absent.
 * The global options block must be the first non-comment, non-whitespace token.
 */
function findGlobalBlock(content: string): { open: number; close: number } | null {
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

/** Build the `servers :PORT { timeouts { ... } }` blocks for proxies that have timeouts set.
 * Proxies belonging to a named ServerDef are excluded — their timeouts are in the ServerDef block. */
function buildManagedServersBlocks(proxies: ProxyEntry[]): string {
  return proxies
    .filter(p => !p.namedServerKey && (p.serverReadTimeout || p.serverReadHeaderTimeout || p.serverWriteTimeout || p.serverIdleTimeout || p.maxHeaderBytes))
    .map(p => {
      const lines = [`\tservers :${p.externalPort} {`];
      const tLines: string[] = [];
      if (p.serverReadTimeout) tLines.push(`\t\t\tread_body ${p.serverReadTimeout}`);
      if (p.serverReadHeaderTimeout) tLines.push(`\t\t\tread_header ${p.serverReadHeaderTimeout}`);
      if (p.serverWriteTimeout) tLines.push(`\t\t\twrite ${p.serverWriteTimeout}`);
      if (p.serverIdleTimeout) tLines.push(`\t\t\tidle ${p.serverIdleTimeout}`);
      if (tLines.length) lines.push("\t\ttimeouts {", ...tLines, "\t\t}");
      if (p.maxHeaderBytes) lines.push(`\t\tmax_header_size ${p.maxHeaderBytes}`);
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
  const blocks = buildManagedServersBlocks(proxies);
  const original = (await fsReadFile(MAIN_CADDYFILE, "try")) ?? "";
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
}

/** Parse global options from the cockpit-caddy:opts managed section in a Caddyfile string. */
export function parseGlobalOptions(content: string): GlobalOptions {
  const bi = content.indexOf(GLOBAL_OPTS_BEGIN);
  const ei = content.indexOf(GLOBAL_OPTS_END);
  if (bi === -1 || ei === -1) return {};
  const section = content.slice(bi + GLOBAL_OPTS_BEGIN.length, ei);
  const opts: GlobalOptions = {};
  const lines = section.split("\n");
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
    }
    i++;
  }
  return opts;
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
  return lines.join("\n");
}

/**
 * Writes global Caddy options into the main Caddyfile's managed opts section,
 * validates, and restores on failure. Throws CaddyfileError on validation failure.
 */
export async function syncGlobalOptions(opts: GlobalOptions): Promise<void> {
  const body = buildGlobalOptionsLines(opts);
  const original = (await fsReadFile(MAIN_CADDYFILE, "try")) ?? "";
  const patched = patchManagedSection(original, GLOBAL_OPTS_BEGIN, GLOBAL_OPTS_END, body);
  if (patched === original) return;

  await fsWriteFile(MAIN_CADDYFILE, patched, "try");
  try {
    await runCaddyValidate();
  } catch (e) {
    await fsWriteFile(MAIN_CADDYFILE, original, "try");
    throw e;
  }
}

/** Read current global options from the main Caddyfile. */
export async function readGlobalOptions(): Promise<GlobalOptions> {
  const content = (await fsReadFile(MAIN_CADDYFILE, "try")) ?? "";
  return parseGlobalOptions(content);
}
