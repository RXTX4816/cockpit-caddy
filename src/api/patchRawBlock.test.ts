// Saving a hand-written site block from its dialog (C18, C19): `patchRawBlock` keeps what the
// plugin doesn't own and writes everything the form edits exactly once.
import { describe, it, expect } from "vitest";
import { patchRawBlock } from "./siteBlocks";
import type { ProxyEntry } from "./types";

const site = (overrides: Partial<ProxyEntry> = {}): ProxyEntry => ({
  id: "host:app.example.com", serverKey: "srv0", externalPort: 443, externalHost: "app.example.com",
  targetHost: "localhost", targetPort: 8000, targetScheme: "http", tls: false, tlsSkipVerify: false,
  ...overrides,
});

/** Saving twice gives what saving once gave. */
function saved(raw: string, p: ProxyEntry): string {
  const once = patchRawBlock(raw, p);
  expect(patchRawBlock(once, p)).toBe(once);
  return once;
}

const count = (text: string, re: RegExp) => (text.match(new RegExp(re.source, "gm")) ?? []).length;

describe("saving a hand-written redirect or respond site (C18)", () => {
  const redirect = "old.example.com {\n\tredir https://new.example.com{uri} 301\n}";
  const respond = 'gone.example.com {\n\trespond "Gone" 410\n}';

  it("replaces the redirect, and adds no reverse_proxy", () => {
    const out = saved(redirect, site({ externalHost: "old.example.com", targetPort: 0, redirect: { to: "https://newer.example.com{uri}", code: 308 } }));
    expect(out).toBe("old.example.com {\n\tredir https://newer.example.com{uri} 308\n}");
  });

  it("replaces the response, and adds no reverse_proxy", () => {
    const out = saved(respond, site({ externalHost: "gone.example.com", targetPort: 0, staticResponse: { statusCode: 404, body: "Not here" } }));
    expect(out).toBe('gone.example.com {\n\trespond "Not here" 404\n}');
  });

  it("turns a redirect site into a proxy without keeping the redir", () => {
    const out = saved(redirect, site({ externalHost: "old.example.com" }));
    expect(out).toBe("old.example.com {\n\treverse_proxy http://localhost:8000\n}");
  });

  it("keeps a respond or redir with a matcher of its own: it isn't the site's handler", () => {
    const raw = "app.example.com {\n\trespond /health 200\n\tredir /old /new 301\n\treverse_proxy localhost:8000\n}";
    const out = saved(raw, site({ targetPort: 9000 }));
    expect(out).toContain("\trespond /health 200\n");
    expect(out).toContain("\tredir /old /new 301\n");
    expect(count(out, /^\treverse_proxy /)).toBe(1);
    expect(out).toContain("\treverse_proxy http://localhost:9000");
  });
});

describe("saving a hand-written reverse_proxy site writes every section the form edits (C19)", () => {
  const raw = [
    "app.example.com {",
    "\turi strip_prefix /app",
    "\trequest_body {",
    "\t\tmax_size 10MB",
    "\t}",
    "\tlog {",
    "\t\toutput stdout",
    "\t}",
    "\tvars tenant acme",
    "\treverse_proxy localhost:8000",
    "\thandle_errors 5xx {",
    '\t\trespond "down" 503',
    "\t}",
    "}",
  ].join("\n");
  const edited = site({
    rewrite: { type: "strip_prefix", value: "/v2" },
    requestBodyMaxSize: 20_000_000,
    accessLog: { output: "file", filePath: "/var/log/caddy/app.log" },
    errorHandlers: [{ matchType: "5xx", type: "respond", body: "maintenance", statusCode: 503 }],
  });

  it("writes the changed rewrite, body limit, access log and error handler once each", () => {
    const out = saved(raw, edited);
    expect(count(out, /^\turi /)).toBe(1);
    expect(out).toContain("\turi strip_prefix /v2\n");
    expect(count(out, /^\trequest_body /)).toBe(1);
    expect(out).toContain("\t\tmax_size 20000000\n");
    expect(count(out, /^\tlog /)).toBe(1);
    expect(out).toContain("\t\toutput file /var/log/caddy/app.log\n");
    expect(out).not.toContain("output stdout");
    expect(count(out, /^\thandle_errors/)).toBe(1);
    expect(out).toContain('\t\trespond "maintenance" 503\n');
    expect(out).not.toContain('"down"');
    expect(count(out, /^\treverse_proxy /)).toBe(1);
  });

  it("keeps the lines the plugin doesn't own", () => {
    expect(saved(raw, edited)).toContain("\tvars tenant acme\n");
  });

  it("removes each section the form cleared", () => {
    const out = saved(raw, site());
    // The handler goes where the first of the form's lines was, the rewrite at the top.
    expect(out).toBe("app.example.com {\n\treverse_proxy http://localhost:8000\n\tvars tenant acme\n}");
  });

  it("keeps a rewrite or request_body with a matcher of its own", () => {
    const own = "app.example.com {\n\trewrite /old /new\n\turi /api/* strip_prefix /api\n\trequest_body /upload {\n\t\tmax_size 1GB\n\t}\n\treverse_proxy localhost:8000\n}";
    const out = saved(own, site());
    expect(out).toContain("\trewrite /old /new\n");
    expect(out).toContain("\turi /api/* strip_prefix /api\n");
    expect(out).toContain("\trequest_body /upload {\n\t\tmax_size 1GB\n\t}\n");
  });

  it("adds an error handler to a site without one, once", () => {
    const out = saved("app.example.com {\n\treverse_proxy localhost:8000\n}", site({ errorHandlers: [{ matchType: "all", type: "respond", body: "oops" }] }));
    expect(count(out, /^\thandle_errors/)).toBe(1);
  });
});

