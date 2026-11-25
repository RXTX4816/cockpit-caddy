import { describe, it, expect } from "vitest";
import { headerUpFromText, headerUpToText } from "./ForwardAuthSection";

describe("forward_auth header_up text (#336)", () => {
  it("reads set, add and delete lines and writes them back", () => {
    const text = "X-Real-IP {remote_host}\n+X-Tag one two\n-Cookie";
    const ops = headerUpFromText(text);
    expect(ops).toEqual([
      { op: "set", name: "X-Real-IP", value: "{remote_host}" },
      { op: "add", name: "X-Tag", value: "one two" },
      { op: "delete", name: "Cookie" },
    ]);
    expect(headerUpToText(ops)).toBe(text);
  });

  it("ignores blank lines and a header without a value", () => {
    expect(headerUpFromText("\n  \nX-Only\n")).toBeUndefined();
    expect(headerUpToText(undefined)).toBe("");
  });
});
