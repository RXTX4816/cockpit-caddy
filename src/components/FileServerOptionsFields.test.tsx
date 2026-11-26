import { describe, it, expect } from "vitest";
import { browseFileLimitInvalid, fileServerOptionsDraft, fileServerOptionsFromDraft } from "./FileServerOptionsFields";

describe("file server options draft (#262)", () => {
  it("keeps the precompressed order a site already has", () => {
    const draft = fileServerOptionsDraft({ root: "/srv", precompressed: ["gzip", "br"] });
    expect(fileServerOptionsFromDraft(draft).precompressed).toEqual(["gzip", "br"]);
  });

  it("leaves unset options out, so old sites save unchanged", () => {
    expect(fileServerOptionsFromDraft(fileServerOptionsDraft({ root: "/srv", browse: true }))).toEqual({});
  });

  it("splits index and hide on whitespace", () => {
    const d = { ...fileServerOptionsDraft(undefined), index: " a.html  b.html ", hide: ".git" };
    expect(fileServerOptionsFromDraft(d)).toEqual({ index: ["a.html", "b.html"], hide: [".git"] });
  });
});

describe("listing options draft (#340)", () => {
  it("round-trips sort, file limit and reveal_symlinks", () => {
    const fs = { root: "/srv", browse: true, browseSort: { by: "time" as const, order: "desc" as const }, browseFileLimit: 50, browseRevealSymlinks: true };
    expect(fileServerOptionsFromDraft(fileServerOptionsDraft(fs))).toEqual({ browseSort: fs.browseSort, browseFileLimit: 50, browseRevealSymlinks: true });
  });

  it("drops an explicit ascending order, Caddy's default", () => {
    const d = fileServerOptionsDraft({ root: "/srv", browseSort: { by: "name", order: "asc" } });
    expect(fileServerOptionsFromDraft(d).browseSort).toEqual({ by: "name" });
  });

  it("rejects a file limit that isn't a positive whole number", () => {
    const d = (browseFileLimit: string) => ({ ...fileServerOptionsDraft(undefined), browseFileLimit });
    expect(browseFileLimitInvalid(d(""))).toBe(false);
    expect(browseFileLimitInvalid(d("10"))).toBe(false);
    for (const bad of ["0", "-1", "1.5", "x"]) expect(browseFileLimitInvalid(d(bad))).toBe(true);
  });
});
