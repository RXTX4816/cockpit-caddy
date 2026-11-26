// Named matchers in the Tree tab (#350): the `@name { … }` block a node's matcher refers to, read
// into the RouteMatch the matcher form edits, and written back. Only a definition the plugin's own
// writer reproduces byte for byte is offered; any other stays the text it is.
import type { RouteMatch, RouteMatchFields } from "./types";
import { buildMatcherCaddyLines } from "./siteBlocks";
import { childNodes, type NodePath, type SiteTree, type TreeItem, type TreeNode } from "./siteTree";

/**
 * The tokens of one Caddyfile line: words, "double quoted" with `\"` escapes, and `backticks`.
 * Undefined for what this reader doesn't take on: a heredoc, a comment, an open quote.
 */
export function lineTokens(line: string): string[] | undefined {
  const out: string[] = [];
  let i = 0;
  const s = line.trim();
  while (i < s.length) {
    if (/\s/.test(s[i])) { i++; continue; }
    if (s[i] === "#" || s.startsWith("<<", i)) return undefined;
    if (s[i] === '"' || s[i] === "`") {
      const q = s[i];
      let tok = "";
      let j = i + 1;
      for (; j < s.length && s[j] !== q; j++) {
        if (q === '"' && s[j] === "\\" && s[j + 1] === '"') { tok += '"'; j++; } else tok += s[j];
      }
      if (j >= s.length) return undefined;
      out.push(tok);
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < s.length && !/\s/.test(s[j])) j++;
    out.push(s.slice(i, j));
    i = j;
  }
  return out;
}

const presence = (vals: string[]) => vals.length === 1 && vals[0] === "*" ? [] : vals;

/** The matcher fields of a body's lines, or undefined at the first line that isn't one. */
function readFields(lines: string[], start: number, end: number, into: RouteMatch | RouteMatchFields, allowBlocks: boolean): boolean {
  for (let i = start; i < end; i++) {
    const tok = lineTokens(lines[i]);
    if (!tok?.length) return false;
    const [dir, ...args] = tok;
    const m = into as RouteMatch;
    if ((dir === "path" || dir === "host" || dir === "method") && args.length) m[dir] = [...(m[dir] ?? []), ...args];
    else if (dir === "header" && args.length >= 2) m.header = { ...m.header, [args[0]]: presence(args.slice(1)) };
    else if (dir === "query" && args.length) {
      const q: Record<string, string[]> = { ...m.query };
      for (const pair of args) {
        const eq = pair.indexOf("=");
        if (eq <= 0) return false;
        const [k, v] = [pair.slice(0, eq), pair.slice(eq + 1)];
        q[k] = v === "*" ? (q[k] ?? []) : [...(q[k] ?? []), v];
      }
      m.query = q;
    } else if ((dir === "remote_ip" || dir === "client_ip") && args.length) m[dir] = { ranges: args };
    else if (dir === "path_regexp" && (args.length === 1 || args.length === 2)) m.path_regexp = args.length === 2 ? { name: args[0], pattern: args[1] } : { pattern: args[0] };
    else if (dir === "header_regexp" && (args.length === 2 || args.length === 3)) {
      m.header_regexp = args.length === 3 ? { name: args[0], header: args[1], pattern: args[2] } : { header: args[0], pattern: args[1] };
    } else if (dir === "protocol" && args.length === 1) m.protocol = args[0] as RouteMatch["protocol"];
    else if (dir === "vars" && args.length >= 2) m.vars = { ...m.vars, [args[0]]: args.slice(1) };
    else if (dir === "file" && args.length === 1 && args[0] === "{") {
      const close = lines.findIndex((l, j) => j > i && l.trim() === "}");
      if (close < 0) return false;
      const file: NonNullable<RouteMatch["file"]> = { try_files: [] };
      for (let j = i + 1; j < close; j++) {
        const ft = lineTokens(lines[j]);
        if (ft?.[0] === "try_files" && ft.length > 1) file.try_files.push(...ft.slice(1));
        else if (ft?.[0] === "try_policy" && ft.length === 2) file.try_policy = ft[1] as typeof file.try_policy;
        else return false;
      }
      m.file = file;
      i = close;
    } else if (allowBlocks && dir === "not" && args.length === 1 && args[0] === "{") {
      let depth = 1;
      let close = -1;
      for (let j = i + 1; j < end && close < 0; j++) {
        const t = lines[j].trim();
        if (t.endsWith("{")) depth++;
        else if (t === "}" && --depth === 0) close = j;
      }
      if (close < 0) return false;
      const not: RouteMatchFields = {};
      if (!readFields(lines, i + 1, close, not, false)) return false;
      m.not = not;
      i = close;
    } else if (allowBlocks && dir === "expression" && args.length === 1) m.expression = args[0];
    else return false;
  }
  return true;
}

