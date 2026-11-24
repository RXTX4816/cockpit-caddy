/**
 * Per-site DNS challenge (#289): a site using automatic HTTPS either inherits the global
 * `acme_dns` provider (nothing written) or overrides it with `tls { dns <provider> … }`.
 * The adapt tests need a Caddy with a dns.providers.* module on PATH and skip otherwise.
 */
/* global process -- declared in src/test/node-shims.d.ts */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proxyToBlock, parseConfTlsDnsMap, proxyAddressKeys, CONF_HEADER } from "./caddy";
import type { ProxyEntry } from "./types";

const site = (over: Partial<ProxyEntry> = {}): ProxyEntry => ({
  id: "x", serverKey: "x", externalHost: "a.example.com", externalPort: 443, targetHost: "localhost", targetPort: 8080,
  targetScheme: "http", tls: true, tlsIssuer: "acme", tlsSkipVerify: false, ...over,
});

const override = { provider: "cloudflare", credentials: { api_token: "CADDY_DNS_SITE_A_EXAMPLE_COM_1_API_TOKEN" } };

describe("per-site DNS challenge in the Caddyfile", () => {
  it("inherit writes no tls block for an ACME site", () => {
    expect(proxyToBlock(site())).not.toMatch(/\btls\b/);
  });

  it("override writes the provider with env references only", () => {
    const block = proxyToBlock(site({ dnsChallenge: override }));
    expect(block).toContain("\ttls {\n\t\tdns cloudflare {\n\t\t\tapi_token {env.CADDY_DNS_SITE_A_EXAMPLE_COM_1_API_TOKEN}\n\t\t}\n\t}");
  });

  it("is only written for ACME sites", () => {
    expect(proxyToBlock(site({ tlsIssuer: "internal", dnsChallenge: override }))).not.toContain("dns cloudflare");
    expect(proxyToBlock(site({ tls: false, dnsChallenge: override }))).not.toContain("dns cloudflare");
  });

  it("goes together with on_demand", () => {
    const block = proxyToBlock(site({ dnsChallenge: override, tlsOnDemand: true }));
    expect(block).toContain("\t\ton_demand");
    expect(block).toContain("\t\tdns cloudflare {");
  });

  it("reads the override back per site, and nothing for an inheriting one", () => {
    const a = site({ dnsChallenge: override });
    const b = site({ id: "y", externalHost: "b.example.com" });
    const conf = `${CONF_HEADER}\n\n${proxyToBlock(a)}\n\n${proxyToBlock(b)}\n`;
    const map = parseConfTlsDnsMap(conf);
    expect(map[proxyAddressKeys(a)[0]]).toEqual(override);
    expect(map[proxyAddressKeys(b)[0]]).toBeUndefined();
  });

  it("does not take a `dns` line outside the tls block for a provider", () => {
    const conf = "a.example.com {\n\treverse_proxy localhost:8080 {\n\t\tdns x\n\t}\n}\n";
    expect(parseConfTlsDnsMap(conf)).toEqual({});
  });
});

function dnsProvider(): string | undefined {
  try {
    return execFileSync("caddy", ["list-modules"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n").map(l => l.trim().match(/^dns\.providers\.(\S+)$/)?.[1]).find(Boolean);
  } catch {
    return undefined;
  }
}
const provider = dnsProvider();

type Policy = { subjects?: string[]; issuers?: Array<{ module: string; challenges?: { dns?: { provider?: Record<string, string> } } }> };
function policies(caddyfile: string): Policy[] {
  const dir = mkdtempSync(join(tmpdir(), "cockpit-caddy-dns-"));
  try {
    writeFileSync(join(dir, "Caddyfile"), caddyfile);
    const out = execFileSync("caddy", ["adapt", "--config", join(dir, "Caddyfile"), "--adapter", "caddyfile"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(out).apps.tls.automation.policies as Policy[];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!provider && !process.env.CADDY_ADAPT_REQUIRED_DNS)("per-site DNS challenge through caddy adapt", () => {
  // Most providers take an api_token or token; the option name doesn't matter to adapt
  // as long as the module accepts it, so use the one the module knows.
  const option = provider === "desec" ? "token" : "api_token";
  const global = `{\n\tacme_dns ${provider} {\n\t\t${option} {env.CADDY_DNS_GLOBAL}\n\t}\n}\n\n`;
  const providerOf = (p: Policy) => p.issuers?.[0]?.challenges?.dns?.provider;

  it("an inheriting site gets the global provider", () => {
    const pols = policies(global + proxyToBlock(site()));
    expect(pols.every(p => providerOf(p)?.[option] === "{env.CADDY_DNS_GLOBAL}")).toBe(true);
  });

  it("an overriding site keeps its own provider and credentials", () => {
    const own = { provider: provider!, credentials: { [option]: "CADDY_DNS_SITE_A" } };
    const pols = policies(global + proxyToBlock(site({ dnsChallenge: own })));
    const mine = pols.find(p => (p.subjects ?? []).some(s => s === "a.example.com"));
    expect(providerOf(mine!)).toEqual({ name: provider, [option]: "{env.CADDY_DNS_SITE_A}" });
  });
});
