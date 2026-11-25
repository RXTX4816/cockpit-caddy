import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RouteMatchersSection, matcherHasTwoRegexps, validateRouteMatch, varsFromText, varsToText } from "./RouteMatchersSection";

describe("advanced route matchers (#331)", () => {
  it("reads and writes the vars lines", () => {
    const text = "{host} example.com www.example.com\n{method} GET";
    expect(varsFromText(text)).toEqual({ "{host}": ["example.com", "www.example.com"], "{method}": ["GET"] });
    expect(varsToText(varsFromText(text))).toBe(text);
    expect(varsFromText("{host}\n")).toBeUndefined();
  });

  it("refuses two regexps in one matcher, a header regexp without a header and a file without files", () => {
    expect(matcherHasTwoRegexps({ path_regexp: { pattern: "^/a" }, header_regexp: { header: "X", pattern: "b" } })).toBe(true);
    expect(validateRouteMatch({ path_regexp: { pattern: "^/a" }, header_regexp: { header: "X", pattern: "b" } })).toBe(true);
    expect(validateRouteMatch({ header_regexp: { header: "", pattern: "b" } })).toBe(true);
    expect(validateRouteMatch({ file: { try_files: [], try_policy: "first_exist" } })).toBe(true);
    expect(validateRouteMatch({ path_regexp: { pattern: "^/a" }, not: { header_regexp: { header: "X", pattern: "b" } } })).toBe(false);
    expect(validateRouteMatch({ not: { path_regexp: { pattern: "^/a" }, header_regexp: { header: "X", pattern: "b" } } })).toBe(true);
    expect(validateRouteMatch(undefined)).toBe(false);
  });

  it("sets the new fields from the section", () => {
    const onChange = vi.fn();
    render(<RouteMatchersSection value={undefined} onChange={onChange} isExpanded />);
    fireEvent.change(screen.getAllByLabelText("Path regex")[0], { target: { value: "^/u/(.*)$" } });
    expect(onChange).toHaveBeenLastCalledWith({ path_regexp: { pattern: "^/u/(.*)$" } });
    fireEvent.change(screen.getAllByLabelText("Protocol")[0], { target: { value: "https" } });
    expect(onChange).toHaveBeenLastCalledWith({ protocol: "https" });
    fireEvent.change(screen.getAllByLabelText("Files to look for")[0], { target: { value: "{path} /index.html" } });
    expect(onChange).toHaveBeenLastCalledWith({ file: { try_files: ["{path}", "/index.html"] } });
  });
});
