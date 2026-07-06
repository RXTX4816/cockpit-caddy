import { describe, it, expect, beforeEach } from "vitest";
import { buildRouteUrl, resolveRouteHost } from "./routeUrl";
import type { ProxyEntry } from "../api";

function makeProxy(overrides: Partial<ProxyEntry> = {}): ProxyEntry {
  return {
    id: "1",
    serverKey: "srv1",
    externalPort: 443,
    externalScheme: "https",
    tls: true,
    targetScheme: "http",
    targetHost: "localhost",
    targetPort: 8080,
    ...overrides,
  } as ProxyEntry;
}

describe("resolveRouteHost / buildRouteUrl (#140)", () => {
  beforeEach(() => {
    Object.defineProperty(window, "location", {
      value: { ...window.location, hostname: "localhost" },
      writable: true,
    });
  });

  it("falls back to window.location.hostname when no host info is set", () => {
    const proxy = makeProxy();
    expect(resolveRouteHost(proxy)).toBe("localhost");
    expect(buildRouteUrl("https", 8443, proxy)).toBe("https://localhost:8443/");
  });

  it("uses externalHost (the subdomain typed into Add/Edit Proxy) over window.location.hostname", () => {
    const proxy = makeProxy({ externalHost: "app.example.com" });
    expect(resolveRouteHost(proxy)).toBe("app.example.com");
    expect(buildRouteUrl("https", 8443, proxy)).toBe("https://app.example.com:8443/");
  });

  it("prefers the Host matcher over externalHost when both are set", () => {
    const proxy = makeProxy({
      externalHost: "app.example.com",
      matchers: { host: ["matched.example.com"] },
    });
    expect(resolveRouteHost(proxy)).toBe("matched.example.com");
    expect(buildRouteUrl("https", 8443, proxy)).toBe("https://matched.example.com:8443/");
  });

  it("includes the first path matcher in the URL when present", () => {
    const proxy = makeProxy({ externalHost: "app.example.com", matchers: { path: ["/api/*"] } });
    expect(buildRouteUrl("https", 8443, proxy)).toBe("https://app.example.com:8443/api/");
  });
});
