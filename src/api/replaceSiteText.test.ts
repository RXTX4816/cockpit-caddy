import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetHost } from "@rxtx4816/cockpit-plugin-base-react/host";
import { installFakeHost, type FakeHost } from "@rxtx4816/cockpit-plugin-base-react/testing/host";
import { setCaddyManaged, CaddyfileError } from "./caddy";
import { replaceSiteText } from "./siteEditing";
import type { ProxyEntry } from "./types";

const MAIN = "/etc/caddy/Caddyfile";
const CONF = "/etc/caddy/conf.d/cockpit-caddy.conf";
const MAIN_BEFORE = "{\n}\n\nimport /etc/caddy/conf.d/*\n";
const SITE = "example.com:8443 {\n\troute {\n\t\thandle /a/* {\n\t\t\trespond ok\n\t\t}\n\t}\n}";
const OTHER = ":9000 {\n\treverse_proxy localhost:9001\n}";
const CONF_BEFORE = `# header\n\n# label: App\n${SITE}\n\n${OTHER}\n`;
const proxy = { id: "x", serverKey: "srv0", externalPort: 8443, externalHost: "example.com", targetHost: "localhost", targetPort: 1, targetScheme: "http", tls: false, tlsSkipVerify: false } as ProxyEntry;

describe("replaceSiteText (#350)", () => {
  let host: FakeHost;
  beforeEach(() => {
    setCaddyManaged(true);
    host = installFakeHost({ [MAIN]: MAIN_BEFORE, [CONF]: CONF_BEFORE });
  });
  afterEach(() => resetHost());

  it("replaces the site's block, validates once, and leaves the label and other sites alone", async () => {
    host.onRun(["caddy", "validate"], "");
    const edited = SITE.replace("/a/*", "/b/*");
    const result = await replaceSiteText(proxy, edited, SITE);
    expect(result.live).toEqual({ kind: "reload" });
    expect(host.files.get(CONF)).toBe(CONF_BEFORE.replace(SITE, edited));
    expect(host.commands.filter(c => c.startsWith("caddy validate"))).toHaveLength(1);
  });

  it("keeps the file as it was when Caddy rejects the config", async () => {
    host.onRun(["caddy", "validate"], () => { throw new Error("Error: unrecognized directive"); });
    await expect(replaceSiteText(proxy, SITE.replace("respond ok", "nonsense"), SITE)).rejects.toBeInstanceOf(CaddyfileError);
    expect(host.files.get(CONF)).toBe(CONF_BEFORE);
  });

  it("says so when the site is not in the file", async () => {
    await expect(replaceSiteText({ ...proxy, externalPort: 1234 }, SITE, SITE)).rejects.toThrow(/not found/);
    expect(host.files.get(CONF)).toBe(CONF_BEFORE);
  });

  it("finds the block by the host matcher, as the form's edit does (#362)", async () => {
    host.onRun(["caddy", "validate"], "");
    // A site whose host is in its matchers, not in its address.
    const matched = { ...proxy, externalHost: undefined, matchers: { host: ["example.com"] } } as ProxyEntry;
    await replaceSiteText(matched, SITE.replace("/a/*", "/b/*"), SITE);
    expect(host.files.get(CONF)).toContain("handle /b/*");
  });

  it("writes nothing when the block changed since the tab read it (#362)", async () => {
    const newer = SITE.replace("respond ok", "respond newer");
    host.files.set(CONF, CONF_BEFORE.replace(SITE, newer));
    await expect(replaceSiteText(proxy, SITE.replace("/a/*", "/b/*"), SITE)).rejects.toThrow(/changed/);
    expect(host.files.get(CONF)).toContain("respond newer");
  });
});
