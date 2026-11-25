import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { resetHost } from "@rxtx4816/cockpit-plugin-base-react/host";
import { installFakeHost, type FakeHost } from "@rxtx4816/cockpit-plugin-base-react/testing/host";
import { listCaddyModules, moduleCapabilities, parseCaddyModules } from "./caddyModules";

const OUTPUT = `admin.api.load
admin.api.metrics
caddy.adapters.caddyfile
dns.providers.cloudflare
dns.providers.hetzner
http.handlers.rate_limit
layer4
layer4.matchers.tls

  Standard modules: 6
  Non-standard modules: 3
  Unknown modules: 0
`;

describe("caddy list-modules (#343)", () => {
  let host: FakeHost;
  beforeEach(() => { host = installFakeHost({}); });
  afterEach(() => resetHost());

  it("reads the module ids, the DNS providers and the non-standard count", () => {
    const m = parseCaddyModules(OUTPUT);
    expect(m.all).toContain("http.handlers.rate_limit");
    expect(m.all).not.toContain("Standard");
    expect(m.dnsProviders).toEqual(["cloudflare", "hetzner"]);
    expect(m.nonStandard).toBe(3);
    expect(parseCaddyModules("a.b\n").nonStandard).toBeUndefined();
  });

  it("says which optional features the modules give", () => {
    const caps = Object.fromEntries(moduleCapabilities(parseCaddyModules(OUTPUT)).map(c => [c.key, c.available]));
    expect(caps).toEqual({ dns: true, layer4: true, rate_limit: true, security: false });
    const stock = Object.fromEntries(moduleCapabilities(parseCaddyModules("http.handlers.reverse_proxy\n")).map(c => [c.key, c.available]));
    expect(stock).toEqual({ dns: false, layer4: false, rate_limit: false, security: false });
    expect(moduleCapabilities(parseCaddyModules("security\n")).find(c => c.key === "security")?.available).toBe(true);
  });

  it("asks the Caddy binary once and returns its modules", async () => {
    host.onRun(["caddy", "list-modules"], OUTPUT);
    expect((await listCaddyModules())?.dnsProviders).toEqual(["cloudflare", "hetzner"]);
    expect(host.commands.filter(c => c.startsWith("caddy list-modules"))).toHaveLength(1);
  });

  it("returns undefined when Caddy cannot be asked or says nothing", async () => {
    host.onRun(["caddy", "list-modules"], () => { throw new Error("not found"); });
    expect(await listCaddyModules()).toBeUndefined();
    host.onRun(["caddy", "list-modules"], "");
    expect(await listCaddyModules()).toBeUndefined();
  });

  it("reads what the installed caddy really prints", () => {
    let out = "";
    try { out = execFileSync("caddy", ["list-modules"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return; }
    const m = parseCaddyModules(out);
    expect(m.all).toContain("http.handlers.reverse_proxy");
    expect(m.all.every(id => /^[A-Za-z0-9_.-]+$/.test(id))).toBe(true);
  });
});
