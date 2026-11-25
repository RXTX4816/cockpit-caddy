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
  if (!t.endsWith("{") || braceDelta(t) <= 0) return undefined;
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
