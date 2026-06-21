import { describe, it, expect } from "vitest";
import {
  parseLabelsFromCaddyfile,
  parseLegacyLabelsFromCaddyfile,
  parseConfTlsMap,
  extractRawBlocksFromCaddyfile,
  buildMigratedConfContent,
  proxyToBlock,
  surgicallyReplaceBlock,
  surgicallyRemoveBlock,
  surgicallyWriteProxy,
} from "./caddy";
import type { ProxyEntry } from "./types";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const SIMPLE_CONF = `# Managed by cockpit-caddy - do not edit manually

# label: homarr
:7700 {
\ttls internal
\treverse_proxy http://localhost:7701
}

# label: jellyfin
:8096 {
\treverse_proxy http://localhost:8097
}
`;

const MIGRATED_CONF = `# label: homarr
https://jellyfin.speedport.ip:7700 {
\t# homarr
\ttls internal
\treverse_proxy localhost:8998
}

:8096 {
\treverse_proxy http://localhost:8097
}
`;

const proxy = (overrides: Partial<ProxyEntry> = {}): ProxyEntry => ({
  id: "7700",
  serverKey: "srv0",
  externalPort: 7700,
  targetHost: "localhost",
  targetPort: 7701,
  targetScheme: "http",
  tls: false,
  tlsSkipVerify: false,
  label: undefined,
  ...overrides,
});

// ---------------------------------------------------------------------------
// parseLabelsFromCaddyfile
// ---------------------------------------------------------------------------

describe("parseLabelsFromCaddyfile", () => {
  it("reads labels above :PORT blocks", () => {
    expect(parseLabelsFromCaddyfile(SIMPLE_CONF)).toEqual({ 7700: "homarr", 8096: "jellyfin" });
  });

  it("reads labels above https://host:PORT blocks", () => {
    const conf = `# label: myapp\nhttps://host.lan:7700 {\n\treverse_proxy localhost:8080\n}\n`;
    expect(parseLabelsFromCaddyfile(conf)).toEqual({ 7700: "myapp" });
  });

  it("ignores blocks without a label comment", () => {
    const conf = `:7700 {\n\treverse_proxy http://localhost:8080\n}\n`;
    expect(parseLabelsFromCaddyfile(conf)).toEqual({});
  });

  it("tolerates a blank line between label comment and block", () => {
    // Parser is lenient: blank lines do not clear the pending label since we
    // never generate blank lines between label and block header ourselves.
    const conf = `# label: orphan\n\n:7700 {\n\treverse_proxy http://localhost:8080\n}\n`;
    expect(parseLabelsFromCaddyfile(conf)).toEqual({ 7700: "orphan" });
  });
});

// ---------------------------------------------------------------------------
// parseLegacyLabelsFromCaddyfile (label inside block as first comment)
// ---------------------------------------------------------------------------

