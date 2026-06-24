import type { CaddyConfig, CaddyHandler, CaddyReverseProxyHandler, CaddyServer, ProxyEntry } from "./types";

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
  const header = "# Managed by cockpit-caddy - do not edit manually\n";
  if (blocks.length === 0) return header + "\n";
  const parts = blocks.map(b => (b.label ? `# label: ${b.label}\n` : "") + b.raw);
  return header + "\n" + parts.join("\n\n") + "\n";
}

export async function writeRawProxyConf(content: string): Promise<void> {
  await cockpit.file(PROXY_CONF_PATH, { superuser: "try" }).replace(content);
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
    return (await cockpit.file(PROXY_CONF_PATH, { superuser: "try" }).read()) ?? "";
  } catch {
    return "";
  }
}

const CONF_HEADER = "# Managed by cockpit-caddy - do not edit manually";

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

function buildRewriteCaddyLines(rewrite: import("./types").RewriteConfig, port: number): string[] {
  if (rewrite.type === "strip_prefix") return [`\turi strip_prefix ${rewrite.value}`];
  if (rewrite.type === "add_prefix") return [`\trewrite ${rewrite.value}{uri}`];
  return [
    `\t@rw${port} path_regexp rw ${rewrite.find}`,
    `\trewrite @rw${port} ${regexReplaceToCaddy(rewrite.replace)}`,
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
function buildReverseProxyLines(p: Pick<ProxyEntry, "targetScheme" | "targetHost" | "targetPort" | "tlsSkipVerify" | "requestHeaders" | "dialTimeout" | "responseHeaderTimeout" | "extraUpstreams" | "lbPolicy">): string[] {
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

  const needsBlock = transportLines.length > 0 || headerLines.length > 0 || lbLines.length > 0;
  if (!needsBlock) return [`\treverse_proxy ${upstreams.join(" ")}`];

  return [`\treverse_proxy ${upstreams.join(" ")} {`, ...lbLines, ...transportLines, ...headerLines, "\t}"];
}

function buildExternalAddress(p: Pick<ProxyEntry, "externalPort" | "externalScheme" | "externalHost">): string {
  if (p.externalScheme && p.externalHost) return `${p.externalScheme}://${p.externalHost}:${p.externalPort}`;
  if (p.externalHost) return `${p.externalHost}:${p.externalPort}`;
  return `:${p.externalPort}`;
}

/** Generates the Caddyfile block for a single proxy (label comment + block body). */
export function proxyToBlock(p: ProxyEntry): string {
  const header = buildExternalAddress(p);
  const lines = p.label ? [`# label: ${p.label}`, `${header} {`] : [`${header} {`];
  if (p.redirect) {
    lines.push(`\tredir ${p.redirect.to} ${p.redirect.code}`);
  } else if (p.fileServer) {
    if (p.tls) lines.push("\ttls internal");
    if (p.compress) lines.push("\tencode gzip zstd");
    if (p.basicAuth?.length) lines.push(...buildBasicAuthCaddyLines(p.basicAuth));
    for (const h of p.responseHeaders ?? []) {
      if (h.op === "delete") lines.push(`\theader -${h.name}`);
      else if (h.op === "add") lines.push(`\theader +${h.name} ${h.value ?? ""}`);
      else lines.push(`\theader ${h.name} "${h.value ?? ""}"`);
    }
    lines.push(`\troot * ${p.fileServer.root}`);
    lines.push(p.fileServer.browse ? "\tfile_server browse" : "\tfile_server");
  } else {
    if (p.tls) lines.push("\ttls internal");
    if (p.compress) lines.push("\tencode gzip zstd");
    if (p.basicAuth?.length) lines.push(...buildBasicAuthCaddyLines(p.basicAuth));
    for (const h of p.responseHeaders ?? []) {
      if (h.op === "delete") lines.push(`\theader -${h.name}`);
      else if (h.op === "add") lines.push(`\theader +${h.name} ${h.value ?? ""}`);
      else lines.push(`\theader ${h.name} "${h.value ?? ""}"`);
    }
    if (p.rewrite) lines.push(...buildRewriteCaddyLines(p.rewrite, p.externalPort));
    lines.push(...buildReverseProxyLines(p));
  }
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
  if (proxy.tls) kept.push("\ttls internal");
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
    kept.push(...buildReverseProxyLines(proxy));
  }
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
  const isPluginFormat = new RegExp(`^:${proxy.externalPort}[\\s{]`).test(headerLine)
    || headerLine === `:${proxy.externalPort}{`;

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
  labelLine: number | null; // index of the "# label:" line above this block, if any
  headerLine: number;       // index of the block opener line
  closingLine: number;      // index of the closing "}"
  port: number;
}

function findBlockPositions(lines: string[]): BlockPosition[] {
  const positions: BlockPosition[] = [];
  let i = 0;
  let pendingLabelLine: number | null = null;

  while (i < lines.length) {
    const trimmed = lines[i].trim();

    if (!trimmed) { i++; continue; }

    if (trimmed.match(/^#\s*label:/)) {
      pendingLabelLine = i; i++; continue;
    }

    if (!trimmed.endsWith("{")) {
      // Any non-empty non-opener line (including other comments) clears the pending label
      pendingLabelLine = null; i++; continue;
    }

    const portMatch = trimmed.match(/:(\d+)[^{]*\{$/);
    if (!portMatch) {
      // Non-port block (e.g. global options) — skip entire block
      pendingLabelLine = null;
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
      positions.push({ labelLine: pendingLabelLine, headerLine, closingLine, port });
    }
    pendingLabelLine = null;
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
  await cockpit.file(PROXY_CONF_PATH, { superuser: "try" }).replace(proxiesToCaddyfile(proxies));
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

type AnyHandler = { handler: string; routes?: Array<{ handle?: AnyHandler[]; [key: string]: unknown }>; [key: string]: unknown };

function findReverseProxy(handles: AnyHandler[]): CaddyReverseProxyHandler | undefined {
  for (const h of handles) {
    if (h.handler === "reverse_proxy") {
      return h as CaddyReverseProxyHandler;
    }
    if (h.handler === "subroute" && h.routes) {
      for (const sub of h.routes) {
        const found = findReverseProxy((sub.handle ?? []) as AnyHandler[]);
        if (found) return found;
      }
    }
  }
  return undefined;
}

export function parseProxies(config: CaddyConfig): ProxyEntry[] {
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

    const allHandles = (server.routes ?? []).flatMap(r => (r.handle ?? []) as AnyHandler[]);

    // Detect redirect (static_response with Location header)
    const staticResp = allHandles.find(h => h.handler === "static_response") as
      { handler: string; headers?: Record<string, string[]>; status_code?: number } | undefined;
    const locationHeader = staticResp?.headers?.["Location"]?.[0];
    if (staticResp && locationHeader) {
      const code = (staticResp.status_code ?? 302) as 301 | 302 | 307 | 308;
      proxies.push({
        id: String(externalPort),
        externalPort,
        externalHost,
        targetHost: "localhost",
        targetPort: 0,
        targetScheme: "http",
        tls: false,
        tlsSkipVerify: false,
        serverKey: key,
        redirect: { to: jsonPlaceholderToCaddy(locationHeader), code },
      });
      continue;
    }

    // Detect file_server
    const fsHandle = allHandles.find(h => h.handler === "file_server") as
      { handler: string; root?: string; browse?: Record<string, unknown> } | undefined;
    if (fsHandle) {
      const fsCompress = allHandles.some(h => h.handler === "encode");
      const fsAuthHandle = allHandles.find(h => h.handler === "authentication");
      const fsBasicAuth = fsAuthHandle ? parseBasicAuthJson(fsAuthHandle) : undefined;
      const fsHeadersHandle = allHandles.find(h => h.handler === "headers");
      const fsResponseHeaders = fsHeadersHandle ? parseResponseHeadersJson(fsHeadersHandle) : [];
      proxies.push({
        id: String(externalPort),
        externalPort,
        externalHost,
        targetHost: "localhost",
        targetPort: 0,
        targetScheme: "http",
        tls: Array.isArray(server.tls_connection_policies) && server.tls_connection_policies.length > 0,
        tlsSkipVerify: false,
        serverKey: key,
        fileServer: { root: fsHandle.root ?? "/", browse: fsHandle.browse !== undefined },
        compress: fsCompress || undefined,
        basicAuth: fsBasicAuth?.length ? fsBasicAuth : undefined,
        responseHeaders: fsResponseHeaders.length ? fsResponseHeaders : undefined,
      });
      continue;
    }

    const rp = findReverseProxy(allHandles);
    if (!rp) continue;

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

    // Transport presence means HTTPS upstream
    const targetScheme: "http" | "https" = rp.transport?.tls !== undefined ? "https" : "http";
    const tlsSkipVerify = rp.transport?.tls?.insecure_skip_verify ?? false;
    const dialTimeout = rp.transport?.dial_timeout as string | undefined;
    const responseHeaderTimeout = rp.transport?.response_header_timeout as string | undefined;

    const tls = Array.isArray(server.tls_connection_policies) && server.tls_connection_policies.length > 0;

    const compress = allHandles.some(h => h.handler === "encode");

    const authHandle = allHandles.find(h => h.handler === "authentication");
    const basicAuth = authHandle ? parseBasicAuthJson(authHandle) : undefined;

    const rewriteHandle = allHandles.find(h => h.handler === "rewrite");
    const rewrite = rewriteHandle ? parseRewriteFromHandle(rewriteHandle) : undefined;

    const headersHandle = allHandles.find(h => h.handler === "headers");
    const responseHeadersParsed = headersHandle ? parseResponseHeadersJson(headersHandle) : [];

    const requestHeaders = parseRequestHeadersJson(rp.headers as Record<string, unknown> | undefined);

    proxies.push({
      id: String(externalPort),
      externalPort,
      externalHost,
      targetHost: targetHost || "localhost",
      targetPort: isNaN(targetPort) ? 80 : targetPort,
      targetScheme,
      tls,
      tlsSkipVerify,
      serverKey: key,
      compress: compress || undefined,
      basicAuth: basicAuth?.length ? basicAuth : undefined,
      dialTimeout: dialTimeout || undefined,
      responseHeaderTimeout: responseHeaderTimeout || undefined,
      rewrite,
      requestHeaders: requestHeaders.length ? requestHeaders : undefined,
      responseHeaders: responseHeadersParsed.length ? responseHeadersParsed : undefined,
      extraUpstreams: extraUpstreams.length ? extraUpstreams : undefined,
      lbPolicy,
    });
  }

  return proxies.sort((a, b) => a.externalPort - b.externalPort);
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

function buildReverseProxyHandler(proxy: Pick<ProxyEntry, "targetHost" | "targetPort" | "targetScheme" | "tlsSkipVerify" | "requestHeaders" | "dialTimeout" | "responseHeaderTimeout" | "extraUpstreams" | "lbPolicy">): CaddyReverseProxyHandler {
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
  return rp;
}

export function buildServerEntry(proxy: Omit<ProxyEntry, "id" | "serverKey">): CaddyServer {
  const listenAddr = proxy.externalHost
    ? `${proxy.externalHost}:${proxy.externalPort}`
    : `:${proxy.externalPort}`;
  if (proxy.redirect) {
    return {
      listen: [listenAddr],
      routes: [{
        handle: [{
          handler: "static_response",
          headers: { Location: [caddyPlaceholderToJson(proxy.redirect.to)] },
          status_code: proxy.redirect.code,
        }],
        terminal: true,
      }],
    };
  }
  if (proxy.fileServer) {
    const fsHandles: CaddyHandler[] = [];
    if (proxy.compress) fsHandles.push(buildEncodeHandler());
    if (proxy.basicAuth?.length) fsHandles.push(buildBasicAuthHandler(proxy.basicAuth));
    if (proxy.responseHeaders?.length) fsHandles.push(buildResponseHeadersHandler(proxy.responseHeaders));
    const fsHandler: Record<string, unknown> = { handler: "file_server", root: proxy.fileServer.root };
    if (proxy.fileServer.browse) fsHandler["browse"] = {};
    fsHandles.push(fsHandler as CaddyHandler);
    const server: CaddyServer = {
      listen: [listenAddr],
      routes: [{ handle: fsHandles, terminal: true }],
    };
    if (proxy.tls) server.tls_connection_policies = [{}];
    return server;
  }
  const handles: CaddyHandler[] = [];
  if (proxy.compress) handles.push(buildEncodeHandler());
  if (proxy.basicAuth?.length) handles.push(buildBasicAuthHandler(proxy.basicAuth));
  if (proxy.responseHeaders?.length) handles.push(buildResponseHeadersHandler(proxy.responseHeaders));
  if (proxy.rewrite) handles.push(buildRewriteHandler(proxy.rewrite));
  handles.push(buildReverseProxyHandler(proxy));
  const server: CaddyServer = {
    listen: [listenAddr],
    routes: [{ handle: handles, terminal: true }],
  };
  if (proxy.tls) {
    server.tls_connection_policies = [{}];
  }
  return server;
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
  // Strip any existing encode/authentication/rewrite/headers/file_server handlers; we'll re-add the correct ones below
  const withoutRewrite = handles.filter(h => h.handler !== "rewrite" && h.handler !== "headers" && h.handler !== "encode" && h.handler !== "authentication" && h.handler !== "file_server");
  const patched = withoutRewrite.map(h => {
    if (h.handler === "reverse_proxy") {
      found = true;
      return buildReverseProxyHandler(proxy);
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
    patched.push(buildReverseProxyHandler(proxy));
  }
  // Prepend encode/auth/response-headers/rewrite handlers if configured
  const prefix: CaddyHandler[] = [];
  if (proxy.compress) prefix.push(buildEncodeHandler());
  if (proxy.basicAuth?.length) prefix.push(buildBasicAuthHandler(proxy.basicAuth));
  if (proxy.responseHeaders?.length) prefix.push(buildResponseHeadersHandler(proxy.responseHeaders));
  if (proxy.rewrite) prefix.push(buildRewriteHandler(proxy.rewrite));
  return [...prefix, ...patched] as CaddyHandler[];
}

/** Patch only the fields we manage; preserve everything else in the original server. */
function patchServer(original: CaddyServer, proxy: ProxyEntry): CaddyServer {
  const server = { ...original };

  server.listen = [proxy.externalHost
    ? `${proxy.externalHost}:${proxy.externalPort}`
    : `:${proxy.externalPort}`];

  if (proxy.tls) {
    if (!server.tls_connection_policies?.length) {
      server.tls_connection_policies = [{}];
    }
    // else preserve existing custom TLS policies
  } else {
    delete server.tls_connection_policies;
  }

  server.routes = (original.routes ?? []).map(route => ({
    ...route,
    handle: patchHandles((route.handle ?? []) as CaddyHandler[], proxy),
  }));

  return server;
}

export function mergeProxy(config: CaddyConfig, proxy: ProxyEntry): CaddyConfig {
  const servers = { ...(config.apps?.http?.servers ?? {}) };
  const original = servers[proxy.serverKey];
  servers[proxy.serverKey] = (original && !proxy.redirect) ? patchServer(original, proxy) : buildServerEntry(proxy);

  const hasTls = Object.values(servers).some(
    s => Array.isArray(s.tls_connection_policies) && s.tls_connection_policies.length > 0,
  );

  return {
    ...config,
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
  delete servers[serverKey];

  const hasTls = Object.values(servers).some(
    s => Array.isArray(s.tls_connection_policies) && s.tls_connection_policies.length > 0,
  );

  return {
    ...config,
    apps: {
      ...config.apps,
      http: { ...config.apps?.http, servers },
      tls: hasTls ? config.apps?.tls : undefined,
    },
  };
}
