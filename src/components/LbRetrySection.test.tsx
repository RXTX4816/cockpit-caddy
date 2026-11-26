import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { LbRetrySection, lbRetryConfigToValues, lbRetryValuesToConfig, validateLbRetry, lbRetryWarning, type LbRetryValues } from "./LbRetrySection";

const empty = lbRetryConfigToValues(undefined);
const v = (patch: Partial<LbRetryValues>): LbRetryValues => ({ ...empty, ...patch });

// #252: passive checks need fail_duration; active checks need a path.
describe("LbRetrySection health checks (#252)", () => {
  it("round-trips every field through values and config", () => {
    const cfg = {
      retries: 2, tryDuration: "5s", tryInterval: "250ms",
      failDuration: "30s", maxFails: 3, unhealthyStatus: [500, 503],
      healthUri: "/healthz", healthInterval: "10s", healthTimeout: "2s", healthStatus: "2xx",
    };
    expect(lbRetryValuesToConfig(lbRetryConfigToValues(cfg))).toEqual(cfg);
  });

  it("empty values give no config", () => {
    expect(lbRetryValuesToConfig(empty)).toBeUndefined();
  });

  it("unhealthy status codes or max fails without a fail duration warn but don't block saving", () => {
    // Older versions saved unhealthy_status alone (the old Defaults preset); such a proxy must stay editable.
    expect(validateLbRetry(v({ unhealthyStatus: "500" }))).toBeNull();
    expect(lbRetryWarning(v({ unhealthyStatus: "500" }))).toBe("lb_retry.validation_needs_fail_duration");
    expect(lbRetryWarning(v({ maxFails: "3" }))).toBe("lb_retry.validation_needs_fail_duration");
    expect(lbRetryWarning(v({ unhealthyStatus: "500", maxFails: "3", failDuration: "30s" }))).toBeNull();
  });

  it("max fails must be a positive whole number", () => {
    expect(validateLbRetry(v({ failDuration: "30s", maxFails: "0" }))).toBe("lb_retry.validation_max_fails");
  });

  it("active check options need a path or a port", () => {
    expect(validateLbRetry(v({ healthInterval: "10s" }))).toBe("lb_retry.validation_needs_health_target");
    expect(validateLbRetry(v({ healthPasses: "2" }))).toBe("lb_retry.validation_needs_health_target");
    expect(validateLbRetry(v({ healthHeaders: "Host a" }))).toBe("lb_retry.validation_needs_health_target");
    expect(validateLbRetry(v({ healthUri: "/h", healthInterval: "10s" }))).toBeNull();
    expect(validateLbRetry(v({ healthPort: "8081", healthInterval: "10s" }))).toBeNull();
  });

  it("checks durations and the expected status", () => {
    expect(validateLbRetry(v({ failDuration: "30" }))).toBe("lb_retry.validation_duration");
    expect(validateLbRetry(v({ healthUri: "/h", healthTimeout: "x" }))).toBe("lb_retry.validation_duration");
    expect(validateLbRetry(v({ healthUri: "/h", healthStatus: "2xx" }))).toBeNull();
    expect(validateLbRetry(v({ healthUri: "/h", healthStatus: "204" }))).toBeNull();
    expect(validateLbRetry(v({ healthUri: "/h", healthStatus: "ok" }))).toBe("lb_retry.validation_health_status");
  });

  it("the health check path must start with /", () => {
    expect(validateLbRetry(v({ healthUri: "healthz" }))).toBe("lb_retry.validation_health_uri");
  });
});

describe("LbRetrySection error placement (#252)", () => {
  it("shows each group's errors under that group only", () => {
    render(<LbRetrySection value={v({ tryDuration: "x", unhealthyStatus: "500" })} onChange={() => {}} isExpanded />);
    const retry = screen.getByTestId("lbr-retry-help");
    const passive = screen.getByTestId("lbr-passive-help");
    const active = screen.getByTestId("lbr-active-help");
    expect(retry.textContent).toContain("Must be a Go duration");
    expect(passive.textContent).toContain("only take effect with a fail duration");
    expect(active.textContent).not.toContain("Must be a Go duration");
    expect(active.textContent).not.toContain("fail duration");
  });
});

