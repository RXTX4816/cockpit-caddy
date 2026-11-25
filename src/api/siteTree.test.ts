import { describe, expect, it } from "vitest";
import { surgicallyEditProxy, surgicallyWriteProxy } from "./caddy";
import { braceDelta, childNodes, hasNestedBlocks, nodeHandlers, parseSiteTree, serializeSiteTree } from "./siteTree";
import type { ProxyEntry } from "./types";

const FLAT = `example.com {
\thandle /api/* {
\t\treverse_proxy localhost:9000
\t}
\thandle {
\t\treverse_proxy localhost:8000
\t}
}`;

const ROUTE = `example.com {
\troute {
\t\theader X-A 1
\t\treverse_proxy localhost:9000
\t}
}`;

const NESTED = `example.com {
\t# keep this comment
\thandle /app/* {
\t\thandle /app/api/* {
\t\t\treverse_proxy localhost:9000
\t\t}
\t\treverse_proxy localhost:8000
\t}
\tlog
}`;

describe("which sites have route or nested handle blocks (#348)", () => {
  it("counts a route and a handle inside a handle, but not top-level handles", () => {
    expect(hasNestedBlocks(FLAT)).toBe(false);
    expect(hasNestedBlocks(ROUTE)).toBe(true);
    expect(hasNestedBlocks(NESTED)).toBe(true);
    expect(hasNestedBlocks("example.com {\n\treverse_proxy localhost:1\n}")).toBe(false);
    expect(hasNestedBlocks("example.com {\n\thandle_path /x/* {\n\t\troute {\n\t\t\trespond ok\n\t\t}\n\t}\n}")).toBe(true);
  });

  it("is not fooled by braces in placeholders, quotes and comments", () => {
    expect(braceDelta("respond {http.request.uri} 200")).toBe(0);
    expect(braceDelta('respond "{" 200')).toBe(0);
    expect(braceDelta("handle @a { # {")).toBe(1);
    expect(hasNestedBlocks('example.com {\n\theader X-A "route {"\n\trespond "{host}"\n}')).toBe(false);
    expect(hasNestedBlocks("example.com {\n\t# route {\n\thandle {\n\t\trespond ok\n\t}\n}")).toBe(false);
  });
});

const entry = (over: Partial<ProxyEntry> = {}): ProxyEntry => ({
  id: "x", serverKey: "srv0", externalPort: 443, externalHost: "example.com", targetHost: "localhost", targetPort: 9000,
  targetScheme: "http", tls: false, tlsSkipVerify: false, ...over,
});

describe("saving a site with route or nested handle blocks leaves them as written (#348)", () => {
  const conf = (block: string) => `# header\n\n${block}\n`;

  it.each([["a route", ROUTE], ["a nested handle", NESTED]])("keeps %s byte for byte when the form saves", (_name, block) => {
    const written = surgicallyWriteProxy(conf(block), entry({ targetPort: 9999, compress: true, label: undefined }));
    for (const line of block.split("\n").slice(1, -1)) expect(written).toContain(line);
    expect(written.match(/reverse_proxy/g)).toHaveLength(block.match(/reverse_proxy/g)!.length);
    expect(written).not.toContain("9999");
    expect(written).not.toContain("encode");
  });

  it("still applies what the form owns: TLS and the imports", () => {
    const written = surgicallyWriteProxy(conf(ROUTE), entry({ tls: true, tlsIssuer: "internal", externalScheme: "https", imports: ["common"] }));
    expect(written).toContain("tls internal");
    expect(written).toContain("import common");
    expect(written).toContain("\t\treverse_proxy localhost:9000");
  });

  it("moves the blocks to the new address when the site's address changes", () => {
    const written = surgicallyEditProxy(conf(NESTED.replace("example.com {", "https://example.com:443 {")), entry({ externalPort: 443 }), entry({ externalHost: "other.example.com", externalScheme: "https", externalPort: 8443 }));
    expect(written).toContain("other.example.com");
    expect(written).not.toMatch(/^https:\/\/example\.com:443 \{/m);
    expect(written).toContain("handle /app/api/* {");
    expect(written).toContain("# keep this comment");
  });

  it("still regenerates a plain plugin block", () => {
    const plain = `:7700 {\n\treverse_proxy localhost:7701\n}`;
    const written = surgicallyWriteProxy(conf(plain), entry({ externalHost: undefined, externalPort: 7700, targetPort: 9999 }));
    expect(written).toContain("reverse_proxy http://localhost:9999");
    expect(written).not.toContain("7701");
  });
});

describe("the tree of a site (#349)", () => {
  const FULL = `example.com {
\t# the app
\t@api path /api/*
\ttls internal
\troute {
\t\theader X-A 1
\t\thandle @api {
\t\t\treverse_proxy localhost:9000 {
\t\t\t\theader_up X-B 2
\t\t\t}
\t\t}
\t\thandle_path /static/* {
\t\t\tfile_server
\t\t}
\t}
\thandle_errors {
\t\trespond "{err.status_code}"
\t}
}`;

  it("reads route, handle and handle_path into nodes with their matchers and children", () => {
    const tree = parseSiteTree(FULL)!;
    const roots = childNodes(tree.items);
    expect(roots.map(n => [n.kind, n.matcher])).toEqual([["route", ""], ["opaque", ""]]);
    const route = roots[0];
    expect(nodeHandlers(route)).toEqual(["header X-A 1"]);
    const kids = childNodes(route.items);
    expect(kids.map(n => [n.kind, n.matcher])).toEqual([["handle", "@api"], ["handle_path", "/static/*"]]);
    // reverse_proxy { … } is a block the tree does not look into
    expect(childNodes(kids[0].items).map(n => [n.kind, n.header.trim()])).toEqual([["opaque", "reverse_proxy localhost:9000 {"]]);
    expect(nodeHandlers(kids[1])).toEqual(["file_server"]);
  });

  it("shows a flat site as its top-level handle blocks only", () => {
    const tree = parseSiteTree(FLAT)!;
    expect(childNodes(tree.items).map(n => [n.kind, n.matcher])).toEqual([["handle", "/api/*"], ["handle", ""]]);
    expect(childNodes(tree.items).every(n => childNodes(n.items).length === 0)).toBe(true);
  });

  it("puts every line back where it was, byte for byte", () => {
    for (const text of [FULL, FLAT, ROUTE, NESTED, "example.com {\n}", "example.com {\n\n\t# only a comment\n\n}"]) {
      expect(serializeSiteTree(parseSiteTree(text)!)).toBe(text);
    }
  });

  it("keeps a header with a trailing comment and one with the block on its own line as written", () => {
    const text = "example.com {\n\thandle /a/* { # first\n\t\trespond ok\n\t}\n\troute {\n\t\thandle {\n\t\t\trespond \"{}\"\n\t\t}\n\t}\n}";
    const tree = parseSiteTree(text)!;
    expect(childNodes(tree.items).map(n => n.kind)).toEqual(["handle", "route"]);
    expect(serializeSiteTree(tree)).toBe(text);
  });

  it("returns nothing for text whose braces do not balance", () => {
    expect(parseSiteTree("example.com {\n\troute {\n\t\trespond ok\n}")).toBeUndefined();
    expect(parseSiteTree("not a block")).toBeUndefined();
  });
});
