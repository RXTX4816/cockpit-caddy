/**
 * Feeds generated Caddyfiles to a real `caddy adapt` (#208) and parses Caddy's JSON back,
 * the same path a reload takes. Needs a `caddy` binary on PATH (CI installs Caddy 2.11);
 * skipped without one unless CADDY_ADAPT_REQUIRED is set, which turns a missing binary
 * into a failure instead.
 */
/* global process -- declared in src/test/node-shims.d.ts */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONF_HEADER, parseConfAccessLogMap, mergeProxy, buildServerEntry, proxiesToCaddyfile, parseProxies, parseConfExternalAddresses, proxyAddressKeys, resolveInternalIssuerSettings, surgicallyWriteProxy, buildMigratedConfContent, migrateCaddyfile, parseConfTlsIssuerMap, parseConfTlsOnDemandMap, parseConfTlsMap, expandPlaceholderShorthands } from "./caddy";
import { snippetsToConf, parseSnippets, parseConfSiteImports, parseConfSiteBlocks, separateSnippetSettings } from "./snippets";
import { buildEncodeHandler, buildFilterEncoder, buildRedirectHandler, buildRewriteHandler } from "./caddyJsonModel";
import { buildGlobalOptionsPatch } from "./globalOptions";
import { buildMatcherJson } from "./siteBlocks";
import type { CaddyConfig, CaddyServer, ProxyEntry } from "./types";

function hasCaddy(): boolean {
  try {
    execFileSync("caddy", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const required = !!process.env.CADDY_ADAPT_REQUIRED;
const available = hasCaddy();

function adapt(caddyfile: string): CaddyConfig {
  const dir = mkdtempSync(join(tmpdir(), "cockpit-caddy-adapt-"));
  try {
    const file = join(dir, "Caddyfile");
    writeFileSync(file, caddyfile);
    const out = execFileSync("caddy", ["adapt", "--config", file, "--adapter", "caddyfile"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(out) as CaddyConfig;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** parseProxies plus the conf.d host/scheme/issuer fallback useProxies layers on top. */
function readBack(conf: string): ProxyEntry[] {
  const ext = parseConfExternalAddresses(conf);
  const issuers = parseConfTlsIssuerMap(conf);
  const onDemands = parseConfTlsOnDemandMap(conf);
  const confTls = parseConfTlsMap(conf);
  return parseProxies(adapt(conf)).map(p => {
    const found = proxyAddressKeys(p).map(k => ext[k]).find(Boolean);
    const keys = proxyAddressKeys({ ...p, externalHost: p.externalHost ?? found?.host, externalScheme: p.externalScheme ?? found?.scheme });
    const tls = p.tls || keys.some(k => confTls[k]);
    const withHost = { ...p, tls, externalHost: p.externalHost ?? found?.host, externalScheme: p.externalScheme ?? found?.scheme };
    const issuer = proxyAddressKeys(withHost).map(k => issuers[k]).find(Boolean);
    const onDemand = proxyAddressKeys(withHost).some(k => onDemands[k]);
    const withIssuer = issuer && withHost.tls && !withHost.customTls ? { ...withHost, tlsIssuer: issuer } : withHost;
    return onDemand && withIssuer.tls ? { ...withIssuer, tlsOnDemand: true } : withIssuer;
  });
}

const entry = (overrides: Partial<ProxyEntry>): ProxyEntry => ({
  id: "x", serverKey: "srv0", externalPort: 443, targetHost: "localhost", targetPort: 8000,
  targetScheme: "http", tls: true, tlsSkipVerify: false, ...overrides,
});

describe.runIf(available || required)("caddy adapt accepts generated multi-host site blocks (#208)", () => {
  it("has a caddy binary", () => {
    expect(available).toBe(true);
  });

  it("several names next to a single-name site on the same port", () => {
    const conf = proxiesToCaddyfile([
      entry({ externalHost: "example.com, www.example.com", targetPort: 8000 }),
      entry({ externalHost: "other.example.com", targetPort: 9000 }),
    ]);
    const proxies = readBack(conf);
    expect(proxies.map(p => [p.externalHost, p.targetPort]).sort()).toEqual([
      ["example.com, www.example.com", 8000],
      ["other.example.com", 9000],
    ]);
  });

  it("several names with a scheme and their own port, sole occupant of it", () => {
    const conf = proxiesToCaddyfile([
      entry({ externalScheme: "https", externalHost: "a.example.com, b.example.com", externalPort: 8443 }),
    ]);
    const [p] = readBack(conf);
    expect(p.externalPort).toBe(8443);
    expect(p.externalHost).toBe("a.example.com, b.example.com");
    expect(p.externalScheme).toBe("https");
    expect(p.tls).toBe(true);
  });

  it("several names with TLS off", () => {
    const conf = proxiesToCaddyfile([entry({ tls: false, externalHost: "a.example.com, b.example.com", externalPort: 8080 })]);
    const [p] = readBack(conf);
    expect(p.externalHost).toBe("a.example.com, b.example.com");
    expect(p.tls).toBe(false);
  });

  it("several names with a custom internal-issuer lifetime get one automation policy listing both", () => {
    const conf = proxiesToCaddyfile([
      entry({ externalHost: "a.example.com, b.example.com", tlsAdvanced: { certLifetime: "30d" } }),
      entry({ externalHost: "c.example.com", targetPort: 9000 }),
    ]);
    const policies = adapt(conf).apps?.tls?.automation?.policies ?? [];
    expect(policies.find(p => p.subjects?.some(s => s === "a.example.com"))?.subjects).toEqual(["a.example.com", "b.example.com"]);
    const p = readBack(conf).find(x => x.targetPort === 8000)!;
    expect(resolveInternalIssuerSettings(adapt(conf), p.externalHost).certLifetime).toBe("30d");
  });

  it("parse, edit, write: a hand-written portless multi-name block next to another site", () => {
    const conf = `${CONF_HEADER}\n\nexample.com, www.example.com {\n\treverse_proxy localhost:8000\n}\n\nother.example.com {\n\treverse_proxy localhost:9000\n}\n`;
    const p = readBack(conf).find(x => x.targetPort === 8000)!;
    expect(p.externalHost).toBe("example.com, www.example.com");
    const edited = surgicallyWriteProxy(conf, { ...p, targetPort: 8001 });
    const again = readBack(edited);
    expect(again.map(x => [x.externalHost, x.targetPort]).sort()).toEqual([
      ["example.com, www.example.com", 8001],
      ["other.example.com", 9000],
    ]);
    const grown = surgicallyWriteProxy(edited, { ...p, externalHost: "example.com, www.example.com, api.example.com" });
    expect(readBack(grown).map(x => x.externalHost).sort()).toEqual(["example.com, www.example.com, api.example.com", "other.example.com"]);
  });
});

/** The reverse_proxy handlers of a server's first route, wherever subroutes nest them. */
function reverseProxies(server: CaddyServer | undefined): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const walk = (handles: Array<Record<string, unknown>>) => {
    for (const h of handles) {
      if (h.handler === "reverse_proxy") out.push(h);
      for (const r of (h.routes as Array<{ handle?: Array<Record<string, unknown>> }> | undefined) ?? []) walk(r.handle ?? []);
    }
  };
  for (const r of server?.routes ?? []) walk((r.handle ?? []) as Array<Record<string, unknown>>);
  return out;
}

describe.runIf(available || required)("forward_auth instant-apply JSON matches the Caddyfile adapter (#248)", () => {
  const cases: Array<[string, import("./types").ForwardAuthConfig]> = [
    ["https upstream with copy_headers", { upstreamUrl: "https://auth.example.com:9091", uri: "/api/verify?rd=x", copyHeaders: ["Remote-User", "Remote-Groups"] }],
    ["https upstream without a port", { upstreamUrl: "https://auth.example.com", uri: "/", copyHeaders: ["Remote-User"] }],
    ["http upstream without copy_headers or port", { upstreamUrl: "http://auth.local", uri: "/verify", copyHeaders: [] }],
    ["renamed copy_headers, header_up and trusted_proxies (#336)", {
      upstreamUrl: "http://auth.local:9091", uri: "/verify", copyHeaders: ["Remote-User", "Remote-Groups>X-Groups"],
      headerUp: [{ op: "set" as const, name: "X-Extra", value: "1" }, { op: "delete" as const, name: "X-Cookie" }],
      trustedProxies: ["private_ranges", "203.0.113.0/24"],
    }],
    ["only trusted_proxies (#336)", { upstreamUrl: "http://auth.local", uri: "/verify", copyHeaders: [], trustedProxies: ["203.0.113.0/24", "198.51.100.7"] }],
  ];

  it.each(cases)("%s", (_name, forwardAuth) => {
    const p = entry({ tls: false, externalPort: 8080, forwardAuth });
    const adapted = adapt(proxiesToCaddyfile([p]));
    const fromCaddy = reverseProxies(Object.values(adapted.apps?.http?.servers ?? {})[0])[0];
    const pushed = reverseProxies(buildServerEntry(p))[0];
    expect(pushed).toEqual(fromCaddy);
  });

  it("reads forward_auth back from adapted JSON and keeps the real upstream as the target", () => {
    const forwardAuth = { upstreamUrl: "https://auth.example.com:9091", uri: "/api/verify", copyHeaders: ["Remote-Groups", "Remote-User"] };
    const [p] = parseProxies(adapt(proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, targetPort: 8000, forwardAuth })])));
    expect(p.targetHost).toBe("localhost");
    expect(p.targetPort).toBe(8000);
    expect(p.forwardAuth).toEqual(forwardAuth);
  });

  it("reads the renamed headers, header_up and trusted_proxies back (#336)", () => {
    const forwardAuth = {
      upstreamUrl: "http://auth.local:9091", uri: "/verify", copyHeaders: ["Remote-Groups>X-Groups", "Remote-User"],
      headerUp: [{ op: "set" as const, name: "X-Extra", value: "1" }, { op: "delete" as const, name: "X-Cookie" }],
      trustedProxies: ["private_ranges", "203.0.113.0/24"],
    };
    const [p] = parseProxies(adapt(proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, targetPort: 8000, forwardAuth })])));
    expect(p.forwardAuth).toMatchObject({ ...forwardAuth, headerUp: expect.arrayContaining(forwardAuth.headerUp) });
  });
});