/**
 * The matcher a `@name { … }` block defines, when writing that matcher back gives exactly these
 * lines; otherwise undefined, and the block stays as written.
 */
export function parseMatcherBlock(lines: string[]): { name: string; match: RouteMatch } | undefined {
  const head = lines[0]?.match(/^(\s*)@([\w-]+) \{$/);
  if (!head || lines.length < 3 || lines[lines.length - 1].trim() !== "}") return undefined;
  const [, indent, name] = head;
  const match: RouteMatch = {};
  if (!readFields(lines, 1, lines.length - 1, match, true)) return undefined;
  return buildMatcherCaddyLines(match, name, indent).join("\n") === lines.join("\n") ? { name, match } : undefined;
}

const nodeText = (n: TreeNode) => [n.header, ...n.items.map(it => "line" in it ? it.line : ""), n.close];

/** True when the body defines `@name` itself, on one line or as a block. */
function definesIn(items: TreeItem[], name: string): boolean {
  return items.some(it => "line" in it
    ? new RegExp(`^@${name}(\\s|$)`).test(it.line.trim())
    : it.node.kind === "opaque" && new RegExp(`^@${name}\\s*\\{`).test(it.node.header.trim()));
}

/**
 * The definition the matcher `@name` of the node at `path` refers to, read for the matcher form:
 * only when the site's own body defines it as a block the form can write, and no block around
 * the node defines its own `@name` (which would be the one in effect).
 */
export function siteMatcherDefinition(tree: SiteTree, path: NodePath, name: string): RouteMatch | undefined {
  let items = tree.items;
  for (const idx of path.slice(0, -1)) {
    const parent = childNodes(items)[idx];
    if (!parent) return undefined;
    if (definesIn(parent.items, name)) return undefined;
    items = parent.items;
  }
  const defs = tree.items.flatMap(it => "node" in it && it.node.kind === "opaque" && new RegExp(`^\\s*@${name} \\{$`).test(it.node.header) ? [it.node] : []);
  if (defs.length !== 1 || tree.items.some(it => "line" in it && new RegExp(`^@${name}(\\s|$)`).test(it.line.trim()))) return undefined;
  // A block that holds a nested block other than file/not is opaque all the way down; nodeText
  // then misses lines, and parseMatcherBlock refuses it.
  if (defs[0].items.some(it => "node" in it)) return undefined;
  return parseMatcherBlock(nodeText(defs[0]))?.match;
}

/** The tree with the site's `@name { … }` block rewritten from `match`, at its place and indent. */
export function replaceSiteMatcherDefinition(tree: SiteTree, name: string, match: RouteMatch): SiteTree {
  return {
    ...tree,
    items: tree.items.map(it => {
      if (!("node" in it) || it.node.kind !== "opaque" || !new RegExp(`^\\s*@${name} \\{$`).test(it.node.header)) return it;
      const indent = it.node.header.match(/^\s*/)![0];
      const lines = buildMatcherCaddyLines(match, name, indent);
      return { node: { ...it.node, header: lines[0], items: lines.slice(1, -1).map(line => ({ line })), close: lines[lines.length - 1] } };
    }),
  };
}
