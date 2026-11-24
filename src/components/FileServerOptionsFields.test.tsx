import { describe, it, expect } from "vitest";
import { fileServerOptionsDraft, fileServerOptionsFromDraft } from "./FileServerOptionsFields";

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