describe.runIf(available || required)("route matchers write a Caddyfile Caddy accepts (#250)", () => {
  const matchers = {
    query: { debug: ["true"], flag: [] as string[], tag: ["a", "b"] },
    header: { "X-Foo": [] as string[], "X-Bar": ["baz"] },
  };

  it("query values, query presence and header presence adapt and read back unchanged", () => {
    const conf = proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, matchers })]);
    const [p] = readBack(conf);
    expect(p.matchers).toEqual(matchers);
  });

  it("the instant-apply JSON matcher equals the adapted one", () => {
    const p = entry({ tls: false, externalPort: 8080, matchers });
    const found: Array<Record<string, unknown>> = [];
    JSON.stringify(adapt(proxiesToCaddyfile([p])), (k, v) => {
      if (v && typeof v === "object" && "query" in v && "header" in v) found.push(v);
      return v;
    });
    const pushedMatch = buildServerEntry(p).routes?.[0]?.match?.[0] as Record<string, unknown>;
    expect(found).toHaveLength(1);
    expect({ header: pushedMatch.header, query: pushedMatch.query }).toEqual({ header: found[0].header, query: found[0].query });
  });
});

describe.runIf(available || required)("route matchers with not and expression adapt and read back (#287)", () => {
  const routeMatch = (conf: string) => {
    const found: Array<Record<string, unknown>> = [];
    JSON.stringify(adapt(conf), (k, v) => {
      if (k === "match" && Array.isArray(v)) found.push(...v);
      return v;
    });
    return found.filter(m => !("host" in m && Object.keys(m).length === 1));
  };

  it("exclude only", () => {
    const matchers = { not: { path: ["/api/*"] } };
    const conf = proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, matchers })]);
    expect(routeMatch(conf)).toEqual([{ not: [{ path: ["/api/*"] }] }]);
    expect(readBack(conf)[0].matchers).toEqual(matchers);
  });

  it("include and exclude", () => {
    const matchers = { path: ["/app/*"], not: { path: ["/app/admin/*"], remote_ip: { ranges: ["10.0.0.0/8"] }, header: { "X-Bot": [] as string[] } } };
    const conf = proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, matchers })]);
    expect(routeMatch(conf)).toEqual([{ path: ["/app/*"], not: [{ path: ["/app/admin/*"], remote_ip: { ranges: ["10.0.0.0/8"] }, header: { "X-Bot": ["*"] } }] }]);
    expect(readBack(conf)[0].matchers).toEqual(matchers);
  });

  it.each([
    '{method} == "GET" && {path}.startsWith("/api")',
    "{header.X-Forwarded-Proto} == 'https'",
    'path("/a/*") || {query.debug} == "1"',
    "remote_ip('10.0.0.0/8') && !({uri}.endsWith(`.php`))",
  ])("expression %s", expression => {
    const matchers = { path: ["/api/*"], not: { path: ["/api/v1/*"] }, expression };
    const conf = proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, matchers })]);
    const [adapted] = routeMatch(conf);
    expect(adapted.not).toEqual([{ path: ["/api/v1/*"] }]);
    expect(adapted.expression).toMatchObject({ expr: expandPlaceholderShorthands(expression) });
    expect(readBack(conf)[0].matchers).toEqual(matchers);
  });

  it("the instant-apply JSON matcher equals the adapted one (apart from the matcher name)", () => {
    const p = entry({ tls: false, externalPort: 8080, matchers: { not: { method: ["POST"] }, expression: '{path}.startsWith("/x")' } });
    const [adapted] = routeMatch(proxiesToCaddyfile([p]));
    const pushed = buildServerEntry(p).routes?.[0]?.match?.[0] as Record<string, unknown>;
    expect(pushed).toEqual({ ...adapted, expression: { expr: (adapted.expression as { expr: string }).expr } });
  });

  it("a path-only include with an exclude stays a handle, not handle_path", () => {
    const matchers = { path: ["/api/*"], not: { path: ["/api/private/*"] } };
    const conf = proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, matchers, handlePath: true })]);
    expect(conf).not.toContain("handle_path");
    const [p] = readBack(conf);
    expect(p.matchers).toEqual(matchers);
    expect(p.handlePath).toBeUndefined();
  });
});

describe.runIf(available || required)("strip prefix on several paths (#255)", () => {
  const p = entry({ tls: false, externalPort: 8080, matchers: { path: ["/a/*", "/bb/*"] }, handlePath: true });

  it("caddy adapt accepts it and it reads back as handle_path, not a regex rewrite", () => {
    const [back] = readBack(proxiesToCaddyfile([p]));
    expect(back.matchers).toEqual({ path: ["/a/*", "/bb/*"] });
    expect(back.handlePath).toBe(true);
    expect(back.rewrite).toBeUndefined();
  });

  it("the instant-apply JSON strips the same way as the adapted Caddyfile", () => {
    const rewriteOf = (v: unknown): unknown => {
      if (!v || typeof v !== "object") return undefined;
      if ((v as { handler?: string }).handler === "rewrite") return v;
      for (const child of Object.values(v)) {
        const found = rewriteOf(child);
        if (found) return found;
      }
      return undefined;
    };
    const pushed = buildServerEntry(p);
    expect(rewriteOf(pushed)).toEqual(rewriteOf(adapt(proxiesToCaddyfile([p]))));
    expect(rewriteOf(pushed)).toMatchObject({ path_regexp: [{ find: "^(?:/bb|/a)/?", replace: "/" }] });
    const [back] = parseProxies({ apps: { http: { servers: { srv0: pushed } } } });
    expect(back.handlePath).toBe(true);
    expect(back.rewrite).toBeUndefined();
  });

  it("a single path still writes handle_path", () => {
    const single = entry({ tls: false, externalPort: 8080, matchers: { path: ["/a/*"] }, handlePath: true });
    const conf = proxiesToCaddyfile([single]);
    expect(conf).toContain("handle_path /a/* {");
    expect(readBack(conf)[0].handlePath).toBe(true);
  });
});

