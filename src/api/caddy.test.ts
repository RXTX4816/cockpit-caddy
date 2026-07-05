import { describe, it, expect } from "vitest";
import {
  parseLabelsFromCaddyfile,
  parseLegacyLabelsFromCaddyfile,
  parseConfTlsMap,
  parseConfExternalAddresses,
  extractRawBlocksFromCaddyfile,
  buildMigratedConfContent,
  mergeMigratedConfContent,
  deduplicateManagedHeader,
  proxyToBlock,
  buildServerEntry,
  parseProxies,
  surgicallyReplaceBlock,
  surgicallyRemoveBlock,
  surgicallyWriteProxy,
  parseGlobalOptions,
  buildGlobalOptionsPatch,
  serverDefToBlock,
  surgicallyWriteServerBlock,
  surgicallyRemoveServerBlock,
  mergeNamedServer,
} from "./caddy";
import type { CaddyConfig, ProxyEntry, RouteMatch, ServerDef } from "./types";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const SIMPLE_CONF = `# Managed by cockpit-caddy - edits to this file may be overwritten by user plugin actions

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
    expect(parseLabelsFromCaddyfile(SIMPLE_CONF)).toEqual({ ":7700": "homarr", ":8096": "jellyfin" });
  });

  it("reads labels above https://host:PORT blocks", () => {
    const conf = `# label: myapp\nhttps://host.lan:7700 {\n\treverse_proxy localhost:8080\n}\n`;
    expect(parseLabelsFromCaddyfile(conf)).toEqual({ "https://host.lan:7700": "myapp" });
  });

  it("ignores blocks without a label comment", () => {
    const conf = `:7700 {\n\treverse_proxy http://localhost:8080\n}\n`;
    expect(parseLabelsFromCaddyfile(conf)).toEqual({});
  });

  it("tolerates a blank line between label comment and block", () => {
    // Parser is lenient: blank lines do not clear the pending label since we
    // never generate blank lines between label and block header ourselves.
    const conf = `# label: orphan\n\n:7700 {\n\treverse_proxy http://localhost:8080\n}\n`;
    expect(parseLabelsFromCaddyfile(conf)).toEqual({ ":7700": "orphan" });
  });

  it("reads labels above a bare-hostname block with no port (#95)", () => {
    const conf = `# label: git\ngit.example.com {\n\treverse_proxy localhost:4732\n}\n`;
    expect(parseLabelsFromCaddyfile(conf)).toEqual({ "git.example.com": "git" });
  });
});

// ---------------------------------------------------------------------------
// parseLegacyLabelsFromCaddyfile (label inside block as first comment)
// ---------------------------------------------------------------------------

describe("parseLegacyLabelsFromCaddyfile", () => {
  it("reads inline label comment inside block", () => {
    const conf = `https://host.lan:7700 {\n\t# homarr\n\ttls internal\n\treverse_proxy localhost:8998\n}\n`;
    expect(parseLegacyLabelsFromCaddyfile(conf)).toEqual({ "https://host.lan:7700": "homarr" });
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
    expect(parseConfTlsMap(conf)).toEqual({ "https://host.lan:7700": true });
  });

  it("detects tls internal directive", () => {
    const conf = `:7700 {\n\ttls internal\n\treverse_proxy http://localhost:8998\n}\n`;
    expect(parseConfTlsMap(conf)).toEqual({ ":7700": true });
  });

  it("detects tls with email argument", () => {
    const conf = `:7700 {\n\ttls admin@example.com\n\treverse_proxy http://localhost:8998\n}\n`;
    expect(parseConfTlsMap(conf)).toEqual({ ":7700": true });
  });

  it("does not flag tls off as enabled", () => {
    const conf = `:7700 {\n\ttls off\n\treverse_proxy http://localhost:8998\n}\n`;
    expect(parseConfTlsMap(conf)).toEqual({ ":7700": false });
  });

  it("does not confuse tls_ prefixed directives", () => {
    const conf = `:7700 {\n\treverse_proxy http://localhost:8998 {\n\t\ttransport http {\n\t\t\ttls_insecure_skip_verify\n\t\t}\n\t}\n}\n`;
    expect(parseConfTlsMap(conf)).toEqual({ ":7700": false });
  });

  it("handles mixed blocks", () => {
    expect(parseConfTlsMap(MIGRATED_CONF)).toEqual({ "https://jellyfin.speedport.ip:7700": true, ":8096": false });
  });
});

// ---------------------------------------------------------------------------
// parseConfExternalAddresses
// ---------------------------------------------------------------------------

describe("parseConfExternalAddresses", () => {
  it("extracts scheme and host from scheme://host:PORT", () => {
    const conf = `https://host.lan:7700 {\n\treverse_proxy localhost:8998\n}\n`;
    expect(parseConfExternalAddresses(conf)).toEqual({ "https://host.lan:7700": { scheme: "https", host: "host.lan" } });
  });

  it("extracts host from host:PORT", () => {
    const conf = `host.lan:7700 {\n\treverse_proxy localhost:8998\n}\n`;
    expect(parseConfExternalAddresses(conf)).toEqual({ "host.lan:7700": { host: "host.lan" } });
  });

  it("records nothing for a bare :PORT block", () => {
    const conf = `:7700 {\n\treverse_proxy localhost:8998\n}\n`;
    expect(parseConfExternalAddresses(conf)).toEqual({});
  });

  it("extracts host from a bare hostname with no port (#95)", () => {
    const conf = `git.example.com {\n\treverse_proxy localhost:4732\n}\n`;
    expect(parseConfExternalAddresses(conf)).toEqual({ "git.example.com": { host: "git.example.com" } });
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

  it("skips the global options block (bare `{`)", () => {
    const conf = `{\n\tadmin off\n}\n:7700 {\n\treverse_proxy http://localhost:8080\n}\n`;
    const blocks = extractRawBlocksFromCaddyfile(conf);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].port).toBe(7700);
  });

  it("does not drop a bare-hostname block with no port (#95)", () => {
    const conf = `git.example.com {\n\treverse_proxy localhost:4732\n}\n`;
    const blocks = extractRawBlocksFromCaddyfile(conf);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].address).toBe("git.example.com");
    expect(blocks[0].port).toBeUndefined();
    expect(blocks[0].raw).toContain("reverse_proxy localhost:4732");
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

  it("does not produce an empty conf.d for a bare-hostname site block (#95)", () => {
    const conf = `git.example.com {\n\treverse_proxy localhost:4732\n}\n`;
    const blocks = extractRawBlocksFromCaddyfile(conf);
    const result = buildMigratedConfContent(blocks);
    expect(result).toContain("git.example.com {");
    expect(result).toContain("reverse_proxy localhost:4732");
  });
});

