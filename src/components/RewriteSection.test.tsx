import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RewriteSection, validateRewrite } from "./RewriteSection";

describe("RewriteSection (#332)", () => {
  it("flags a rewrite with a missing field", () => {
    expect(validateRewrite(undefined)).toBe(false);
    expect(validateRewrite({ type: "strip_prefix", value: "/api" })).toBe(false);
    expect(validateRewrite({ type: "strip_suffix", value: "" })).toBe(true);
    expect(validateRewrite({ type: "uri_replace", find: "", replace: "x" })).toBe(true);
    expect(validateRewrite({ type: "uri_replace", find: "a", replace: "" })).toBe(false);
    expect(validateRewrite({ type: "method", method: "" })).toBe(true);
    expect(validateRewrite({ type: "query", ops: [] })).toBe(true);
    expect(validateRewrite({ type: "query", ops: [{ op: "set", key: "", value: "1" }] })).toBe(true);
    expect(validateRewrite({ type: "query", ops: [{ op: "replace", key: "a", search: "", replace: "b" }] })).toBe(true);
    expect(validateRewrite({ type: "query", ops: [{ op: "delete", key: "a" }] })).toBe(false);
  });

  it("starts each new type with sensible fields", () => {
    const onChange = vi.fn();
    render(<RewriteSection value={undefined} onChange={onChange} isExpanded />);
    const select = screen.getByLabelText("Rewrite type");
    fireEvent.change(select, { target: { value: "method" } });
    expect(onChange).toHaveBeenLastCalledWith({ type: "method", method: "GET" });
    fireEvent.change(select, { target: { value: "query" } });
    expect(onChange).toHaveBeenLastCalledWith({ type: "query", ops: [{ op: "set", key: "", value: "" }] });
    fireEvent.change(select, { target: { value: "strip_suffix" } });
    expect(onChange).toHaveBeenLastCalledWith({ type: "strip_suffix", value: "" });
  });

  it("edits the operations of a query rewrite", () => {
    const onChange = vi.fn();
    render(<RewriteSection value={{ type: "query", ops: [{ op: "set", key: "a", value: "1" }] }} onChange={onChange} isExpanded />);
    fireEvent.change(screen.getByLabelText("Change"), { target: { value: "delete" } });
    expect(onChange).toHaveBeenLastCalledWith({ type: "query", ops: [{ op: "delete", key: "a", value: "1" }] });
    fireEvent.click(screen.getByText(/Add change/));
    expect(onChange).toHaveBeenLastCalledWith({ type: "query", ops: [{ op: "set", key: "a", value: "1" }, { op: "set", key: "", value: "" }] });
  });
});
