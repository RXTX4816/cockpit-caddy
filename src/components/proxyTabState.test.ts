import { describe, it, expect } from "vitest";
import type { ProxyEntry } from "../api";
import { emptyProxyTabState, proxyTabStateFromEntry, proxyTabStateToEntry } from "./proxyTabState";

const base: ProxyEntry = {
  id: "host:example.com", serverKey: "srv0", externalPort: 443, externalHost: "example.com",
  targetHost: "localhost", targetPort: 8000, targetScheme: "http", tls: true, tlsSkipVerify: false,
};

// #290: Add, Edit and Duplicate share one mapping between a ProxyEntry and the tab state.
describe("proxy tab state (#290)", () => {
  it("an entry without tab settings maps to the empty state and back to nothing", async () => {
    expect(proxyTabStateFromEntry(base)).toEqual(emptyProxyTabState());
    const fields = await proxyTabStateToEntry(emptyProxyTabState());
    expect(Object.values(fields).filter(v => v !== undefined)).toEqual([]);
  });

  it("round-trips every tab setting", async () => {
    const full: ProxyEntry = {
      ...base,
      basicAuth: [{ username: "admin", passwordHash: "$2a$14$x" }],
      forwardAuth: { upstreamUrl: "http://localhost:9091", uri: "/auth", copyHeaders: ["Remote-User"] },
      matchers: { path: ["/api/*"] },
      handlePath: true,
      rewrite: { type: "strip_prefix", value: "/api" },
      requestHeaders: [{ op: "set", name: "X-A", value: "1" }],
      responseHeaders: [{ op: "delete", name: "Server" }],
      isNamedRoute: true,
      namedRouteName: "api",
      extraUpstreams: [{ host: "10.0.0.2", port: 8001 }],
      lbPolicy: "round_robin",
      dialTimeout: "5s",
      responseHeaderTimeout: "30s",
      errorHandlers: [{ matchType: "specific", codes: [404], type: "respond", body: "gone" }],
      serverReadTimeout: "10s",
      serverReadHeaderTimeout: "2s",
      serverWriteTimeout: "20s",
      serverIdleTimeout: "2m",
      maxHeaderBytes: 32768,
      disableHttp3: true,
      requestBodyMaxSize: 1048576,
    };
    const fields = await proxyTabStateToEntry(proxyTabStateFromEntry(full));
    expect(fields).toMatchObject({
      basicAuth: [{ username: "admin", passwordHash: "$2a$14$x" }],
      forwardAuth: full.forwardAuth,
      matchers: { path: ["/api/*"] },
      handlePath: true,
      rewrite: full.rewrite,
      requestHeaders: full.requestHeaders,
      responseHeaders: full.responseHeaders,
      isNamedRoute: true,
      namedRouteName: "api",
      extraUpstreams: [{ host: "10.0.0.2", port: 8001 }],
      lbPolicy: "round_robin",
      dialTimeout: "5s",
      responseHeaderTimeout: "30s",
      errorHandlers: full.errorHandlers,
      serverReadTimeout: "10s",
      serverReadHeaderTimeout: "2s",
      serverWriteTimeout: "20s",
      serverIdleTimeout: "2m",
      maxHeaderBytes: 32768,
      disableHttp3: true,
      requestBodyMaxSize: 1048576,
    });
  });

  it("drops the named-route name when the route isn't named", async () => {
    const s = { ...emptyProxyTabState(), isNamedRoute: false, namedRouteName: "stale" };
    expect((await proxyTabStateToEntry(s)).namedRouteName).toBeUndefined();
  });
});
