import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { resetHost } from "@rxtx4816/cockpit-plugin-base-react/host";
import { installFakeHost, type FakeHost } from "@rxtx4816/cockpit-plugin-base-react/testing/host";
import { listCaddyModules, listDnsProviders, moduleCapabilities, parseCaddyModules, probeCaddyModules, resetCaddyModulesCache, hasCapability } from "./caddyModules";
import { CaddyfileError, setCaddyManaged } from "./caddy";

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
  beforeEach(() => { host = installFakeHost({}); resetCaddyModulesCache(); setCaddyManaged(true); });
  afterEach(() => { resetHost(); resetCaddyModulesCache(); setCaddyManaged(true); });

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

  it("asks once for the Settings list and the DNS providers both (#361)", async () => {
    host.onRun(["caddy", "list-modules"], OUTPUT);
    await Promise.all([listCaddyModules(), listDnsProviders(), listDnsProviders()]);
    expect(await listDnsProviders()).toEqual(["cloudflare", "hetzner"]);
    expect(host.commands.filter(c => c.startsWith("caddy list-modules"))).toHaveLength(1);
  });

  it("says no DNS providers for a full list without one, and unknown when Caddy can't be asked", async () => {
    host.onRun(["caddy", "list-modules"], "http.handlers.reverse_proxy\n");
    expect(await listDnsProviders()).toEqual([]);
    resetCaddyModulesCache();
    setCaddyManaged(false);
    expect(await listDnsProviders({ refresh: true })).toBeNull();
  });

  it("reads what the installed caddy really prints", () => {
    let out = "";
    try { out = execFileSync("caddy", ["list-modules"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return; }
    const m = parseCaddyModules(out);
    expect(m.all).toContain("http.handlers.reverse_proxy");
    expect(m.all.every(id => /^[A-Za-z0-9_.-]+$/.test(id))).toBe(true);
  });
});

describe("module probes over the Admin API (#343)", () => {
  /** An adapter that knows the given modules, answering the way Caddy's /adapt does. */
  const caddyWith = (known: string[]) => async (caddyfile: string) => {
    const dns = caddyfile.match(/acme_dns (\S+)/)?.[1];
    if (dns && !known.includes(`dns.providers.${dns}`)) throw new CaddyfileError(`adapting config using caddyfile adapter: getting module named 'dns.providers.${dns}': module not registered: dns.providers.${dns}`);
    if (/^\{\n\tlayer4/.test(caddyfile) && !known.includes("layer4")) throw new CaddyfileError("adapting config using caddyfile adapter: Caddyfile:2: unrecognized global option: layer4");
    if (/^\{\n\tsecurity/.test(caddyfile) && !known.includes("security")) throw new CaddyfileError("adapting config using caddyfile adapter: Caddyfile:2: unrecognized global option: security");
    if (/rate_limit/.test(caddyfile) && !known.includes("rate_limit")) throw new CaddyfileError("adapting config using caddyfile adapter: unrecognized directive: rate_limit");
    // A module that is there may still complain about the empty probe config.
    if (/rate_limit/.test(caddyfile)) throw new CaddyfileError("adapting config using caddyfile adapter: zone must have a key");
  };

  it("finds the modules a Caddy has and the ones it lacks", async () => {
    const m = (await probeCaddyModules(caddyWith(["dns.providers.cloudflare", "rate_limit"])))!;
    expect(m.source).toBe("admin-api");
    expect(m.dnsProviders).toEqual(["cloudflare"]);
    expect(Object.fromEntries(moduleCapabilities(m).map(c => [c.key, c.available]))).toEqual({ dns: true, layer4: false, rate_limit: true, security: false });
  });

  it("leaves DNS unknown when no probed provider is there, since others may be", async () => {
    const m = (await probeCaddyModules(caddyWith([])))!;
    expect(hasCapability(m, "dns")).toBeUndefined();
    expect(hasCapability(m, "layer4")).toBe(false);
  });

  it("knows nothing when Caddy can't be reached, which is never missing", async () => {
    expect(await probeCaddyModules(async () => { throw new Error("curl: (7) Failed to connect"); })).toBeUndefined();
  });
});
