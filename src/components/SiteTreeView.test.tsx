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

describe("adding, moving and removing blocks in the Tree tab (#351)", () => {
  const TWO = "example.com {\n\troute {\n\t\thandle /a/* {\n\t\t\trespond a\n\t\t}\n\t\thandle {\n\t\t\trespond b\n\t\t}\n\t}\n}";

  it("moves a block with the keyboard-reachable buttons and saves the new order", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<SiteTreeTab siteText={TWO} onSave={onSave} />);
    expect((screen.getByRole("button", { name: /Move up: handle \/a\/\*/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Move down: handle \/a\/\*/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save blocks" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const text = onSave.mock.calls[0][0] as string;
    expect(text.indexOf("respond b")).toBeLessThan(text.indexOf("respond a"));
  });

  it("asks before removing a block that has blocks inside, and not for one that has none", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<SiteTreeTab siteText={TWO} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: /Remove: route all requests/ }));
    expect(screen.getByRole("alertdialog").textContent).toContain("Remove this block and the 2 blocks inside it?");
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Remove: handle \/a\/\*/ }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save blocks" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).not.toContain("respond a");
    expect(onSave.mock.calls[0][0]).toContain("respond b");
  });

  it("removes a block with its children after the confirmation", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<SiteTreeTab siteText={TWO} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: /Remove: route all requests/ }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("button", { name: "Save blocks" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).toBe("example.com {\n}");
  });

  it("adds a block inside the selected one, or at the top level when none is selected", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<SiteTreeTab siteText={TWO} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText("Matcher of the new block"), { target: { value: "/new/*" } });
    fireEvent.click(screen.getByRole("button", { name: "Add at the top level" }));
    fireEvent.click(screen.getByRole("button", { name: /Edit: route all requests/ }));
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "handle_path" } });
    fireEvent.change(screen.getByLabelText("Matcher of the new block"), { target: { value: "/in/*" } });
    fireEvent.click(screen.getByRole("button", { name: "Add inside the selected block" }));
    fireEvent.click(screen.getByRole("button", { name: "Save blocks" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const text = onSave.mock.calls[0][0] as string;
    expect(text).toContain("\n\thandle /new/* {\n\t}\n");
    expect(text).toContain("\t\thandle_path /in/* {\n\t\t}\n\t}");
  });

  it("does not add a handle_path without a path", () => {
    render(<SiteTreeTab siteText={TWO} onSave={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "handle_path" } });
    expect((screen.getByRole("button", { name: "Add at the top level" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Tree tab review fixes (#362)", () => {
  it("keeps an invalid edit and lets nothing else happen until it is fixed", () => {
    render(<SiteTreeTab siteText={SITE} onSave={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Edit: handle_path \/static\/\*/ }));
    fireEvent.change(screen.getByLabelText("Matcher"), { target: { value: "@api" } });
    expect(screen.getByText(/needs one path that starts with \//)).toBeTruthy();
    const other = screen.getByRole("button", { name: /Edit: handle @api/ }) as HTMLButtonElement;
    expect(other.disabled).toBe(true);
    fireEvent.click(other);
    expect((screen.getByLabelText("Matcher") as HTMLInputElement).value).toBe("@api");
    expect((screen.getByRole("button", { name: "Save blocks" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("sends the text the edit started from, then the saved one", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<SiteTreeTab siteText={SITE} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: /Edit: handle_path \/static\/\*/ }));
    fireEvent.change(screen.getByLabelText("Matcher"), { target: { value: "/files/*" } });
    fireEvent.click(screen.getByRole("button", { name: "Save blocks" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][1]).toBe(SITE);
    fireEvent.click(screen.getByRole("button", { name: /Edit: handle_path \/files\/\*/ }));
    fireEvent.change(screen.getByLabelText("Matcher"), { target: { value: "/f/*" } });
    fireEvent.click(screen.getByRole("button", { name: "Save blocks" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1][1]).toBe(onSave.mock.calls[0][0]);
  });

  it("moves blocks only inside a route, and says why", () => {
    const text = "example.com {\n\thandle /a/* {\n\t\troute {\n\t\t\trespond a\n\t\t}\n\t}\n\thandle {\n\t\trespond b\n\t}\n}";
    render(<SiteTreeTab siteText={text} onSave={vi.fn()} />);
    expect((screen.getByRole("button", { name: /Move down: handle \/a\/\*/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/sorts the other blocks itself/)).toBeTruthy();
  });

  it("locks the form fields the save would drop for a site with nested blocks", () => {
    const common = { state: emptyProxyTabState(), onChange: () => {}, general: <div>g</div>, generalHasError: false, onSelect: () => {}, isDisabled: false, idPrefix: "t", showTls: true };
    const { unmount } = render(<ProxyTabs {...common} active="limits" siteText={SITE} />);
    expect((document.getElementById("t-bind") as HTMLInputElement).disabled).toBe(false);
    expect((document.getElementById("t-request-body-max-size") as HTMLInputElement).disabled).toBe(true);
    unmount();
    render(<ProxyTabs {...common} active="security" siteText={SITE} />);
    expect(screen.getAllByText(/only saves the address, bind, imports and TLS/).length).toBeGreaterThan(0);
    expect(document.querySelectorAll("input:disabled, button:disabled").length).toBeGreaterThan(0);
  });
});

describe("the named matcher form in the Tree tab (#350)", () => {
  const SITE_DEF = `example.com {
\t@api {
\t\tpath /api/*
\t}
\troute {
\t\thandle @api {
\t\t\treverse_proxy localhost:9000
\t\t}
\t}
}`;

  it("edits the definition of the node's @name with the matcher fields, and only that", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<SiteTreeTab siteText={SITE_DEF} onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: /Edit: handle @api/ }));
    const form = screen.getByTestId("tree-matcher-definition");
    fireEvent.change(within(form).getAllByLabelText("Path")[0], { target: { value: "/v2/*" } });
    fireEvent.click(within(form).getAllByRole("button", { name: "Add path" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Save blocks" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toBe(SITE_DEF.replace("\t\tpath /api/*\n", "\t\tpath /api/* /v2/*\n"));
  });

  it("keeps a one-line definition as text: no matcher form", () => {
    render(<SiteTreeTab siteText={SITE} onSave={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Edit: handle @api/ }));
    expect(screen.queryByTestId("tree-matcher-definition")).toBeNull();
  });
});
