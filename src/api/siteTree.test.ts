import { describe, expect, it } from "vitest";
import { surgicallyEditProxy, surgicallyWriteProxy } from "./caddy";
import { addNode, braceDelta, childNodes, countDescendants, editNode, hasNestedBlocks, moveNode, nodeAt, nodeHandlers, parseSiteTree, rawOnlyBlocks, removeNode, rewriteHeader, serializeSiteTree, validateNodeEdit } from "./siteTree";
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


describe("editing the nodes of a tree (#350)", () => {
  const SITE = `example.com {
\t# the app
\t@api path /api/*
\ttls internal
\troute {
\t\t# keep me
\t\theader X-A 1
\t\thandle @api { # api
\t\t\treverse_proxy localhost:9000 {
\t\t\t\theader_up X-B 2
\t\t\t}
\t\t\trespond /ok "fine"
\t\t}
\t\thandle_path /static/* {
\t\t\tfile_server
\t\t}
\t}
\thandle_errors {
\t\trespond "{err.status_code}"
\t}
}`;

  it("changes a matcher and keeps the rest of the header as written", () => {
    expect(rewriteHeader("\t\thandle @api { # api", "/app/*")).toBe("\t\thandle /app/* { # api");
    expect(rewriteHeader("\troute {", "/x")).toBe("\troute /x {");
    expect(rewriteHeader("\t\thandle /a {", "")).toBe("\t\thandle {");
    expect(rewriteHeader("\t\thandle_path /a/* {", "  /b/*  ")).toBe("\t\thandle_path /b/* {");
  });

  it("rewrites only the edited lines, nothing else, and reads back what was written", () => {
    const tree = parseSiteTree(SITE)!;
    const edited = editNode(tree, [0, 0], { matcher: "/app/*", handlers: { 0: "respond /ok \"fine\" 200" } });
    const text = serializeSiteTree(edited);
    const before = SITE.split("\n");
    const after = text.split("\n");
    expect(after).toHaveLength(before.length);
    const changed = before.map((l, i) => [l, after[i]]).filter(([a, b]) => a !== b);
    expect(changed).toEqual([
      ["\t\thandle @api { # api", "\t\thandle /app/* { # api"],
      ['\t\t\trespond /ok "fine"', '\t\t\trespond /ok "fine" 200'],
    ]);
    const back = nodeAt(parseSiteTree(text)!, [0, 0])!;
    expect(back.matcher).toBe("/app/*");
    expect(nodeHandlers(back)).toEqual(['respond /ok "fine" 200']);
  });

  it("edits a node's own directives by their index and leaves comments and blocks in place", () => {
    const tree = parseSiteTree(SITE)!;
    const route = nodeAt(tree, [0])!;
    expect(nodeHandlers(route)).toEqual(["header X-A 1"]);
    const text = serializeSiteTree(editNode(tree, [0], { handlers: { 0: "header X-A 2" } }));
    expect(text).toContain("\t\t# keep me\n\t\theader X-A 2\n");
    expect(text).toContain("\t\t\t\theader_up X-B 2");
    expect(text).toContain("\thandle_errors {");
  });

  it("never touches an opaque node and ignores a path that is not there", () => {
    const tree = parseSiteTree(SITE)!;
    expect(serializeSiteTree(editNode(tree, [1], { matcher: "x", handlers: { 0: "x" } }))).toBe(SITE);
    expect(serializeSiteTree(editNode(tree, [5], { matcher: "x" }))).toBe(SITE);
    expect(serializeSiteTree(editNode(tree, [0, 0, 0], { matcher: "x" }))).toBe(SITE);
  });

  it("refuses an edit that would break the lines around it", () => {
    expect(validateNodeEdit({ matcher: "@a {" })).toBe("matcher");
    expect(validateNodeEdit({ matcher: "/a\n/b" })).toBe("matcher");
    expect(validateNodeEdit({ handlers: { 0: "" } })).toBe("handler");
    expect(validateNodeEdit({ handlers: { 0: "respond ok\nrespond no" } })).toBe("handler");
    expect(validateNodeEdit({ handlers: { 0: "respond {http.request.uri}" } })).toBeUndefined();
    const tree = parseSiteTree(SITE)!;
    expect(serializeSiteTree(editNode(tree, [0], { matcher: "@a {" }))).toBe(SITE);
  });

  it("round-trips an edited tree of every kind", () => {
    const tree = parseSiteTree(SITE)!;
    for (const [path, edit] of [[[0], { matcher: "/r/*" }], [[0, 0], { matcher: "@other" }], [[0, 1], { matcher: "/files/*" }]] as const) {
      const text = serializeSiteTree(editNode(tree, [...path], edit));
      expect(serializeSiteTree(parseSiteTree(text)!)).toBe(text);
      expect(nodeAt(parseSiteTree(text)!, [...path])!.matcher).toBe(edit.matcher);
    }
  });
});


