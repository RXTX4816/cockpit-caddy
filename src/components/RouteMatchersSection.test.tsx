import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RouteMatchersSection } from "./RouteMatchersSection";
import type { RouteMatch } from "../api";

function setup(value: RouteMatch | undefined) {
  const onChange = vi.fn();
  render(<RouteMatchersSection value={value} onChange={onChange} isExpanded onToggleExpanded={() => {}} />);
  return onChange;
}

// #287: an Exclude group (Caddy's `not`) and a raw CEL expression.
describe("RouteMatchersSection exclude and expression (#287)", () => {
  it("adds an exclude path without touching the include fields", () => {
    const onChange = setup({ path: ["/app/*"] });
    fireEvent.change(screen.getByLabelText("Exclude: Path"), { target: { value: "/app/admin/*" } });
    fireEvent.click(screen.getByRole("button", { name: "Exclude: Add path" }));
    expect(onChange).toHaveBeenLastCalledWith({ path: ["/app/*"], not: { path: ["/app/admin/*"] } });
  });

  it("an exclude on its own is a valid matcher", () => {
    const onChange = setup(undefined);
    fireEvent.change(screen.getByLabelText("Exclude: Remote IP / CIDR"), { target: { value: "10.0.0.0/8" } });
    fireEvent.click(screen.getByRole("button", { name: "Exclude: Add CIDR range" }));
    expect(onChange).toHaveBeenLastCalledWith({ not: { remote_ip: { ranges: ["10.0.0.0/8"] } } });
  });

  it("removing the last exclude value drops the not group", () => {
    const onChange = setup({ path: ["/a"], not: { path: ["/a/b"] } });
    fireEvent.click(screen.getByRole("button", { name: "Exclude: Remove path" }));
    expect(onChange).toHaveBeenLastCalledWith({ path: ["/a"] });
  });

  it("include and exclude methods toggle independently", () => {
    const onChange = setup({ method: ["GET"] });
    fireEvent.click(screen.getByRole("group", { name: "Exclude requests that match" }).querySelector("#method-not-POST")!);
    expect(onChange).toHaveBeenLastCalledWith({ method: ["GET"], not: { method: ["POST"] } });
  });

  it("edits the expression and links to the docs", () => {
    const onChange = setup(undefined);
    fireEvent.change(screen.getByLabelText("Expression (CEL)"), { target: { value: '{path}.startsWith("/api")' } });
    expect(onChange).toHaveBeenLastCalledWith({ expression: '{path}.startsWith("/api")' });
    expect(screen.getByRole("link", { name: /expression/i })).toHaveAttribute("href", "https://caddyserver.com/docs/caddyfile/matchers#expression");
  });

  it("clearing the expression removes it", () => {
    const onChange = setup({ path: ["/a"], expression: "true" });
    fireEvent.change(screen.getByLabelText("Expression (CEL)"), { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith({ path: ["/a"] });
  });

  it("shows the configured dot for an exclude or an expression alone", () => {
    const { rerender } = render(<RouteMatchersSection value={{ not: { path: ["/x"] } }} onChange={() => {}} />);
    expect(screen.getByLabelText("Configured")).toBeInTheDocument();
    rerender(<RouteMatchersSection value={{ expression: "true" }} onChange={() => {}} />);
    expect(screen.getByLabelText("Configured")).toBeInTheDocument();
  });
});
