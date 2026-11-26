import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FileServerOptionsFields, browseFileLimitInvalid, fileServerOptionsDraft, fileServerOptionsFromDraft } from "./FileServerOptionsFields";

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

describe("static try_files next to SPA mode", () => {
  it("round-trips a site's own try_files through the draft", () => {
    const d = fileServerOptionsDraft({ root: "/srv", tryFiles: "{path} {path}/ /index.html?{query}" });
    expect(d.tryFiles).toBe("{path} {path}/ /index.html?{query}");
    expect(fileServerOptionsFromDraft(d)).toEqual({ tryFiles: "{path} {path}/ /index.html?{query}" });
  });

  it("SPA mode replaces the line, and typing the SPA line turns SPA mode on", () => {
    expect(fileServerOptionsFromDraft({ ...fileServerOptionsDraft(undefined), spa: true, tryFiles: "{path} /x" })).toEqual({ spa: true });
    expect(fileServerOptionsFromDraft({ ...fileServerOptionsDraft(undefined), tryFiles: " {path}   /index.html " })).toEqual({ spa: true });
  });

  it("shows the SPA line locked while SPA mode is on, and the site's own line after", () => {
    const d = { ...fileServerOptionsDraft(undefined), tryFiles: "{path} /a.html" };
    const { rerender } = render(<FileServerOptionsFields idPrefix="s" value={{ ...d, spa: true }} onChange={() => {}} />);
    const field = () => document.getElementById("s-try-files") as HTMLInputElement;
    expect(field().value).toBe("{path} /index.html");
    expect(field().disabled).toBe(true);
    rerender(<FileServerOptionsFields idPrefix="s" value={d} onChange={() => {}} />);
    expect(field().value).toBe("{path} /a.html");
    expect(field().disabled).toBe(false);
  });

  it("opens the advanced options when the site has a try_files line", () => {
    render(<FileServerOptionsFields idPrefix="t" value={{ ...fileServerOptionsDraft(undefined), tryFiles: "{path} /a.html" }} onChange={() => {}} />);
    expect(screen.getByText("Try files")).toBeTruthy();
    expect(screen.getByTestId("t-advanced").querySelector("#t-try-files")).toBeTruthy();
  });
});
