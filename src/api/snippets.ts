/**
 * Caddyfile snippets (#288): `(name) { ... }` blocks edited as raw text on the Settings tab and
 * pulled into sites with `import name`. The plugin keeps its own snippets in a separate conf.d
 * file (cockpit-caddy-snippets.conf, see readSnippetsConf) that sorts before cockpit-caddy.conf, because Caddy only finds a snippet defined before
 * the import that uses it. Hand-written snippets in the main Caddyfile are listed read-only.
 */
import { extractRawBlocksFromCaddyfile, parseLabelsFromCaddyfile, setBlockResult } from "./caddy";
import type { ProxyEntry } from "./types";

export const SNIPPETS_HEADER = "# Snippets written by the Cockpit Caddy plugin (Settings → Snippets). Sites use them with `import <name>`.";

export interface SnippetDef {
  name: string;
  /** The snippet's inner text, without the `(name) {` line, the closing brace or the indent. */
  body: string;
  /** "plugin": in the plugin's snippets file, editable. "caddyfile": hand-written in the main Caddyfile. */
  source: "plugin" | "caddyfile";
}

const SNIPPET_HEADER = /^\(([^()\s{}]+)\)$/;

/** A name Caddy accepts in `(name)` and `import name` that can't be mistaken for a file path. */
export function isValidSnippetName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name);
}

function dedent(lines: string[]): string[] {
  const indents = lines.filter(l => l.trim()).map(l => l.match(/^[ \t]*/)![0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines.map(l => l.slice(Math.min(cut, l.match(/^[ \t]*/)![0].length)).trimEnd());
}

function trimBlankEdges(lines: string[]): string[] {
  let a = 0, b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
}

/** Every top-level `(name) { ... }` snippet in Caddyfile text. */
export function parseSnippets(content: string, source: SnippetDef["source"]): SnippetDef[] {
  return extractRawBlocksFromCaddyfile(content).flatMap(block => {
    const m = SNIPPET_HEADER.exec(block.address);
    if (!m) return [];
    const inner = block.raw.split("\n").slice(1, -1);
    return [{ name: m[1], body: trimBlankEdges(dedent(inner)).join("\n"), source }];
  });
}

/** Plugin snippets first (the editable ones), then hand-written ones whose name isn't taken. */
export function mergeSnippetLists(plugin: SnippetDef[], caddyfile: SnippetDef[]): SnippetDef[] {
  return [...plugin, ...caddyfile.filter(s => !plugin.some(p => p.name === s.name))];
}

/** The plugin's snippets file for these snippets. */
export function snippetsToConf(snippets: Pick<SnippetDef, "name" | "body">[]): string {
  const blocks = snippets.map(s => {
    const body = trimBlankEdges(s.body.replace(/\r\n?/g, "\n").split("\n")).map(l => (l.trim() ? `\t${l.trimEnd()}` : ""));
    return [`(${s.name}) {`, ...body, "}"].join("\n");
  });
  return [SNIPPETS_HEADER, ...blocks].join("\n\n") + "\n";
}

/** The first non-empty line of a body, for the list. */
export function snippetPreview(body: string): string {
  return body.split("\n").map(l => l.trim()).find(Boolean) ?? "";
}

/** Lines of a block at the given brace depth (1 = directly inside a site block). */
function linesAtDepth(lines: string[], target: number, start = 0): string[] {
  const out: string[] = [];
  let depth = start;
  for (const line of lines) {
    const t = line.trim();
    if (depth === target && t && !t.startsWith("#")) out.push(t);
    depth += (t.match(/\{/g) ?? []).length - (t.match(/\}/g) ?? []).length;
  }
  return out;
}

const isSiteBlock = (address: string) => !address.startsWith("(") && !address.startsWith("&(");

/** Address → raw text of each site block in conf.d (with the port fallback keys). */
export function parseConfSiteBlocks(conf: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const block of extractRawBlocksFromCaddyfile(conf)) {
    if (isSiteBlock(block.address)) setBlockResult(result, block, block.raw);
  }
  return result;
}

/** Snippet names imported at the top level of a site block (file and glob imports aren't snippets). */
export function siteBlockImports(raw: string): string[] {
  return linesAtDepth(raw.split("\n").slice(1), 1, 1)
    .map(l => /^import\s+(\S+)\s*$/.exec(l)?.[1])
    .filter((n): n is string => !!n && isValidSnippetName(n));
}

/** Address → snippet imports for every conf.d site block that has any. */
export function parseConfSiteImports(conf: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const block of extractRawBlocksFromCaddyfile(conf)) {
    if (!isSiteBlock(block.address)) continue;
    const imports = siteBlockImports(block.raw);
    if (imports.length) setBlockResult(result, block, imports);
  }
  return result;
}

