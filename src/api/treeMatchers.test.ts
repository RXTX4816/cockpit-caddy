import { describe, it, expect } from "vitest";
import { lineTokens, parseMatcherBlock, siteMatcherDefinition, replaceSiteMatcherDefinition } from "./treeMatchers";
import { buildMatcherCaddyLines } from "./siteBlocks";
import { parseSiteTree, serializeSiteTree } from "./siteTree";
import type { RouteMatch } from "./types";

describe("lineTokens (#350)", () => {
  it("reads words, double quotes with escapes and backticks", () => {
    expect(lineTokens('\theader X-A "a b" `c"d` "e\\"f"')).toEqual(["header", "X-A", "a b", 'c"d', 'e"f']);
  });

  it("refuses a heredoc, a comment and an open quote", () => {
    expect(lineTokens("respond <<END")).toBeUndefined();
    expect(lineTokens("path /a # note")).toBeUndefined();
    expect(lineTokens('header X "open')).toBeUndefined();
  });
});

describe("parseMatcherBlock (#350)", () => {
  const roundTrip = (m: RouteMatch) => parseMatcherBlock(buildMatcherCaddyLines(m, "api", "\t"))?.match;

  it.each<[string, RouteMatch]>([
    ["paths and hosts", { path: ["/api/*", "/v2/*"], host: ["a.example.com"] }],
    ["methods and headers with presence", { method: ["GET", "POST"], header: { "X-A": ["1", "two words"], "X-B": [] } }],
    ["query with presence", { query: { a: ["1", "2"], b: [] } }],
    ["IP ranges and protocol", { remote_ip: { ranges: ["10.0.0.0/8"] }, client_ip: { ranges: ["192.168.0.0/16"] }, protocol: "https" }],
    ["regexps", { path_regexp: { name: "p", pattern: "^/x/(.*)$" }, header_regexp: { header: "Host", pattern: "^www\\." } }],
    ["file and vars", { file: { try_files: ["{path}", "{path}/"], try_policy: "first_exist" }, vars: { "{x}": ["1"] } }],
    ["not and expression", { path: ["/a/*"], not: { path: ["/a/private/*"], method: ["DELETE"] }, expression: "{method} == 'GET'" }],
  ])("reads back what the writer writes: %s", (_n, m) => {
    expect(roundTrip(m)).toEqual(m);
  });

  it("refuses a block the writer would write differently, so it stays as written", () => {
    expect(parseMatcherBlock(["\t@api {", "\t\thost a.example.com", "\t\tpath /api/*", "\t}"])).toBeUndefined();
    expect(parseMatcherBlock(["\t@api {", "\t\tpath /api/*  # mine", "\t}"])).toBeUndefined();
    expect(parseMatcherBlock(["\t@api {", "\t\tunknown_matcher x", "\t}"])).toBeUndefined();
    expect(parseMatcherBlock(["    @api {", "\t\tpath /api/*", "    }"])).toBeUndefined();
  });
});

const SITE = `example.com {
\t# routes
\t@api {
\t\tpath /api/*
\t}
\troute {
\t\thandle @api {
\t\t\treverse_proxy localhost:9000
\t\t}
\t}
}`;

describe("the site's named matcher in the tree (#350)", () => {
  it("finds the definition a node's @name refers to", () => {
    expect(siteMatcherDefinition(parseSiteTree(SITE)!, [1, 0], "api")).toEqual({ path: ["/api/*"] });
  });

  it("offers none when a block around the node defines its own, or the site defines it inline", () => {
    const shadowed = SITE.replace("\troute {\n", "\troute {\n\t\t@api path /other/*\n");
    expect(siteMatcherDefinition(parseSiteTree(shadowed)!, [1, 0], "api")).toBeUndefined();
    const inline = "example.com {\n\t@api path /api/*\n\troute {\n\t\thandle @api {\n\t\t\trespond 1\n\t\t}\n\t}\n}";
    expect(siteMatcherDefinition(parseSiteTree(inline)!, [0, 0], "api")).toBeUndefined();
  });

  it("rewrites only the definition's lines", () => {
    const tree = replaceSiteMatcherDefinition(parseSiteTree(SITE)!, "api", { path: ["/api/*"], method: ["GET"] });
    expect(serializeSiteTree(tree)).toBe(SITE.replace("\t\tpath /api/*\n", "\t\tpath /api/*\n\t\tmethod GET\n"));
  });
});
