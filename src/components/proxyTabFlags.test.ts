import { serverExtrasToValues } from "./ServerTimeoutsSection";
import { describe, it, expect } from "vitest";
import { proxyTabFlags, type ProxyTabValues } from "./proxyTabFlags";
import { accessLogConfigToValues } from "./AccessLogSection";
import { lbRetryConfigToValues } from "./LbRetrySection";
import { tlsConfigToValues } from "./TlsSection";
import { emptyLbArgs } from "./UpstreamsSection";

const base: ProxyTabValues = {
  basicAuth: [], forwardAuth: undefined, forwardAuthError: null, tlsValues: tlsConfigToValues(undefined, undefined),
  matchers: undefined, rewrite: undefined, requestHeaders: undefined, responseHeaders: undefined, isNamedRoute: false,
  extraUpstreams: [], lbPolicy: "", lbArgs: emptyLbArgs(), lbRetry: lbRetryConfigToValues(undefined), transport: { dialTimeout: "", responseHeaderTimeout: "" },
  accessLog: accessLogConfigToValues(undefined), errorHandlers: [],
  serverTimeouts: { readTimeout: "", readHeaderTimeout: "", writeTimeout: "", idleTimeout: "", maxHeaderBytes: "", disableHttp3: false, ...serverExtrasToValues(undefined) },
  requestBodyMaxSize: "",
};

const dots = (v: Partial<ProxyTabValues>) => Object.entries(proxyTabFlags({ ...base, ...v }, false).configured).filter(([, on]) => on).map(([k]) => k);

// #260: a dot marks every tab except General that holds a non-default value.
describe("proxyTabFlags", () => {
  it("nothing set, no dots", () => {
    expect(dots({})).toEqual([]);
  });

  it("each setting marks only its own tab", () => {
    expect(dots({ basicAuth: [{ username: "a", password: "b" }] })).toEqual(["security"]);
    expect(dots({ matchers: { not: { path: ["/x"] } } })).toEqual(["routing"]);
    expect(dots({ transport: { dialTimeout: "5s", responseHeaderTimeout: "" } })).toEqual(["upstreams"]);
    expect(dots({ errorHandlers: [{ matchType: "all", type: "respond", body: "x" }] })).toEqual(["logging"]);
  });

  // #292: server timeouts and the body size are limits, not logging.
  it("server timeouts and the body size mark the Limits tab", () => {
    expect(dots({ requestBodyMaxSize: "1024" })).toEqual(["limits"]);
    expect(dots({ serverTimeouts: { ...base.serverTimeouts, idleTimeout: "2m" } })).toEqual(["limits"]);
    expect(dots({ serverTimeouts: { ...base.serverTimeouts, disableHttp3: true } })).toEqual(["limits"]);
  });

  it("errors mark their tab", () => {
    const flags = proxyTabFlags({ ...base, forwardAuthError: "forward_auth.validation_uri_required", extraUpstreams: [{ host: "", port: "x" }] }, true);
    expect(flags.hasError).toEqual({ general: true, security: true, routing: false, upstreams: true, logging: false, limits: false });
  });
});

describe("load-balancing arguments (#285)", () => {
  it("a weight count that doesn't match the upstreams is an Upstreams error", () => {
    const v = { ...base, extraUpstreams: [{ host: "a", port: "1" }], lbPolicy: "weighted_round_robin", lbArgs: { ...emptyLbArgs(), weights: ["1"] } };
    expect(proxyTabFlags(v, false).hasError.upstreams).toBe(true);
    expect(proxyTabFlags({ ...v, lbArgs: { ...emptyLbArgs(), weights: ["1", "2"] } }, false).hasError.upstreams).toBe(false);
  });
});
