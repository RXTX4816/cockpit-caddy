import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ResponseHeadersSection, replaceEntry } from "./ResponseHeadersSection";

// The op toggle has an "Add" too; the add button is the last one.
const addButton = () => screen.getAllByRole("button", { name: "Add" }).pop() as HTMLButtonElement;

describe("ResponseHeadersSection default and replace", () => {
  it("adds a default: set only when the response has none", () => {
    const onChange = vi.fn();
    render(<ResponseHeadersSection value={undefined} onChange={onChange} isExpanded />);
    fireEvent.click(document.getElementById("resp-hdr-op-default")!);
    fireEvent.change(screen.getByLabelText("Header name"), { target: { value: "Cache-Control" } });
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "max-age=60" } });
    expect(screen.getByText(/only if the response doesn't have it/)).toBeTruthy();
    fireEvent.click(addButton());
    expect(onChange).toHaveBeenCalledWith([{ op: "default", name: "Cache-Control", value: "max-age=60" }]);
  });

  it("adds a replace as plain text unless Regular expression is ticked", () => {
    const onChange = vi.fn();
    render(<ResponseHeadersSection value={undefined} onChange={onChange} isExpanded />);
    fireEvent.click(document.getElementById("resp-hdr-op-replace")!);
    fireEvent.change(screen.getByLabelText("Header name"), { target: { value: "Server" } });
    const add = addButton();
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Text to find"), { target: { value: "^Apache(.*)$" } });
    fireEvent.change(screen.getByLabelText("Replacement"), { target: { value: "web$1" } });
    fireEvent.click(screen.getByLabelText("Regular expression"));
    fireEvent.click(add);
    expect(onChange).toHaveBeenCalledWith([{ op: "replace", name: "Server", value: "^Apache(.*)$", replacement: "web$1" }]);
  });

  it("stores a regexp without special characters as plain text, the way it reads back", () => {
    expect(replaceEntry("X", "abc", "d", true)).toEqual({ op: "replace", name: "X", value: "abc", replacement: "d", literal: true });
    expect(replaceEntry("X", "a.c", "d", false)).toEqual({ op: "replace", name: "X", value: "a.c", replacement: "d", literal: true });
    expect(replaceEntry("X", "abc", "$1", true)).toEqual({ op: "replace", name: "X", value: "abc", replacement: "$1" });
  });

  it("lists a regexp replace with its marker", () => {
    render(<ResponseHeadersSection value={[{ op: "replace", name: "Server", value: "^A", replacement: "B" }]} onChange={() => {}} isExpanded />);
    expect(screen.getByText("REPLACE")).toBeTruthy();
    expect(screen.getByText("Server: ^A → B")).toBeTruthy();
  });
});