describe("mergeMigratedConfContent — preserves existing conf.d annotations", () => {
  it("keeps a preceding # label: comment on an existing standalone route", () => {
    const existing = "# label: homarr\n:8080 {\n\treverse_proxy localhost:8998\n}\n";
    const newBlocks = extractRawBlocksFromCaddyfile("git.example.com {\n\treverse_proxy localhost:4732\n}\n");
    const result = mergeMigratedConfContent(existing, newBlocks);
    expect(result).toContain("# label: homarr");
    expect(result).toContain(":8080 {");
    expect(result).toContain("git.example.com {");
  });

  it("keeps # server: and # serverdef: comments on an existing named server block", () => {
    const existing = '# server: pub\n# serverdef: {"name":"Public","tls":true}\n:443 {\n\ttls internal\n\treverse_proxy localhost:7701\n}\n';
    const result = mergeMigratedConfContent(existing, []);
    expect(result).toContain("# server: pub");
    expect(result).toContain('# serverdef: {"name":"Public","tls":true}');
    expect(result).toContain(":443 {");
  });

  it("falls back to the fresh-migration header when conf.d was empty", () => {
    const newBlocks = extractRawBlocksFromCaddyfile("git.example.com {\n\treverse_proxy localhost:4732\n}\n");
    const result = mergeMigratedConfContent("", newBlocks);
    expect(result).toContain("# Managed by cockpit-caddy");
    expect(result).toContain("git.example.com {");
  });

  it("does not duplicate the managed-by header across repeated migrations", () => {
    let content = mergeMigratedConfContent("", extractRawBlocksFromCaddyfile(":3333 {\n\treverse_proxy localhost:3000\n}\n"));
    content = mergeMigratedConfContent(content, extractRawBlocksFromCaddyfile(":3334 {\n\treverse_proxy localhost:3000\n}\n"));
    content = mergeMigratedConfContent(content, extractRawBlocksFromCaddyfile(":3335 {\n\treverse_proxy localhost:3000\n}\n"));
    expect(content.match(/# Managed by cockpit-caddy/g)).toHaveLength(1);
    expect(content).toContain(":3333 {");
    expect(content).toContain(":3334 {");
    expect(content).toContain(":3335 {");
  });
});

describe("deduplicateManagedHeader", () => {
  it("collapses repeated header comments left by older migrations, keeping the first", () => {
    const content = [
      "# Managed by cockpit-caddy - edits to this file may be overwritten by user plugin actions",
      "",
      "# label: test",
      ":3333 {",
      "\treverse_proxy localhost:3000",
      "}",
      "",
      "# Managed by cockpit-caddy - edits to this file may be overwritten by user plugin actions",
      "",
      ":3334 {",
      "\treverse_proxy localhost:3000",
      "}",
      "",
      "# Managed by cockpit-caddy - edits to this file may be overwritten by user plugin actions",
      "",
      ":3335 {",
      "\treverse_proxy localhost:3000",
      "}",
    ].join("\n") + "\n";

    const { content: result, changed } = deduplicateManagedHeader(content);
    expect(changed).toBe(true);
    expect(result.match(/# Managed by cockpit-caddy/g)).toHaveLength(1);
    expect(result).toContain("# label: test");
    expect(result).toContain(":3333 {");
    expect(result).toContain(":3334 {");
    expect(result).toContain(":3335 {");
  });

  it("reports no change when there is only one header", () => {
    const content = "# Managed by cockpit-caddy - edits to this file may be overwritten by user plugin actions\n\n:3333 {\n\treverse_proxy localhost:3000\n}\n";
    const { content: result, changed } = deduplicateManagedHeader(content);
    expect(changed).toBe(false);
    expect(result).toBe(content);
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

  it("writes simple tls internal when no advanced settings", () => {
    const result = proxyToBlock(proxy({ tls: true }));
    expect(result).toContain("\ttls internal");
    expect(result).not.toContain("protocols");
    expect(result).not.toContain("ciphers");
  });

  it("writes tls block with protocols when protocolMin/Max set", () => {
    const result = proxyToBlock(proxy({
      tls: true,
      tlsAdvanced: { protocolMin: "tls1.2", protocolMax: "tls1.3" },
    }));
    expect(result).toContain("\ttls {");
    expect(result).toContain("issuer internal");
    expect(result).toContain("protocols tls1.2 tls1.3");
    expect(result).not.toContain("tls internal");
  });

  it("writes tls block with single protocol when only min set", () => {
    const result = proxyToBlock(proxy({ tls: true, tlsAdvanced: { protocolMin: "tls1.2" } }));
    expect(result).toContain("protocols tls1.2");
    expect(result).not.toContain("tls1.0");
  });

  it("uses tls1.2 as floor when only max set", () => {
    const result = proxyToBlock(proxy({ tls: true, tlsAdvanced: { protocolMax: "tls1.3" } }));
    expect(result).toContain("protocols tls1.2 tls1.3");
    expect(result).not.toContain("tls1.0");
  });

  it("writes tls block with ciphers", () => {
    const result = proxyToBlock(proxy({
      tls: true,
      tlsAdvanced: { cipherSuites: ["TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256", "TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256"] },
    }));
    expect(result).toContain("ciphers TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256 TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256");
  });

  it("writes tls block with client_auth for mTLS", () => {
    const result = proxyToBlock(proxy({
      tls: true,
      mtls: { mode: "require_and_verify", trustedCaFile: "/etc/caddy/ca.pem" },
    }));
    expect(result).toContain("client_auth {");
    expect(result).toContain("mode require_and_verify");
    expect(result).toContain("trusted_ca_cert_file /etc/caddy/ca.pem");
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

// ---------------------------------------------------------------------------
// URI rewrite — Caddyfile generation (proxyToBlock)
// ---------------------------------------------------------------------------

describe("proxyToBlock — rewrite", () => {
  it("emits uri strip_prefix before reverse_proxy", () => {
    const result = proxyToBlock(proxy({ rewrite: { type: "strip_prefix", value: "/api" } }));
    const lines = result.split("\n");
    const rpIdx = lines.findIndex(l => l.includes("reverse_proxy"));
    const rwIdx = lines.findIndex(l => l.includes("uri strip_prefix /api"));
    expect(rwIdx).toBeGreaterThan(-1);
    expect(rwIdx).toBeLessThan(rpIdx);
  });

  it("emits rewrite add_prefix before reverse_proxy", () => {
    const result = proxyToBlock(proxy({ rewrite: { type: "add_prefix", value: "/v2" } }));
    const lines = result.split("\n");
    const rpIdx = lines.findIndex(l => l.includes("reverse_proxy"));
    const rwIdx = lines.findIndex(l => l.includes("rewrite /v2{uri}"));
    expect(rwIdx).toBeGreaterThan(-1);
    expect(rwIdx).toBeLessThan(rpIdx);
  });

  it("emits path_regexp matcher + rewrite for regex mode", () => {
    const result = proxyToBlock(proxy({ rewrite: { type: "regex", find: "^/old/(.*)", replace: "/new/$1" } }));
    expect(result).toContain("path_regexp rw ^/old/(.*)");
    expect(result).toContain("{re.rw.1}");
    expect(result).toContain("reverse_proxy");
  });

  it("emits no rewrite directive when rewrite is undefined", () => {
    const result = proxyToBlock(proxy());
    expect(result).not.toContain("uri strip_prefix");
    expect(result).not.toContain("path_regexp");
  });
});

// ---------------------------------------------------------------------------
// URI rewrite — JSON API (buildServerEntry + parseProxies round-trip)
// ---------------------------------------------------------------------------

function makeConfig(handles: Record<string, unknown>[]): CaddyConfig {
  return {
    apps: {
      http: {
        servers: {
          srv0: {
            listen: [":7700"],
            routes: [{ handle: handles as import("./types").CaddyHandler[], terminal: true }],
          },
        },
      },
    },
  };
}

describe("parseProxies — bare-hostname sites sharing an implicit-port server (#95)", () => {
  it("shows a single bare-hostname route as its own proxy with externalHost set", () => {
    const config: CaddyConfig = {
      apps: {
        http: {
          servers: {
            srv0: {
              listen: [":443"],
              routes: [{
                match: [{ host: ["git.example.com"] }],
                handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "localhost:4732" }] }] as import("./types").CaddyHandler[],
                terminal: true,
              }],
            },
          },
        },
      },
    };
    const [p] = parseProxies(config);
    expect(p.externalHost).toBe("git.example.com");
    expect(p.externalPort).toBe(443);
    expect(p.targetPort).toBe(4732);
    expect(p.matchers).toBeUndefined();
  });

  it("does not drop routes beyond the first when multiple subdomains share one server (#95)", () => {
    const config: CaddyConfig = {
      apps: {
        http: {
          servers: {
            srv0: {
              listen: [":443"],
              routes: [
                {
                  match: [{ host: ["a.example.com"] }],
                  handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "localhost:1111" }] }] as import("./types").CaddyHandler[],
                  terminal: true,
                },
                {
                  match: [{ host: ["b.example.com"] }],
                  handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "localhost:2222" }] }] as import("./types").CaddyHandler[],
                  terminal: true,
                },
              ],
            },
          },
        },
      },
    };
    const proxies = parseProxies(config);
    expect(proxies).toHaveLength(2);
    expect(proxies.map(p => p.externalHost).sort()).toEqual(["a.example.com", "b.example.com"]);
    expect(proxies.map(p => p.targetPort).sort()).toEqual([1111, 2222]);
  });
});

