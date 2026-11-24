import { describe, it, expect, beforeEach } from "vitest";
import { mockSpawn } from "../test/setup";
import { buildGlobalOptionsPatch, parseGlobalOptions } from "./caddy";
import {
  parseDnsProviders, dnsEnvVarName, formatEnvFile, parseEnvFile, applyDnsSecrets, DNS_ENV_PATH, DNS_DROPIN_PATH,
} from "./dnsChallenge";

const BASE = '{\n\tadmin "unix//run/caddy/admin.socket"\n}\n\nimport /etc/caddy/conf.d/*\n';

describe("acme_dns global option (#261)", () => {
  it("writes env references only and parses them back", () => {
    const acmeDns = { provider: "cloudflare", credentials: { api_token: "CADDY_DNS_API_TOKEN" } };
    const out = buildGlobalOptionsPatch(BASE, { acmeDns });
    expect(out).toContain("\tacme_dns cloudflare {\n\t\tapi_token {env.CADDY_DNS_API_TOKEN}\n\t}");
    expect(parseGlobalOptions(out).acmeDns).toEqual(acmeDns);
  });

  it("a provider without credentials is a single line", () => {
    const out = buildGlobalOptionsPatch(BASE, { acmeDns: { provider: "duckdns", credentials: {} } });
    expect(out).toContain("\tacme_dns duckdns\n");
    expect(parseGlobalOptions(out).acmeDns).toEqual({ provider: "duckdns", credentials: {} });
  });

  it("removing it drops the block", () => {
    const withDns = buildGlobalOptionsPatch(BASE, { acmeDns: { provider: "cloudflare", credentials: { api_token: "CADDY_DNS_API_TOKEN" } } });
    expect(buildGlobalOptionsPatch(withDns, {})).not.toContain("acme_dns");
  });

  it("reads a hand-written block with a literal value without exposing it as an env name", () => {
    const hand = '{\n\tacme_dns cloudflare {\n\t\tapi_token abc123\n\t\tzone_token {env.CF_ZONE}\n\t}\n}\n';
    expect(parseGlobalOptions(hand).acmeDns).toEqual({
      provider: "cloudflare", credentials: { zone_token: "CF_ZONE" }, literal: { api_token: "abc123" },
    });
    // Saved back unchanged, it keeps the literal where it was.
    expect(buildGlobalOptionsPatch(hand, { acmeDns: parseGlobalOptions(hand).acmeDns })).toContain("\t\tapi_token abc123\n");
  });
});

describe("DNS provider modules", () => {
  it("lists the dns.providers.* modules of `caddy list-modules`", () => {
    const out = "admin.api.load\ndns.providers.cloudflare\ndns.providers.hetzner\nhttp.handlers.file_server\n\n  Standard modules: 120\n";
    expect(parseDnsProviders(out)).toEqual(["cloudflare", "hetzner"]);
    expect(parseDnsProviders("http.handlers.file_server\n")).toEqual([]);
  });
});

describe("credential env file", () => {
  it("names variables per key, and per site without clashing", () => {
    expect(dnsEnvVarName("api_token")).toBe("CADDY_DNS_API_TOKEN");
    expect(dnsEnvVarName("api-token")).toBe("CADDY_DNS_API_TOKEN");
    expect(dnsEnvVarName("api_token", "*.example.com")).toMatch(/^CADDY_DNS_SITE_WILDCARD_EXAMPLE_COM_[A-Z0-9]+_API_TOKEN$/);
    expect(dnsEnvVarName("api_token", "a.example.com")).not.toBe(dnsEnvVarName("api_token", "a-example.com"));
  });

  it("formats and parses systemd EnvironmentFile lines, quoting what needs it", () => {
    const vars = { CADDY_DNS_API_TOKEN: 'ab"c\\d$e', OTHER: "plain" };
    const text = formatEnvFile(vars);
    expect(text).toContain('CADDY_DNS_API_TOKEN="ab\\"c\\\\d$e"');
    expect(parseEnvFile(text)).toEqual(vars);
    expect(parseEnvFile("# comment\n\nA=1\nB='two'\n")).toEqual({ A: "1", B: "two" });
  });
});

describe("applyDnsSecrets", () => {
  let files: Record<string, string>;
  beforeEach(() => {
    files = {};
    mockSpawn.mockReset();
    mockSpawn.mockImplementation((args: string[]) => {
      let input = "";
      const p = Promise.resolve().then(() => {
        const cmd = args.join(" ");
        if (args[0] === "cat") {
          if (!(args[2] in files)) throw new Error("missing");
          return files[args[2]];
        }
        if (cmd.includes(`> ${DNS_ENV_PATH}.tmp`)) files[DNS_ENV_PATH] = input;
        if (cmd.includes(`> ${DNS_DROPIN_PATH}`)) files[DNS_DROPIN_PATH] = input;
        if (args[0] === "rm") for (const f of args.slice(2)) delete files[f];
        return "";
      });
      return Object.assign(p, { input: (d: string) => { input = d; } });
    });
  });

  const argvs = () => mockSpawn.mock.calls.map(c => (c[0] as string[]).join(" "));

  it("writes values root-only through stdin, adds the drop-in and reloads systemd", async () => {
    const r = await applyDnsSecrets({ CADDY_DNS_API_TOKEN: "s3cr3t" }, []);
    expect(r.changed).toBe(true);
    expect(files[DNS_ENV_PATH]).toBe('CADDY_DNS_API_TOKEN="s3cr3t"\n');
    expect(files[DNS_DROPIN_PATH]).toContain(`EnvironmentFile=-${DNS_ENV_PATH}`);
    const all = argvs().join("\n");
    expect(all).toContain("umask 077");
    expect(all).toContain(`chmod 600 ${DNS_ENV_PATH}`);
    expect(all).toContain("chown root:root");
    expect(all).toContain("systemctl daemon-reload");
    // The secret travels on stdin only, never in a command line.
    expect(all).not.toContain("s3cr3t");
    for (const c of mockSpawn.mock.calls) expect((c[1] as { superuser?: string }).superuser).toBe("require");
  });

  it("keeps other variables and drops the removed ones", async () => {
    files[DNS_ENV_PATH] = 'CADDY_DNS_SITE_X_TOKEN="keep"\nCADDY_DNS_API_TOKEN="old"\n';
    files[DNS_DROPIN_PATH] = "x";
    await applyDnsSecrets({}, ["CADDY_DNS_API_TOKEN"]);
    expect(files[DNS_ENV_PATH]).toBe('CADDY_DNS_SITE_X_TOKEN="keep"\n');
  });

  it("removes the file and the drop-in when nothing is left", async () => {
    files[DNS_ENV_PATH] = 'CADDY_DNS_API_TOKEN="old"\n';
    files[DNS_DROPIN_PATH] = "x";
    const r = await applyDnsSecrets({}, ["CADDY_DNS_API_TOKEN"]);
    expect(r.changed).toBe(true);
    expect(files).toEqual({});
    expect(argvs().join("\n")).toContain("systemctl daemon-reload");
  });

  it("changes nothing when there is nothing to set or remove", async () => {
    files[DNS_ENV_PATH] = 'A="1"\n';
    files[DNS_DROPIN_PATH] = "x";
    expect((await applyDnsSecrets({}, ["NOT_THERE"])).changed).toBe(false);
  });

  it("rejects a value with a line break", async () => {
    await expect(applyDnsSecrets({ A: "x\ny" }, [])).rejects.toThrow();
  });
});
