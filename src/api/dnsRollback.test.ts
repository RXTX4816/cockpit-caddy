import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockSpawn, mockHttp, mockUser } from "../test/setup";
import { syncGlobalOptions, CaddyfileError } from "./caddy";
import { DNS_ENV_PATH, DNS_DROPIN_PATH } from "./dnsChallenge";

// #316: a Settings save that fails validation must leave dns.env as it was before the save.
const CADDYFILE = '{\n\tadmin "unix//run/caddy/admin.socket"\n}\n\nimport /etc/caddy/conf.d/*\n';
const SECRET = "n3w-s3cr3t";
const OLD = "0ld-v4lue";

let files: Record<string, string>;

beforeEach(() => {
  files = { "/etc/caddy/Caddyfile": CADDYFILE };
  vi.stubGlobal("cockpit", {
    spawn: mockSpawn, http: mockHttp, user: mockUser,
    file: (path: string) => ({
      read: async () => files[path] ?? null,
      replace: async (content: string) => { files[path] = content; },
    }),
  });
  mockSpawn.mockReset();
  mockHttp.mockImplementation(() => { throw new Error("no admin API"); });
  mockSpawn.mockImplementation((args: string[]) => {
    let input = "";
    const p = Promise.resolve().then(() => {
      const cmd = args.join(" ");
      if (args[0] === "cat") {
        if (!(args[2] in files)) throw new Error("missing");
        return files[args[2]];
      }
      if (args[0] === "test") {
        if (!(args[2] in files)) throw new Error("missing");
        return "";
      }
      if (args[0] === "caddy" && args[1] === "validate") throw new Error("exit 1");
      if (cmd.includes(`> ${DNS_ENV_PATH}.tmp`)) files[DNS_ENV_PATH] = input;
      if (cmd.includes(`> ${DNS_DROPIN_PATH}`)) files[DNS_DROPIN_PATH] = input;
      if (args[0] === "rm") for (const f of args.slice(2)) delete files[f];
      return "";
    });
    return Object.assign(p, {
      input: (d: string) => { input = d; },
      stream: (cb: (s: string) => void) => { if (args[1] === "validate") cb("Error: bad config\n"); return p; },
    });
  });
});

const opts = { acmeDns: { provider: "cloudflare", credentials: { api_token: "CADDY_DNS_API_TOKEN" } } };
const argvs = () => mockSpawn.mock.calls.map(c => (c[0] as string[]).join(" "));

describe("failed Settings save and the DNS env file (#316)", () => {
  it("puts the env file back as it was", async () => {
    const before = `CADDY_DNS_API_TOKEN="${OLD}"\nOTHER="keep"\n`;
    files[DNS_ENV_PATH] = before;
    files[DNS_DROPIN_PATH] = "dropin";
    await expect(syncGlobalOptions(opts, { set: { CADDY_DNS_API_TOKEN: SECRET }, remove: [] })).rejects.toBeInstanceOf(CaddyfileError);
    expect(files[DNS_ENV_PATH]).toBe(before);
    expect(files[DNS_DROPIN_PATH]).toBeDefined();
    expect(files["/etc/caddy/Caddyfile"]).toBe(CADDYFILE);
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
    expect(files[DNS_ENV_PATH]).toBeUndefined();
    expect(files[DNS_DROPIN_PATH]).toBeUndefined();
    const all = argvs();
    const lastRm = all.map((c, i) => (c.startsWith("rm ") ? i : -1)).filter(i => i >= 0).pop()!;
    expect(all.slice(lastRm + 1)).toContain("systemctl daemon-reload");
    expect(all.join("\n")).not.toContain(SECRET);
  });
});