describe("buildServerEntry — rewrite", () => {
  it("prepends strip_path_prefix handler for strip_prefix", () => {
    const server = buildServerEntry(proxy({ rewrite: { type: "strip_prefix", value: "/api" } }));
    const handles = server.routes[0].handle as Array<{ handler: string; strip_path_prefix?: string }>;
    expect(handles[0].handler).toBe("rewrite");
    expect(handles[0].strip_path_prefix).toBe("/api");
    expect(handles[1].handler).toBe("reverse_proxy");
  });

  it("prepends uri handler for add_prefix", () => {
    const server = buildServerEntry(proxy({ rewrite: { type: "add_prefix", value: "/v2" } }));
    const handles = server.routes[0].handle as Array<{ handler: string; uri?: string }>;
    expect(handles[0].handler).toBe("rewrite");
    expect(handles[0].uri).toBe("/v2{http.request.uri}");
    expect(handles[1].handler).toBe("reverse_proxy");
  });

  it("prepends path_regexp handler for regex", () => {
    const server = buildServerEntry(proxy({ rewrite: { type: "regex", find: "^/old/(.*)", replace: "/new/$1" } }));
    const handles = server.routes[0].handle as Array<{ handler: string; path_regexp?: Array<{ find: string; replace: string }> }>;
    expect(handles[0].handler).toBe("rewrite");
    expect(handles[0].path_regexp?.[0]).toEqual({ find: "^/old/(.*)", replace: "/new/$1" });
    expect(handles[1].handler).toBe("reverse_proxy");
  });

  it("emits no rewrite handler when rewrite is undefined", () => {
    const server = buildServerEntry(proxy());
    const handles = server.routes[0].handle;
    expect(handles).toHaveLength(1);
    expect(handles[0].handler).toBe("reverse_proxy");
  });
});

// ---------------------------------------------------------------------------
// Request headers — Caddyfile generation (proxyToBlock)
// ---------------------------------------------------------------------------

describe("proxyToBlock — requestHeaders", () => {
  it("emits header_up set inside reverse_proxy block", () => {
    const result = proxyToBlock(proxy({ requestHeaders: [{ op: "set", name: "X-Real-IP", value: "{remote_host}" }] }));
    expect(result).toContain("reverse_proxy http://localhost:7701 {");
    expect(result).toContain("\theader_up X-Real-IP {remote_host}");
  });

  it("emits header_up + prefix for add op", () => {
    const result = proxyToBlock(proxy({ requestHeaders: [{ op: "add", name: "X-Foo", value: "bar" }] }));
    expect(result).toContain("\theader_up +X-Foo bar");
  });

  it("emits header_up - prefix for delete op", () => {
    const result = proxyToBlock(proxy({ requestHeaders: [{ op: "delete", name: "X-Forwarded-For" }] }));
    expect(result).toContain("\theader_up -X-Forwarded-For");
  });

  it("combines tlsSkipVerify transport and header_up in same block", () => {
    const result = proxyToBlock(proxy({
      targetScheme: "https",
      tlsSkipVerify: true,
      requestHeaders: [{ op: "set", name: "X-Real-IP", value: "{remote_host}" }],
    }));
    expect(result).toContain("tls_insecure_skip_verify");
    expect(result).toContain("header_up X-Real-IP {remote_host}");
  });

  it("emits no block when requestHeaders is undefined", () => {
    const result = proxyToBlock(proxy());
    expect(result).toContain("reverse_proxy http://localhost:7701\n}");
  });
});

// ---------------------------------------------------------------------------
// Request headers — JSON API (buildServerEntry + parseProxies round-trip)
// ---------------------------------------------------------------------------

describe("buildServerEntry — requestHeaders", () => {
  it("emits headers.request.set in reverse_proxy handler", () => {
    const server = buildServerEntry(proxy({ requestHeaders: [{ op: "set", name: "X-Real-IP", value: "{remote_host}" }] }));
    const rp = server.routes[0].handle[0] as { handler: string; headers?: { request?: { set?: Record<string, string[]> } } };
    expect(rp.headers?.request?.set?.["X-Real-IP"]).toEqual(["{http.request.remote.host}"]);
  });

  it("emits headers.request.add for add op", () => {
    const server = buildServerEntry(proxy({ requestHeaders: [{ op: "add", name: "X-Foo", value: "bar" }] }));
    const rp = server.routes[0].handle[0] as { handler: string; headers?: { request?: { add?: Record<string, string[]> } } };
    expect(rp.headers?.request?.add?.["X-Foo"]).toEqual(["bar"]);
  });

  it("emits headers.request.delete for delete op", () => {
    const server = buildServerEntry(proxy({ requestHeaders: [{ op: "delete", name: "X-Forwarded-For" }] }));
    const rp = server.routes[0].handle[0] as { handler: string; headers?: { request?: { delete?: string[] } } };
    expect(rp.headers?.request?.delete).toContain("X-Forwarded-For");
  });

  it("omits headers field when requestHeaders is undefined", () => {
    const server = buildServerEntry(proxy());
    const rp = server.routes[0].handle[0] as { handler: string; headers?: unknown };
    expect(rp.headers).toBeUndefined();
  });
});

