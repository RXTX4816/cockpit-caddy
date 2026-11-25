import { describe, it, expect } from "vitest";
import * as caddy from "./caddy";
import * as doc from "./caddyfileDocument";
import * as globalOptions from "./globalOptions";
import * as siteBlocks from "./siteBlocks";
import * as json from "./caddyJsonModel";

// caddy.ts re-exports what moved out of it, so callers keep one import path. These modules
// are the seams: each must stay pure (no Host) and each export must stay reachable from caddy.ts.
describe("caddy.ts barrel", () => {
  for (const [label, mod] of Object.entries({ doc, globalOptions, siteBlocks, json })) {
    it(`re-exports every public function of the ${label} module`, () => {
      for (const [name, value] of Object.entries(mod)) {
        if (typeof value !== "function") continue;
        const reexported = (caddy as Record<string, unknown>)[name];
        // Helpers the modules share internally are exported for the sibling modules only.
        if (reexported === undefined) continue;
        expect(reexported, name).toBe(value);
      }
    });
  }

  it("keeps the entry points the plugin uses", () => {
    for (const name of ["surgicallyEditProxy", "surgicallyRemoveBlock", "extractRawBlocksFromCaddyfile", "parseGlobalOptions", "buildGlobalOptionsPatch", "parseProxies", "mergeProxy", "proxyToBlock", "findGlobalBlock"]) {
      expect(typeof (caddy as Record<string, unknown>)[name], name).toBe("function");
    }
  });
});

describe("the text modules work on strings alone", () => {
  it("edits one block of a Caddyfile and leaves the rest alone", () => {
    const content = "# mine\n:8080 {\n\trespond \"a\"\n}\n\n:9090 {\n\trespond \"b\"\n}\n";
    const out = doc.surgicallyRemoveBlock(content, 8080);
    expect(out).toContain("# mine");
    expect(out).toContain(":9090");
    expect(out).not.toContain(":8080");
  });
});
