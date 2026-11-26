import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetHost } from "@rxtx4816/cockpit-plugin-base-react/host";
import { installFakeHost, type FakeHost } from "@rxtx4816/cockpit-plugin-base-react/testing/host";
import { setCaddyManaged, CaddyfileError } from "./caddy";
import { addSite, editSite, removeSite, liveChangeFor, needsCaddyfileReload, type SiteEditContext } from "./siteEditing";
import type { ProxyEntry, ServerDef } from "./types";

const MAIN = "/etc/caddy/Caddyfile";
const CONF = "/etc/caddy/conf.d/cockpit-caddy.conf";
const MAIN_BEFORE = '{\n\tadmin "unix//run/caddy/admin.socket"\n}\n\nimport /etc/caddy/conf.d/*\n';

function entry(port: number, over: Partial<ProxyEntry> = {}): Omit<ProxyEntry, "id" | "serverKey"> {
  return { externalPort: port, targetHost: "localhost", targetPort: port + 1, targetScheme: "http", tls: false, tlsSkipVerify: false, label: undefined, ...over };
}
function proxy(port: number, over: Partial<ProxyEntry> = {}): ProxyEntry {
  return { id: String(port), serverKey: `srv${port}`, ...entry(port, over) };
}
const ctx = (over: Partial<SiteEditContext> = {}): SiteEditContext => ({ config: {}, proxies: [], servers: [], ...over });

let host: FakeHost;
beforeEach(() => {
  setCaddyManaged(true);
  host = installFakeHost({ [MAIN]: MAIN_BEFORE, [CONF]: "" });
  host.onRun(["caddy", "validate"], "");
});
afterEach(() => resetHost());

describe("addSite (standalone)", () => {
  it("writes the site to conf.d, validates, and asks for a JSON push", async () => {
    const r = await addSite(ctx(), entry(7700));
    expect(host.files.get(CONF)).toContain(":7700");
    expect(r.live.kind).toBe("push");
    expect(r.site?.entry).toMatchObject({ id: "7700", serverKey: "srv7700" });
    expect(r.written).toContain(":7700");
  });

  it("asks for a reload when the site only Caddy's adapter can build (php_fastcgi)", async () => {
    const r = await addSite(ctx(), entry(7701, { phpFastcgi: { root: "/srv" } as ProxyEntry["phpFastcgi"] }));
    expect(r.live.kind).toBe("reload");
  });

  it("refuses a port a named server already listens on, and writes nothing", async () => {
    const def: ServerDef = { key: "web", name: "Web", listenAddresses: [":7700"], tls: false };
    await expect(addSite(ctx({ servers: [def] }), entry(7700))).rejects.toBeInstanceOf(CaddyfileError);
    expect(host.files.get(CONF)).toBe("");
  });

  it("leaves conf.d as it was when Caddy rejects the config", async () => {
    host.onRun(["caddy", "validate"], () => { throw new Error("Error: bad"); });
    await expect(addSite(ctx(), entry(7702))).rejects.toBeInstanceOf(CaddyfileError);
    expect(host.files.get(CONF)).toBe("");
  });
});

describe("addSite (named server)", () => {
  const def: ServerDef = { key: "web", name: "Web", listenAddresses: [":8443"], tls: false };

  it("numbers the route after the server's existing ones and keeps the label on the server", async () => {
    const existing = proxy(8443, { namedServerKey: "web", id: "web:0", serverKey: "web" });
    const r = await addSite(ctx({ servers: [def], proxies: [existing] }), entry(8443, { namedServerKey: "web", label: "second" }));
    expect(r.servers?.[0].routeLabels).toEqual({ "web:1": "second" });
    expect(host.files.get(CONF)).toContain("Web");
  });

  it("fails for a server that does not exist", async () => {
    await expect(addSite(ctx(), entry(8443, { namedServerKey: "nope" }))).rejects.toThrow("not found");
  });
});

describe("editSite (standalone)", () => {
  it("keeps the server key, recomputes the id and reports both address keys", async () => {
    const original = proxy(7710);
    await addSite(ctx(), entry(7710));
    const r = await editSite(ctx({ proxies: [original] }), { ...original, externalPort: 7711 });
    expect(r.site?.entry).toMatchObject({ id: "7711", serverKey: "srv7710" });
    expect(r.site?.originalKey).not.toBe(r.site?.key);
    expect(host.files.get(CONF)).toContain(":7711");
    expect(host.files.get(CONF)).not.toContain(":7710");
  });

  it("reloads when the matchers changed, since a live route's matchers cannot be patched", async () => {
    const original = proxy(7712);
    await addSite(ctx(), entry(7712));
    const r = await editSite(ctx({ proxies: [original] }), { ...original, matchers: { path: ["/api/*"] } as ProxyEntry["matchers"] });
    expect(r.live.kind).toBe("reload");
  });
});

describe("removeSite", () => {
  it("removes a standalone site from conf.d and reports its key", async () => {
    const p = proxy(7720);
    await addSite(ctx(), entry(7720));
    const r = await removeSite(ctx({ proxies: [p] }), p.id);
    expect(host.files.get(CONF)).not.toContain(":7720");
    expect(r?.removedKey).toBeDefined();
    expect(r?.live.kind).toBe("push");
  });

  it("does nothing for an unknown id", async () => {
    expect(await removeSite(ctx(), "nope")).toBeUndefined();
  });

  it("removes a named server's last route together with the server", async () => {
    const def: ServerDef = { key: "web", name: "Web", listenAddresses: [":8443"], tls: false };
    const route = proxy(8443, { namedServerKey: "web", id: "web:0", serverKey: "web" });
    const r = await removeSite(ctx({ servers: [def], proxies: [route] }), "web:0");
    expect(r?.servers).toEqual([]);
  });
});

describe("liveChangeFor", () => {
  it("reloads when any listed site relies on the Caddyfile's own TLS automation", () => {
    const acme = proxy(7730, { tls: true, tlsIssuer: "acme" });
    expect(liveChangeFor([acme], {}).kind).toBe("reload");
    expect(liveChangeFor([proxy(7731)], { apps: {} }).kind).toBe("push");
  });
});

describe("needsCaddyfileReload for a site with nested blocks (#348)", () => {
  it("reloads instead of pushing the form's single target over the blocks", () => {
    const base = { id: "x", serverKey: "x", externalHost: "example.com", externalPort: 443, targetHost: "", targetPort: 0, targetScheme: "http", tls: true, tlsSkipVerify: false } as ProxyEntry;
    const nested = "example.com {\n\troute {\n\t\thandle /api/* {\n\t\t\treverse_proxy api:8080\n\t\t}\n\t}\n}";
    expect(needsCaddyfileReload({ ...base, siteText: nested })).toBe(true);
    expect(needsCaddyfileReload({ ...base, siteText: "example.com {\n\treverse_proxy web:3000\n}" })).toBe(false);
  });
});
