/**
 * The Caddyfile as a text document: finding site blocks, the global options block and the
 * conf.d import, and replacing or removing one block while every other byte stays as the
 * user wrote it. Pure functions on strings, no file access; caddy.ts re-exports the public ones.
 */
import { externalHostList } from "./externalHosts";


/** The import line the plugin adds when the main Caddyfile doesn't import conf.d at all. */
export const CONF_D_IMPORT_LINE = "import /etc/caddy/conf.d/*.conf";

/** Any `import` line that pulls in something from conf.d, in whatever form the user wrote it. */
export const ANY_CONF_D_IMPORT = /^[ \t]*import[ \t]+\S*conf\.d\//m;

/** `import [/etc/caddy/]conf.d/*` or `…/*.conf`, the globs whose files can be inlined. */
export const CONF_D_GLOB_IMPORT = /^[ \t]*import[ \t]+(?:\/etc\/caddy\/)?conf\.d\/\*(\.conf)?[ \t]*$/m;

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
 * The port of a header made only of hostless schemes, such as the distros' `http:// {`
 * welcome site (#256): 80 for `http://`, 443 for `https://`. Undefined for anything else.
 */
export function schemeOnlyPort(addresses: SiteAddress[] | undefined): number | undefined {
  if (!addresses?.length || addresses.some(a => a.host || a.port !== undefined || a.path || !a.scheme)) return undefined;
  if (addresses.every(a => a.scheme === "http")) return 80;
  if (addresses.every(a => a.scheme === "https")) return 443;
  return undefined;
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

/**
 * First line of cockpit-caddy.conf. Plain information for anyone opening the file:
 * nothing parses it, apart from normalizeManagedHeader keeping a single copy.
 */
export const CONF_HEADER = "# Written by the Cockpit Caddy plugin. Hand edits are fine; saving a proxy in Cockpit rewrites only the block that holds it.";

/** Header written before #237. It read as if the plugin kept the real config elsewhere. */
export const LEGACY_CONF_HEADER = "# Managed by cockpit-caddy - edits to this file may be overwritten by user plugin actions";

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
