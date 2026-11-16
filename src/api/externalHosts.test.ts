import { describe, it, expect } from "vitest";
import { externalHostList, normalizeExternalHost, validateExternalHost, formatExternalHostPort, formatExternalAddressPreview } from "./externalHosts";

describe("externalHostList (#208)", () => {
  it("returns no hosts for an empty or missing value", () => {
    expect(externalHostList(undefined)).toEqual([]);
    expect(externalHostList("")).toEqual([]);
    expect(externalHostList("   ")).toEqual([]);
  });

  it("returns a single host as a one-item list", () => {
    expect(externalHostList("example.com")).toEqual(["example.com"]);
  });

  it("splits a comma-separated list and trims each name", () => {
    expect(externalHostList("example.com, www.example.com")).toEqual(["example.com", "www.example.com"]);
    expect(externalHostList(" a.example.com ,b.example.com")).toEqual(["a.example.com", "b.example.com"]);
  });
});

describe("normalizeExternalHost (#208)", () => {
  it("joins the names with a comma and a space, as Caddy writes site addresses", () => {
    expect(normalizeExternalHost("a.example.com,b.example.com")).toBe("a.example.com, b.example.com");
  });

  it("trims a single host and leaves it otherwise unchanged", () => {
    expect(normalizeExternalHost("  example.com ")).toBe("example.com");
  });

  it("returns undefined when nothing is left", () => {
    expect(normalizeExternalHost("  ")).toBeUndefined();
  });
});

describe("validateExternalHost (#208)", () => {
  it("accepts an empty value (hostless) and a single host", () => {
    expect(validateExternalHost("")).toBeUndefined();
    expect(validateExternalHost("example.com")).toBeUndefined();
    expect(validateExternalHost("192.168.1.10")).toBeUndefined();
    expect(validateExternalHost("[::1]")).toBeUndefined();
  });

  it("accepts several comma-separated hosts", () => {
    expect(validateExternalHost("example.com, www.example.com")).toBeUndefined();
  });

  it("rejects an empty entry", () => {
    expect(validateExternalHost("a.example.com,,b.example.com")).toEqual({ kind: "empty_entry" });
    expect(validateExternalHost("a.example.com,")).toEqual({ kind: "empty_entry" });
    expect(validateExternalHost(", a.example.com")).toEqual({ kind: "empty_entry" });
  });

  it("rejects a space inside a name", () => {
    expect(validateExternalHost("a.example.com b.example.com")).toEqual({ kind: "space", host: "a.example.com b.example.com" });
  });

  it("rejects a scheme in any entry", () => {
    expect(validateExternalHost("https://a.example.com, b.example.com")).toEqual({ kind: "scheme_or_port", host: "https://a.example.com" });
    expect(validateExternalHost("a.example.com, https://b.example.com")).toEqual({ kind: "scheme_or_port", host: "https://b.example.com" });
  });

  it("rejects a port in any entry", () => {
    expect(validateExternalHost("a.example.com:8443, b.example.com")).toEqual({ kind: "scheme_or_port", host: "a.example.com:8443" });
    expect(validateExternalHost("[::1]:8443")).toEqual({ kind: "scheme_or_port", host: "[::1]:8443" });
  });

  it("rejects the same name listed twice", () => {
    expect(validateExternalHost("a.example.com, A.example.com")).toEqual({ kind: "duplicate", host: "A.example.com" });
  });
});

describe("formatExternalHostPort (#208)", () => {
  it("shows a hostless address as :port", () => {
    expect(formatExternalHostPort({ externalPort: 443 })).toBe(":443");
  });

  it("shows a single host as host:port, as before", () => {
    expect(formatExternalHostPort({ externalHost: "example.com", externalPort: 443 })).toBe("example.com:443");
  });

  it("shows every host of a multi-host address", () => {
    expect(formatExternalHostPort({ externalHost: "example.com, www.example.com", externalPort: 443 }))
      .toBe("example.com:443, www.example.com:443");
  });
});

describe("formatExternalAddressPreview (#208)", () => {
  it("matches the single-host preview the dialogs showed before", () => {
    expect(formatExternalAddressPreview("https", "example.com", "8443")).toBe("https://example.com:8443");
    expect(formatExternalAddressPreview("", "example.com", "")).toBe("example.com:…");
    expect(formatExternalAddressPreview("", "", "8443")).toBe(":8443");
    expect(formatExternalAddressPreview("", "", "")).toBeNull();
  });

  it("lists every name with the scheme and port", () => {
    expect(formatExternalAddressPreview("https", "a.example.com,b.example.com", "8443"))
      .toBe("https://a.example.com:8443, https://b.example.com:8443");
  });
});
