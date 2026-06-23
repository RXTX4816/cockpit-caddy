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

const TCP_BASE = "http://127.0.0.1:2019";
const UNIX_SOCKET = "/run/caddy/admin.socket";

let transport: Transport | null = null;

async function tcpGet(path: string): Promise<string> {
  return cockpit.spawn(
    ["curl", "-sf", `${TCP_BASE}${path}`],
    { err: "ignore" },
  );
}

async function unixGet(path: string): Promise<string> {
  return cockpit.spawn(
    ["curl", "-sf", "--unix-socket", UNIX_SOCKET, `http://localhost${path}`],
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
  await curlPost(["curl", `${TCP_BASE}${path}`], body);
}

async function unixPost(path: string, body: string): Promise<void> {
  await curlPost(
    ["curl", "--unix-socket", UNIX_SOCKET, `http://localhost${path}`],
    body,
    { superuser: "try" },
  );
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

/** Builds the reverse_proxy directive lines for a proxy (tab-indented). */
function buildReverseProxyLines(p: Pick<ProxyEntry, "targetScheme" | "targetHost" | "targetPort" | "tlsSkipVerify">): string[] {
  if (p.targetScheme === "https") {
    const upstream = `https://${p.targetHost}:${p.targetPort}`;
    if (p.tlsSkipVerify) {
      return [
        `\treverse_proxy ${upstream} {`,
        "\t\ttransport http {",
        "\t\t\ttls_insecure_skip_verify",
        "\t\t}",
        "\t}",
      ];
    }
    return [`\treverse_proxy ${upstream}`];
  }
  return [`\treverse_proxy http://${p.targetHost}:${p.targetPort}`];
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
  if (p.tls) lines.push("\ttls internal");
  lines.push(...buildReverseProxyLines(p));
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
  kept.push(...buildReverseProxyLines(proxy));
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
    const rp = findReverseProxy(allHandles);
    if (!rp) continue;

    const dial = rp.upstreams?.[0]?.dial ?? "";
    const lastColon = dial.lastIndexOf(":");
    const targetHost = lastColon > 0 ? dial.slice(0, lastColon) : dial;
    const targetPort = lastColon > 0 ? parseInt(dial.slice(lastColon + 1), 10) : 80;

    // Transport presence means HTTPS upstream
    const targetScheme: "http" | "https" = rp.transport?.tls !== undefined ? "https" : "http";
    const tlsSkipVerify = rp.transport?.tls?.insecure_skip_verify ?? false;

    const tls = Array.isArray(server.tls_connection_policies) && server.tls_connection_policies.length > 0;

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
    });
  }

  return proxies.sort((a, b) => a.externalPort - b.externalPort);
}

// ---------------------------------------------------------------------------
// Building / patching server entries
// ---------------------------------------------------------------------------

function buildReverseProxyHandler(proxy: Pick<ProxyEntry, "targetHost" | "targetPort" | "targetScheme" | "tlsSkipVerify">): CaddyReverseProxyHandler {
  const rp: CaddyReverseProxyHandler = {
    handler: "reverse_proxy",
    upstreams: [{ dial: `${proxy.targetHost}:${proxy.targetPort}` }],
  };
  if (proxy.targetScheme === "https") {
    rp.transport = {
      protocol: "http",
      tls: proxy.tlsSkipVerify ? { insecure_skip_verify: true } : {},
    };
  }
  return rp;
}

export function buildServerEntry(proxy: Omit<ProxyEntry, "id" | "serverKey">): CaddyServer {
  const listenAddr = proxy.externalHost
    ? `${proxy.externalHost}:${proxy.externalPort}`
    : `:${proxy.externalPort}`;
  const server: CaddyServer = {
    listen: [listenAddr],
    routes: [{ handle: [buildReverseProxyHandler(proxy)], terminal: true }],
  };
  if (proxy.tls) {
    server.tls_connection_policies = [{}];
  }
  return server;
}

/** Patch handles in-place: update reverse_proxy upstreams/transport, leave everything else untouched. */
function patchHandles(handles: CaddyHandler[], proxy: ProxyEntry): CaddyHandler[] {
  let found = false;
  const patched = handles.map(h => {
    if (h.handler === "reverse_proxy") {
      found = true;
      const rp = h as CaddyReverseProxyHandler;
      const transport = proxy.targetScheme === "https"
        ? { ...(rp.transport ?? {}), protocol: "http", tls: { ...(rp.transport?.tls ?? {}), insecure_skip_verify: proxy.tlsSkipVerify || undefined } }
        : undefined;
      return { ...rp, upstreams: [{ dial: `${proxy.targetHost}:${proxy.targetPort}` }], transport };
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
  return patched as CaddyHandler[];
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
  servers[proxy.serverKey] = original ? patchServer(original, proxy) : buildServerEntry(proxy);

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
