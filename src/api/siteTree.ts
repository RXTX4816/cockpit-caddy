// The route and nested handle blocks of a site (#333): which sites have them, the tree they make,
// and (later slices) editing it. Pure functions on the text of one site block; the text stays the
// source of truth and nothing here reads or writes a file.

/** `{` minus `}` on one line, ignoring braces inside quotes and `{placeholders}` that close on the line. */
export function braceDelta(line: string): number {
  let delta = 0;
  let quote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\") { i++; continue; }
    if (c === '"') { quote = !quote; continue; }
    if (quote) continue;
    if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) break;
    if (c === "{") {
      // `{host}` and `{http.request.uri}` are placeholders, not blocks.
      const close = line.indexOf("}", i);
      if (close > i && !/\s/.test(line.slice(i, close + 1)) && line[i + 1] !== undefined && line[i + 1] !== "}") { i = close; continue; }
      delta++;
    } else if (c === "}") {
      delta--;
    }
  }
  return delta;
}

/** The container directives a tree is made of. */
export const TREE_KINDS = ["route", "handle", "handle_path"] as const;
export type TreeKind = typeof TREE_KINDS[number];

/** The keyword that opens a line, when the line opens a block. */
function blockKeyword(line: string): string | undefined {
  const t = line.trim();
  if (!/\{\s*(#.*)?$/.test(t) || braceDelta(t) <= 0) return undefined;
  return t.split(/\s+/)[0].replace(/\{$/, "");
}

/**
 * True when the site block holds a `route`, or a `handle` / `handle_path` / `route` inside another
 * one. A flat site of top-level `handle` blocks (what the plugin writes for a matcher) has none.
 */
export function hasNestedBlocks(siteText: string): boolean {
  const lines = siteText.split("\n");
  const stack: string[] = [];
  for (let i = 1; i < lines.length - 1; i++) {
    const line = lines[i];
    const kw = blockKeyword(line);
    if (kw && (TREE_KINDS as readonly string[]).includes(kw)) {
      if (kw === "route" || stack.some(k => (TREE_KINDS as readonly string[]).includes(k))) return true;
    }
    const delta = braceDelta(line);
    if (delta > 0) for (let d = 0; d < delta; d++) stack.push(kw ?? "");
    else if (delta < 0) for (let d = 0; d < -delta; d++) stack.pop();
  }
  return false;
}


// ---------------------------------------------------------------------------
// The tree (#349)
// ---------------------------------------------------------------------------

/** A line of a body, or a block nested in it. Every line of the text is in exactly one place. */
export type TreeItem = { line: string } | { node: TreeNode };

/**
 * A `route`, `handle` or `handle_path` block, or a block of any other directive (`opaque`), which
 * is shown as written and not looked into. `header` and `close` are the lines as written,
 * indent included, so putting a tree back together gives the text it was made from.
 */
export interface TreeNode {
  kind: TreeKind | "opaque";
  header: string;
  /** What follows the keyword on the header line, without the `{`: `@api`, `/app/*`, or "". */
  matcher: string;
  items: TreeItem[];
  close: string;
}

/** The site block: its address line, what is in it, and its closing line. */
export interface SiteTree {
  header: string;
  items: TreeItem[];
  close: string;
}

const isContainer = (kw: string | undefined): kw is TreeKind => !!kw && (TREE_KINDS as readonly string[]).includes(kw);

/** The part of a header line after the keyword and before the opening brace. */
function headerMatcher(header: string): string {
  const t = header.trim().replace(/\{\s*(#.*)?$/, "").trim();
  return t.split(/\s+/).slice(1).join(" ");
}

/**
 * Reads the lines of a block body (everything between the braces of `lines[start - 1]`) into items.
 * Stops at the line that closes the block and returns where it is.
 */
function readItems(lines: string[], start: number): { items: TreeItem[]; end: number } | undefined {
  const items: TreeItem[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    const delta = braceDelta(line);
    if (delta < 0) return { items, end: i };
    if (delta > 0) {
      const kw = blockKeyword(line);
      const node = readNode(lines, i, kw);
      if (!node) return undefined;
      items.push({ node: node.node });
      i = node.end + 1;
      continue;
    }
    items.push({ line });
    i++;
  }
  return undefined;
}

function readNode(lines: string[], at: number, kw: string | undefined): { node: TreeNode; end: number } | undefined {
  const header = lines[at];
  if (braceDelta(header) !== 1) {
    // `a { b {` on one line, or a header that opens several blocks: kept as written, whole.
    let depth = 0;
    for (let j = at; j < lines.length; j++) {
      depth += braceDelta(lines[j]);
      if (depth <= 0) return { node: { kind: "opaque", header, matcher: "", items: lines.slice(at + 1, j).map(line => ({ line })), close: lines[j] }, end: j };
    }
    return undefined;
  }
  if (isContainer(kw)) {
    const body = readItems(lines, at + 1);
    if (!body) return undefined;
    return { node: { kind: kw, header, matcher: headerMatcher(header), items: body.items, close: lines[body.end] }, end: body.end };
  }
  // Any other block (reverse_proxy { … }, handle_errors { … }, @name { … }) is shown as written.
  let depth = 1;
  for (let j = at + 1; j < lines.length; j++) {
    depth += braceDelta(lines[j]);
    if (depth === 0) return { node: { kind: "opaque", header, matcher: "", items: lines.slice(at + 1, j).map(line => ({ line })), close: lines[j] }, end: j };
  }
  return undefined;
}

/** Reads a site block into a tree; undefined when its braces do not balance. */
export function parseSiteTree(siteText: string): SiteTree | undefined {
  const lines = siteText.split("\n");
  if (lines.length < 2 || braceDelta(lines[0]) !== 1) return undefined;
  const body = readItems(lines, 1);
  if (!body || body.end !== lines.length - 1) return undefined;
  return { header: lines[0], items: body.items, close: lines[body.end] };
}

function itemLines(items: TreeItem[]): string[] {
  return items.flatMap(it => "line" in it ? [it.line] : nodeLines(it.node));
}

function nodeLines(n: TreeNode): string[] {
  return [n.header, ...itemLines(n.items), n.close];
}

/** The text of a tree: with nothing edited, exactly the text it was read from. */
export function serializeSiteTree(tree: SiteTree): string {
  return [tree.header, ...itemLines(tree.items), tree.close].join("\n");
}

/** The directives of a node written on one line each, as `name args`, comments and blank lines left out. */
export function nodeHandlers(node: Pick<TreeNode, "items">): string[] {
  return node.items.flatMap(it => "line" in it ? [it.line.trim()] : []).filter(l => l && !l.startsWith("#"));
}

/** The containers that make up the tree: the child nodes of a node, or of the site. */
export function childNodes(items: TreeItem[]): TreeNode[] {
  return items.flatMap(it => "node" in it ? [it.node] : []);
}


// ---------------------------------------------------------------------------
// Editing the nodes that are there (#350)
// ---------------------------------------------------------------------------

/** Where a node is: the index among the child nodes at each level, from the site down. */
export type NodePath = number[];

export function nodeAt(tree: SiteTree, path: NodePath): TreeNode | undefined {
  let items = tree.items;
  let node: TreeNode | undefined;
  for (const idx of path) {
    node = childNodes(items)[idx];
    if (!node) return undefined;
    items = node.items;
  }
  return node;
}

/** The header line with another matcher, keeping its indent, the keyword and anything after the `{`. */
export function rewriteHeader(header: string, matcher: string): string {
  const m = header.match(/^(\s*)(route|handle_path|handle)\b(.*?)(\s*\{.*)$/);
  if (!m) return header;
  const [, indent, keyword, , rest] = m;
  return `${indent}${keyword}${matcher.trim() ? ` ${matcher.trim()}` : ""} ${rest.trimStart()}`;
}

/** The item indexes of the lines `nodeHandlers` lists, in order. */
function handlerItemIndexes(items: TreeItem[]): number[] {
  const out: number[] = [];
  items.forEach((it, i) => {
    if ("line" in it && it.line.trim() && !it.line.trim().startsWith("#")) out.push(i);
  });
  return out;
}

export interface NodeEdit {
  /** The new matcher of a route, handle or handle_path; "" for none. */
  matcher?: string;
  /** New text for directives of the node's own, by their index in `nodeHandlers`. */
  handlers?: Record<number, string>;
}

/** What is wrong with an edit, or undefined: a matcher or directive must stay on one line without braces. */
export function validateNodeEdit(edit: NodeEdit): string | undefined {
  if (edit.matcher !== undefined && /[\n{}]/.test(edit.matcher)) return "matcher";
  for (const text of Object.values(edit.handlers ?? {})) {
    if (!text.trim() || /\n/.test(text) || braceDelta(text) !== 0) return "handler";
  }
  return undefined;
}

function replaceNode(items: TreeItem[], path: NodePath, change: (n: TreeNode) => TreeNode): TreeItem[] {
  const [first, ...rest] = path;
  let seen = -1;
  return items.map(it => {
    if (!("node" in it)) return it;
    seen++;
    if (seen !== first) return it;
    return { node: rest.length ? { ...it.node, items: replaceNode(it.node.items, rest, change) } : change(it.node) };
  });
}

/**
 * The tree with one node edited. Only that node's header and the text of the directives that are
 * changed differ; every other line, comment and block, opaque ones included, stays as it was.
 */
export function editNode(tree: SiteTree, path: NodePath, edit: NodeEdit): SiteTree {
  if (validateNodeEdit(edit) || !nodeAt(tree, path)) return tree;
  return {
    ...tree,
    items: replaceNode(tree.items, path, node => {
      if (node.kind === "opaque") return node;
      const indexes = handlerItemIndexes(node.items);
      const items = node.items.map((it, i) => {
        const which = indexes.indexOf(i);
        const text = which >= 0 ? edit.handlers?.[which] : undefined;
        if (text === undefined || !("line" in it)) return it;
        return { line: `${it.line.match(/^\s*/)![0]}${text.trim()}` };
      });
      return { ...node, header: edit.matcher !== undefined ? rewriteHeader(node.header, edit.matcher) : node.header, matcher: edit.matcher !== undefined ? edit.matcher.trim() : node.matcher, items };
    }),
  };
}
