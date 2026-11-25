import { describe, it, expect } from "vitest";
import {
  dynamicUpstreamsToConfig, dynamicUpstreamsToValues, emptyDynamicSource, validateDynamicUpstreams,
} from "./DynamicUpstreamsSection";

describe("DynamicUpstreamsSection values (#326)", () => {
  const cfg = [
    { type: "srv" as const, name: "_http._tcp.example.com", refresh: "1m", resolvers: ["1.1.1.1", "9.9.9.9"], gracePeriod: "5s" },
    { type: "a" as const, name: "backend.example.com", port: "8080", versions: "ipv4" as const },
  ];

  it("round-trips a config through the typed values", () => {
    expect(dynamicUpstreamsToConfig(dynamicUpstreamsToValues(cfg))).toEqual(cfg);
  });

  it("leaves out sources without a name and returns undefined for none", () => {
    expect(dynamicUpstreamsToConfig([emptyDynamicSource()])).toBeUndefined();
    expect(dynamicUpstreamsToConfig([])).toBeUndefined();
  });

  it("drops the port and versions of an srv source", () => {
    const [s] = dynamicUpstreamsToConfig([{ ...emptyDynamicSource(), name: "_x._tcp.a.b", port: "80", versions: "ipv4" }])!;
    expect(s).toEqual({ type: "srv", name: "_x._tcp.a.b" });
  });

  it("flags a source with options but no name, bad durations and bad ports", () => {
    expect(validateDynamicUpstreams([emptyDynamicSource()])).toBeNull();
    expect(validateDynamicUpstreams([{ ...emptyDynamicSource(), refresh: "1m" }])).toBe("dynamic_upstreams.validation_name");
    expect(validateDynamicUpstreams([{ ...emptyDynamicSource(), name: "x", refresh: "soon" }])).toBe("lb_retry.validation_duration");
    expect(validateDynamicUpstreams([{ ...emptyDynamicSource(), type: "a", name: "x", port: "99999x" }])).toBe("upstreams.validation_port");
    expect(validateDynamicUpstreams([{ ...emptyDynamicSource(), type: "a", name: "x", port: "8080" }])).toBeNull();
  });
});
