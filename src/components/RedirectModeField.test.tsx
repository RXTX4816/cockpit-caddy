import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RedirectModeField, joinRedirectTarget, redirectModeOf, splitRedirectTarget } from "./RedirectModeField";

describe("redirect keep path and html mode (#338)", () => {
  it("adds {uri} once and without a double slash", () => {
    expect(joinRedirectTarget("https://example.com", true)).toBe("https://example.com{uri}");
    expect(joinRedirectTarget("https://example.com/", true)).toBe("https://example.com{uri}");
    expect(joinRedirectTarget("https://example.com{uri}", true)).toBe("https://example.com{uri}");
    expect(joinRedirectTarget(" https://example.com ", false)).toBe("https://example.com");
  });

  it("takes {uri} off the end of a stored target for the checkbox", () => {
    expect(splitRedirectTarget("https://{host}{uri}")).toEqual({ to: "https://{host}", keepPath: true });
    expect(splitRedirectTarget("https://example.com/new")).toEqual({ to: "https://example.com/new", keepPath: false });
  });

  it("reads the mode of a redirect", () => {
    expect(redirectModeOf({ code: 301 })).toBe(301);
    expect(redirectModeOf({ code: 302, html: true })).toBe("html");
    expect(redirectModeOf(undefined)).toBe(308);
  });

  it("offers the html page next to the status codes and keeps the path on request", () => {
    const onModeChange = vi.fn();
    const onKeepPathChange = vi.fn();
    render(<RedirectModeField idPrefix="r" mode={308} onModeChange={onModeChange} keepPath={false} onKeepPathChange={onKeepPathChange} />);
    fireEvent.click(screen.getByRole("button", { name: "HTML page" }));
    expect(onModeChange).toHaveBeenCalledWith("html");
    fireEvent.click(screen.getByLabelText("Keep the path and query"));
    expect(onKeepPathChange).toHaveBeenCalledWith(true);
  });
});
