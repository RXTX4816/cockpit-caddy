import { describe, expect, it } from "vitest";
import { accessLogConfigToValues } from "./AccessLogSection";
import { serverTabFlags, type ServerTabValues } from "./ServerDialogTabs";
import { tlsConfigToValues } from "./TlsSection";

const empty = (): ServerTabValues => ({
  tlsValues: tlsConfigToValues(undefined, undefined),
  accessLog: accessLogConfigToValues(undefined),
  errorHandlers: [],
  serverTimeouts: { readTimeout: "", readHeaderTimeout: "", writeTimeout: "", idleTimeout: "", maxHeaderBytes: "", disableHttp3: false },
});

describe("serverTabFlags", () => {
  it("marks nothing for the defaults", () => {
    const f = serverTabFlags(empty(), false);
    expect(Object.values(f.configured).some(Boolean)).toBe(false);
    expect(Object.values(f.hasError).some(Boolean)).toBe(false);
  });

  it("marks Limits when a timeout is set", () => {
    const v = empty();
    v.serverTimeouts.idleTimeout = "30s";
    expect(serverTabFlags(v, false).configured.limits).toBe(true);
  });

  it("marks Logging when an error handler exists", () => {
    const v = empty();
    v.errorHandlers = [{ statusCodes: [404], response: { type: "static", body: "x" } } as never];
    expect(serverTabFlags(v, false).configured.logging).toBe(true);
  });

  it("flags Logging when file output has no path", () => {
    const v = empty();
    v.accessLog = { ...v.accessLog, enabled: true, output: "file", filePath: "" };
    expect(serverTabFlags(v, false).hasError.logging).toBe(true);
  });

  it("puts a General error on the General tab", () => {
    expect(serverTabFlags(empty(), true).hasError.general).toBe(true);
  });
});