describe("parseProxies — requestHeaders round-trip", () => {
  it("parses set header from JSON config", () => {
    const config = makeConfig([{
      handler: "reverse_proxy",
      upstreams: [{ dial: "localhost:7701" }],
      headers: { request: { set: { "X-Real-IP": ["{http.request.remote.host}"] } } },
    }]);
    const [p] = parseProxies(config);
    expect(p.requestHeaders).toEqual([{ op: "set", name: "X-Real-IP", value: "{remote_host}" }]);
  });

  it("parses delete header from JSON config", () => {
    const config = makeConfig([{
      handler: "reverse_proxy",
      upstreams: [{ dial: "localhost:7701" }],
      headers: { request: { delete: ["X-Forwarded-For"] } },
    }]);
    const [p] = parseProxies(config);
    expect(p.requestHeaders).toEqual([{ op: "delete", name: "X-Forwarded-For" }]);
  });

  it("leaves requestHeaders undefined when no headers field", () => {
    const config = makeConfig([{ handler: "reverse_proxy", upstreams: [{ dial: "localhost:7701" }] }]);
    const [p] = parseProxies(config);
    expect(p.requestHeaders).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Response headers — Caddyfile generation (proxyToBlock)
// ---------------------------------------------------------------------------

describe("proxyToBlock — responseHeaders", () => {
  it("emits header set directive before reverse_proxy", () => {
    const result = proxyToBlock(proxy({ responseHeaders: [{ op: "set", name: "X-Frame-Options", value: "DENY" }] }));
    const lines = result.split("\n");
    const rpIdx = lines.findIndex(l => l.includes("reverse_proxy"));
    const hIdx = lines.findIndex(l => l.includes('header X-Frame-Options "DENY"'));
    expect(hIdx).toBeGreaterThan(-1);
    expect(hIdx).toBeLessThan(rpIdx);
  });

  it("emits header delete directive", () => {
    const result = proxyToBlock(proxy({ responseHeaders: [{ op: "delete", name: "Server" }] }));
    expect(result).toContain("\theader -Server");
  });

  it("emits header add directive with + prefix", () => {
    const result = proxyToBlock(proxy({ responseHeaders: [{ op: "add", name: "X-Custom", value: "val" }] }));
    expect(result).toContain("\theader +X-Custom val");
  });
});

// ---------------------------------------------------------------------------
// Response headers — JSON API (buildServerEntry + parseProxies round-trip)
// ---------------------------------------------------------------------------

describe("buildServerEntry — responseHeaders", () => {
  it("prepends headers handler before reverse_proxy", () => {
    const server = buildServerEntry(proxy({ responseHeaders: [{ op: "set", name: "X-Frame-Options", value: "DENY" }] }));
    const handles = server.routes[0].handle as Array<{ handler: string }>;
    expect(handles[0].handler).toBe("headers");
    expect(handles[1].handler).toBe("reverse_proxy");
  });

  it("puts headers handler before rewrite handler", () => {
    const server = buildServerEntry(proxy({
      responseHeaders: [{ op: "set", name: "X-Frame-Options", value: "DENY" }],
      rewrite: { type: "strip_prefix", value: "/api" },
    }));
    const handles = server.routes[0].handle as Array<{ handler: string }>;
    expect(handles[0].handler).toBe("headers");
    expect(handles[1].handler).toBe("rewrite");
    expect(handles[2].handler).toBe("reverse_proxy");
  });

  it("sets response.set in the headers handler", () => {
    const server = buildServerEntry(proxy({ responseHeaders: [{ op: "set", name: "X-Frame-Options", value: "DENY" }] }));
    const h = server.routes[0].handle[0] as { handler: string; response?: { set?: Record<string, string[]> } };
    expect(h.response?.set?.["X-Frame-Options"]).toEqual(["DENY"]);
  });

  it("sets response.delete in the headers handler", () => {
    const server = buildServerEntry(proxy({ responseHeaders: [{ op: "delete", name: "Server" }] }));
    const h = server.routes[0].handle[0] as { handler: string; response?: { delete?: string[] } };
    expect(h.response?.delete).toContain("Server");
  });
});

describe("parseProxies — responseHeaders round-trip", () => {
  it("parses set response header from JSON config", () => {
    const config = makeConfig([
      { handler: "headers", response: { set: { "X-Frame-Options": ["DENY"] } } },
      { handler: "reverse_proxy", upstreams: [{ dial: "localhost:7701" }] },
    ]);
    const [p] = parseProxies(config);
    expect(p.responseHeaders).toEqual([{ op: "set", name: "X-Frame-Options", value: "DENY" }]);
  });

  it("parses delete response header from JSON config", () => {
    const config = makeConfig([
      { handler: "headers", response: { delete: ["Server"] } },
      { handler: "reverse_proxy", upstreams: [{ dial: "localhost:7701" }] },
    ]);
    const [p] = parseProxies(config);
    expect(p.responseHeaders).toEqual([{ op: "delete", name: "Server" }]);
  });

  it("leaves responseHeaders undefined when no headers handler", () => {
    const config = makeConfig([{ handler: "reverse_proxy", upstreams: [{ dial: "localhost:7701" }] }]);
    const [p] = parseProxies(config);
    expect(p.responseHeaders).toBeUndefined();
  });
});

describe("parseProxies — rewrite round-trip", () => {
  it("parses strip_prefix from JSON config", () => {
    const config = makeConfig([
      { handler: "rewrite", strip_path_prefix: "/api" },
      { handler: "reverse_proxy", upstreams: [{ dial: "localhost:7701" }] },
    ]);
    const [p] = parseProxies(config);
    expect(p.rewrite).toEqual({ type: "strip_prefix", value: "/api" });
  });

  it("parses add_prefix from JSON config", () => {
    const config = makeConfig([
      { handler: "rewrite", uri: "/v2{http.request.uri}" },
      { handler: "reverse_proxy", upstreams: [{ dial: "localhost:7701" }] },
    ]);
    const [p] = parseProxies(config);
    expect(p.rewrite).toEqual({ type: "add_prefix", value: "/v2" });
  });

  it("parses regex from JSON config", () => {
    const config = makeConfig([
      { handler: "rewrite", path_regexp: [{ find: "^/old/(.*)", replace: "/new/$1" }] },
      { handler: "reverse_proxy", upstreams: [{ dial: "localhost:7701" }] },
    ]);
    const [p] = parseProxies(config);
    expect(p.rewrite).toEqual({ type: "regex", find: "^/old/(.*)", replace: "/new/$1" });
  });

  it("leaves rewrite undefined when no rewrite handler", () => {
    const config = makeConfig([
      { handler: "reverse_proxy", upstreams: [{ dial: "localhost:7701" }] },
    ]);
    const [p] = parseProxies(config);
    expect(p.rewrite).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Response compression (#37)
// ---------------------------------------------------------------------------

describe("proxyToBlock — compress", () => {
  it("emits encode gzip zstd when compress is true", () => {
    const result = proxyToBlock(proxy({ compress: true }));
    expect(result).toContain("\tencode gzip zstd");
  });

  it("encode line appears before reverse_proxy", () => {
    const result = proxyToBlock(proxy({ compress: true }));
    const lines = result.split("\n");
    const encIdx = lines.findIndex(l => l.includes("encode gzip"));
    const rpIdx = lines.findIndex(l => l.includes("reverse_proxy"));
    expect(encIdx).toBeGreaterThan(-1);
    expect(encIdx).toBeLessThan(rpIdx);
  });

  it("does not emit encode when compress is false/undefined", () => {
    expect(proxyToBlock(proxy())).not.toContain("encode");
    expect(proxyToBlock(proxy({ compress: false }))).not.toContain("encode");
  });
});

describe("buildServerEntry — compress", () => {
  it("includes encode handler first when compress is true", () => {
    const server = buildServerEntry(proxy({ compress: true }));
    const handles = server.routes[0].handle;
    expect(handles[0]).toMatchObject({ handler: "encode" });
    expect((handles[0] as { handler: string; encodings: object }).encodings).toMatchObject({ gzip: {}, zstd: {} });
  });

  it("omits encode handler when compress is false", () => {
    const server = buildServerEntry(proxy());
    const handles = server.routes[0].handle;
    expect(handles.every(h => h.handler !== "encode")).toBe(true);
  });
});

describe("parseProxies — compress round-trip", () => {
  it("detects compress=true when encode handler present", () => {
    const config = makeConfig([
      { handler: "encode", encodings: { gzip: {}, zstd: {}, br: {} } },
      { handler: "reverse_proxy", upstreams: [{ dial: "localhost:7701" }] },
    ]);
    const [p] = parseProxies(config);
    expect(p.compress).toBe(true);
  });

  it("leaves compress undefined when no encode handler", () => {
    const config = makeConfig([{ handler: "reverse_proxy", upstreams: [{ dial: "localhost:7701" }] }]);
    const [p] = parseProxies(config);
    expect(p.compress).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Upstream timeouts (#28)
// ---------------------------------------------------------------------------

describe("proxyToBlock — transport timeouts", () => {
  it("emits transport http block with dial_timeout for http upstream", () => {
    const result = proxyToBlock(proxy({ dialTimeout: "10s" }));
    expect(result).toContain("transport http {");
    expect(result).toContain("dial_timeout 10s");
  });

  it("emits both timeout directives", () => {
    const result = proxyToBlock(proxy({ dialTimeout: "5s", responseHeaderTimeout: "30s" }));
    expect(result).toContain("dial_timeout 5s");
    expect(result).toContain("response_header_timeout 30s");
  });

  it("does not emit transport block when no timeouts and http upstream", () => {
    const result = proxyToBlock(proxy());
    expect(result).not.toContain("transport http");
  });

  it("combines tls_insecure_skip_verify with timeouts in one transport block", () => {
    const result = proxyToBlock(proxy({ targetScheme: "https", tlsSkipVerify: true, dialTimeout: "5s" }));
    const transportStart = result.indexOf("transport http {");
    const transportEnd = result.indexOf("}", transportStart);
    const transportBlock = result.slice(transportStart, transportEnd + 1);
    expect(transportBlock).toContain("tls_insecure_skip_verify");
    expect(transportBlock).toContain("dial_timeout 5s");
    // Only one transport block
    expect(result.indexOf("transport http {", transportStart + 1)).toBe(-1);
  });
});

describe("parseProxies — timeouts round-trip", () => {
  it("parses dial_timeout from transport", () => {
    const config = makeConfig([{
      handler: "reverse_proxy",
      upstreams: [{ dial: "localhost:7701" }],
      transport: { protocol: "http", dial_timeout: "10s" },
    }]);
    const [p] = parseProxies(config);
    expect(p.dialTimeout).toBe("10s");
    expect(p.targetScheme).toBe("http");
  });

  it("parses both timeouts", () => {
    const config = makeConfig([{
      handler: "reverse_proxy",
      upstreams: [{ dial: "localhost:7701" }],
      transport: { protocol: "http", dial_timeout: "5s", response_header_timeout: "30s" },
    }]);
    const [p] = parseProxies(config);
    expect(p.dialTimeout).toBe("5s");
    expect(p.responseHeaderTimeout).toBe("30s");
  });

  it("leaves timeouts undefined when no transport", () => {
    const config = makeConfig([{ handler: "reverse_proxy", upstreams: [{ dial: "localhost:7701" }] }]);
    const [p] = parseProxies(config);
    expect(p.dialTimeout).toBeUndefined();
    expect(p.responseHeaderTimeout).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// HTTP Basic Auth (#38)
// ---------------------------------------------------------------------------

describe("proxyToBlock — basic_auth", () => {
  it("emits basic_auth block with account", () => {
    const result = proxyToBlock(proxy({ basicAuth: [{ username: "alice", passwordHash: "$2a$14$xyz" }] }));
    expect(result).toContain("\tbasic_auth {");
    expect(result).toContain("\t\talice $2a$14$xyz");
    expect(result).toContain("}");
  });

  it("basic_auth block appears before reverse_proxy", () => {
    const result = proxyToBlock(proxy({ basicAuth: [{ username: "alice", passwordHash: "$2a$14$xyz" }] }));
    const lines = result.split("\n");
    const authIdx = lines.findIndex(l => l.includes("basic_auth"));
    const rpIdx = lines.findIndex(l => l.includes("reverse_proxy"));
    expect(authIdx).toBeGreaterThan(-1);
    expect(authIdx).toBeLessThan(rpIdx);
  });

  it("does not emit basic_auth when not configured", () => {
    expect(proxyToBlock(proxy())).not.toContain("basic_auth");
  });
});

describe("buildServerEntry — basic_auth", () => {
  it("includes authentication handler when basicAuth set", () => {
    const server = buildServerEntry(proxy({ basicAuth: [{ username: "alice", passwordHash: "$2a$14$xyz" }] }));
    const handles = server.routes[0].handle;
    const authHandler = handles.find(h => h.handler === "authentication");
    expect(authHandler).toBeDefined();
    const accounts = (authHandler as unknown as { providers: { http_basic: { accounts: Array<{ username: string; password: string }> } } }).providers.http_basic.accounts;
    expect(accounts).toEqual([{ username: "alice", password: "$2a$14$xyz" }]);
  });

  it("omits authentication handler when no basicAuth", () => {
    const server = buildServerEntry(proxy());
    expect(server.routes[0].handle.every(h => h.handler !== "authentication")).toBe(true);
  });
});

describe("parseProxies — basic_auth round-trip", () => {
  it("parses basicAuth from authentication handler", () => {
    const config = makeConfig([
      { handler: "authentication", providers: { http_basic: { accounts: [{ username: "alice", password: "$2a$14$xyz" }] } } },
      { handler: "reverse_proxy", upstreams: [{ dial: "localhost:7701" }] },
    ]);
    const [p] = parseProxies(config);
    expect(p.basicAuth).toEqual([{ username: "alice", passwordHash: "$2a$14$xyz" }]);
  });

  it("leaves basicAuth undefined when no authentication handler", () => {
    const config = makeConfig([{ handler: "reverse_proxy", upstreams: [{ dial: "localhost:7701" }] }]);
    const [p] = parseProxies(config);
    expect(p.basicAuth).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Static file server
// ---------------------------------------------------------------------------

describe("proxyToBlock — fileServer", () => {
  it("generates file_server block without browse", () => {
    const result = proxyToBlock(proxy({ fileServer: { root: "/var/www/html" }, tls: false, targetHost: "localhost", targetPort: 0 }));
    expect(result).toContain("root * /var/www/html");
    expect(result).toContain("file_server");
    expect(result).not.toContain("file_server browse");
    expect(result).not.toContain("reverse_proxy");
  });

  it("generates file_server browse block when browse is true", () => {
    const result = proxyToBlock(proxy({ fileServer: { root: "/srv/files", browse: true }, tls: false, targetHost: "localhost", targetPort: 0 }));
    expect(result).toContain("root * /srv/files");
    expect(result).toContain("file_server browse");
  });

  it("includes tls internal when tls is true", () => {
    const result = proxyToBlock(proxy({ fileServer: { root: "/var/www" }, tls: true, targetHost: "localhost", targetPort: 0 }));
    expect(result).toContain("tls internal");
    expect(result).toContain("root * /var/www");
  });

  it("includes label comment", () => {
    const result = proxyToBlock(proxy({ fileServer: { root: "/var/www" }, tls: false, targetHost: "localhost", targetPort: 0, label: "docs" }));
    expect(result.split("\n")[0]).toBe("# label: docs");
  });
});

describe("buildServerEntry — fileServer", () => {
  it("builds file_server handler", () => {
    const server = buildServerEntry({ externalPort: 7700, externalScheme: undefined, externalHost: undefined, targetHost: "localhost", targetPort: 0, targetScheme: "http", tls: false, tlsSkipVerify: false, fileServer: { root: "/var/www/html" } });
    const handle = server.routes[0].handle[0] as Record<string, unknown>;
    expect(handle["handler"]).toBe("file_server");
    expect(handle["root"]).toBe("/var/www/html");
    expect(handle["browse"]).toBeUndefined();
  });

  it("sets browse property when browse is true", () => {
    const server = buildServerEntry({ externalPort: 7700, externalScheme: undefined, externalHost: undefined, targetHost: "localhost", targetPort: 0, targetScheme: "http", tls: false, tlsSkipVerify: false, fileServer: { root: "/var/www", browse: true } });
    const handle = server.routes[0].handle[0] as Record<string, unknown>;
    expect(handle["browse"]).toBeDefined();
  });

  it("sets tls_connection_policies when tls is true", () => {
    const server = buildServerEntry({ externalPort: 7700, externalScheme: undefined, externalHost: undefined, targetHost: "localhost", targetPort: 0, targetScheme: "http", tls: true, tlsSkipVerify: false, fileServer: { root: "/var/www" } });
    expect(server.tls_connection_policies).toBeDefined();
    expect(server.tls_connection_policies!.length).toBe(1);
  });
});

describe("parseProxies — fileServer round-trip", () => {
  it("parses file_server handler", () => {
    const config = makeConfig([{ handler: "file_server", root: "/var/www/html" }]);
    const [p] = parseProxies(config);
    expect(p.fileServer).toEqual({ root: "/var/www/html", browse: false });
    expect(p.targetHost).toBe("localhost");
    expect(p.targetPort).toBe(0);
  });

  it("parses browse flag", () => {
    const config = makeConfig([{ handler: "file_server", root: "/srv/files", browse: {} }]);
    const [p] = parseProxies(config);
    expect(p.fileServer?.browse).toBe(true);
  });

  it("parses tls from connection policies", () => {
    const config: CaddyConfig = {
      apps: {
        http: {
          servers: {
            srv0: {
              listen: [":7700"],
              tls_connection_policies: [{}],
              routes: [{ handle: [{ handler: "file_server", root: "/var/www" } as import("./types").CaddyHandler], terminal: true }],
            },
          },
        },
      },
    };
    const [p] = parseProxies(config);
    expect(p.tls).toBe(true);
    expect(p.fileServer?.root).toBe("/var/www");
  });
});

describe("proxyToBlock — fileServer with compress/auth/headers", () => {
  it("adds encode directive when compress is true", () => {
    const result = proxyToBlock(proxy({ fileServer: { root: "/var/www" }, compress: true, tls: false, targetHost: "localhost", targetPort: 0 }));
    expect(result).toContain("encode gzip zstd");
    expect(result.indexOf("encode gzip zstd")).toBeLessThan(result.indexOf("root *"));
  });

  it("adds basic_auth block when basicAuth is set", () => {
    const result = proxyToBlock(proxy({ fileServer: { root: "/srv" }, basicAuth: [{ username: "alice", passwordHash: "$2a$14$xyz" }], tls: false, targetHost: "localhost", targetPort: 0 }));
    expect(result).toContain("basic_auth {");
    expect(result).toContain("alice $2a$14$xyz");
  });

  it("adds header directives when responseHeaders set", () => {
    const result = proxyToBlock(proxy({ fileServer: { root: "/srv" }, responseHeaders: [{ op: "set", name: "Cache-Control", value: "max-age=3600" }], tls: false, targetHost: "localhost", targetPort: 0 }));
    expect(result).toContain('header Cache-Control "max-age=3600"');
  });
});

describe("buildServerEntry — fileServer with compress/auth/headers", () => {
  it("prepends encode handler when compress", () => {
    const server = buildServerEntry({ externalPort: 7700, externalScheme: undefined, externalHost: undefined, targetHost: "localhost", targetPort: 0, targetScheme: "http", tls: false, tlsSkipVerify: false, fileServer: { root: "/var/www" }, compress: true });
    expect(server.routes[0].handle[0].handler).toBe("encode");
    const fsH = server.routes[0].handle.find(h => h.handler === "file_server");
    expect(fsH).toBeDefined();
  });

  it("prepends authentication handler when basicAuth", () => {
    const server = buildServerEntry({ externalPort: 7700, externalScheme: undefined, externalHost: undefined, targetHost: "localhost", targetPort: 0, targetScheme: "http", tls: false, tlsSkipVerify: false, fileServer: { root: "/srv" }, basicAuth: [{ username: "bob", passwordHash: "hash" }] });
    const authH = server.routes[0].handle.find(h => h.handler === "authentication");
    expect(authH).toBeDefined();
  });
});

describe("parseProxies — fileServer compress/auth round-trip", () => {
  it("parses compress from encode handler alongside file_server", () => {
    const config = makeConfig([{ handler: "encode", encodings: { gzip: {}, zstd: {} } }, { handler: "file_server", root: "/var/www" }]);
    const [p] = parseProxies(config);
    expect(p.fileServer?.root).toBe("/var/www");
    expect(p.compress).toBe(true);
  });

  it("parses basicAuth from authentication handler alongside file_server", () => {
    const config = makeConfig([
      { handler: "authentication", providers: { http_basic: { accounts: [{ username: "alice", password: "$2a$14$xyz" }] } } },
      { handler: "file_server", root: "/srv" },
    ]);
    const [p] = parseProxies(config);
    expect(p.fileServer?.root).toBe("/srv");
    expect(p.basicAuth).toEqual([{ username: "alice", passwordHash: "$2a$14$xyz" }]);
  });
});

describe("proxyToBlock — multiple upstreams", () => {
  it("emits all upstreams on the reverse_proxy line", () => {
    const result = proxyToBlock(proxy({
      extraUpstreams: [{ host: "backend2", port: 8081 }, { host: "backend3", port: 8082 }],
    }));
    expect(result).toContain("reverse_proxy http://localhost:7701 http://backend2:8081 http://backend3:8082");
  });

  it("emits lb_policy when set", () => {
    const result = proxyToBlock(proxy({
      extraUpstreams: [{ host: "backend2", port: 8081 }],
      lbPolicy: "least_conn",
    }));
    expect(result).toContain("lb_policy least_conn");
  });

  it("does not emit lb_policy when no extra upstreams", () => {
    const result = proxyToBlock(proxy({ lbPolicy: "random" }));
    expect(result).not.toContain("lb_policy");
  });
});

describe("buildServerEntry — multiple upstreams", () => {
  it("includes all upstreams in reverse_proxy handler", () => {
    const server = buildServerEntry({
      externalPort: 7700, externalScheme: undefined, externalHost: undefined,
      targetHost: "localhost", targetPort: 8080, targetScheme: "http",
      tls: false, tlsSkipVerify: false,
      extraUpstreams: [{ host: "backend2", port: 8081 }],
    });
    const rp = server.routes[0].handle.find(h => h.handler === "reverse_proxy") as Record<string, unknown> | undefined;
    expect(rp).toBeDefined();
    const ups = rp!.upstreams as Array<{ dial: string }>;
    expect(ups).toHaveLength(2);
    expect(ups[0].dial).toBe("localhost:8080");
    expect(ups[1].dial).toBe("backend2:8081");
  });

  it("includes load_balancing when lbPolicy set", () => {
    const server = buildServerEntry({
      externalPort: 7700, externalScheme: undefined, externalHost: undefined,
      targetHost: "localhost", targetPort: 8080, targetScheme: "http",
      tls: false, tlsSkipVerify: false,
      extraUpstreams: [{ host: "backend2", port: 8081 }],
      lbPolicy: "round_robin",
    });
    const rp = server.routes[0].handle.find(h => h.handler === "reverse_proxy") as Record<string, unknown> | undefined;
    const lb = rp!.load_balancing as Record<string, unknown> | undefined;
    expect(lb?.selection_policy).toMatchObject({ policy: "round_robin" });
  });
});

describe("parseProxies — multiple upstreams round-trip", () => {
  it("parses extra upstreams from reverse_proxy handler", () => {
    const config = makeConfig([{
      handler: "reverse_proxy",
      upstreams: [{ dial: "localhost:8080" }, { dial: "backend2:8081" }],
    }]);
    const [p] = parseProxies(config);
    expect(p.targetHost).toBe("localhost");
    expect(p.targetPort).toBe(8080);
    expect(p.extraUpstreams).toEqual([{ host: "backend2", port: 8081 }]);
  });

  it("parses lbPolicy from load_balancing selection_policy", () => {
    const config = makeConfig([{
      handler: "reverse_proxy",
      upstreams: [{ dial: "localhost:8080" }, { dial: "backend2:8081" }],
      load_balancing: { selection_policy: { policy: "random" } },
    }]);
    const [p] = parseProxies(config);
    expect(p.lbPolicy).toBe("random");
  });

  it("omits extraUpstreams when only one upstream", () => {
    const config = makeConfig([{ handler: "reverse_proxy", upstreams: [{ dial: "localhost:8080" }] }]);
    const [p] = parseProxies(config);
    expect(p.extraUpstreams).toBeUndefined();
  });
});

const OPTS_BEGIN = "# cockpit-caddy:opts:begin";
const OPTS_END = "# cockpit-caddy:opts:end";
function makeOpts(body: string): string {
  return `{\n${OPTS_BEGIN}\n${body}\n${OPTS_END}\n}`;
}

describe("parseGlobalOptions — ACME fields", () => {
  it("returns empty object when no managed section", () => {
    expect(parseGlobalOptions("")).toEqual({});
  });

  it("parses email", () => {
    const opts = parseGlobalOptions(makeOpts("\temail admin@example.com"));
    expect(opts.email).toBe("admin@example.com");
  });

  it("parses acme_ca", () => {
    const opts = parseGlobalOptions(makeOpts("\tacme_ca https://acme-v02.api.letsencrypt.org/directory"));
    expect(opts.acmeCA).toBe("https://acme-v02.api.letsencrypt.org/directory");
  });

  it("parses acme_ca_root", () => {
    const opts = parseGlobalOptions(makeOpts("\tacme_ca_root /etc/caddy/ca.pem"));
    expect(opts.acmeCARoot).toBe("/etc/caddy/ca.pem");
  });

  it("parses acme_eab block", () => {
    const body = "\tacme_eab {\n\t\tkey_id kid123\n\t\tmac_key mac456\n\t}";
    const opts = parseGlobalOptions(makeOpts(body));
    expect(opts.acmeEabKeyId).toBe("kid123");
    expect(opts.acmeEabMacKey).toBe("mac456");
  });

  it("parses all ACME fields together with existing opts", () => {
    const body = [
      "\thttp_port 8080",
      "\temail admin@example.com",
      "\tacme_ca https://acme-staging-v02.api.letsencrypt.org/directory",
      "\tacme_eab {",
      "\t\tkey_id mykey",
      "\t\tmac_key mymac",
      "\t}",
    ].join("\n");
    const opts = parseGlobalOptions(makeOpts(body));
    expect(opts.httpPort).toBe(8080);
    expect(opts.email).toBe("admin@example.com");
    expect(opts.acmeCA).toBe("https://acme-staging-v02.api.letsencrypt.org/directory");
    expect(opts.acmeEabKeyId).toBe("mykey");
    expect(opts.acmeEabMacKey).toBe("mymac");
  });
});

describe("parseGlobalOptions — on-demand TLS", () => {
  it("parses on_demand_tls block with ask, interval, burst", () => {
    const body = [
      "\ton_demand_tls {",
      "\t\task http://localhost:9090/check",
      "\t\tinterval 2m",
      "\t\tburst 5",
      "\t}",
    ].join("\n");
    const opts = parseGlobalOptions(makeOpts(body));
    expect(opts.onDemandEnabled).toBe(true);
    expect(opts.onDemandAsk).toBe("http://localhost:9090/check");
    expect(opts.onDemandInterval).toBe("2m");
    expect(opts.onDemandBurst).toBe(5);
  });

  it("sets onDemandEnabled without optional fields", () => {
    const body = "\ton_demand_tls {\n\t}";
    const opts = parseGlobalOptions(makeOpts(body));
    expect(opts.onDemandEnabled).toBe(true);
    expect(opts.onDemandAsk).toBeUndefined();
    expect(opts.onDemandInterval).toBeUndefined();
    expect(opts.onDemandBurst).toBeUndefined();
  });

  it("does not set onDemandEnabled when block absent", () => {
    const opts = parseGlobalOptions(makeOpts("\temail admin@example.com"));
    expect(opts.onDemandEnabled).toBeUndefined();
  });
});

describe("parseGlobalOptions — #96 unmanaged directives fallback", () => {
  it("reads email/acme_ca from a hand-written global block with no managed markers", () => {
    const content = "{\n\temail admin@example.com\n\tacme_ca https://acme-staging-v02.api.letsencrypt.org/directory\n}\n";
    const opts = parseGlobalOptions(content);
    expect(opts.email).toBe("admin@example.com");
    expect(opts.acmeCA).toBe("https://acme-staging-v02.api.letsencrypt.org/directory");
  });

  it("returns empty object when there is no global block at all (zero-config automatic HTTPS)", () => {
    expect(parseGlobalOptions("git.example.com {\n\treverse_proxy localhost:3000\n}\n")).toEqual({});
  });

  it("prefers the managed section over unmanaged directives when both exist", () => {
    const content = `{\n${OPTS_BEGIN}\n\temail managed@example.com\n${OPTS_END}\n}\n`;
    const opts = parseGlobalOptions(content);
    expect(opts.email).toBe("managed@example.com");
  });
});

describe("buildGlobalOptionsPatch — #96 no duplicate directives on first save", () => {
  it("removes a pre-existing unmanaged email directive before inserting the managed section", () => {
    const content = "{\n\temail old@example.com\n}\n";
    const patched = buildGlobalOptionsPatch(content, { email: "new@example.com" });
    const emailMatches = patched.match(/^\s*email /gm) ?? [];
    expect(emailMatches).toHaveLength(1);
    expect(patched).toContain("email new@example.com");
    expect(patched).not.toContain("old@example.com");
  });

  it("leaves other unmanaged directives (e.g. admin off) untouched", () => {
    const content = "{\n\tadmin off\n\temail old@example.com\n}\n";
    const patched = buildGlobalOptionsPatch(content, { email: "new@example.com" });
    expect(patched).toContain("admin off");
    expect(patched).toContain("email new@example.com");
  });

  it("does not duplicate directives on a second save once the managed section exists", () => {
    const first = buildGlobalOptionsPatch("{\n\temail old@example.com\n}\n", { email: "new@example.com" });
    const second = buildGlobalOptionsPatch(first, { email: "second@example.com" });
    const emailMatches = second.match(/^\s*email /gm) ?? [];
    expect(emailMatches).toHaveLength(1);
    expect(second).toContain("email second@example.com");
  });
});

// ---------------------------------------------------------------------------
// Route matchers — #48
// ---------------------------------------------------------------------------

describe("proxyToBlock — matchers", () => {
  it("emits named matcher block + handle wrapper when matchers set", () => {
    const m: RouteMatch = { path: ["/api/*"] };
    const result = proxyToBlock(proxy({ matchers: m }));
    expect(result).toContain("@m7700 {");
    expect(result).toContain("path /api/*");
    expect(result).toContain("handle @m7700 {");
    expect(result).toContain("\t\treverse_proxy");
  });

  it("emits handle_path when path-only matcher + handlePath=true", () => {
    const m: RouteMatch = { path: ["/api/*"] };
    const result = proxyToBlock(proxy({ matchers: m, handlePath: true }));
    expect(result).toContain("handle_path /api/*");
    expect(result).not.toContain("@m7700");
  });

  it("does NOT use handle_path when multiple matcher types set", () => {
    const m: RouteMatch = { path: ["/api/*"], host: ["example.com"] };
    const result = proxyToBlock(proxy({ matchers: m, handlePath: true }));
    expect(result).toContain("@m7700 {");
    expect(result).not.toContain("handle_path");
  });

  it("emits multi-key matcher (AND logic) as single @name block", () => {
    const m: RouteMatch = { path: ["/api/*"], method: ["GET", "POST"] };
    const result = proxyToBlock(proxy({ matchers: m }));
    expect(result).toContain("path /api/*");
    expect(result).toContain("method GET POST");
  });

  it("no handle wrapper when no matchers", () => {
    const result = proxyToBlock(proxy());
    expect(result).not.toContain("handle @");
  });
});

describe("buildServerEntry — matchers", () => {
  it("adds match array when matchers set", () => {
    const m: RouteMatch = { path: ["/api/*"] };
    const entry = buildServerEntry(proxy({ matchers: m }));
    expect(entry.routes[0].match).toBeDefined();
    expect(entry.routes[0].match?.[0]).toMatchObject({ path: ["/api/*"] });
  });

  it("terminal: false when matcher route, terminal: true when no matcher", () => {
    const m: RouteMatch = { path: ["/api/*"] };
    const withMatcher = buildServerEntry(proxy({ matchers: m }));
    expect(withMatcher.routes[0].terminal).not.toBe(true);

    const noMatcher = buildServerEntry(proxy());
    expect(noMatcher.routes[0].terminal).toBe(true);
  });

  it("encodes remote_ip matcher", () => {
    const m: RouteMatch = { remote_ip: { ranges: ["10.0.0.0/8"] } };
    const entry = buildServerEntry(proxy({ matchers: m }));
    expect(entry.routes[0].match?.[0]).toMatchObject({ remote_ip: { ranges: ["10.0.0.0/8"] } });
  });
});

describe("parseProxies — named server post-reload compatibility", () => {
  const serverDef: ServerDef = { key: "testsrv", name: "Test", listenAddresses: [":6464"], tls: true };

  it("recognises named server by listen address when Caddy assigns a different key", () => {
    // After Caddy reloads from Caddyfile it assigns its own key (srv0) not our stored key
    const config: CaddyConfig = {
      apps: { http: { servers: {
        srv0: {
          listen: [":6464"],
          routes: [{ handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "localhost:3000" }] }], terminal: true }],
        },
      } } },
    };
    const proxies = parseProxies(config, [serverDef]);
    expect(proxies).toHaveLength(1);
    expect(proxies[0].namedServerKey).toBe("testsrv");
    expect(proxies[0].id).toBe("testsrv:0");
  });

  it("unwraps subroute handlers produced by Caddyfile adapter", () => {
    // Caddy's Caddyfile adapter wraps `handle { reverse_proxy ... }` in a subroute
    const config: CaddyConfig = {
      apps: { http: { servers: {
        srv0: {
          listen: [":6464"],
          routes: [{
            handle: [{
              handler: "subroute",
              routes: [{ handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "localhost:3000" }] }] }],
            }],
          }],
        },
      } } },
    };
    const proxies = parseProxies(config, [serverDef]);
    expect(proxies).toHaveLength(1);
    expect(proxies[0].targetPort).toBe(3000);
    expect(proxies[0].namedServerKey).toBe("testsrv");
  });

  it("keeps standalone proxies as standalone even when serverDefs present", () => {
    const config: CaddyConfig = {
      apps: { http: { servers: {
        srv7700: {
          listen: [":7700"],
          routes: [{ handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "localhost:7701" }] }], terminal: true }],
        },
      } } },
    };
    const proxies = parseProxies(config, [serverDef]);
    expect(proxies[0].namedServerKey).toBeUndefined();
  });
});

describe("parseProxies — matchers round-trip", () => {
  it("restores path matcher from JSON", () => {
    const config: CaddyConfig = {
      apps: { http: { servers: {
        srv7700: {
          listen: [":7700"],
          routes: [{
            match: [{ path: ["/api/*"] }],
            handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "localhost:7701" }] }],
          }],
        },
      } } },
    };
    const proxies = parseProxies(config);
    expect(proxies[0].matchers).toMatchObject({ path: ["/api/*"] });
  });

  it("restores multi-key matcher", () => {
    const config: CaddyConfig = {
      apps: { http: { servers: {
        srv7700: {
          listen: [":7700"],
          routes: [{
            match: [{ path: ["/api/*"], method: ["GET"] }],
            handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "localhost:7701" }] }],
          }],
        },
      } } },
    };
    const proxies = parseProxies(config);
    expect(proxies[0].matchers?.method).toEqual(["GET"]);
    expect(proxies[0].matchers?.path).toEqual(["/api/*"]);
  });
});

// ---------------------------------------------------------------------------
// Named server — #49
// ---------------------------------------------------------------------------

const testDef: ServerDef = {
  key: "pub",
  name: "Public HTTPS",
  listenAddresses: [":443"],
  tls: true,
};

describe("serverDefToBlock", () => {
  it("emits server key comment and listen address", () => {
    const routes: ProxyEntry[] = [proxy({ matchers: undefined })];
    const { block } = serverDefToBlock(testDef, routes);
    expect(block).toContain("# server: pub");
    expect(block).toContain(":443 {");
    expect(block).toContain("tls internal");
  });

  it("puts matcher routes before catch-all", () => {
    const r1 = proxy({ id: "pub:0", matchers: { path: ["/api/*"] } });
    const r2 = proxy({ id: "pub:1" });
    const { block } = serverDefToBlock(testDef, [r1, r2]);
    const apiPos = block.indexOf("path /api/*");
    const catchPos = block.indexOf("handle {");
    expect(apiPos).toBeGreaterThan(-1);
    expect(catchPos).toBeGreaterThan(-1);
    expect(apiPos).toBeLessThan(catchPos);
  });

  it("emits preamble snippet for named route", () => {
    const r = proxy({ id: "pub:0", isNamedRoute: true, namedRouteName: "auth" });
    const { preamble } = serverDefToBlock(testDef, [r]);
    expect(preamble).toContain("&(auth) {");
  });
});

describe("surgicallyWriteServerBlock", () => {
  it("inserts new server block into empty content", () => {
    const routes: ProxyEntry[] = [proxy()];
    const result = surgicallyWriteServerBlock("", testDef, routes);
    expect(result).toContain("# server: pub");
    expect(result).toContain(":443 {");
  });

  it("replaces existing server block identified by key comment", () => {
    const initial = "# server: pub\n:443 {\n\ttls internal\n\treverse_proxy http://localhost:7701\n}\n";
    const routes: ProxyEntry[] = [proxy({ tls: true })];
    const result = surgicallyWriteServerBlock(initial, testDef, routes);
    expect(result.split("# server: pub").length).toBe(2); // only one occurrence
  });

  it("replaces existing block that has embedded # serverdef: comment without duplicating", () => {
    // The # serverdef: comment must NOT clear the pending serverKey in findBlockPositions.
    // If it does, the block is not found and a duplicate is appended → ambiguous site definition.
    const initial = "# server: pub\n# serverdef: {\"name\":\"pub\",\"tls\":true}\n:443 {\n\ttls internal\n}\n";
    const routes: ProxyEntry[] = [proxy({ tls: true })];
    const result = surgicallyWriteServerBlock(initial, testDef, routes);
    expect(result.split("# server: pub").length).toBe(2); // exactly one — no duplicate
    expect(result.split(":443 {").length).toBe(2); // exactly one :443 block
  });
});

describe("surgicallyRemoveServerBlock", () => {
  it("removes a server block by key", () => {
    const content = "# server: pub\n:443 {\n\ttls internal\n}\n\n# label: other\n:80 {\n\treverse_proxy http://localhost:8080\n}\n";
    const result = surgicallyRemoveServerBlock(content, "pub");
    expect(result).not.toContain("# server: pub");
    expect(result).toContain("# label: other");
  });

  it("returns unchanged content when key not found", () => {
    const content = "# label: other\n:80 {\n\treverse_proxy http://localhost:8080\n}\n";
    const result = surgicallyRemoveServerBlock(content, "nonexistent");
    expect(result).toBe(content);
  });
});

describe("mergeNamedServer — post-reload key collision (#129)", () => {
  it("drops a stale Caddy-auto-named entry sharing the same listen address", () => {
    // Caddy reloaded from the Caddyfile at some point and assigned its own
    // key (srv3) to this server instead of the plugin's stored key. Pushing
    // a live JSON update under the stored key must replace that entry, not
    // add a second server claiming the same port.
    const config: CaddyConfig = {
      apps: { http: { servers: {
        srv3: {
          listen: [":7878"],
          routes: [{ handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "localhost:3000" }] }], terminal: true }],
        },
      } } },
    };
    const def: ServerDef = { key: "uzuzuzuz", name: "Test", listenAddresses: [":7878"], tls: false };
    const routes: ProxyEntry[] = [proxy({ id: "uzuzuzuz:0", matchers: { path: ["/a"] } })];

    const result = mergeNamedServer(config, def, routes);
    const servers = result.apps!.http!.servers!;

    expect(Object.keys(servers)).toEqual(["uzuzuzuz"]);
    expect(servers.uzuzuzuz.listen).toEqual([":7878"]);
  });

  it("leaves other servers on different listen addresses untouched", () => {
    const config: CaddyConfig = {
      apps: { http: { servers: {
        srv0: {
          listen: [":9999"],
          routes: [{ handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "localhost:4000" }] }], terminal: true }],
        },
      } } },
    };
    const def: ServerDef = { key: "uzuzuzuz", name: "Test", listenAddresses: [":7878"], tls: false };
    const routes: ProxyEntry[] = [proxy({ id: "uzuzuzuz:0", matchers: undefined })];

    const result = mergeNamedServer(config, def, routes);
    const servers = result.apps!.http!.servers!;

    expect(Object.keys(servers).sort()).toEqual(["srv0", "uzuzuzuz"]);
  });
});