/** Snippet name → the sites (label, else address) in conf.d that import it. */
export function snippetUsage(conf: string): Record<string, string[]> {
  const usage: Record<string, string[]> = {};
  const labels = parseLabelsFromCaddyfile(conf);
  for (const block of extractRawBlocksFromCaddyfile(conf)) {
    if (!isSiteBlock(block.address)) continue;
    const site = labels[block.address] || block.address;
    for (const name of siteBlockImports(block.raw)) (usage[name] ??= []).push(site);
  }
  return usage;
}

/** Caddyfile directives whose result the site dialogs show as fields. */
const DIRECTIVE_FIELDS: Array<[string[], keyof ProxyEntry]> = [
  [["header"], "responseHeaders"],
  [["basic_auth", "basicauth"], "basicAuth"],
  [["forward_auth"], "forwardAuth"],
  [["encode"], "compress"],
  [["log"], "accessLog"],
  [["request_body"], "requestBodyMaxSize"],
  [["rewrite", "uri"], "rewrite"],
  [["handle_errors"], "errorHandlers"],
];

const directiveName = (line: string) => line.split(/[\s{]/, 1)[0];

/**
 * Caddy's JSON has imported snippets already expanded, so a snippet's headers or auth would read
 * back as the site's own fields and be written into the site block on the next save. A field
 * that an imported snippet sets and the site block itself doesn't is dropped from the entry;
 * when both set headers, only the headers named in the site block stay. `snippetSettings` names
 * the snippets that supplied something, for the note in the dialog.
 */
export function separateSnippetSettings(entry: ProxyEntry, ownBlock: string | undefined, snippets: SnippetDef[]): ProxyEntry {
  if (!entry.imports?.length) return entry;
  const ownLines = ownBlock ? linesAtDepth(ownBlock.split("\n").slice(1), 1, 1).filter(l => !l.startsWith("import ")) : [];
  const ownDirectives = new Set(ownLines.map(directiveName));
  const out: ProxyEntry = { ...entry };
  const from = new Set<string>();
  for (const name of entry.imports) {
    const snippet = snippets.find(s => s.name === name);
    if (!snippet) continue;
    const snippetDirectives = new Set(linesAtDepth(snippet.body.split("\n"), 0).map(directiveName));
    for (const [directives, field] of DIRECTIVE_FIELDS) {
      if (!directives.some(d => snippetDirectives.has(d)) || out[field] === undefined) continue;
      if (!directives.some(d => ownDirectives.has(d))) {
        delete out[field];
        from.add(name);
      } else if (field === "responseHeaders" && out.responseHeaders) {
        const ownText = ownBlock!.toLowerCase();
        const kept = out.responseHeaders.filter(h => ownText.includes(h.name.toLowerCase()));
        if (kept.length !== out.responseHeaders.length) from.add(name);
        if (kept.length) out.responseHeaders = kept;
        else delete out.responseHeaders;
      }
    }
  }
  if (from.size) out.snippetSettings = [...from];
  return out;
}