// #301: bare placeholders looked like values someone had typed. Caddy's defaults read
// "Default: …", values that only illustrate an option (off by default) read "e.g. …".
describe("LbRetrySection placeholders (#301)", () => {
  it("marks Caddy defaults and examples", () => {
    render(<LbRetrySection value={empty} onChange={() => {}} isExpanded />);
    const ph = (id: string) => document.getElementById(id)!.getAttribute("placeholder");
    expect(ph("lbr-retries")).toBe("e.g. 3");
    expect(ph("lbr-try-duration")).toBe("e.g. 5s");
    expect(ph("lbr-try-interval")).toBe("Default: 250ms");
    expect(ph("lbr-fail-duration")).toBe("e.g. 30s");
    expect(ph("lbr-max-fails")).toBe("Default: 1");
    expect(ph("lbr-health-uri")).toBe("e.g. /healthz");
    expect(ph("lbr-health-interval")).toBe("Default: 30s");
    expect(ph("lbr-health-timeout")).toBe("Default: 5s");
    expect(ph("lbr-health-status")).toBe("Default: 2xx");
  });
});

// Active check port, request headers and the pass/fail counts.
describe("LbRetrySection active check port, headers, passes and fails", () => {
  it("round-trips them through values and config, headers one per line", () => {
    const cfg = {
      healthUri: "/healthz", healthPort: 8081, healthPasses: 2, healthFails: 3,
      healthHeaders: { Host: ["app.internal"], "X-Token": ["a b", "c"] },
    };
    const values = lbRetryConfigToValues(cfg);
    expect(values.healthHeaders).toBe("Host app.internal\nX-Token a b\nX-Token c");
    expect(lbRetryValuesToConfig(values)).toEqual(cfg);
  });

  it("skips blank header lines and trims around the value", () => {
    expect(lbRetryValuesToConfig(v({ healthUri: "/h", healthHeaders: "\n  Host   app.internal  \n\n" }))?.healthHeaders).toEqual({ Host: ["app.internal"] });
  });

  it("checks the port, the counts and the header lines", () => {
    expect(validateLbRetry(v({ healthPort: "0" }))).toBe("lb_retry.validation_health_port");
    expect(validateLbRetry(v({ healthPort: "70000" }))).toBe("lb_retry.validation_health_port");
    expect(validateLbRetry(v({ healthUri: "/h", healthPasses: "0" }))).toBe("lb_retry.validation_health_count");
    expect(validateLbRetry(v({ healthUri: "/h", healthFails: "x" }))).toBe("lb_retry.validation_health_count");
    expect(validateLbRetry(v({ healthUri: "/h", healthHeaders: "Host" }))).toBe("lb_retry.validation_health_headers");
    expect(validateLbRetry(v({ healthUri: "/h", healthHeaders: "Bad:Name x" }))).toBe("lb_retry.validation_health_headers");
    expect(validateLbRetry(v({ healthUri: "/h", healthPort: "8081", healthPasses: "2", healthFails: "3", healthHeaders: "Host a" }))).toBeNull();
  });

  it("marks Caddy's defaults in the placeholders", () => {
    render(<LbRetrySection value={empty} onChange={() => {}} isExpanded />);
    const ph = (id: string) => document.getElementById(id)!.getAttribute("placeholder");
    expect(ph("lbr-health-port")).toBe("Default: the upstream's port");
    expect(ph("lbr-health-passes")).toBe("Default: 1");
    expect(ph("lbr-health-fails")).toBe("Default: 1");
    expect(ph("lbr-health-headers")).toBe("e.g. Host app.internal");
  });
});