describe.runIf(available || required)("proxy error handlers replacing upstream error pages (#255)", () => {
  const rpOf = (servers: Record<string, CaddyServer> | undefined) => {
    const find = (v: unknown): Record<string, unknown> | undefined => {
      if (!v || typeof v !== "object") return undefined;
      if ((v as { handler?: string }).handler === "reverse_proxy") return v as Record<string, unknown>;
      for (const child of Object.values(v)) {
        const found = find(child);
        if (found) return found;
      }
      return undefined;
    };
    return find(servers);
  };
  const p = entry({
    tls: false, externalPort: 8080, replaceUpstreamErrors: true,
    errorHandlers: [{ matchType: "4xx", type: "respond", body: "oops" }, { matchType: "specific", codes: [502], type: "respond", body: "bad" }],
  });

  it("the Caddyfile reads back with the switch on, and the pushed JSON matches the adapted one", () => {
    const conf = proxiesToCaddyfile([p]);
    const adapted = adapt(conf);
    expect(readBack(conf)[0].replaceUpstreamErrors).toBe(true);
    expect(buildServerEntry(p).routes?.[0]?.handle?.find(h => h.handler === "reverse_proxy")?.handle_response)
      .toEqual(rpOf(adapted.apps?.http?.servers)?.handle_response);
  });

  it("without the switch nothing is intercepted and it reads back off", () => {
    const off = { ...p, replaceUpstreamErrors: undefined };
    const conf = proxiesToCaddyfile([off]);
    expect(rpOf(adapt(conf).apps?.http?.servers)?.handle_response).toBeUndefined();
    expect(readBack(conf)[0].replaceUpstreamErrors).toBeUndefined();
  });

  it("an existing exact-code config opens with the switch on and saves byte-identical", () => {
    const exact = entry({ tls: false, externalPort: 8080, errorHandlers: [{ matchType: "specific", codes: [404], type: "respond", body: "nf", statusCode: 404 }] });
    // What the plugin wrote before #255: the interception was always on.
    const before = proxiesToCaddyfile([{ ...exact, replaceUpstreamErrors: true }]);
    expect(before).toContain("error 404");
    const [back] = readBack(before);
    expect(back.replaceUpstreamErrors).toBe(true);
    expect(proxiesToCaddyfile([{ ...exact, ...back, id: exact.id, serverKey: exact.serverKey }])).toBe(before);
  });
});

describe.runIf(available || required)("snippets imported into sites (#288)", () => {
  const snippetsConf = snippetsToConf([{ name: "security-headers", body: "header {\n\tX-Frame-Options DENY\n\tReferrer-Policy no-referrer\n}" }]);
  // conf.d/*.conf is read in name order, so the snippets file comes first.
  const withSnippets = (conf: string) => snippetsConf + "\n" + conf;
  const sites = [
    entry({ tls: false, externalPort: 8080, imports: ["security-headers"] }),
    entry({ tls: false, externalPort: 8081, targetPort: 9001, imports: ["security-headers"], responseHeaders: [{ op: "set", name: "X-Own", value: "1" }] }),
  ];

  /** readBack plus the snippet layer useProxies adds. */
  function readBackWithSnippets(conf: string): ProxyEntry[] {
    const imports = parseConfSiteImports(conf);
    const blocks = parseConfSiteBlocks(conf);
    const snippets = parseSnippets(snippetsConf, "plugin");
    return readBack(withSnippets(conf)).map(p => {
      const key = proxyAddressKeys(p).find(k => imports[k]);
      const withImports = key ? { ...p, imports: imports[key] } : p;
      return separateSnippetSettings(withImports, key ? blocks[key] : undefined, snippets);
    });
  }

  it("defines the snippet once, imports it in both sites, and Caddy applies it", () => {
    const conf = proxiesToCaddyfile(sites);
    expect(conf.match(/import security-headers/g)).toHaveLength(2);
    expect(conf).not.toContain("X-Frame-Options");
    const json = JSON.stringify(adapt(withSnippets(conf)));
    expect(json.match(/X-Frame-Options/g)).toHaveLength(2);
  });

  it("reopening and saving a site doesn't copy the snippet's headers into it", () => {
    const conf = proxiesToCaddyfile(sites);
    const read = readBackWithSnippets(conf);
    const plain = read.find(p => p.externalPort === 8080)!;
    const own = read.find(p => p.externalPort === 8081)!;
    expect(plain.imports).toEqual(["security-headers"]);
    expect(plain.responseHeaders).toBeUndefined();
    expect(plain.snippetSettings).toEqual(["security-headers"]);
    expect(own.responseHeaders).toEqual([{ op: "set", name: "X-Own", value: "1" }]);

    const saved = surgicallyWriteProxy(surgicallyWriteProxy(conf, plain), own);
    expect(saved).not.toContain("X-Frame-Options");
    expect(saved.match(/import security-headers/g)).toHaveLength(2);
    expect(readBackWithSnippets(saved).map(p => [p.externalPort, p.responseHeaders])).toEqual([
      [8080, undefined],
      [8081, [{ op: "set", name: "X-Own", value: "1" }]],
    ]);
  });

  it("an import of an unknown snippet is rejected by Caddy", () => {
    expect(() => adapt(proxiesToCaddyfile([entry({ tls: false, externalPort: 8082, imports: ["missing"] })]))).toThrow();
  });
});

