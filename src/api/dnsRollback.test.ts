import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockSpawn, mockHttp } from "../test/setup";
import { resetHost } from "@rxtx4816/cockpit-plugin-base-react/host";
import type { FakeHost } from "@rxtx4816/cockpit-plugin-base-react/testing/host";
import { installDnsHost } from "../test/dnsHost";
import { syncGlobalOptions, saveWithDnsSecrets, CaddyfileError, CaddyApiError } from "./caddy";
import { DNS_ENV_PATH, DNS_DROPIN_PATH } from "./dnsChallenge";

// #316: a Settings save that fails validation must leave dns.env as it was before the save.
const CADDYFILE = '{\n\tadmin "unix//run/caddy/admin.socket"\n}\n\nimport /etc/caddy/conf.d/*\n';
const SECRET = "n3w-s3cr3t";
const OLD = "0ld-v4lue";

let host: FakeHost;

beforeEach(() => {
  host = installDnsHost({ "/etc/caddy/Caddyfile": CADDYFILE });
  // Only the Admin API goes through cockpit directly: there is none here.
  mockSpawn.mockReset();
  mockSpawn.mockImplementation(() => Promise.reject(new Error("no admin API")));
  mockHttp.mockImplementation(() => { throw new Error("no admin API"); });
  // `caddy validate` rejects the config and says why on its output.
  host.onRun(["caddy", "validate"], () => { throw new Error("Error: bad config"); });
});
afterEach(() => resetHost());

const opts = { acmeDns: { provider: "cloudflare", credentials: { api_token: "CADDY_DNS_API_TOKEN" } } };
const argvs = () => host.commands;

describe("failed Settings save and the DNS env file (#316)", () => {
  it("puts the env file back as it was", async () => {
    const before = `CADDY_DNS_API_TOKEN="${OLD}"\nOTHER="keep"\n`;
    host.files.set(DNS_ENV_PATH, before);
    host.files.set(DNS_DROPIN_PATH, "dropin");
    await expect(syncGlobalOptions(opts, { set: { CADDY_DNS_API_TOKEN: SECRET }, remove: [] })).rejects.toBeInstanceOf(CaddyfileError);
    expect(host.files.get(DNS_ENV_PATH)).toBe(before);
    expect(host.files.get(DNS_DROPIN_PATH)).toBeDefined();
    expect(host.files.get("/etc/caddy/Caddyfile")).toBe(CADDYFILE);
    const writes = argvs().filter(c => c.includes(`> ${DNS_ENV_PATH}.tmp`));
    expect(writes).toHaveLength(2); // the new values, then the old ones back
    expect(writes[1]).toContain("chmod 600");
    expect(writes[1]).toContain("chown root:root");
    const all = argvs().join("\n");
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(OLD);
  });

  it("removes the file and the drop-in it created, and reloads systemd", async () => {
    await expect(syncGlobalOptions(opts, { set: { CADDY_DNS_API_TOKEN: SECRET }, remove: [] })).rejects.toThrow();
    expect(host.files.get(DNS_ENV_PATH)).toBeUndefined();
    expect(host.files.get(DNS_DROPIN_PATH)).toBeUndefined();
    const all = argvs();
    const lastRm = all.map((c, i) => (c.startsWith("rm ") ? i : -1)).filter(i => i >= 0).pop()!;
    expect(all.slice(lastRm + 1)).toContain("systemctl daemon-reload");
    expect(all.join("\n")).not.toContain(SECRET);
  });
});

describe("saveWithDnsSecrets: per-site credentials around a site save (#289)", () => {
  const SITE_VAR = "CADDY_DNS_SITE_A_1_API_TOKEN";

  it("writes the values, restarts Caddy before the save, and removes the old variables after it", async () => {
    host.files.set(DNS_ENV_PATH, 'CADDY_DNS_SITE_A_1_OLD="x"\n');
    host.files.set(DNS_DROPIN_PATH, "dropin");
    const order: string[] = [];
    host.calls.length = 0;
    await saveWithDnsSecrets({ set: { [SITE_VAR]: SECRET }, remove: ["CADDY_DNS_SITE_A_1_OLD"] }, async () => {
      order.push(...argvs());
      order.push("save");
    });
    expect(host.files.get(DNS_ENV_PATH)).toBe(`${SITE_VAR}="${SECRET}"\n`);
    const restartAt = order.findIndex(c => c.startsWith("systemctl restart"));
    expect(restartAt).toBeGreaterThanOrEqual(0);
    expect(restartAt).toBeLessThan(order.indexOf("save"));
    expect(argvs().join("\n")).not.toContain(SECRET);
  });

  it("restores the env file when the save fails, and rethrows", async () => {
    const before = `OTHER="keep"\n`;
    host.files.set(DNS_ENV_PATH, before);
    host.files.set(DNS_DROPIN_PATH, "dropin");
    await expect(saveWithDnsSecrets({ set: { [SITE_VAR]: SECRET }, remove: [] }, async () => {
      throw new CaddyfileError("bad");
    })).rejects.toThrow("bad");
    expect(host.files.get(DNS_ENV_PATH)).toBe(before);
  });

  it("keeps the values when only the API push failed (the Caddyfile is saved)", async () => {
    await expect(saveWithDnsSecrets({ set: { [SITE_VAR]: SECRET }, remove: [] }, async () => {
      throw new CaddyApiError("push failed");
    })).rejects.toThrow();
    expect(host.files.get(DNS_ENV_PATH)).toBe(`${SITE_VAR}="${SECRET}"\n`);
  });

  it("neither touches the env file nor restarts without credentials to change", async () => {
    await saveWithDnsSecrets({ set: {}, remove: [] }, async () => {});
    await saveWithDnsSecrets(undefined, async () => {});
    expect(argvs()).toEqual([]);
  });
});
