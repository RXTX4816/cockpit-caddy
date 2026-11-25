import { describe, expect, it, vi } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";
import { SiteTreeTab, describeMatcher, matcherDefinitions } from "./SiteTreeView";
import { parseSiteTree } from "../api/siteTree";
import { ProxyTabs } from "./ProxyTabs";
import { emptyProxyTabState } from "./proxyTabState";

const SITE = `example.com {
\t@api path /api/*
\troute {
\t\theader X-A 1
\t\thandle @api {
\t\t\treverse_proxy localhost:9000
\t\t}
\t\thandle_path /static/* {
\t\t\tfile_server
\t\t}
\t}
}`;

describe("the Tree tab (#349)", () => {
  it("shows the nodes with their matchers, resolved @names and handlers, nested", () => {
    render(<SiteTreeTab siteText={SITE} />);
    const tree = screen.getByRole("tree");
    const items = within(tree).getAllByRole("treeitem");
    expect(items.map(i => i.getAttribute("aria-label"))).toEqual([
      "example.com {", "route all requests", "handle @api: path /api/*", "handle_path /static/*",
    ]);
    expect(within(tree).getByText("header X-A 1")).toBeTruthy();
    expect(within(tree).getByText("reverse_proxy localhost:9000")).toBeTruthy();
    expect(screen.getByText(/Read-only for now/)).toBeTruthy();
  });

  it("explains a text it cannot read as a tree", () => {
    render(<SiteTreeTab siteText={"example.com {\n\troute {\n}"} />);
    expect(screen.getByText(/could not be read as a tree/)).toBeTruthy();
  });

  it("resolves @names from the body around, and leaves other matchers as they are", () => {
    const tree = parseSiteTree(SITE)!;
    const defs = matcherDefinitions(tree.items);
    expect(defs).toEqual({ api: "path /api/*" });
    expect(describeMatcher("@api", [defs])).toBe("@api: path /api/*");
    expect(describeMatcher("@gone", [defs])).toBe("@gone");
    expect(describeMatcher("/a/*", [defs])).toBe("/a/*");
  });

  it("adds a Tree tab to the site dialog only for a site with nested blocks", () => {
    const common = { state: emptyProxyTabState(), onChange: () => {}, general: <div>g</div>, generalHasError: false, active: "general" as const, onSelect: () => {}, isDisabled: false, idPrefix: "t" };
    const { rerender } = render(<ProxyTabs {...common} siteText={SITE} />);
    expect(screen.getByRole("tab", { name: "Tree" })).toBeTruthy();
    rerender(<ProxyTabs {...common} siteText={"example.com {\n\thandle /a/* {\n\t\trespond ok\n\t}\n}"} />);
    expect(screen.queryByRole("tab", { name: "Tree" })).toBeNull();
    rerender(<ProxyTabs {...common} />);
    expect(screen.queryByRole("tab", { name: "Tree" })).toBeNull();
  });
});

describe("editing in the Tree tab (#350)", () => {
  it("shows the fields of the selected node and saves the edited text", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<SiteTreeTab siteText={SITE} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: /Edit: handle_path \/static\/\*/ }));
    fireEvent.change(screen.getByLabelText("Matcher"), { target: { value: "/files/*" } });
    fireEvent.change(screen.getByLabelText("Directive 1"), { target: { value: "file_server browse" } });
    fireEvent.click(screen.getByRole("button", { name: "Save blocks" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const text = onSave.mock.calls[0][0] as string;
    expect(text).toBe(SITE.replace("handle_path /static/* {", "handle_path /files/* {").replace("file_server", "file_server browse"));
  });

  it("keeps what was typed when another node is selected, and can discard it", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<SiteTreeTab siteText={SITE} onSave={onSave} />);
    expect((screen.getByRole("button", { name: "Save blocks" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Edit: route all requests/ }));
    fireEvent.change(screen.getByLabelText("Matcher"), { target: { value: "/r/*" } });
    fireEvent.click(screen.getByRole("button", { name: /Edit: handle_path/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save blocks" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).toContain("route /r/* {");
  });

  it("shows why a save failed and keeps the edit", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("unrecognized directive"));
    render(<SiteTreeTab siteText={SITE} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: /Edit: route all requests/ }));
    fireEvent.change(screen.getByLabelText("Matcher"), { target: { value: "/r/*" } });
    fireEvent.click(screen.getByRole("button", { name: "Save blocks" }));
    await waitFor(() => expect(screen.getByText("unrecognized directive")).toBeTruthy());
    expect((screen.getByLabelText("Matcher") as HTMLInputElement).value).toBe("/r/*");
  });

  it("offers no editing without onSave, and leaves an opaque node unselectable", () => {
    render(<SiteTreeTab siteText={SITE} />);
    expect(screen.queryByRole("button", { name: /Edit:/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save blocks" })).toBeNull();
  });
});