describe.runIf(available || required)("user values are quoted so Caddy reads them back verbatim (#251)", () => {
  // Header values can't contain newlines; everything else must survive the Caddyfile lexer.
  const headerValues = ["plain", "two words", 'say "hi"', "{http.vars.who} extra", "C:\\dir\\", "back\\\"slash quote", "a`b c", "#notacomment"];
  // Caddy ends a heredoc wherever the marker appears, even mid-line ("BACKEND", "APPEND").
  const bodies = [...headerValues, "line1\nline2 \"quoted\"\n\tindented", "END\nEND", "the BACKEND is down\nAPPEND END1 here"];

  it.each(headerValues)("request and response header value %j", value => {
    const headers = [{ op: "set" as const, name: "X-Set", value }, { op: "add" as const, name: "X-Add", value }];
    const [p] = readBack(proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, requestHeaders: headers, responseHeaders: headers })]));
    expect(p.requestHeaders).toEqual(expect.arrayContaining(headers));
    expect(p.responseHeaders).toEqual(expect.arrayContaining(headers));
  });

  it.each(bodies)("respond body %j", body => {
    const [p] = readBack(proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, staticResponse: { statusCode: 200, body } })]));
    expect(p.staticResponse?.body).toBe(body);
    expect(p.staticResponse?.statusCode).toBe(200);
  });

  it.each(bodies)("respond body %j with close", body => {
    const [p] = readBack(proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, staticResponse: { statusCode: 403, body, close: true } })]));
    expect(p.staticResponse).toEqual({ statusCode: 403, body, close: true });
  });

  it.each(bodies)("error handler respond body %j", body => {
    const errorHandlers = [{ matchType: "all" as const, type: "respond" as const, body, statusCode: 500 }];
    const adapted = JSON.stringify(adapt(proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, errorHandlers })])));
    expect(adapted).toContain(JSON.stringify(body));
  });

  it.each(headerValues)("php_fastcgi env value %j", value => {
    const phpFastcgi = { upstream: "localhost:9000", root: "/srv/php", env: { APP_NAME: value } };
    const [p] = readBack(proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, phpFastcgi })]));
    expect(p.phpFastcgi?.env).toEqual({ APP_NAME: value });
  });

  it("a static site root with a space", () => {
    const [p] = readBack(proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, fileServer: { root: "/srv/my site" } })]));
    expect(p.fileServer?.root).toBe("/srv/my site");
  });

  it("route matcher header value with a space", () => {
    const matchers = { header: { "X-Agent": ["Some Bot"] } };
    const [p] = readBack(proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, matchers })]));
    expect(p.matchers).toEqual(matchers);
  });

  it("quoted values survive parse → edit → write next to another site", () => {
    const headers = [{ op: "set" as const, name: "X-Set", value: 'say "hi" {http.vars.who}' }];
    const body = "a\n{b}\nc";
    const conf = proxiesToCaddyfile([
      entry({ tls: false, externalPort: 8080, responseHeaders: headers }),
      entry({ tls: false, externalPort: 8081, targetPort: 9000 }),
      entry({ tls: false, externalPort: 8082, staticResponse: { statusCode: 200, body } }),
    ]);
    const first = readBack(conf);
    let edited = surgicallyWriteProxy(conf, { ...first.find(x => x.externalPort === 8080)!, targetPort: 8001 });
    edited = surgicallyWriteProxy(edited, { ...first.find(x => x.externalPort === 8082)!, staticResponse: { statusCode: 201, body } });
    const again = readBack(edited);
    expect(again.find(x => x.externalPort === 8080)).toMatchObject({ targetPort: 8001, responseHeaders: headers });
    expect(again.find(x => x.externalPort === 8081)?.targetPort).toBe(9000);
    expect(again.find(x => x.externalPort === 8082)?.staticResponse).toEqual({ statusCode: 201, body });
  });
});

describe.runIf(available || required)("PHP sites serve static files too (#247)", () => {
  const php = { upstream: "localhost:9000", root: "/srv/php" };

  function handlers(conf: string): string[] {
    const out: string[] = [];
    JSON.stringify(adapt(conf), (k, v) => {
      if (k === "handler") out.push(v as string);
      return v;
    });
    return out;
  }

  it.each([
    ["hostless", {}],
    ["with a hostname", { externalHost: "php.example.com", tls: true, externalPort: 443 }],
  ])("a new PHP site (%s) gets file_server and still reads back as PHP", (_n, extra) => {
    const conf = proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, phpFastcgi: php, ...extra })]);
    expect(conf).toMatch(/php_fastcgi localhost:9000\n\tfile_server\n/);
    expect(handlers(conf)).toContain("file_server");
    const [p] = readBack(conf);
    expect(p.phpFastcgi).toEqual(php);
    expect(p.fileServer).toBeUndefined();
  });

  it("a PHP root with a space reads back verbatim", () => {
    const [p] = readBack(proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, phpFastcgi: { ...php, root: "/srv/my app" } })]));
    expect(p.phpFastcgi?.root).toBe("/srv/my app");
  });

  it.each([
    ["without file_server", ""],
    ["with file_server", "\tfile_server\n"],
  ])("editing a hand-written PHP site %s keeps it a PHP site with one file_server", (_n, fs) => {
    const conf = `${CONF_HEADER}\n\nphp.example.com {\n\troot * /srv/php\n\tphp_fastcgi localhost:9000\n${fs}}\n\nother.example.com {\n\treverse_proxy localhost:9000\n}\n`;
    const p = readBack(conf).find(x => x.phpFastcgi)!;
    expect(p.phpFastcgi).toEqual(php);
    const edited = surgicallyWriteProxy(conf, { ...p, phpFastcgi: { ...php, index: "app.php" } });
    const block = edited.slice(edited.indexOf("php.example.com {"), edited.indexOf("other.example.com"));
    expect(block).not.toContain("reverse_proxy");
    expect(block.match(/file_server/g)).toHaveLength(1);
    const again = readBack(edited);
    expect(again.find(x => x.externalHost === "php.example.com")?.phpFastcgi).toEqual({ ...php, index: "app.php" });
    expect(again.find(x => x.externalHost === "other.example.com")?.targetPort).toBe(9000);
  });
});

describe.runIf(available || required)("passive and active health checks (#252)", () => {
  const twoUpstreams = { extraUpstreams: [{ host: "localhost", port: 8001 }] };
  const lbRetry = {
    retries: 2, failDuration: "30s", maxFails: 3, unhealthyStatus: [500, 503],
    healthUri: "/healthz", healthInterval: "10s", healthTimeout: "2s", healthStatus: "2xx",
  };

  function adaptedRp(conf: string): Record<string, unknown> {
    let rp: Record<string, unknown> | undefined;
    JSON.stringify(adapt(conf), (k, v) => {
      if (v && typeof v === "object" && (v as { handler?: string }).handler === "reverse_proxy") rp = v;
      return v;
    });
    return rp!;
  }

  it("reads every health-check field back after a reload", () => {
    const [p] = readBack(proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, ...twoUpstreams, lbRetry })]));
    expect(p.lbRetry).toEqual(lbRetry);
  });

  it("an exact expected status reads back as written", () => {
    const cfg = { healthUri: "/h", healthStatus: "204" };
    const [p] = readBack(proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, lbRetry: cfg })]));
    expect(p.lbRetry).toEqual(cfg);
  });

  it("the instant-apply JSON health_checks equal the adapted ones (durations aside)", () => {
    const p = entry({ tls: false, externalPort: 8080, ...twoUpstreams, lbRetry });
    const fromCaddy = adaptedRp(proxiesToCaddyfile([p])).health_checks as Record<string, Record<string, unknown>>;
    const pushed = (buildServerEntry(p).routes?.[0]?.handle?.find(h => h.handler === "reverse_proxy") as Record<string, unknown>)
      .health_checks as Record<string, Record<string, unknown>>;
    const ns = (d: unknown) => (typeof d === "string" ? parseInt(d, 10) * 1e9 : d);
    expect({ ...pushed.passive, fail_duration: ns(pushed.passive.fail_duration) }).toEqual(fromCaddy.passive);
    expect({ ...pushed.active, interval: ns(pushed.active.interval), timeout: ns(pushed.active.timeout) }).toEqual(fromCaddy.active);
  });

  it("unhealthy_status is not written without fail_duration, where Caddy would ignore it", () => {
    const conf = proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, lbRetry: { unhealthyStatus: [500] } })]);
    expect(conf).not.toContain("unhealthy_status");
    expect(adaptedRp(conf).health_checks).toBeUndefined();
  });
});

