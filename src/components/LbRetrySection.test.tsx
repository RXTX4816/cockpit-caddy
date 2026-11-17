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

  it("active check options need a path", () => {
    expect(validateLbRetry(v({ healthInterval: "10s" }))).toBe("lb_retry.validation_needs_health_uri");
    expect(validateLbRetry(v({ healthUri: "/h", healthInterval: "10s" }))).toBeNull();
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
