import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SizeField, bytesToSize, sizeToBytes } from "./SizeField";

// #260: sizes as number + unit, stored as bytes.
describe("size units", () => {
  it("shows bytes in the largest unit they divide into", () => {
    expect(bytesToSize("10485760")).toEqual({ amount: "10", unit: "MB" });
    expect(bytesToSize("524288")).toEqual({ amount: "512", unit: "KB" });
    expect(bytesToSize("1073741824")).toEqual({ amount: "1", unit: "GB" });
    expect(bytesToSize("1000")).toEqual({ amount: "1000", unit: "B" });
    expect(bytesToSize("")).toEqual({ amount: "", unit: "MB" });
  });

  it("converts back to bytes", () => {
    expect(sizeToBytes("512", "KB")).toBe("524288");
    expect(sizeToBytes("1.5", "MB")).toBe("1572864");
    expect(sizeToBytes("", "GB")).toBe("");
  });

  it("10485760 is shown as 10 MB, and entering 512 KB saves 524288", () => {
    const onChange = vi.fn();
    const { rerender } = render(<SizeField id="s" value="10485760" onChange={onChange} />);
    expect(screen.getByRole("spinbutton")).toHaveValue(10);
    expect(screen.getByRole("combobox")).toHaveValue("MB");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "KB" } });
    expect(onChange).toHaveBeenLastCalledWith("10240");
    rerender(<SizeField id="s" value="10240" onChange={onChange} />);
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "512" } });
    expect(onChange).toHaveBeenLastCalledWith("524288");
  });

  it("a value set from outside that isn't a whole multiple of the chosen unit shows as a fraction", () => {
    const { rerender } = render(<SizeField id="s" value="1048576" onChange={vi.fn()} />);
    expect(screen.getByRole("combobox")).toHaveValue("MB");
    rerender(<SizeField id="s" value="1572864" onChange={vi.fn()} />);
    expect(screen.getByRole("spinbutton")).toHaveValue(1.5);
  });
});
