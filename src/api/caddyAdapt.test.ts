/**
 * Feeds generated Caddyfiles to a real `caddy adapt` (#208) and parses Caddy's JSON back,
 * the same path a reload takes. Needs a `caddy` binary on PATH (CI installs Caddy 2.11);
 * skipped without one unless CADDY_ADAPT_REQUIRED is set, which turns a missing binary
 * into a failure instead.
 */
/* global process -- declared in src/test/node-shims.d.ts */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONF_HEADER, buildServerEntry, proxiesToCaddyfile, parseProxies, parseConfExternalAddresses, proxyAddressKeys, resolveInternalIssuerSettings, surgicallyWriteProxy } from "./caddy";
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

/** parseProxies plus the conf.d host/scheme fallback useProxies layers on top. */
function readBack(conf: string): ProxyEntry[] {
  const ext = parseConfExternalAddresses(conf);
  return parseProxies(adapt(conf)).map(p => {
    const found = proxyAddressKeys(p).map(k => ext[k]).find(Boolean);
    return { ...p, externalHost: p.externalHost ?? found?.host, externalScheme: p.externalScheme ?? found?.scheme };
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
