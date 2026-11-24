import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { ProxyEntry } from "../api";

vi.mock("../api", async importOriginal => ({
  ...(await importOriginal<typeof import("../api")>()),
  readProxyConf: vi.fn(async () => ""),
  fetchCaddyConfig: vi.fn(async () => ({})),
}));

import { AddProxyDialog } from "./AddProxyDialog";
import { EditProxyDialog } from "./EditProxyDialog";

// jsdom has no layout; EditProxyDialog scrolls its confirm warning into view.
Element.prototype.scrollIntoView = () => {};

const tab = (name: string) => screen.getByRole("tab", { name: new RegExp(`^${name}`) });
const isActive = (name: string) => tab(name).getAttribute("aria-selected") === "true";
const hasDot = (name: string) => within(tab(name)).queryByLabelText("Configured") !== null;
const hasErrorIcon = (name: string) => within(tab(name)).queryByLabelText("Has errors") !== null;

const base: ProxyEntry = {
  id: "host:example.com", serverKey: "srv0", externalPort: 443, externalHost: "example.com",
  targetHost: "localhost", targetPort: 8000, targetScheme: "http", tls: true, tlsSkipVerify: false,
};

// #260: the proxy dialog is split into five tabs instead of 13 flat accordions.
describe("proxy dialog tabs (#260)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marks only the tab whose settings are configured", () => {
    const proxy: ProxyEntry = { ...base, basicAuth: [{ username: "admin", passwordHash: "$2a$14$x" }] };
    render(<EditProxyDialog proxy={proxy} existingRoutes={[]} onSave={vi.fn()} onClose={() => {}} />);
    expect(hasDot("Security")).toBe(true);
    for (const name of ["General", "Routing", "Upstreams", "Logging & errors"]) expect(hasDot(name)).toBe(false);
  });

  it("Save jumps to the first tab with an error", async () => {
    const onSave = vi.fn();
    render(<EditProxyDialog proxy={base} existingRoutes={[]} onSave={onSave} onClose={() => {}} />);
    fireEvent.click(tab("Upstreams"));
    fireEvent.click(screen.getByRole("button", { name: "Add upstream" }));
    fireEvent.click(tab("General"));
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(isActive("Upstreams")).toBe(true));
    expect(hasErrorIcon("Upstreams")).toBe(true);
    expect(screen.queryByRole("button", { name: "Confirm" })).not.toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("an error in General wins over one in a later tab", async () => {
    render(<EditProxyDialog proxy={base} existingRoutes={[]} onSave={vi.fn()} onClose={() => {}} />);
    fireEvent.change(document.getElementById("edit-target-host")!, { target: { value: "" } });
    fireEvent.click(tab("Upstreams"));
    fireEvent.click(screen.getByRole("button", { name: "Add upstream" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(isActive("General")).toBe(true));
    expect(screen.getByText("Target host is required")).toBeInTheDocument();
  });

  it("Add: an empty dialog jumps back to General on Save", async () => {
    const onAdd = vi.fn();
    render(<AddProxyDialog existingRoutes={[]} onAdd={onAdd} onClose={() => {}} />);
    fireEvent.click(tab("Security"));
    fireEvent.click(screen.getByRole("button", { name: "Add Proxy" }));
    await waitFor(() => expect(isActive("General")).toBe(true));
    expect(onAdd).not.toHaveBeenCalled();
  });

  it.each(["http", "https"] as const)("target %s round-trips through the toggle", async scheme => {
    const onSave = vi.fn(async (_e: ProxyEntry) => {});
    const other = scheme === "http" ? "https" : "http";
    render(<EditProxyDialog proxy={{ ...base, targetScheme: other }} existingRoutes={[]} onSave={onSave} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: other })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: scheme }));
    expect(screen.getByRole("button", { name: scheme })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).toMatchObject({ targetScheme: scheme, targetHost: "localhost", targetPort: 8000 });
  });

  // #292: Limits is the sixth tab and holds server timeouts and the body size.
  it("server timeouts and the body size sit on the Limits tab", () => {
    const proxy: ProxyEntry = { ...base, serverIdleTimeout: "2m" };
    render(<EditProxyDialog proxy={proxy} existingRoutes={[]} onSave={vi.fn()} onClose={() => {}} />);
    expect(screen.getAllByRole("tab").map(t => t.textContent)).toEqual(["General", "Security", "Routing", "Upstreams", "Logging & errors", "Limits"]);
    expect(hasDot("Limits")).toBe(true);
    expect(hasDot("Logging & errors")).toBe(false);
    fireEvent.click(tab("Limits"));
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByRole("heading", { name: "Server Timeouts & Limits" })).toBeInTheDocument();
    expect(panel.querySelector("#edit-proxy-request-body-max-size")).not.toBeNull();
    fireEvent.click(tab("Logging & errors"));
    expect(within(screen.getByRole("tabpanel")).queryByRole("heading", { name: "Server Timeouts & Limits" })).toBeNull();
  });
});

// #255: error handlers replace the app's own error pages only with this switch on.
describe("proxy dialog: replace the app's own error pages (#255)", () => {
  const withHandlers: ProxyEntry = { ...base, errorHandlers: [{ matchType: "4xx", type: "respond", body: "oops" }] };
  const replaceSwitch = () => screen.getByRole("checkbox", { name: "Also replace the app's own error pages" });

  async function save(onSave: ReturnType<typeof vi.fn>) {
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    return onSave.mock.calls[0][0] as ProxyEntry;
  }

  it("is off for handlers without upstream interception, and turning it on saves it", async () => {
    const onSave = vi.fn();
    render(<EditProxyDialog proxy={withHandlers} existingRoutes={[]} onSave={onSave} onClose={() => {}} />);
    fireEvent.click(tab("Logging & errors"));
    expect(replaceSwitch()).not.toBeChecked();
    fireEvent.click(replaceSwitch());
    expect((await save(onSave)).replaceUpstreamErrors).toBe(true);
  });

  it("an existing config with it on opens checked and keeps it", async () => {
    const onSave = vi.fn();
    render(<EditProxyDialog proxy={{ ...withHandlers, replaceUpstreamErrors: true }} existingRoutes={[]} onSave={onSave} onClose={() => {}} />);
    fireEvent.click(tab("Logging & errors"));
    expect(replaceSwitch()).toBeChecked();
    expect((await save(onSave)).replaceUpstreamErrors).toBe(true);
  });

  it("is hidden without error handlers", () => {
    render(<EditProxyDialog proxy={base} existingRoutes={[]} onSave={vi.fn()} onClose={() => {}} />);
    fireEvent.click(tab("Logging & errors"));
    expect(screen.queryByRole("checkbox", { name: "Also replace the app's own error pages" })).toBeNull();
  });
});