describe("parseLegacyLabelsFromCaddyfile", () => {
  it("reads inline label comment inside block", () => {
    const conf = `https://host.lan:7700 {\n\t# homarr\n\ttls internal\n\treverse_proxy localhost:8998\n}\n`;
    expect(parseLegacyLabelsFromCaddyfile(conf)).toEqual({ 7700: "homarr" });
  });

  it("returns empty when no inline comments", () => {
    expect(parseLegacyLabelsFromCaddyfile(SIMPLE_CONF)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// parseConfTlsMap
// ---------------------------------------------------------------------------

describe("parseConfTlsMap", () => {
  it("detects tls from https:// block header", () => {
    const conf = `https://host.lan:7700 {\n\treverse_proxy localhost:8998\n}\n`;
    expect(parseConfTlsMap(conf)).toEqual({ 7700: true });
  });

  it("detects tls internal directive", () => {
    const conf = `:7700 {\n\ttls internal\n\treverse_proxy http://localhost:8998\n}\n`;
    expect(parseConfTlsMap(conf)).toEqual({ 7700: true });
  });

  it("detects tls with email argument", () => {
    const conf = `:7700 {\n\ttls admin@example.com\n\treverse_proxy http://localhost:8998\n}\n`;
    expect(parseConfTlsMap(conf)).toEqual({ 7700: true });
  });

  it("does not flag tls off as enabled", () => {
    const conf = `:7700 {\n\ttls off\n\treverse_proxy http://localhost:8998\n}\n`;
    expect(parseConfTlsMap(conf)).toEqual({ 7700: false });
  });

  it("does not confuse tls_ prefixed directives", () => {
    const conf = `:7700 {\n\treverse_proxy http://localhost:8998 {\n\t\ttransport http {\n\t\t\ttls_insecure_skip_verify\n\t\t}\n\t}\n}\n`;
    expect(parseConfTlsMap(conf)).toEqual({ 7700: false });
  });

  it("handles mixed blocks", () => {
    expect(parseConfTlsMap(MIGRATED_CONF)).toEqual({ 7700: true, 8096: false });
  });
});

// ---------------------------------------------------------------------------
// extractRawBlocksFromCaddyfile
// ---------------------------------------------------------------------------

describe("extractRawBlocksFromCaddyfile", () => {
  it("extracts port and raw text verbatim", () => {
    const conf = `https://host.lan:7700 {\n\ttls internal\n\treverse_proxy localhost:8998\n}\n`;
    const blocks = extractRawBlocksFromCaddyfile(conf);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].port).toBe(7700);
    expect(blocks[0].raw).toBe(`https://host.lan:7700 {\n\ttls internal\n\treverse_proxy localhost:8998\n}`);
  });

  it("skips global option blocks (no port match)", () => {
    const conf = `{\n\tadmin off\n}\n:7700 {\n\treverse_proxy http://localhost:8080\n}\n`;
    const blocks = extractRawBlocksFromCaddyfile(conf);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].port).toBe(7700);
  });

  it("extracts inline label from first comment line inside block", () => {
    const conf = `https://host.lan:7700 {\n\t# homarr\n\treverse_proxy localhost:8998\n}\n`;
    const blocks = extractRawBlocksFromCaddyfile(conf);
    expect(blocks[0].label).toBe("homarr");
  });

  it("returns null label when no first-line comment", () => {
    const conf = `:7700 {\n\treverse_proxy http://localhost:8080\n}\n`;
    const blocks = extractRawBlocksFromCaddyfile(conf);
    expect(blocks[0].label).toBeNull();
  });

  it("handles multiple blocks", () => {
    const blocks = extractRawBlocksFromCaddyfile(MIGRATED_CONF);
    expect(blocks.map(b => b.port)).toEqual([7700, 8096]);
  });
});

// ---------------------------------------------------------------------------
// buildMigratedConfContent
// ---------------------------------------------------------------------------

describe("buildMigratedConfContent", () => {
  it("preserves verbatim block content with label above", () => {
    const conf = `https://host.lan:7700 {\n\t# homarr\n\ttls internal\n\treverse_proxy localhost:8998\n}\n`;
    const blocks = extractRawBlocksFromCaddyfile(conf);
    const result = buildMigratedConfContent(blocks);
    expect(result).toContain("https://host.lan:7700 {");
    expect(result).toContain("tls internal");
    expect(result).toContain("reverse_proxy localhost:8998");
    expect(result).toContain("# label: homarr");
  });

  it("does not reformat or simplify the block header", () => {
    const conf = `https://host.lan:7700 {\n\ttls internal\n\treverse_proxy localhost:8998\n}\n`;
    const blocks = extractRawBlocksFromCaddyfile(conf);
    const result = buildMigratedConfContent(blocks);
    // Block header must be the full https://host:PORT form, not simplified to :PORT
    expect(result).not.toMatch(/^:7700\s*\{/m);
    expect(result).toContain("https://host.lan:7700 {");
  });
});

// ---------------------------------------------------------------------------
// proxyToBlock
// ---------------------------------------------------------------------------

describe("proxyToBlock", () => {
  it("generates :PORT format block", () => {
    const result = proxyToBlock(proxy({ tls: true, label: "myapp" }));
    expect(result.split("\n")[0]).toBe("# label: myapp");
    expect(result).toContain(":7700 {");
    expect(result).toContain("tls internal");
    expect(result).toContain("reverse_proxy http://localhost:7701");
  });

  it("omits label line when no label", () => {
    const result = proxyToBlock(proxy());
    expect(result.split("\n")[0]).toBe(":7700 {");
  });

  it("uses https upstream when targetScheme is https", () => {
    const result = proxyToBlock(proxy({ targetScheme: "https" }));
    expect(result).toContain("reverse_proxy https://localhost:7701");
    expect(result).not.toContain("transport");
  });

  it("adds transport block when tlsSkipVerify", () => {
    const result = proxyToBlock(proxy({ targetScheme: "https", tlsSkipVerify: true }));
    expect(result).toContain("tls_insecure_skip_verify");
    expect(result).toContain("transport http {");
  });
});

// ---------------------------------------------------------------------------
// surgicallyReplaceBlock
// ---------------------------------------------------------------------------

describe("surgicallyReplaceBlock", () => {
  it("replaces the correct block leaving others verbatim", () => {
    const newBlock = `:7700 {\n\treverse_proxy http://localhost:9999\n}`;
    const result = surgicallyReplaceBlock(SIMPLE_CONF, 7700, newBlock);
    expect(result).toContain("reverse_proxy http://localhost:9999");
    expect(result).toContain(":8096 {");
    expect(result).toContain("reverse_proxy http://localhost:8097");
    expect(result).not.toContain("reverse_proxy http://localhost:7701");
  });

  it("appends when port not found", () => {
    const newBlock = `:9000 {\n\treverse_proxy http://localhost:9001\n}`;
    const result = surgicallyReplaceBlock(SIMPLE_CONF, 9000, newBlock);
    expect(result).toContain(":9000 {");
    expect(result).toContain(":7700 {");
    expect(result).toContain(":8096 {");
  });

  it("replaces label comment above block", () => {
    const newBlock = `# label: renamed\n:7700 {\n\treverse_proxy http://localhost:9999\n}`;
    const result = surgicallyReplaceBlock(SIMPLE_CONF, 7700, newBlock);
    expect(result).toContain("# label: renamed");
    expect(result).not.toContain("# label: homarr");
  });
});

// ---------------------------------------------------------------------------
// surgicallyRemoveBlock
// ---------------------------------------------------------------------------

describe("surgicallyRemoveBlock", () => {
  it("removes the target block and its label comment", () => {
    const result = surgicallyRemoveBlock(SIMPLE_CONF, 7700);
    expect(result).not.toContain(":7700 {");
    expect(result).not.toContain("# label: homarr");
    expect(result).not.toContain("reverse_proxy http://localhost:7701");
  });

  it("leaves other blocks intact", () => {
    const result = surgicallyRemoveBlock(SIMPLE_CONF, 7700);
    expect(result).toContain(":8096 {");
    expect(result).toContain("# label: jellyfin");
    expect(result).toContain("reverse_proxy http://localhost:8097");
  });

  it("is a no-op when port not found", () => {
    const result = surgicallyRemoveBlock(SIMPLE_CONF, 9999);
    expect(result).toBe(SIMPLE_CONF);
  });
});

// ---------------------------------------------------------------------------
// surgicallyWriteProxy
// ---------------------------------------------------------------------------

describe("surgicallyWriteProxy", () => {
  it("full-replaces a plugin-format block (:PORT {)", () => {
    const p = proxy({ tls: true, label: "updated" });
    const result = surgicallyWriteProxy(SIMPLE_CONF, p);
    expect(result).toContain(":7700 {");
    expect(result).toContain("# label: updated");
    expect(result).toContain("tls internal");
    expect(result).toContain("reverse_proxy http://localhost:7701");
    // old label gone
    expect(result).not.toContain("# label: homarr");
  });

  it("patches a migrated block in-place, preserving header", () => {
    const p = proxy({ tls: true, targetPort: 9999, label: "homarr" });
    const result = surgicallyWriteProxy(MIGRATED_CONF, p);
    // original header preserved
    expect(result).toContain("https://jellyfin.speedport.ip:7700 {");
    // not converted to :PORT format
    expect(result).not.toContain("\n:7700 {");
    // reverse_proxy updated
    expect(result).toContain("reverse_proxy http://localhost:9999");
    // tls preserved
    expect(result).toContain("tls internal");
    // comment inside block preserved
    expect(result).toContain("# homarr");
  });

  it("patches a migrated block: removes tls when disabled", () => {
    const p = proxy({ tls: false, targetPort: 8998 });
    const result = surgicallyWriteProxy(MIGRATED_CONF, p);
    expect(result).toContain("https://jellyfin.speedport.ip:7700 {");
    expect(result).not.toContain("tls internal");
    expect(result).toContain("reverse_proxy http://localhost:8998");
  });

  it("does not touch other blocks when patching", () => {
    const p = proxy({ tls: true, targetPort: 9999 });
    const result = surgicallyWriteProxy(MIGRATED_CONF, p);
    expect(result).toContain(":8096 {");
    expect(result).toContain("reverse_proxy http://localhost:8097");
  });

  it("appends new plugin-format block when port not present", () => {
    const p = proxy({ externalPort: 9000, targetPort: 9001 });
    const result = surgicallyWriteProxy(SIMPLE_CONF, p);
    expect(result).toContain(":9000 {");
    expect(result).toContain("reverse_proxy http://localhost:9001");
    expect(result).toContain(":7700 {");
    expect(result).toContain(":8096 {");
  });

  it("updates label comment on a migrated block", () => {
    const p = proxy({ tls: true, targetPort: 8998, label: "new-label" });
    const result = surgicallyWriteProxy(MIGRATED_CONF, p);
    expect(result).toContain("# label: new-label");
  });

  it("removes label comment on a migrated block when label cleared", () => {
    const confWithLabel = `# label: old\nhttps://host.lan:7700 {\n\ttls internal\n\treverse_proxy localhost:8998\n}\n`;
    const p = proxy({ tls: true, targetPort: 8998, label: undefined });
    const result = surgicallyWriteProxy(confWithLabel, p);
    expect(result).not.toContain("# label: old");
    expect(result).toContain("https://host.lan:7700 {");
  });
});
