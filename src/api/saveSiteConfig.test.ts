import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetHost } from "@rxtx4816/cockpit-plugin-base-react/host";
import { installFakeHost, type FakeHost } from "@rxtx4816/cockpit-plugin-base-react/testing/host";
import { saveSiteConfig, setCaddyManaged, CaddyfileError } from "./caddy";
import type { ProxyEntry } from "./types";

const MAIN = "/etc/caddy/Caddyfile";
const CONF = "/etc/caddy/conf.d/cockpit-caddy.conf";
const MAIN_BEFORE = '{\n\tadmin "unix//run/caddy/admin.socket"\n}\n\nimport /etc/caddy/conf.d/*\n';
const CONF_BEFORE = ":8080 {\n\treverse_proxy localhost:9000\n}\n";

const withTimeout: ProxyEntry = {
  id: "7700", serverKey: "srv0", externalPort: 7700, targetHost: "localhost", targetPort: 7701,
  targetScheme: "http", tls: false, tlsSkipVerify: false, label: undefined, serverReadTimeout: "30s",
};

let host: FakeHost;
beforeEach(() => {
  setCaddyManaged(true);
  host = installFakeHost({ [MAIN]: MAIN_BEFORE, [CONF]: CONF_BEFORE });
});
afterEach(() => resetHost());

// A site save changes the server-level timeouts in the main Caddyfile and the site in conf.d.
// Saved one after the other, a rejected conf.d left the new timeouts behind in the main file.
describe("saveSiteConfig", () => {
  it("writes the timeouts and the site, and validates once", async () => {
    host.onRun(["caddy", "validate"], "");
    await saveSiteConfig([withTimeout], ":7700 {\n\treverse_proxy localhost:7701\n}\n");
    expect(host.files.get(MAIN)).toContain("read_body 30s");
    expect(host.files.get(CONF)).toContain(":7700");
    expect(host.commands.filter(c => c.startsWith("caddy validate"))).toHaveLength(1);
  });

  it("leaves both files as they were when the config is rejected", async () => {
    host.onRun(["caddy", "validate"], () => { throw new Error("Error: port 7700 is already in use"); });
    await expect(saveSiteConfig([withTimeout], ":7700 {\n\treverse_proxy localhost:7701\n}\n")).rejects.toBeInstanceOf(CaddyfileError);
    expect(host.files.get(MAIN)).toBe(MAIN_BEFORE);
    expect(host.files.get(CONF)).toBe(CONF_BEFORE);
  });

  it("does not validate when nothing changes", async () => {
    await saveSiteConfig([], CONF_BEFORE);
    expect(host.commands.filter(c => c.startsWith("caddy validate"))).toHaveLength(0);
  });
});

// #328: the per-listener options go into the same `servers :PORT` block as the timeouts.
describe("saveSiteConfig server options (#328)", () => {
  it("writes keepalive, SNI, credential logging and full duplex into the port's servers block", async () => {
    host.onRun(["caddy", "validate"], "");
    const p: ProxyEntry = { ...withTimeout, serverReadTimeout: undefined, serverExtras: {
      keepaliveInterval: "30s", keepaliveIdle: "1m", readBodyIdle: "5s", strictSniHost: true, logCredentials: true, enableFullDuplex: true,
    } };
    await saveSiteConfig([p], ":7700 {\n\treverse_proxy localhost:7701\n}\n");
    const main = host.files.get(MAIN) ?? "";
    expect(main).toContain("servers :7700 {");
    for (const line of ["keepalive_interval 30s", "keepalive_idle 1m", "strict_sni_host", "log_credentials", "enable_full_duplex"]) {
      expect(main).toContain(line);
    }
    expect(main).toMatch(/timeouts \{\n\t+read_body_idle 5s\n/);
  });

  it("writes no servers block when none is set", async () => {
    host.onRun(["caddy", "validate"], "");
    await saveSiteConfig([{ ...withTimeout, serverReadTimeout: undefined }], ":7700 {\n\treverse_proxy localhost:7701\n}\n");
    expect(host.files.get(MAIN)).not.toContain("servers :7700");
  });
});
