// The Caddyfile as a text document: where a block starts and ends, reading what is in a file
// (addresses, TLS, access log, forward auth, legacy labels) and editing one block while leaving
// the rest of the file, comments and hand edits included, exactly as it was.
// Pure: no Host, no I/O. Depends on nothing else in the plugin.

import { externalHostList } from "./externalHosts";

/** The import line the plugin adds when the main Caddyfile doesn't import conf.d at all. */
export const CONF_D_IMPORT_LINE = "import /etc/caddy/conf.d/*.conf";


/** Any `import` line that pulls in something from conf.d, in whatever form the user wrote it. */
export const ANY_CONF_D_IMPORT = /^[ \t]*import[ \t]+\S*conf\.d\//m;


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
 * Extracts the trailing `:PORT` from a block address, if any. Used to add a
 * port-keyed fallback entry to conf.d-derived metadata maps, since a proxy
 * that's the sole occupant of its port loses its host/scheme info once
 * round-tripped through Caddy's JSON config (Caddy omits the host matcher
 * when there's nothing else on that port to disambiguate) — the exact
 * `scheme://host:port` address key then no longer matches anything.
 */
export function addressPortKey(address: string): string | undefined {
  const m = address.match(/:(\d+)$/);
  if (m) return m[1];
  return schemeOnlyPort(parseSiteAddresses(address))?.toString();
}


/**
 * The port of a header made only of hostless schemes, such as the distros' `http:// {`
 * welcome site (#256): 80 for `http://`, 443 for `https://`. Undefined for anything else.
 */
export function schemeOnlyPort(addresses: SiteAddress[] | undefined): number | undefined {
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
export interface SiteAddress {
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
export function parseSiteAddresses(header: string): SiteAddress[] | undefined {
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


/** Returns address → the site's own DNS provider (#289), from `dns <provider>` in its `tls { }` block. */
export function parseConfTlsDnsMap(content: string): Record<string, import("./types").DnsChallengeConfig> {
  const result: Record<string, import("./types").DnsChallengeConfig> = {};
  for (const block of extractRawBlocksFromCaddyfile(content)) {
    const lines = block.raw.split("\n");
    let depth = 0;
    let tlsDepth = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (tlsDepth >= 0 && depth === tlsDepth + 1) {
        const m = line.match(/^dns\s+(\S.*)$/);
        if (m) {
          const { config, next } = parseDnsProviderDirective(m[1], lines, i);
          if (config) setBlockResult(result, block, config);
          i = next - 1;
          continue;
        }
      }
      if (/^tls(\s.*)?\{$/.test(line) && tlsDepth < 0) tlsDepth = depth;
      depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
      if (tlsDepth >= 0 && depth <= tlsDepth) tlsDepth = -1;
    }
  }
  return result;
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


/**
 * First line of cockpit-caddy.conf. Plain information for anyone opening the file:
 * nothing parses it, apart from normalizeManagedHeader keeping a single copy.
 */
export const CONF_HEADER = "# Written by the Cockpit Caddy plugin. Hand edits are fine; saving a proxy in Cockpit rewrites only the block that holds it.";


/** Parse the forward_auth block from within a single conf.d site block (raw text). */
export function parseForwardAuthFromBlockRaw(raw: string): import("./types").ForwardAuthConfig | undefined {
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


// ---------------------------------------------------------------------------
// Surgical per-block conf.d editing
// ---------------------------------------------------------------------------

export interface BlockPosition {
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
export function findMatchingBlock(positions: BlockPosition[], port: number, host: string | undefined): BlockPosition | undefined {
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


export function sameHostSet(a: string[], b: string[]): boolean {
  const norm = (l: string[]) => [...new Set(l.map(h => h.toLowerCase()))].sort().join(",");
  return norm(a) === norm(b);
}


/**
 * Port and hostnames of a top-level block header, or undefined when the block isn't a
 * site block this plugin can address. A header without an explicit port counts when
 * every address names a host (`git.example.com {`, `a.com, b.com {`): Caddy serves it
 * on 443, or 80 for an explicit `http://`.
 */
export function blockHeaderTarget(header: string): { port: number; hosts: string[] } | undefined {
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


export function findBlockPositions(lines: string[]): BlockPosition[] {
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


/** Returns true only for numeric IP addresses — these are valid TCP bind targets. Hostnames are site labels in Caddyfile, not bind interfaces. */
export function isIpAddress(host: string): boolean {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || host.startsWith("[");
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
export function isCaddyInternalSubject(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === "localhost"
    || h.endsWith(".localhost")
    || h.endsWith(".local")
    || h.endsWith(".internal")
    || h.endsWith(".home.arpa")
    || isIpAddress(h);
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
 * Finds the block for a named server (identified by `# server: key` comment).
 * Returns undefined if not found.
 */
export function findServerBlock(lines: string[], serverKey: string): BlockPosition | undefined {
  const positions = findBlockPositions(lines);
  return positions.find(p => p.serverKey === serverKey);
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
 * Reads a DNS provider directive whose arguments are `val` (the rest of line i). Returns the
 * config and the index of the first line after it (after the closing brace of a block).
 */
export function parseDnsProviderDirective(val: string, lines: string[], i: number): { config?: import("./types").DnsChallengeConfig; next: number } {
  const isBlock = val.trim().endsWith("{");
  const args = val.replace(/\{\s*$/, "").trim().split(/\s+/).filter(Boolean);
  if (!args.length) return { next: i + 1 };
  const config: import("./types").DnsChallengeConfig = { provider: args[0], credentials: {} };
  const literal: Record<string, string> = {};
  if (args.length > 1) literal[""] = args.slice(1).join(" ");
  let j = i + 1;
  if (isBlock) {
    let depth = 1;
    for (; j < lines.length; j++) {
      const inner = lines[j].trim();
      depth += (inner.match(/\{/g) ?? []).length - (inner.match(/\}/g) ?? []).length;
      if (depth <= 0) { j++; break; }
      const im = inner.match(/^(\S+)\s+(.+)$/);
      if (!im || depth > 1) continue;
      const env = im[2].trim().match(/^\{env\.([A-Za-z_][A-Za-z0-9_]*)\}$/);
      if (env) config.credentials[im[1]] = env[1];
      else literal[im[1]] = im[2].trim();
    }
  }
  if (Object.keys(literal).length) config.literal = literal;
  return { config, next: j };
}