describe.runIf(available || required)("instant-apply JSON and the saved Caddyfile agree (#254)", () => {
  function firstServer(conf: string) {
    return Object.values(adapt(conf).apps?.http?.servers ?? {})[0];
  }
  function findHandler(handles: unknown, name: string): Record<string, unknown> | undefined {
    let found: Record<string, unknown> | undefined;
    JSON.stringify(handles, (k, v) => {
      if (!found && v && typeof v === "object" && (v as { handler?: string }).handler === name) found = v;
      return v;
    });
    return found;
  }

  it.each(["127.0.0.1", "[::1]"])("an IP in the host field binds that IP after a reload too (%s)", ip => {
    const p = entry({ tls: false, externalPort: 8443, externalHost: ip });
    const conf = proxiesToCaddyfile([p]);
    expect(firstServer(conf)?.listen).toEqual(buildServerEntry(p).listen);
    expect(readBack(conf)[0].externalHost).toBe(ip);
  });

  it("a hostname still listens on every interface", () => {
    const p = entry({ tls: false, externalPort: 8443, externalHost: "app.example.com" });
    expect(proxiesToCaddyfile([p])).not.toContain("bind");
    expect(firstServer(proxiesToCaddyfile([p]))?.listen).toEqual([":8443"]);
  });

  it("editing a hand-written IP site adds the bind once and keeps an existing one", () => {
    const conf = `${CONF_HEADER}\n\nhttp://127.0.0.1:8443 {\n\treverse_proxy localhost:8000\n}\n`;
    const p = readBack(conf)[0];
    const edited = surgicallyWriteProxy(conf, { ...p, targetPort: 8001 });
    expect(edited.match(/\bbind\b/g)).toHaveLength(1);
    expect(firstServer(edited)?.listen).toEqual(["127.0.0.1:8443"]);
    const again = surgicallyWriteProxy(edited, { ...readBack(edited)[0], targetPort: 8002 });
    expect(again.match(/\bbind\b/g)).toHaveLength(1);
  });

  it("changing an IP host to a hostname drops the bind the plugin added", () => {
    const conf = `${CONF_HEADER}\n\n10.0.0.5 {\n\treverse_proxy localhost:8000\n}\n`;
    const once = surgicallyWriteProxy(conf, { ...readBack(conf)[0], tls: true, targetPort: 8001 });
    expect(once).toContain("10.0.0.5 {\n\tbind 10.0.0.5");
    const p = readBack(once)[0];
    const renamed = surgicallyWriteProxy(once, { ...p, tls: true, externalHost: "10.0.0.5, app.example.com" });
    expect(renamed).not.toMatch(/\bbind\b/);
    expect(firstServer(renamed)?.listen).toEqual([":443"]);
  });

  it("a hand-written bind on a hostname site is kept", () => {
    const conf = `${CONF_HEADER}\n\nhttp://app.example.com:8443 {\n\tbind 10.0.0.9\n\treverse_proxy localhost:8000\n}\n`;
    const edited = surgicallyWriteProxy(conf, { ...readBack(conf)[0], targetPort: 8001 });
    expect(edited).toContain("\tbind 10.0.0.9");
  });

  it.each([
    ["substring with a backreference", { type: "regex" as const, find: "^/old/(.*)$", replace: "/new/$1" }],
    ["plain substring", { type: "regex" as const, find: "old", replace: "new" }],
    ["empty replacement", { type: "regex" as const, find: "^/v1", replace: "" }],
    ["spaces and quotes", { type: "regex" as const, find: "a b", replace: 'c "d"' }],
  ])("a regex rewrite (%s) is the same handler in both", (_n, rewrite) => {
    const p = entry({ tls: false, externalPort: 8080, rewrite });
    const conf = proxiesToCaddyfile([p]);
    const fromCaddy = findHandler(firstServer(conf)?.routes, "rewrite");
    const pushed = findHandler(buildServerEntry(p).routes, "rewrite");
    expect(pushed).toEqual(fromCaddy);
    expect(readBack(conf)[0].rewrite).toEqual(rewrite);
  });
});

