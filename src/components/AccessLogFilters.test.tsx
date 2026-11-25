import { describe, it, expect } from "vitest";
import { accessLogConfigToValues, accessLogValuesToConfig, fieldFiltersFromText, fieldFiltersToText, validateFieldFilters } from "./AccessLogSection";

describe("access log field filter text (#334)", () => {
  const text = "request>headers>Authorization delete\nrequest>headers>Cookie hash\nrequest>uri replace ***\nrequest>remote_ip ip_mask 24 64";

  it("reads the lines and writes them back", () => {
    const filters = fieldFiltersFromText(text);
    expect(filters).toEqual([
      { field: "request>headers>Authorization", filter: "delete" },
      { field: "request>headers>Cookie", filter: "hash" },
      { field: "request>uri", filter: "replace", value: "***" },
      { field: "request>remote_ip", filter: "ip_mask", ipv4: 24, ipv6: 64 },
    ]);
    expect(fieldFiltersToText(filters)).toBe(text);
  });

  it("flags a line Caddy would not take", () => {
    expect(validateFieldFilters(text)).toBe(false);
    expect(validateFieldFilters("")).toBe(false);
    expect(validateFieldFilters("request>uri")).toBe(true);
    expect(validateFieldFilters("request>uri replace")).toBe(true);
    expect(validateFieldFilters("request>remote_ip ip_mask")).toBe(true);
    expect(validateFieldFilters("request>uri scramble")).toBe(true);
  });

  it("carries the filters, include and exclude through the form", () => {
    const cfg = { output: "stderr" as const, fieldFilters: fieldFiltersFromText(text), include: ["http.log.access"], exclude: ["admin"] };
    expect(accessLogValuesToConfig(accessLogConfigToValues(cfg))).toMatchObject(cfg);
    expect(accessLogValuesToConfig(accessLogConfigToValues({ output: "stderr" }))).toMatchObject({ output: "stderr", fieldFilters: undefined, include: undefined });
  });
});
