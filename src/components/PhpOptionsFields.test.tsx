import { describe, it, expect } from "vitest";
import { fileServerOptionsDraft, fileServerOptionsFromDraft, phpOptionsDraft, phpOptionsFromDraft, phpOptionsHaveErrors } from "./FileServerOptionsFields";

describe("file_server and php_fastcgi option drafts (#340)", () => {
  it("maps the file_server options to the form and back", () => {
    const fs = { root: "/srv", disableCanonicalUris: true, status: 404, browseTemplate: "/etc/caddy/listing.html" };
    expect(fileServerOptionsFromDraft(fileServerOptionsDraft(fs))).toEqual({ disableCanonicalUris: true, status: 404, browseTemplate: "/etc/caddy/listing.html" });
  });

  it("writes nothing for a site without options", () => {
    expect(fileServerOptionsFromDraft(fileServerOptionsDraft({ root: "/srv" }))).toEqual({});
  });

  it("maps the php options to the form and back", () => {
    const php = { upstream: "x:9000", root: "/srv", captureStderr: true, resolveRootSymlink: true, dialTimeout: "3s", readTimeout: "10s", writeTimeout: "20s" };
    expect(phpOptionsFromDraft(phpOptionsDraft(php))).toEqual({ captureStderr: true, resolveRootSymlink: true, dialTimeout: "3s", readTimeout: "10s", writeTimeout: "20s" });
  });

  it("flags a timeout Caddy would not read", () => {
    expect(phpOptionsHaveErrors({ ...phpOptionsDraft(undefined), readTimeout: "ten" })).toBe(true);
    expect(phpOptionsHaveErrors({ ...phpOptionsDraft(undefined), readTimeout: "10s" })).toBe(false);
  });
});
