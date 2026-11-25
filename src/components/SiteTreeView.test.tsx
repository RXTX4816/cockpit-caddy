import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
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