describe.runIf(available || required)("migration output loads in Caddy (#267)", () => {
  it("a migrated site still finds the snippet that stayed in the main Caddyfile", () => {
    const original = "(common) {\n\theader X-Common yes\n}\n\n:8080 {\n\timport common\n\trespond \"hi\"\n}\n\nimport /etc/caddy/conf.d/*\n";
    const { blocks, caddyfile } = migrateCaddyfile(original);
    const dir = mkdtempSync(join(tmpdir(), "cockpit-caddy-migrate-"));
    try {
      mkdirSync(join(dir, "conf.d"));
      writeFileSync(join(dir, "conf.d", "cockpit-caddy.conf"), buildMigratedConfContent(blocks));
      writeFileSync(join(dir, "Caddyfile"), caddyfile.replace("/etc/caddy/conf.d/", `${dir}/conf.d/`));
      const out = execFileSync("caddy", ["adapt", "--config", join(dir, "Caddyfile"), "--adapter", "caddyfile"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      expect(out).toContain("X-Common");
      expect(out).toContain(":8080");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.runIf(available || required)("TLS issuer: automatic ACME or the internal CA (#246)", () => {
  const site = (o: Partial<ProxyEntry>) => entry({ externalHost: "app.example.com", ...o });
  const internalPolicyFor = (conf: string, host: string) =>
    (adapt(conf).apps?.tls?.automation?.policies ?? []).some(p => p.subjects?.includes(host) && p.issuers?.some(i => i.module === "internal"));

  it("ACME writes no tls line and reads back as ACME", () => {
    const conf = proxiesToCaddyfile([site({ tlsIssuer: "acme" })]);
    expect(conf).not.toMatch(/\btls\b/);
    expect(internalPolicyFor(conf, "app.example.com")).toBe(false);
    expect(readBack(conf)[0]).toMatchObject({ tls: true, tlsIssuer: "acme" });
  });

  it("the internal CA writes tls internal and reads back as internal", () => {
    const conf = proxiesToCaddyfile([site({ tlsIssuer: "internal" })]);
    expect(conf).toContain("tls internal");
    expect(internalPolicyFor(conf, "app.example.com")).toBe(true);
    expect(readBack(conf)[0]).toMatchObject({ tls: true, tlsIssuer: "internal" });
  });

  it("no issuer given stays the internal CA, as before", () => {
    expect(proxiesToCaddyfile([site({})])).toContain("tls internal");
  });

  it("ACME with protocol settings writes a tls block without an issuer", () => {
    const conf = proxiesToCaddyfile([site({ tlsIssuer: "acme", tlsAdvanced: { protocolMin: "tls1.3" } })]);
    expect(conf).toContain("\ttls {\n\t\tprotocols tls1.3\n\t}");
    expect(conf).not.toContain("issuer");
    expect(readBack(conf)[0]).toMatchObject({ tlsIssuer: "acme" });
  });

  it("a hostless site can't use ACME and falls back to the internal CA", () => {
    expect(proxiesToCaddyfile([entry({ tlsIssuer: "acme" })])).toContain("tls internal");
  });

  it.each([
    ["a hand-written bare hostname", "app.example.com {\n\treverse_proxy localhost:8000\n}"],
    ["a plugin-format host:443 header", "app.example.com:443 {\n\treverse_proxy localhost:8000\n}"],
  ])("editing %s that relies on automatic HTTPS keeps it ACME", (_n, block) => {
    const conf = `${CONF_HEADER}\n\n${block}\n`;
    const p = readBack(conf)[0];
    expect(p).toMatchObject({ tls: true, tlsIssuer: "acme" });
    const edited = surgicallyWriteProxy(conf, { ...p, targetPort: 8001 });
    expect(edited).not.toMatch(/\btls\b/);
    expect(internalPolicyFor(edited, "app.example.com")).toBe(false);
    expect(readBack(edited)[0]).toMatchObject({ tlsIssuer: "acme", targetPort: 8001 });
  });

  it("a hand-written tls internal on a public name reads back as internal", () => {
    const conf = `${CONF_HEADER}\n\napp.example.com {\n\ttls internal\n\treverse_proxy localhost:8000\n}\n`;
    expect(readBack(conf)[0]).toMatchObject({ tlsIssuer: "internal" });
  });
});

describe.runIf(available || required)("per-site on-demand TLS (#253)", () => {
  const onDemandPolicy = (conf: string) => (adapt(conf).apps?.tls?.automation?.policies ?? []).find(p => (p as { on_demand?: boolean }).on_demand);

  it("an ACME site with on-demand writes tls { on_demand } and reads it back", () => {
    const conf = proxiesToCaddyfile([entry({ externalHost: "app.example.com", tlsIssuer: "acme", tlsOnDemand: true })]);
    expect(conf).toContain("\ttls {\n\t\ton_demand\n\t}");
    expect(onDemandPolicy(conf)?.subjects).toEqual(["app.example.com"]);
    expect(readBack(conf)[0]).toMatchObject({ tlsIssuer: "acme", tlsOnDemand: true });
  });

  it("an internal-CA site with on-demand keeps the internal issuer", () => {
    const conf = proxiesToCaddyfile([entry({ externalHost: "app.example.com", tlsIssuer: "internal", tlsOnDemand: true })]);
    expect(conf).toContain("\ttls {\n\t\tissuer internal\n\t\ton_demand\n\t}");
    expect(onDemandPolicy(conf)?.issuers?.[0]?.module).toBe("internal");
    expect(readBack(conf)[0]).toMatchObject({ tlsIssuer: "internal", tlsOnDemand: true });
  });

  it("a hostless internal-CA site can use on-demand too", () => {
    const conf = proxiesToCaddyfile([entry({ tlsOnDemand: true })]);
    expect(onDemandPolicy(conf)).toBeDefined();
    expect(readBack(conf)[0]).toMatchObject({ tls: true, tlsOnDemand: true });
  });

  it("on-demand is dropped with TLS off", () => {
    expect(proxiesToCaddyfile([entry({ tls: false, tlsOnDemand: true })])).not.toContain("on_demand");
  });

  it("editing a hand-written on-demand site keeps on_demand", () => {
    const conf = `${CONF_HEADER}\n\napp.example.com {\n\ttls {\n\t\ton_demand\n\t}\n\treverse_proxy localhost:8000\n}\n`;
    const p = readBack(conf)[0];
    expect(p).toMatchObject({ tlsIssuer: "acme", tlsOnDemand: true });
    const edited = surgicallyWriteProxy(conf, { ...p, targetPort: 8001 });
    expect(readBack(edited)[0]).toMatchObject({ tlsIssuer: "acme", tlsOnDemand: true, targetPort: 8001 });
  });
});

describe.runIf(available || required)("static and PHP site options round-trip through caddy adapt (#262)", () => {
  const sites: [string, Partial<ProxyEntry>][] = [
    ["hostless", { tls: false, externalPort: 8080 }],
    ["host-matched", { tls: false, externalPort: 8080, externalHost: "static.example.test", externalScheme: "http" }],
  ];

  it.each(sites)("SPA mode (%s)", (_, site) => {
    const conf = proxiesToCaddyfile([entry({ ...site, fileServer: { root: "/srv/app", spa: true } })]);
    expect(conf).toContain("\ttry_files {path} /index.html\n");
    const [p] = readBack(conf);
    expect(p.fileServer).toEqual({ root: "/srv/app", browse: false, spa: true });
  });

  it.each(sites)("index, hide and precompressed (%s)", (_, site) => {
    const fileServer = { root: "/srv/app", browse: true, index: ["index.html", "default.htm"], hide: [".git", "*.bak"], precompressed: ["zstd", "br", "gzip"] };
    const conf = proxiesToCaddyfile([entry({ ...site, fileServer })]);
    expect(conf).toContain("\tfile_server browse {\n\t\tindex index.html default.htm\n\t\thide .git *.bak\n\t\tprecompressed zstd br gzip\n\t}");
    const [p] = readBack(conf);
    expect(p.fileServer).toEqual(fileServer);
  });

  it.each(sites)("each option on its own (%s)", (_, site) => {
    for (const extra of [{ index: ["home.html"] }, { hide: ["secret"] }, { precompressed: ["gzip"] }]) {
      const fileServer = { root: "/srv/app", browse: false, ...extra };
      const [p] = readBack(proxiesToCaddyfile([entry({ ...site, fileServer })]));
      expect(p.fileServer).toEqual(fileServer);
    }
  });

  it.each(sites)("PHP try_files (%s)", (_, site) => {
    const phpFastcgi = { upstream: "localhost:9000", root: "/srv/php", tryFiles: "{path} {path}/ /index.php?{query}" };
    const conf = proxiesToCaddyfile([entry({ ...site, phpFastcgi })]);
    expect(conf).toContain("\ttry_files {path} {path}/ /index.php?{query}\n");
    const [p] = readBack(conf);
    expect(p.phpFastcgi).toEqual(phpFastcgi);
  });

  it("PHP try_files keeps a custom index", () => {
    const phpFastcgi = { upstream: "localhost:9000", root: "/srv/php", index: "app.php", tryFiles: "{path} /app.php" };
    const [p] = readBack(proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, phpFastcgi })]));
    expect(p.phpFastcgi).toEqual(phpFastcgi);
  });

  it("the plugin's own JSON push carries the same options", () => {
    const fileServer = { root: "/srv/app", browse: false, spa: true, index: ["a.html"], hide: [".env"], precompressed: ["br", "gzip"] };
    const pushed = buildServerEntry(entry({ tls: false, externalPort: 8080, fileServer }));
    const [back] = parseProxies({ apps: { http: { servers: { srv0: pushed } } } });
    expect(back.fileServer).toEqual(fileServer);
    const adaptedFs = JSON.stringify(adapt(proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, fileServer })])));
    expect(adaptedFs).toContain('"index_names":["a.html"]');
    expect(adaptedFs).toContain('"precompressed_order":["br","gzip"]');
  });

  it("sites without the new options write the same lines as before", () => {
    expect(proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, fileServer: { root: "/srv/app", browse: true } })]))
      .toContain("\troot * /srv/app\n\tfile_server browse\n}");
    expect(proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, phpFastcgi: { upstream: "localhost:9000", root: "/srv/php" } })]))
      .toContain("\troot * /srv/php\n\tphp_fastcgi localhost:9000\n\tfile_server\n}");
  });
});

describe.runIf(available || required)("every load-balancing policy round-trips (#285)", () => {
  const extraUpstreams = [{ host: "localhost", port: 8001 }];
  const cases: [string, Partial<ProxyEntry>, string][] = [
    ["ip_hash", { lbPolicy: "ip_hash" }, "lb_policy ip_hash"],
    ["client_ip_hash", { lbPolicy: "client_ip_hash" }, "lb_policy client_ip_hash"],
    ["uri_hash", { lbPolicy: "uri_hash" }, "lb_policy uri_hash"],
    ["header", { lbPolicy: "header", lbPolicyArgs: { headerField: "X-User" } }, "lb_policy header X-User"],
    ["cookie, defaults", { lbPolicy: "cookie" }, "lb_policy cookie\n"],
    ["cookie, name", { lbPolicy: "cookie", lbPolicyArgs: { cookieName: "sid" } }, "lb_policy cookie sid\n"],
    ["cookie, name and secret", { lbPolicy: "cookie", lbPolicyArgs: { cookieName: "sid", cookieSecret: "s3cr3t" } }, "lb_policy cookie sid s3cr3t"],
    ["weighted_round_robin", { lbPolicy: "weighted_round_robin", lbPolicyArgs: { weights: [3, 1] } }, "lb_policy weighted_round_robin 3 1"],
    ["random_choose", { lbPolicy: "random_choose", lbPolicyArgs: { chooseCount: 3 } }, "lb_policy random_choose 3"],
  ];

  it.each(cases)("%s", (_, policy, line) => {
    const p = entry({ tls: false, externalPort: 8080, extraUpstreams, ...policy });
    const conf = proxiesToCaddyfile([p]);
    expect(conf).toContain(`\t\t${line}`);
    const [back] = readBack(conf);
    expect(back.lbPolicy).toBe(policy.lbPolicy);
    expect(back.lbPolicyArgs).toEqual(policy.lbPolicyArgs);
    // The plugin's own JSON push is what Caddy adapts the line to.
    const adapted = adapt(conf).apps?.http?.servers;
    const adaptedLb = JSON.stringify(Object.values(adapted ?? {})[0]).match(/"load_balancing":(\{[^}]*\}\})/)?.[1];
    const pushedLb = JSON.stringify(buildServerEntry(p)).match(/"load_balancing":(\{[^}]*\}\})/)?.[1];
    expect(JSON.parse(pushedLb!)).toEqual(JSON.parse(adaptedLb!));
    const [pushedBack] = parseProxies({ apps: { http: { servers: { srv0: buildServerEntry(p) } } } });
    expect(pushedBack.lbPolicyArgs).toEqual(policy.lbPolicyArgs);
  });

  it.each(["round_robin", "random", "least_conn", "first"] as const)("the old policy %s writes the same line", policy => {
    const conf = proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, extraUpstreams, lbPolicy: policy })]);
    expect(conf).toContain(`\t\tlb_policy ${policy}\n`);
    expect(readBack(conf)[0].lbPolicyArgs).toBeUndefined();
  });
});

