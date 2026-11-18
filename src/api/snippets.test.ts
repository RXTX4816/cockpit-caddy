import { describe, it, expect } from "vitest";
import {
  SNIPPETS_HEADER,
  isValidSnippetName,
  parseSnippets,
  snippetsToConf,
  parseConfSiteImports,
  separateSnippetSettings,
  snippetUsage,
  snippetPreview,
} from "./snippets";
import type { ProxyEntry } from "./types";

const entry = (overrides: Partial<ProxyEntry> = {}): ProxyEntry => ({
  id: "x", serverKey: "srv0", externalPort: 8080, targetHost: "localhost", targetPort: 9000,
  targetScheme: "http", tls: false, tlsSkipVerify: false, ...overrides,
});

// #288: snippets edited as raw Caddyfile text and imported into sites.
describe("snippet names", () => {
  it.each(["security-headers", "auth_basic", "a", "v1.2"])("accepts %s", n => expect(isValidSnippetName(n)).toBe(true));
  it.each(["", "two words", "(x)", "a/b", "-lead", "x{", "*"])("rejects %j", n => expect(isValidSnippetName(n)).toBe(false));
});

describe("parseSnippets / snippetsToConf", () => {
  const body = "header {\n\tX-Frame-Options DENY\n\tReferrer-Policy no-referrer\n}";

  it("round-trips snippets through the plugin's file", () => {
    const conf = snippetsToConf([{ name: "security-headers", body }, { name: "auth", body: "basic_auth {\n\tbob $2a$14$hash\n}" }]);
    expect(conf.startsWith(SNIPPETS_HEADER)).toBe(true);
    expect(conf).toContain("(security-headers) {\n\theader {\n\t\tX-Frame-Options DENY\n");
    expect(parseSnippets(conf, "plugin")).toEqual([
      { name: "security-headers", body, source: "plugin" },
      { name: "auth", body: "basic_auth {\n\tbob $2a$14$hash\n}", source: "plugin" },
    ]);
  });

  it("finds hand-written snippets in the main Caddyfile and ignores site blocks, globals and named routes", () => {
    const main = [
      "{",
      "\tadmin off",
      "}",
      "",
      "(common) {",
      "    encode gzip",
      "    header -Server",
      "}",
      "&(route) {",
      "\trespond hi",
      "}",
      ":80 {",
      "\timport common",
      "}",
      "import /etc/caddy/conf.d/*.conf",
    ].join("\n");
    expect(parseSnippets(main, "caddyfile")).toEqual([{ name: "common", body: "encode gzip\nheader -Server", source: "caddyfile" }]);
  });

  it("an empty list writes just the header", () => {
    expect(snippetsToConf([])).toBe(SNIPPETS_HEADER + "\n");
  });

  it("previews the first non-empty line", () => {
    expect(snippetPreview("\n\nheader {\n\tX 1\n}")).toBe("header {");
    expect(snippetPreview("")).toBe("");
  });
});

describe("site imports", () => {
  const conf = [
    "# header",
    "",
    ":8080 {",
    "\timport security-headers",
    "\timport auth",
    "\timport /etc/caddy/other.caddy",
    "\treverse_proxy localhost:9000",
    "}",
    "",
    "app.example.com {",
    "\thandle /x {",
    "\t\timport nested",
    "\t}",
    "\treverse_proxy localhost:9001",
    "}",
  ].join("\n");

  it("reads the snippet imports at the top level of each site block, not file imports or nested ones", () => {
    const map = parseConfSiteImports(conf);
    expect(map[":8080"]).toEqual(["security-headers", "auth"]);
    expect(map["8080"]).toEqual(["security-headers", "auth"]);
    expect(map["app.example.com"]).toBeUndefined();
  });

  it("lists the sites that still import a snippet", () => {
    const usage = snippetUsage("# label: App\n:8080 {\n\timport sec\n}\n\nb.example.com {\n\timport sec\n\timport auth\n}\n\n(sec) {\n\timport auth\n}\n");
    expect(usage).toEqual({ sec: ["App", "b.example.com"], auth: ["b.example.com"] });
  });
});

describe("separateSnippetSettings", () => {
  const snippets = [
    { name: "sec", body: "header {\n\tX-Frame-Options DENY\n}", source: "plugin" as const },
    { name: "auth", body: "basic_auth {\n\tbob hash\n}\nencode gzip", source: "caddyfile" as const },
  ];

  it("leaves a site without imports alone", () => {
    const p = entry({ responseHeaders: [{ op: "set", name: "X-A", value: "1" }] });
    expect(separateSnippetSettings(p, ":8080 {\n\theader X-A 1\n}", snippets)).toEqual(p);
  });

  it("drops settings that only the imported snippet sets, and names the snippet", () => {
    const p = entry({
      imports: ["sec", "auth"],
      responseHeaders: [{ op: "set", name: "X-Frame-Options", value: "DENY" }],
      basicAuth: [{ username: "bob", passwordHash: "hash" }],
      compress: true,
    });
    const own = ":8080 {\n\timport sec\n\timport auth\n\treverse_proxy localhost:9000\n}";
    const out = separateSnippetSettings(p, own, snippets);
    expect(out.responseHeaders).toBeUndefined();
    expect(out.basicAuth).toBeUndefined();
    expect(out.compress).toBeUndefined();
    expect(out.snippetSettings).toEqual(["sec", "auth"]);
  });

  it("keeps the site's own headers when both the site and the snippet set headers", () => {
    const p = entry({
      imports: ["sec"],
      responseHeaders: [{ op: "set", name: "X-Frame-Options", value: "DENY" }, { op: "set", name: "X-B", value: "2" }],
    });
    const own = ":8080 {\n\timport sec\n\theader X-B 2\n\treverse_proxy localhost:9000\n}";
    const out = separateSnippetSettings(p, own, snippets);
    expect(out.responseHeaders).toEqual([{ op: "set", name: "X-B", value: "2" }]);
    expect(out.snippetSettings).toEqual(["sec"]);
  });

  it("an import of a snippet that sets nothing the dialog shows changes nothing", () => {
    const p = entry({ imports: ["other"], compress: true });
    const out = separateSnippetSettings(p, ":8080 {\n\timport other\n\tencode gzip\n}", [{ name: "other", body: "respond /health 200", source: "plugin" }]);
    expect(out).toEqual(p);
  });
});
