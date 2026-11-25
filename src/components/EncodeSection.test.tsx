import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ENCODE_EMPTY, EncodeSection, encodeFromValues, encodeToValues, validateEncode } from "./EncodeSection";

describe("EncodeSection values (#335)", () => {
  it("maps the options to the form and back", () => {
    const o = { algorithms: ["zstd" as const, "gzip" as const], minimumLength: 512, matchStatus: ["2xx"], matchHeaders: [{ name: "Content-Type", value: "text/*" }] };
    expect(encodeFromValues(encodeToValues(o))).toEqual(o);
  });

  it("writes no options for an empty form", () => {
    expect(encodeFromValues(ENCODE_EMPTY)).toBeUndefined();
  });

  it("flags a bad length, status or header line", () => {
    expect(validateEncode({ ...ENCODE_EMPTY, minimumLength: "12a" })).toBe(true);
    expect(validateEncode({ ...ENCODE_EMPTY, matchStatus: "2xx 99" })).toBe(true);
    expect(validateEncode({ ...ENCODE_EMPTY, matchHeaders: "Content-Type" })).toBe(true);
    expect(validateEncode({ ...ENCODE_EMPTY, minimumLength: "1024", matchStatus: "2xx 404", matchHeaders: "Content-Type text/*" })).toBe(false);
  });

  it("changes the order from the select", () => {
    const onChange = vi.fn();
    render(<EncodeSection value={ENCODE_EMPTY} onChange={onChange} isExpanded />);
    fireEvent.change(screen.getByLabelText("Algorithms and order"), { target: { value: "gzip zstd" } });
    expect(onChange).toHaveBeenCalledWith({ ...ENCODE_EMPTY, algorithms: "gzip zstd" });
  });
});
