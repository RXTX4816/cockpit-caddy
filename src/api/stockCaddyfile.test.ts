import { describe, it, expect } from "vitest";
import arch from "../test/fixtures/arch.Caddyfile?raw";
import debian from "../test/fixtures/debian.Caddyfile?raw";
import fedora from "../test/fixtures/fedora.Caddyfile?raw";
import {
  isStockCaddyfile, migrateStockCaddyfile, CONF_HEADER, CONF_D_IMPORT_LINE,
  parseLabelsFromCaddyfile, proxyAddressKeys, surgicallyRemoveBlock,
} from "./caddy";

describe("isStockCaddyfile (#256)", () => {
  it.each([["arch", arch], ["debian", debian], ["fedora", fedora]])("the %s package's Caddyfile is stock", (_, content) => {
    expect(isStockCaddyfile(content)).toBe(true);
  });

  it("accepts http://:80, root without a matcher and any order", () => {
    expect(isStockCaddyfile("http://:80 {\n\tfile_server\n\troot /usr/share/caddy\n}\n")).toBe(true);
  });

  it("is not stock with an extra directive", () => {
    expect(isStockCaddyfile(arch.replace("\tfile_server\n", "\tfile_server\n\tencode gzip\n"))).toBe(false);
  });

  it("is not stock with a second site", () => {
    expect(isStockCaddyfile(debian + "\nexample.com {\n\treverse_proxy localhost:8080\n}\n")).toBe(false);
  });

  it("is not stock with a different root", () => {
    expect(isStockCaddyfile(fedora.replace("/usr/share/caddy", "/srv/www"))).toBe(false);
  });

  it("is not stock on another address", () => {
    expect(isStockCaddyfile(debian.replace(":80 {", ":8080 {"))).toBe(false);
    expect(isStockCaddyfile(debian.replace(":80 {", "example.com {"))).toBe(false);
  });

  it("is not stock with file_server browse or a duplicated directive", () => {
    expect(isStockCaddyfile(debian.replace("\tfile_server\n", "\tfile_server browse\n"))).toBe(false);
    expect(isStockCaddyfile(debian.replace("\tfile_server\n", "\tfile_server\n\tfile_server\n"))).toBe(false);
  });

  it("is not stock with a snippet next to the welcome site", () => {
    expect(isStockCaddyfile(debian + "\n(common) {\n\tencode gzip\n}\n")).toBe(false);
  });

  it("is not stock when there is no site at all", () => {
    expect(isStockCaddyfile("{\n\tadmin off\n}\nimport /etc/caddy/conf.d/*\n")).toBe(false);
    expect(isStockCaddyfile("")).toBe(false);
  });
});

describe("migrateStockCaddyfile (#256)", () => {
  it("moves the welcome site into conf.d under the given label and keeps the global options", () => {
    const { caddyfile, confD } = migrateStockCaddyfile(arch, "", "Distro welcome page");
    expect(caddyfile).toContain('admin "unix//run/caddy/admin.socket"');
    expect(caddyfile).toContain("import /etc/caddy/conf.d/*");
    expect(caddyfile).not.toContain("root * /usr/share/caddy");
    expect(confD.startsWith(CONF_HEADER)).toBe(true);
    expect(confD).toContain("# label: Distro welcome page\nhttp:// {");
    expect(confD).toContain("\troot * /usr/share/caddy");
  });

  it("adds the plugin's import when the distro file has no conf.d import", () => {
    const { caddyfile } = migrateStockCaddyfile(debian, "", "Distro welcome page");
    expect(caddyfile).toContain(CONF_D_IMPORT_LINE);
    expect(caddyfile).not.toContain(":80 {");
  });

  it("appends to an existing conf.d without touching it", () => {
    const existing = `${CONF_HEADER}\n\n# label: App\n:8080 {\n\treverse_proxy localhost:3000\n}\n`;
    const { confD } = migrateStockCaddyfile(fedora, existing, "Distro welcome page");
    expect(confD.startsWith(existing.trimEnd())).toBe(true);
    expect(confD).toContain("# label: Distro welcome page\nhttp:// {");
  });
});

describe("the moved welcome site is an ordinary conf.d site (#256)", () => {
  const { confD } = migrateStockCaddyfile(arch, "", "Distro welcome page");
  const welcome = { externalPort: 80, tls: false } as const;

  it("its label is found under the proxy's address keys", () => {
    const labels = parseLabelsFromCaddyfile(confD);
    expect(proxyAddressKeys(welcome).map(k => labels[k]).find(Boolean)).toBe("Distro welcome page");
  });

  it("can be removed by port", () => {
    const out = surgicallyRemoveBlock(confD, 80);
    expect(out).not.toContain("http:// {");
    expect(out).not.toContain("Distro welcome page");
  });
});