describe.runIf(available || required)("client_ip matcher (#286)", () => {
  it.each(["client_ip", "remote_ip"] as const)("%s round-trips through the Caddyfile and the JSON push", kind => {
    const matchers = { path: ["/admin/*"], [kind]: { ranges: ["10.0.0.0/8", "192.168.1.5"] } };
    const p = entry({ tls: false, externalPort: 8080, matchers });
    const conf = proxiesToCaddyfile([p]);
    expect(conf).toContain(`${kind} 10.0.0.0/8 192.168.1.5`);
    expect(readBack(conf)[0].matchers).toEqual(matchers);
    const [pushed] = parseProxies({ apps: { http: { servers: { srv0: buildServerEntry(p) } } } });
    expect(pushed.matchers).toEqual(matchers);
  });

  it("works in an exclude group too", () => {
    const matchers = { path: ["/x/*"], not: { client_ip: { ranges: ["10.0.0.0/8"] } } };
    expect(readBack(proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, matchers })]))[0].matchers).toEqual(matchers);
  });
});

describe.runIf(available || required)("caddy adapt accepts the basic_auth realm and algorithm (#337)", () => {
  const accounts = [{ username: "alice", passwordHash: "$argon2id$v=19$m=47104,t=1,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g" }];

  it("reads the algorithm and realm back from a real adapt", () => {
    const conf = proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, basicAuth: accounts, basicAuthOptions: { algorithm: "argon2id", realm: "Private area" } })]);
    const [p] = readBack(conf);
    expect(p.basicAuthOptions).toEqual({ algorithm: "argon2id", realm: "Private area" });
    expect(p.basicAuth).toEqual(accounts);
  });

  it("writes bcrypt in front of a realm, because the realm comes second", () => {
    const bcrypt = [{ username: "bob", passwordHash: "$2a$14$HfqUPi8ecmhKr2br56YonenjapN.9FYZm5cv78bUrYuhZWGotTGWC" }];
    const conf = proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, basicAuth: bcrypt, basicAuthOptions: { realm: "Only us" } })]);
    expect(conf).toContain('basic_auth bcrypt "Only us" {');
    expect(readBack(conf)[0].basicAuthOptions).toEqual({ realm: "Only us" });
  });

  it("reads no options from a plain basic_auth", () => {
    const bcrypt = [{ username: "bob", passwordHash: "$2a$14$HfqUPi8ecmhKr2br56YonenjapN.9FYZm5cv78bUrYuhZWGotTGWC" }];
    expect(readBack(proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, basicAuth: bcrypt })]))[0].basicAuthOptions).toBeUndefined();
  });
});

describe.runIf(available || required)("caddy adapt accepts redir html (#338)", () => {
  it("reads the html redirect back from a real adapt", () => {
    const conf = proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, targetPort: 0, redirect: { to: "https://example.com{uri}", code: 302, html: true } })]);
    expect(readBack(conf)[0].redirect).toEqual({ to: "https://example.com{uri}", code: 302, html: true });
  });

  it("builds the very page Caddy builds", () => {
    const conf = proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, targetPort: 0, redirect: { to: "https://example.com{uri}", code: 302, html: true } })]);
    const server = Object.values(adapt(conf).apps?.http?.servers ?? {})[0] as CaddyServer;
    const caddys = (server.routes?.[0]?.handle?.[0]) as unknown as { body: string };
    expect((buildRedirectHandler({ to: "https://example.com{uri}", code: 302, html: true }) as unknown as { body: string }).body).toBe(caddys.body);
  });
});

describe.runIf(available || required)("caddy adapt accepts the encode options (#335)", () => {
  const options = { algorithms: ["zstd" as const, "gzip" as const], minimumLength: 1024, matchStatus: ["2xx", "404"], matchHeaders: [{ name: "Content-Type", value: "text/*" }] };

  it("reads them back from a real adapt", () => {
    const [p] = readBack(proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, compress: true, encodeOptions: options })]));
    expect(p.compress).toBe(true);
    expect(p.encodeOptions).toEqual(options);
  });

  it("builds the handler Caddy builds", () => {
    const conf = proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, compress: true, encodeOptions: options })]);
    const server = Object.values(adapt(conf).apps?.http?.servers ?? {})[0] as CaddyServer;
    const real = server.routes?.[0]?.handle?.find(h => h.handler === "encode") as unknown as Record<string, unknown>;
    expect(buildEncodeHandler(options)).toMatchObject({ prefer: real.prefer, minimum_length: real.minimum_length, match: real.match });
  });

  it("reads plain compression back as no options", () => {
    const [p] = readBack(proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, compress: true })]));
    expect(p.compress).toBe(true);
    expect(p.encodeOptions).toBeUndefined();
  });
});

describe.runIf(available || required)("caddy adapt accepts the file_server and php_fastcgi options (#340)", () => {
  it("reads the file_server options back from a real adapt", () => {
    const fileServer = { root: "/srv/www", browse: true, browseTemplate: "/etc/caddy/listing.html", disableCanonicalUris: true, status: 404 };
    const [p] = readBack(proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, targetPort: 0, fileServer })]));
    expect(p.fileServer).toMatchObject(fileServer);
  });

  it("reads the php_fastcgi options back from a real adapt", () => {
    const phpFastcgi = {
      upstream: "localhost:9000", root: "/srv/php", captureStderr: true, resolveRootSymlink: true, dialTimeout: "3s", readTimeout: "10s", writeTimeout: "20s",
    };
    const [p] = readBack(proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, targetPort: 0, phpFastcgi })]));
    expect(p.phpFastcgi).toMatchObject(phpFastcgi);
  });
});

describe.runIf(available || required)("caddy adapt accepts the templates directive (#339)", () => {
  it("reads plain templates back", () => {
    const [p] = readBack(proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, targetPort: 0, fileServer: { root: "/srv/www", templates: {} } })]));
    expect(p.fileServer?.templates).toEqual({});
  });

  it("reads the mime types and root back", () => {
    const templates = { mime: ["text/html", "text/css"], root: "/srv/inc" };
    const [p] = readBack(proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, targetPort: 0, fileServer: { root: "/srv/www", templates } })]));
    expect(p.fileServer?.templates).toEqual(templates);
  });

  it("reads no templates from a plain static site", () => {
    const [p] = readBack(proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, targetPort: 0, fileServer: { root: "/srv/www" } })]));
    expect(p.fileServer?.templates).toBeUndefined();
  });
});

