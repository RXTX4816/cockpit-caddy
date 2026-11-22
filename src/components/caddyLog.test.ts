import { describe, it, expect } from "vitest";
import { parseCaddyLogLine, matchesLevel, matchesLogger, matchesSearch } from "./caddyLog";

// #257: Caddy's log lines as table rows.
describe("parseCaddyLogLine", () => {
  it("parses a JSON access log line", () => {
    const line = '{"level":"error","ts":1794990064.388,"logger":"http.log.access.log0","msg":"handled request","request":{"remote_ip":"10.0.2.2","method":"GET","host":"app.example.com","uri":"/api?x=1"},"status":502}';
    const p = parseCaddyLogLine(line);
    expect(p).toMatchObject({
      level: "error", logger: "http.log.access.log0", msg: "handled request",
      host: "app.example.com", method: "GET", uri: "/api?x=1", status: 502, raw: line,
    });
    expect(p.ts?.getTime()).toBe(1794990064388);
    expect(p.json?.status).toBe(502);
  });

  it("parses a JSON line that isn't an access log", () => {
    const p = parseCaddyLogLine('{"level":"info","ts":"2026-11-18T08:00:00.123Z","logger":"tls","msg":"cleaning storage unit"}');
    expect(p).toMatchObject({ level: "info", logger: "tls", msg: "cleaning storage unit" });
    expect(p.ts?.toISOString()).toBe("2026-11-18T08:00:00.123Z");
    expect(p.host).toBeUndefined();
    expect(p.status).toBeUndefined();
  });

  it("parses a console-format line", () => {
    const p = parseCaddyLogLine("2026/11/18 08:00:00.123\tWARN\ttls.cache\tstapling OCSP\t{\"identifiers\": [\"a\"]}");
    expect(p).toMatchObject({ level: "warn", logger: "tls.cache", msg: 'stapling OCSP\t{"identifiers": ["a"]}' });
    expect(p.json).toBeUndefined();
  });

  it("parses a journal-prefixed JSON line", () => {
    const p = parseCaddyLogLine('2026-11-18T08:00:00+0000 vm caddy[812]: {"level":"warn","ts":1794990064,"logger":"admin.api","msg":"received request"}');
    expect(p).toMatchObject({ level: "warn", logger: "admin.api", msg: "received request" });
  });

  it("keeps an unparsable line as its raw text", () => {
    expect(parseCaddyLogLine("-- Boot 1234 --")).toEqual({ raw: "-- Boot 1234 --", msg: "-- Boot 1234 --" });
    expect(parseCaddyLogLine('caddy[1]: {"broken')).toEqual({ raw: 'caddy[1]: {"broken', msg: 'caddy[1]: {"broken' });
  });
});

describe("filters", () => {
  const err = parseCaddyLogLine('{"level":"error","logger":"http.log.access.log0","msg":"x"}');
  const info = parseCaddyLogLine('{"level":"info","logger":"tls","msg":"y"}');
  const plain = parseCaddyLogLine("plain text");

  it("levels are thresholds", () => {
    const debug = parseCaddyLogLine('{"level":"debug","msg":"z"}');
    expect([err, info, plain].map(l => matchesLevel(l, "error"))).toEqual([true, false, false]);
    expect([err, info, plain].map(l => matchesLevel(l, "warn"))).toEqual([true, false, false]);
    expect([err, info, plain, debug].map(l => matchesLevel(l, "info"))).toEqual([true, true, true, true]);
    expect([err, info, plain].map(l => matchesLevel(l, "all"))).toEqual([true, true, true]);
  });

  it("logger tabs", () => {
    expect([err, info, plain].map(l => matchesLogger(l, "caddy"))).toEqual([false, true, true]);
    expect([err, info, plain].map(l => matchesLogger(l, "http.log.access.log0"))).toEqual([true, false, false]);
  });

  it("search in plain and regex mode, a bad regex matches everything", () => {
    expect(matchesSearch(info, "CLEAN", false)).toBe(false);
    expect(matchesSearch(info, "TLS", false)).toBe(true);
    expect(matchesSearch(info, "^\\{.*\"y\"", true)).toBe(true);
    expect(matchesSearch(info, "(", true)).toBe(true);
  });
});