describe("adding, removing and moving nodes (#351)", () => {
  const SITE = `example.com {
\t# first the api
\thandle /api/* {
\t\t# api comment
\t\treverse_proxy localhost:9000 {
\t\t\theader_up X-B 2
\t\t}
\t\thandle /api/v2/* {
\t\t\trespond v2
\t\t}
\t}
\t# then the rest
\thandle {
\t\trespond rest
\t}
\thandle_errors {
\t\trespond "oops"
\t}
}`;

  it("adds a node at the end of the site and of a node, indented like its neighbours", () => {
    const tree = parseSiteTree(SITE)!;
    const top = addNode(tree, [], { kind: "handle", matcher: "/new/*" })!;
    const topText = serializeSiteTree(top.tree);
    expect(topText.endsWith("\thandle_errors {\n\t\trespond \"oops\"\n\t}\n\thandle /new/* {\n\t}\n}")).toBe(true);
    expect(top.path).toEqual([3]);
    expect(nodeAt(top.tree, top.path)!.matcher).toBe("/new/*");
    const nested = addNode(tree, [0], { kind: "route", matcher: "" })!;
    expect(serializeSiteTree(nested.tree)).toContain("\t\thandle /api/v2/* {\n\t\t\trespond v2\n\t\t}\n\t\troute {\n\t\t}\n\t}");
    expect(nested.path).toEqual([0, 2]);
    expect(addNode(tree, [2], { kind: "handle", matcher: "" })).toBeUndefined();
    expect(addNode(tree, [9], { kind: "handle", matcher: "" })).toBeUndefined();
    expect(addNode(tree, [], { kind: "handle", matcher: "@a {" })).toBeUndefined();
  });

  it("uses the indent of a site written with spaces", () => {
    const spaces = "example.com {\n  handle /a {\n    respond ok\n  }\n}";
    const added = addNode(parseSiteTree(spaces)!, [0], { kind: "handle", matcher: "/b" })!;
    expect(serializeSiteTree(added.tree)).toBe("example.com {\n  handle /a {\n    respond ok\n    handle /b {\n    }\n  }\n}");
  });

  it("removes a node with what is inside it and leaves the lines around it", () => {
    const tree = parseSiteTree(SITE)!;
    const text = serializeSiteTree(removeNode(tree, [0]));
    expect(text).not.toContain("/api/*");
    expect(text).not.toContain("api comment");
    expect(text).toContain("\t# first the api\n\t# then the rest\n\thandle {");
    expect(countDescendants(nodeAt(tree, [0])!)).toBe(2);
    expect(countDescendants(nodeAt(tree, [1])!)).toBe(0);
    expect(serializeSiteTree(removeNode(tree, [7]))).toBe(SITE);
    expect(serializeSiteTree(removeNode(tree, []))).toBe(SITE);
    expect(serializeSiteTree(removeNode(tree, [0, 0]))).not.toContain("header_up");
  });

  it("moves a node up and down among its siblings, comments staying where they are", () => {
    const tree = parseSiteTree(SITE)!;
    const down = moveNode(tree, [0], 1)!;
    expect(down.path).toEqual([1]);
    const text = serializeSiteTree(down.tree);
    expect(text.indexOf("handle {")).toBeLessThan(text.indexOf("handle /api/*"));
    expect(text.indexOf("# first the api")).toBeLessThan(text.indexOf("# then the rest"));
    expect(text.split("\n")).toHaveLength(SITE.split("\n").length);
    const back = moveNode(down.tree, down.path, -1)!;
    expect(serializeSiteTree(back.tree)).toBe(SITE);
    expect(moveNode(tree, [0], -1)).toBeUndefined();
    expect(moveNode(tree, [2], 1)).toBeUndefined();
    // an opaque node moves like any other
    const errors = moveNode(tree, [2], -1)!;
    expect(childNodes(errors.tree.items).map(n => n.kind)).toEqual(["handle", "opaque", "handle"]);
    // and inside a node, where the reverse_proxy block is the first sibling
    const inner = moveNode(tree, [0, 0], 1)!;
    expect(inner.path).toEqual([0, 1]);
    expect(serializeSiteTree(inner.tree).indexOf("handle /api/v2/*")).toBeLessThan(serializeSiteTree(inner.tree).indexOf("reverse_proxy localhost:9000"));
  });

  it("names the blocks the tree only shows as written", () => {
    expect(rawOnlyBlocks(SITE)).toEqual(["reverse_proxy localhost:9000 {"]);
    expect(rawOnlyBlocks("example.com {\n\troute {\n\t\trespond ok\n\t}\n\tlog {\n\t\toutput stderr\n\t}\n}")).toEqual([]);
    expect(rawOnlyBlocks("example.com {\n\troute {\n}")).toEqual(["example.com {"]);
  });
});