describe.runIf(available || required)("caddy adapt accepts access log field filters (#334)", () => {
  const filters = [
    { field: "request>headers>Authorization", filter: "delete" as const },
    { field: "request>headers>Cookie", filter: "hash" as const },
    { field: "request>uri", filter: "replace" as const, value: "secret" },
    { field: "request>remote_ip", filter: "ip_mask" as const, ipv4: 24, ipv6: 64 },
  ];

  it("reads the filters back from a real adapt", () => {
    const accessLog = { output: "stderr" as const, format: "console" as const, fieldFilters: filters };
    const [p] = readBack(proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, accessLog })]));
    expect(p.accessLog?.format).toBe("console");
    expect(p.accessLog?.fieldFilters).toEqual(expect.arrayContaining(filters));
    expect(p.accessLog?.fieldFilters).toHaveLength(4);
  });

  it("builds the encoder Caddy builds", () => {
    const conf = proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, accessLog: { output: "stderr", format: "console", fieldFilters: filters } })]);
    const logs = adapt(conf).logging?.logs ?? {};
    const real = Object.values(logs).find(l => l.encoder?.format === "filter")?.encoder;
    expect(buildFilterEncoder("console", filters)).toEqual(real);
  });

  it("accepts include and exclude in Caddy's own log", () => {
    const patched = buildGlobalOptionsPatch("", { runtimeLog: { output: "stderr", include: ["http.log.access"], exclude: ["admin"] } });
    const logs = adapt(`${patched}\n:8080 {\n\trespond ok\n}\n`).logging?.logs ?? {};
    expect(logs.default).toMatchObject({ include: ["http.log.access"], exclude: ["admin"] });
  });
});

describe.runIf(available || required)("caddy adapt accepts log_skip (#334)", () => {
  it("reads a lone path and several paths back from the adapted JSON of a hostless site", () => {
    for (const skipPaths of [["/health*"], ["/health*", "/ping"]]) {
      const conf = proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, accessLog: { output: "stderr", skipPaths } })]);
      const proxies = readBack(conf);
      expect(proxies).toHaveLength(1);
      expect(proxies[0].accessLog?.skipPaths).toEqual(skipPaths);
    }
  });

  it("takes a site with a host as one site and reads its paths from the Caddyfile, where Caddy names the logger itself", () => {
    for (const skipPaths of [["/health*"], ["/health*", "/ping"]]) {
      const conf = proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, externalHost: "example.com", accessLog: { output: "stderr", skipPaths } })]);
      expect(readBack(conf)).toHaveLength(1);
      expect(Object.values(parseConfAccessLogMap(conf))[0].skipPaths).toEqual(skipPaths);
    }
  });

  it("builds the route Caddy builds", () => {
    const conf = proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, accessLog: { output: "stderr", skipPaths: ["/health*", "/ping"] } })]);
    const real = Object.values(adapt(conf).apps?.http?.servers ?? {})[0] as CaddyServer;
    const pushed = buildServerEntry(entry({ tls: false, externalPort: 8080, accessLog: { output: "stderr", skipPaths: ["/health*", "/ping"] } }));
    expect(pushed.routes?.[0]).toEqual(real.routes?.[0]);
  });
});

describe.runIf(available || required)("caddy adapt accepts the new rewrites (#332)", () => {
  const rewrites: import("./types").RewriteConfig[] = [
    { type: "strip_suffix", value: ".html" },
    { type: "uri_replace", find: "/old", replace: "/new" },
    { type: "uri_replace", find: "a b", replace: "", limit: 2 },
    { type: "method", method: "GET" },
    { type: "query", ops: [{ op: "set", key: "page", value: "1" }] },
    { type: "query", ops: [
      { op: "rename", key: "q", value: "query" }, { op: "set", key: "a", value: "b c" }, { op: "add", key: "x", value: "y" },
      { op: "replace", key: "id", search: "^(\\d+)$", replace: "n$1" }, { op: "delete", key: "debug" },
    ] },
  ];

  it.each(rewrites)("reads %j back from a real adapt", rewrite => {
    const [p] = readBack(proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, rewrite })]));
    expect(p.rewrite).toEqual(rewrite);
  });

  it.each(rewrites)("builds the handler Caddy builds for %j", rewrite => {
    const conf = proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, rewrite })]);
    const server = Object.values(adapt(conf).apps?.http?.servers ?? {})[0] as CaddyServer;
    const real = server.routes?.[0]?.handle?.find(h => h.handler === "rewrite");
    expect(buildRewriteHandler(rewrite)).toEqual(real);
  });
});

describe.runIf(available || required)("caddy adapt accepts the new matchers (#331)", () => {
  const cases: Array<[string, import("./types").RouteMatch]> = [
    ["a named path_regexp", { path_regexp: { pattern: "^/user/(\\d+)$", name: "user" } }],
    ["a path_regexp without a name", { path_regexp: { pattern: "^/a/(.*)$" } }],
    ["a header_regexp", { header_regexp: { header: "X-Token", pattern: "^v(\\d+)$", name: "token" } }],
    ["protocol", { protocol: "https" }],
    ["file", { file: { try_files: ["{path}", "{path}/index.html"], try_policy: "first_exist" } }],
    ["vars", { vars: { "{host}": ["example.com", "www.example.com"] } }],
    ["a protocol next to a path and a method", { path: ["/api/*"], method: ["GET"], protocol: "https" }],
  ];

  it.each(cases)("reads %s back from a real adapt", (_name, matchers) => {
    const [p] = readBack(proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, matchers })]));
    expect(p.matchers).toEqual(matchers);
  });

  it.each(cases)("builds the matcher Caddy builds for %s", (_name, matchers) => {
    const conf = proxiesToCaddyfile([entry({ tls: false, externalPort: 8080, matchers })]);
    const server = Object.values(adapt(conf).apps?.http?.servers ?? {})[0] as CaddyServer;
    const real = server.routes?.[0]?.match?.[0] as Record<string, unknown>;
    const built = buildMatcherJson(matchers) as Record<string, unknown>;
    // Caddy names a regexp after its matcher; a name chosen in the form is the same on both sides.
    const strip = (o: Record<string, unknown>) => JSON.parse(JSON.stringify(o, (k, v) => (k === "name" && /^m\d+$/.test(v) ? undefined : v))) as Record<string, unknown>;
    expect(strip(built)).toEqual(strip(real));
  });
});

describe.runIf(available || required)("caddy adapt accepts the site's own ACME settings (#341)", () => {
  const staging = "https://acme-staging-v02.api.letsencrypt.org/directory";
  const acmeSite = (tlsAdvanced: import("./types").TlsAdvancedConfig) =>
    entry({ tls: true, tlsIssuer: "acme", externalHost: "example.com", externalScheme: "https", externalPort: 443, tlsAdvanced });

  it.each([
    ["email, CA and key type", { acmeEmail: "me@example.com", acmeCa: staging, keyType: "p256" }],
    ["only a CA", { acmeCa: staging }],
    ["only an email", { acmeEmail: "me@example.com" }],
    ["only a key type", { keyType: "ed25519" }],
  ])("reads %s back from a real adapt", (_name, tlsAdvanced) => {
    const [p] = readBack(proxiesToCaddyfile([acmeSite(tlsAdvanced)]));
    expect(p.tlsAdvanced).toMatchObject(tlsAdvanced);
  });

  it("builds the policy Caddy builds for a CA, email and key type", () => {
    const tlsAdvanced = { acmeEmail: "me@example.com", acmeCa: staging, keyType: "p256" };
    const real = adapt(proxiesToCaddyfile([acmeSite(tlsAdvanced)])).apps?.tls?.automation?.policies?.find(p => p.subjects?.some(s => s === "example.com"));
    const pushed = mergeProxy({ apps: { http: { servers: {} } } } as CaddyConfig, acmeSite(tlsAdvanced)).apps?.tls?.automation?.policies?.find(p => p.subjects?.some(s => s === "example.com"));
    expect(pushed).toEqual(real);
  });

  it("reads key_type of an internal-issuer site", () => {
    const e = entry({ tls: true, tlsIssuer: "internal", externalHost: "example.com", externalScheme: "https", externalPort: 443, tlsAdvanced: { keyType: "ed25519" } });
    const [p] = readBack(proxiesToCaddyfile([e]));
    expect(p.tlsAdvanced?.keyType).toBe("ed25519");
  });
});

