import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BindSection, bindFromValue, bindHasErrors, bindToValue } from "./BindSection";

describe("BindSection (#323)", () => {
  it("reads spaces and commas, drops repeats, and writes the list back", () => {
    expect(bindFromValue("10.0.0.5, ::1  10.0.0.5")).toEqual(["10.0.0.5", "::1"]);
    expect(bindFromValue("  ")).toBeUndefined();
    expect(bindToValue(["a", "b"])).toBe("a b");
    expect(bindToValue(undefined)).toBe("");
  });

  it("accepts IPs and host names and flags a port or a scheme", () => {
    expect(bindHasErrors("127.0.0.1 ::1 localhost [::1]")).toBe(false);
    expect(bindHasErrors("")).toBe(false);
    expect(bindHasErrors("10.0.0.5:8080")).toBe(true);
    expect(bindHasErrors("http://a")).toBe(true);
  });

  it("reports what is typed", () => {
    const onChange = vi.fn();
    render(<BindSection value="" onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Bind addresses"), { target: { value: "10.0.0.5" } });
    expect(onChange).toHaveBeenCalledWith("10.0.0.5");
  });
});
