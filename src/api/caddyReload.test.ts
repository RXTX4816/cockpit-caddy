import { describe, it, expect, afterEach } from "vitest";
import { applyCaddyfileViaApi, reloadCaddy, setCaddyManaged, CaddyfileError, pingCaddyApi } from "./caddy";
import { mockCockpitFile } from "@rxtx4816/cockpit-plugin-base-react/testing/helpers";
import { mockSpawn } from "../test/setup";

// Regression for the #188 follow-up: when Caddy has no local systemd unit
// (e.g. running in a container), validate/reload must go through the Admin
// API's /load endpoint (Content-Type: text/caddyfile) instead of shelling
// out to a local `caddy` binary or `systemctl`.
describe("applyCaddyfileViaApi / reloadCaddy", () => {
  afterEach(() => {
    mockSpawn.mockReset();
    setCaddyManaged(true);
  });

  it("POSTs the Caddyfile with Content-Type: text/caddyfile via curl", async () => {
    mockSpawn.mockImplementation((argv: string[]) => {
      if (argv[0] === "curl" && argv.some(a => a.includes("/config/"))) return Promise.resolve("{}");
      if (argv[0] === "curl" && argv.some(a => a.includes("/load"))) return Promise.resolve("\n200");
      return Promise.reject(new Error(`unexpected spawn: ${argv.join(" ")}`));
    });

    await pingCaddyApi(); // establishes the tcp transport
    await applyCaddyfileViaApi("example.com { respond \"hi\" }");

    const loadCall = mockSpawn.mock.calls.map(c => c[0] as string[]).find(argv => argv.some(a => a.includes("/load")));
    expect(loadCall).toBeDefined();
    const headerIdx = loadCall!.indexOf("-H");
    expect(loadCall![headerIdx + 1]).toBe("Content-Type: text/caddyfile");
  });

  it("throws a CaddyfileError with the Admin API's error message on rejection", async () => {
    mockSpawn.mockImplementation((argv: string[]) => {
      if (argv[0] === "curl" && argv.some(a => a.includes("/config/"))) return Promise.resolve("{}");
      if (argv[0] === "curl" && argv.some(a => a.includes("/load"))) {
        return Promise.resolve('{"error":"adapting config using caddyfile adapter: bad token"}\n400');
      }
      return Promise.reject(new Error(`unexpected spawn: ${argv.join(" ")}`));
    });

    await pingCaddyApi();
    await expect(applyCaddyfileViaApi("bad {")).rejects.toThrow(CaddyfileError);
    await expect(applyCaddyfileViaApi("bad {")).rejects.toThrow(/bad token/);
  });

  it("reloadCaddy uses systemctl reload when managed", async () => {
    setCaddyManaged(true);
    mockSpawn.mockImplementation((argv: string[]) => {
      if (argv[0] === "systemctl") return Promise.resolve("");
      return Promise.reject(new Error(`unexpected spawn: ${argv.join(" ")}`));
    });

    await reloadCaddy();

    expect(mockSpawn).toHaveBeenCalledWith(
      ["systemctl", "reload", "caddy"],
      expect.objectContaining({ superuser: "try" }),
    );
  });

  it("reloadCaddy applies via the Admin API when unmanaged", async () => {
    setCaddyManaged(false);
    (cockpit as unknown as { file: () => ReturnType<typeof mockCockpitFile> }).file =
      () => mockCockpitFile("example.com { }");
    mockSpawn.mockImplementation((argv: string[]) => {
      if (argv[0] === "systemctl") return Promise.reject(new Error("should not be called"));
      if (argv[0] === "find") return Promise.resolve("");
      if (argv[0] === "curl" && argv.some(a => a.includes("/config/"))) return Promise.resolve("{}");
      if (argv[0] === "curl" && argv.some(a => a.includes("/load"))) return Promise.resolve("\n200");
      return Promise.reject(new Error(`unexpected spawn: ${argv.join(" ")}`));
    });

    await pingCaddyApi();
    await reloadCaddy();

    const loadCall = mockSpawn.mock.calls.map(c => c[0] as string[]).find(argv => argv.some(a => a.includes("/load")));
    expect(loadCall).toBeDefined();
  });

  // Regression: Caddy's `/load` endpoint silently disallows `import` when the
  // Caddyfile is submitted directly over HTTP (no on-disk origin) — a
  // deliberate anti-SSRF safeguard. Confirmed live: posting a Caddyfile with
  // `import /etc/caddy/conf.d/*.conf` returns 200 OK, but the resulting config
  // has zero apps — proxies silently vanish. So conf.d content must be read
  // and inlined client-side before posting, never relying on Caddy's own
  // `import` resolution when unmanaged.
  it("inlines conf.d content instead of relying on Caddy's import when unmanaged", async () => {
    setCaddyManaged(false);
    const mainContent = "{\n\tadmin localhost:2019\n}\n\nimport /etc/caddy/conf.d/*.conf\n";
    const confDContent = "example.com {\n\treverse_proxy localhost:8080\n}";
    (cockpit as unknown as { file: (path: string) => ReturnType<typeof mockCockpitFile> }).file =
      (path: string) => mockCockpitFile(path.includes("conf.d") ? confDContent : mainContent);
    mockSpawn.mockImplementation((argv: string[]) => {
      if (argv[0] === "find") return Promise.resolve("/etc/caddy/conf.d/cockpit-caddy.conf\n");
      if (argv[0] === "curl" && argv.some(a => a.includes("/config/"))) return Promise.resolve("{}");
      if (argv[0] === "curl" && argv.some(a => a.includes("/load"))) return Promise.resolve("\n200");
      return Promise.reject(new Error(`unexpected spawn: ${argv.join(" ")}`));
    });

    await pingCaddyApi();
    await reloadCaddy();

    const loadCall = mockSpawn.mock.calls.map(c => c[0] as string[]).find(argv => argv.some(a => a.includes("/load")));
    expect(loadCall).toBeDefined();
    const postedBody = loadCall![loadCall!.indexOf("-d") + 1];
    expect(postedBody).not.toContain("import");
    expect(postedBody).toContain("example.com");
    expect(postedBody).toContain("reverse_proxy localhost:8080");
  });
});
