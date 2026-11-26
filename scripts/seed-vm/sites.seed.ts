/**
 * Seed data for manual testing (docs/wiki/Manual-Testing.md). Builds the sites as ProxyEntry
 * objects and writes them with the plugin's own Caddyfile writers, so the UI reads them back
 * exactly. Run through apply.sh, which sets SEED_OUT and installs the result on a test VM.
 *
 * Backends (started by setup.sh): 9001 and 9002 serve "Backend 9001/9002", 9003 is a forward-auth
 * endpoint that allows everything, 9009 is never started (a dead upstream on purpose).
 */
/* global process -- declared in src/test/node-shims.d.ts */
import { it } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { proxiesToCaddyfile, surgicallyWriteServerBlock, buildGlobalOptionsPatch } from "../../src/api/caddy";
import { snippetsToConf } from "../../src/api/snippets";
import type { ProxyEntry, ServerDef } from "../../src/api/types";

const site = (id: string, port: number, over: Partial<ProxyEntry>): ProxyEntry => ({
  id, serverKey: `srv_${id}`, externalPort: port, targetHost: "localhost", targetPort: 9001,
  targetScheme: "http", tls: false, tlsSkipVerify: false, ...over,
});

const sites: ProxyEntry[] = [
  site("s1", 8001, {
    label: "Basic proxy (internal CA)", tls: true, tlsIssuer: "internal", compress: true,
    requestHeaders: [{ op: "set", name: "X-Seed-Host", value: "{http.request.host}" }],
    responseHeaders: [{ op: "set", name: "X-Served-By", value: "cockpit-caddy-seed" }],
    accessLog: { output: "file", filePath: "/var/log/caddy/seed-access.log", format: "json" },
  }),
  site("s2", 443, {
    label: "Two hostnames, automatic HTTPS", externalHost: "app.example.test, www.example.test",
    tls: true, tlsIssuer: "acme", targetPort: 9002,
  }),
  site("s3", 8003, {
    label: "Load balanced, sticky, health checks",
    extraUpstreams: [{ host: "localhost", port: 9002 }, { host: "localhost", port: 9009 }],
    lbPolicy: "cookie", lbPolicyArgs: { cookieName: "seed_lb" },
    lbRetry: {
      retries: 2, tryDuration: "5s", tryInterval: "250ms",
      failDuration: "30s", maxFails: 2, unhealthyStatus: [502, 503],
      healthUri: "/", healthInterval: "10s", healthTimeout: "2s", healthStatus: "2xx",
    },
  }),
  site("s4", 8004, {
    label: "Basic auth (demo / demo)",
    // `caddy hash-password` of "demo"
    basicAuth: [{ username: "demo", passwordHash: "$2a$14$.TFndXLpoPFTIsNJiXB3Uu7FwvrDdQyup.oE5aYKRqjJ8ItQKmnzu" }],
  }),
  site("s5", 8005, {
    label: "Forward auth",
    forwardAuth: { upstreamUrl: "http://localhost:9003", uri: "/", copyHeaders: ["Remote-User"] },
  }),
  site("s6", 8006, {
    label: "Route matchers (path, method, header, query, exclude, CEL)", targetPort: 9002,
    matchers: {
      path: ["/api/*"], method: ["GET", "POST"], header: { "X-Debug": [] }, query: { debug: ["1"] },
      not: { path: ["/api/private/*"] }, expression: "{method} != 'DELETE'",
    },
  }),
  site("s7", 8007, {
    label: "Client IP behind trusted proxy", matchers: { client_ip: { ranges: ["10.0.0.0/8"] } },
  }),
  site("s8", 8008, {
    label: "Static SPA", targetPort: 0,
    fileServer: { root: "/srv/seed/spa", spa: true, index: ["index.html"], hide: [".git"], precompressed: ["zstd", "br", "gzip"] },
  }),
  site("s9", 8009, {
    label: "Static file browser", targetPort: 0, fileServer: { root: "/srv/seed/files", browse: true },
  }),
  site("s10", 8010, {
    label: "PHP app (no php-fpm on the VM)", targetPort: 0,
    phpFastcgi: { upstream: "unix//run/php-fpm/php-fpm.sock", root: "/srv/seed/php", tryFiles: "{path} {path}/ /index.php?{query}" },
  }),
  site("s11", 8011, { label: "Redirect to caddyserver.com", targetPort: 0, redirect: { to: "https://caddyserver.com{uri}", code: 302 } }),
  site("s12", 8012, { label: "Maintenance response", targetPort: 0, staticResponse: { statusCode: 503, body: "Down for maintenance" } }),
  site("s13", 8013, { label: "On-demand TLS (internal CA)", tls: true, tlsIssuer: "internal", tlsOnDemand: true }),
  site("s14", 8014, {
    label: "Snippet, error page, limits", targetPort: 9009, imports: ["security-headers"],
    errorHandlers: [{ matchType: "5xx", type: "respond", body: "Upstream is down ({err.status_code})", statusCode: 502 }],
    requestBodyMaxSize: 1048576, dialTimeout: "2s", responseHeaderTimeout: "10s",
    rewrite: { type: "strip_prefix", value: "/app" },
  }),
];

const server: ServerDef = { key: "internal_tools", name: "Internal tools", listenAddresses: [":8020"], tls: false };
const routes: ProxyEntry[] = [
  site("internal_tools:0", 8020, { namedServerKey: "internal_tools", matchers: { path: ["/grafana/*"] }, handlePath: true }),
  site("internal_tools:1", 8020, { namedServerKey: "internal_tools", targetPort: 9002, matchers: { path: ["/wiki/*"] }, handlePath: true }),
];

// The Tree tab (#349, #350) only shows for a site with a route block or nested handles, which the
// plugin's writers never produce, so this one is written as text.
const treeSite = `# label: Nested routes (Tree tab)
http://:8015 {
	@api path /api/*
	route {
		header X-Seed-Route tree
		handle @api {
			handle_path /api/v1/* {
				reverse_proxy http://localhost:9002
			}
			respond "unknown api version" 404
		}
		handle_path /static/* {
			root * /srv/seed/files
			file_server browse
		}
		handle {
			reverse_proxy http://localhost:9001
		}
	}
}
`;

it("writes the seed config", () => {
  const out = process.env.SEED_OUT;
  if (!out) throw new Error("SEED_OUT is not set; run scripts/seed-vm/apply.sh");
  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}/cockpit-caddy.conf`, surgicallyWriteServerBlock(`${proxiesToCaddyfile(sites)}\n${treeSite}`, server, routes));
  writeFileSync(`${out}/cockpit-caddy-snippets.conf`, snippetsToConf([
    { name: "security-headers", body: "header {\n\tX-Content-Type-Options nosniff\n\tReferrer-Policy strict-origin-when-cross-origin\n\t-Server\n}" },
    { name: "cache-static", body: 'header Cache-Control "public, max-age=3600"' },
  ]));
  // Metrics stay off: their site block is written by the Settings save, which the guide tests.
  const main = '{\n\tadmin "unix//run/caddy/admin.socket"\n}\n\nimport /etc/caddy/conf.d/*\n';
  writeFileSync(`${out}/Caddyfile`, buildGlobalOptionsPatch(main, {
    email: "admin@example.test",
    trustedProxies: { ranges: ["127.0.0.1/32"] },
    onDemandEnabled: true, onDemandAsk: "http://localhost:9001/",
  }));
});
