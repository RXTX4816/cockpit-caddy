/// <reference types="vite/client" />
// Guards against the gaps behind #244: locales that silently miss keys (or carry English
// copies of them), t() calls pointing at keys en.json doesn't have, and user-visible text
// hard-coded in JSX instead of going through t(). `cockpit-i18n-check` only reports key
// coverage in the README and never fails the build, so none of this was caught before.
import ts from "typescript";
import { describe, it, expect } from "vitest";

type Tree = { [k: string]: string | Tree };

const localeModules = import.meta.glob<Tree>("./locales/*.json", { eager: true, import: "default" });
const locales: Record<string, Tree> = Object.fromEntries(
  Object.entries(localeModules).map(([path, data]) => [path.replace(/^.*\/(.+)\.json$/, "$1"), data]),
);

const sources = import.meta.glob<string>(["../**/*.{ts,tsx}", "!../**/*.test.{ts,tsx}", "!../test/**"], {
  eager: true,
  query: "?raw",
  import: "default",
});

function leaves(tree: Tree, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(tree)) {
    if (typeof v === "string") out.set(prefix + k, v);
    else for (const [kk, vv] of leaves(v, `${prefix}${k}.`)) out.set(kk, vv);
  }
  return out;
}

const en = leaves(locales.en);
const otherLocales = Object.keys(locales).filter(c => c !== "en").sort();

const placeholders = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map(m => m[1]).sort();

/** A value identical to English is fine for short technical labels and names (TLS, Proxy,
 *  "ACME / Let's Encrypt", "/var/www/html", "308 Permanent Redirect"); a phrase of three or
 *  more plain words, at least two of them lowercase, left in English is an untranslated string. */
function isProse(s: string): boolean {
  const words = s.split(/\s+/)
    .map(w => w.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, ""))
    .filter(w => /^[A-Za-z][A-Za-z']+$/.test(w));
  return words.length >= 3 && words.filter(w => /^[a-z]/.test(w)).length >= 2;
}

/** Keys whose English prose stays the same in every locale. Empty so far; add a key here only
 *  when the text is genuinely language-neutral, never to silence a missing translation. */
const SAME_IN_EVERY_LOCALE = new Set<string>([]);

describe("locales", () => {
  it("ships at least one non-English locale", () => {
    expect(otherLocales.length).toBeGreaterThan(0);
  });

  it.each(otherLocales)("%s has exactly the keys of en.json", code => {
    const keys = leaves(locales[code]);
    expect([...en.keys()].filter(k => !keys.has(k)), "missing").toEqual([]);
    expect([...keys.keys()].filter(k => !en.has(k)), "not in en.json").toEqual([]);
  });

  it.each(otherLocales)("%s keeps every {{placeholder}} of en.json", code => {
    const keys = leaves(locales[code]);
    const broken = [...en].filter(([k, v]) => keys.has(k) && placeholders(keys.get(k)!).join() !== placeholders(v).join());
    expect(broken.map(([k]) => k)).toEqual([]);
  });

  it.each(otherLocales)("%s has no English sentences left untranslated", code => {
    const keys = leaves(locales[code]);
    const untranslated = [...en].filter(([k, v]) => keys.get(k) === v && isProse(v) && !SAME_IN_EVERY_LOCALE.has(k));
    expect(untranslated.map(([k]) => k)).toEqual([]);
  });
});

describe("t() usage", () => {
  it("every literal t(\"key\") in src/ exists in en.json", () => {
    const missing: string[] = [];
    for (const [file, src] of Object.entries(sources)) {
      for (const m of src.matchAll(/\bt\(\s*["']([^"']+)["']/g)) {
        if (!en.has(m[1])) missing.push(`${file}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

/** JSX attributes whose string value is shown to the user or read out by a screen reader. */
const TEXT_ATTRIBUTES = new Set(["aria-label", "title", "label", "content", "alt", "titleText", "bodyText", "helperText", "description"]);
/** Literal text that is the same in every language: protocol and product names, symbols. */
const LITERAL_OK = new Set(["http", "https", "HTTP", "TLS", "IP", "CEL", "macOS", "Firefox", "×", "—", "+", "→"]);

function hardCodedText(file: string, src: string): string[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const report = (node: ts.Node, text: string) => {
    const t = text.replace(/\s+/g, " ").trim();
    if (!/[A-Za-z]{2,}/.test(t) || LITERAL_OK.has(t)) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
    found.push(`${file}:${line + 1}: ${JSON.stringify(t)}`);
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) report(node, node.text);
    if (ts.isJsxAttribute(node) && TEXT_ATTRIBUTES.has(node.name.getText(sf)) && node.initializer) {
      const init = node.initializer;
      if (ts.isStringLiteral(init)) report(init, init.text);
      if (ts.isJsxExpression(init) && init.expression) {
        const e = init.expression;
        if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) report(e, e.text);
        if (ts.isTemplateExpression(e)) report(e, [e.head.text, ...e.templateSpans.map(s => s.literal.text)].join(" "));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe("hard-coded UI text", () => {
  it("JSX text and text attributes go through t()", () => {
    const found = Object.entries(sources)
      .filter(([file]) => file.endsWith(".tsx"))
      .flatMap(([file, src]) => hardCodedText(file, src));
    expect(found).toEqual([]);
  });
});