describe("saving a hand-written site with a route matcher (C19)", () => {
  const raw = [
    "api.example.com {",
    "\t@api {",
    "\t\tpath /api/*",
    "\t}",
    "\thandle @api {",
    "\t\tvars tenant acme",
    "\t\treverse_proxy localhost:8000",
    "\t}",
    "}",
  ].join("\n");

  it("writes the changed matcher and keeps one handler, inside the handle", () => {
    const out = saved(raw, site({ externalHost: "api.example.com", matchers: { path: ["/v2/*"] }, targetPort: 9000 }));
    expect(out).not.toContain("/api/*");
    expect(out).toContain("\t\tpath /v2/*\n");
    expect(count(out, /^\s*reverse_proxy /)).toBe(1);
    expect(out).toContain("\t\treverse_proxy http://localhost:9000\n");
    expect(count(out, /^\thandle /)).toBe(1);
    // What the handle held besides the form's lines stays in it.
    expect(out).toMatch(/\thandle @\S+ \{\n\t\tvars tenant acme\n/);
  });

  it("drops the matcher and the handle when the form clears the matcher", () => {
    const out = saved(raw, site({ externalHost: "api.example.com" }));
    expect(out).toBe("api.example.com {\n\tvars tenant acme\n\treverse_proxy http://localhost:8000\n}");
  });

  it("adds a matcher to a flat site, once", () => {
    const out = saved("api.example.com {\n\treverse_proxy localhost:8000\n}", site({ externalHost: "api.example.com", matchers: { path: ["/api/*"] } }));
    expect(count(out, /^\t@/)).toBe(1);
    expect(count(out, /^\thandle /)).toBe(1);
    expect(count(out, /^\s*reverse_proxy /)).toBe(1);
  });

  it("keeps a named matcher another directive uses", () => {
    const own = "api.example.com {\n\t@blocked remote_ip 10.9.0.0/16\n\tabort @blocked\n\treverse_proxy localhost:8000\n}";
    const out = saved(own, site({ externalHost: "api.example.com", targetPort: 9000 }));
    expect(out).toContain("\t@blocked remote_ip 10.9.0.0/16\n\tabort @blocked\n");
  });

  it("leaves a site with several handle blocks to the Tree tab: its handlers stay as written", () => {
    const multi = "api.example.com {\n\thandle /api/* {\n\t\treverse_proxy localhost:8000\n\t}\n\thandle {\n\t\troot * /srv/www\n\t\tfile_server\n\t}\n}";
    expect(saved(multi, site({ externalHost: "api.example.com", targetPort: 9000 }))).toBe(multi);
  });
});

describe("saving a hand-written site keeps what the user wrote where the form allows it", () => {
  const logged = [
    "app.example.com {",
    "\tlog {",
    "\t\toutput stdout",
    "\t\tsampling {",
    "\t\t\tinterval 1s",
    "\t\t}",
    "\t}",
    "\treverse_proxy localhost:8000",
    "}",
  ].join("\n");

  it("leaves the log block as written when the form's log settings didn't change", () => {
    expect(saved(logged, site({ accessLog: { output: "stdout" } }))).toBe(logged.replace("localhost:8000", "http://localhost:8000"));
  });

  it("keeps a bare log line the form reads no settings from", () => {
    const raw = "app.example.com {\n\tlog\n\treverse_proxy localhost:8000\n}";
    expect(saved(raw, site())).toBe("app.example.com {\n\tlog\n\treverse_proxy http://localhost:8000\n}");
  });

  it("keeps the log subdirectives the form doesn't model when its log settings change", () => {
    const out = saved(logged, site({ accessLog: { output: "file", filePath: "/var/log/caddy/app.log" } }));
    expect(out).toContain("\t\toutput file /var/log/caddy/app.log\n");
    expect(out).toContain("\t\tsampling {\n\t\t\tinterval 1s\n\t\t}\n\t}\n");
    expect(count(out, /^\tlog /)).toBe(1);
  });

  it("keeps the logger name of a changed log", () => {
    const raw = "app.example.com {\n\tlog access {\n\t\toutput stdout\n\t}\n\treverse_proxy localhost:8000\n}";
    expect(saved(raw, site({ accessLog: { output: "stderr" } }))).toContain("\tlog access {\n\t\toutput stderr\n\t}\n");
  });

  it("keeps the name of the site's own matcher", () => {
    const raw = "api.example.com {\n\t@api {\n\t\tpath /api/*\n\t}\n\thandle @api {\n\t\treverse_proxy localhost:8000\n\t}\n}";
    const out = saved(raw, site({ externalHost: "api.example.com", matchers: { path: ["/v2/*"] } }));
    expect(out).toBe("api.example.com {\n\t@api {\n\t\tpath /v2/*\n\t}\n\thandle @api {\n\t\treverse_proxy http://localhost:8000\n\t}\n}");
  });

  it("writes the handler where the site had it", () => {
    const raw = "app.example.com {\n\tvars tenant acme\n\treverse_proxy localhost:8000\n\trespond /health 200\n}";
    expect(saved(raw, site({ targetPort: 9000 }))).toBe("app.example.com {\n\tvars tenant acme\n\treverse_proxy http://localhost:9000\n\trespond /health 200\n}");
  });
});
