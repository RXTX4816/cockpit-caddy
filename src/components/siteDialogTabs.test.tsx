import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { ProxyEntry } from "../api";
import { AddStaticDialog } from "./AddStaticDialog";
import { EditStaticDialog } from "./EditStaticDialog";
import { AddPhpFastcgiDialog } from "./AddPhpFastcgiDialog";
import { EditPhpFastcgiDialog } from "./EditPhpFastcgiDialog";
import { AddRedirectDialog } from "./AddRedirectDialog";
import { EditRedirectDialog } from "./EditRedirectDialog";
import { AddRespondDialog } from "./AddRespondDialog";
import { EditRespondDialog } from "./EditRespondDialog";

const tabNames = () => screen.getAllByRole("tab").map(t => t.textContent);
const tab = (name: string) => screen.getByRole("tab", { name: new RegExp(`^${name}`) });
const isActive = (name: string) => tab(name).getAttribute("aria-selected") === "true";
const hasDot = (name: string) => within(tab(name)).queryByLabelText("Configured") !== null;

const base: ProxyEntry = {
  id: "port:8080", serverKey: "srv0", externalPort: 8080,
  targetHost: "localhost", targetPort: 0, targetScheme: "http", tls: false, tlsSkipVerify: false,
};
const SITE_TABS = ["General", "Security", "Routing", "Logging & errors", "Limits"];

// #293: the static / PHP / redirect / respond dialogs use the proxy dialog's tabs, with fewer of them.
describe("site dialog tabs (#293)", () => {
  it.each([
    ["static", () => <AddStaticDialog existingPorts={[]} onAdd={vi.fn()} onClose={() => {}} />, SITE_TABS],
    ["PHP", () => <AddPhpFastcgiDialog existingPorts={[]} onAdd={vi.fn()} onClose={() => {}} />, SITE_TABS],
    ["redirect", () => <AddRedirectDialog existingPorts={[]} onAdd={vi.fn()} onClose={() => {}} />, ["General", "Routing"]],
    ["respond", () => <AddRespondDialog existingPorts={[]} onAdd={vi.fn()} onClose={() => {}} />, ["General", "Routing"]],
  ])("Add %s shows its tabs", (_name, ui, expected) => {
    render(ui());
    expect(tabNames()).toEqual(expected);
  });

  it("Edit static marks the configured tabs and saves the settings unchanged", async () => {
    const proxy: ProxyEntry = {
      ...base,
      fileServer: { root: "/srv/www" },
      basicAuth: [{ username: "admin", passwordHash: "$2a$14$x" }],
      requestBodyMaxSize: 1024,
    };
    const onSave = vi.fn(async (_e: ProxyEntry) => {});
    render(<EditStaticDialog proxy={proxy} existingPorts={[]} onSave={onSave} onClose={() => {}} />);
    expect(SITE_TABS.filter(hasDot)).toEqual(["Security", "Limits"]);
    fireEvent.click(tab("Limits"));
    expect(document.getElementById("edit-static-request-body-max-size")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).toMatchObject({
      fileServer: { root: "/srv/www" },
      basicAuth: [{ username: "admin", passwordHash: "$2a$14$x" }],
      requestBodyMaxSize: 1024,
    });
  });

  it("Edit PHP keeps the environment variables on General", () => {
    const proxy: ProxyEntry = { ...base, phpFastcgi: { upstream: "localhost:9000", root: "/srv/php", env: { APP_ENV: "prod" } } };
    render(<EditPhpFastcgiDialog proxy={proxy} existingPorts={[]} onSave={vi.fn()} onClose={() => {}} />);
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByRole("heading", { name: "Environment variables" })).toBeInTheDocument();
    expect(within(panel).getByDisplayValue("APP_ENV")).toBeInTheDocument();
  });

  it("Save jumps back to General when a General field is invalid", async () => {
    const proxy: ProxyEntry = { ...base, redirect: { to: "https://example.com", code: 308 } };
    const onSave = vi.fn();
    render(<EditRedirectDialog proxy={proxy} existingPorts={[]} onSave={onSave} onClose={() => {}} />);
    fireEvent.change(document.getElementById("edit-redirect-to")!, { target: { value: "" } });
    fireEvent.click(tab("Routing"));
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(isActive("General")).toBe(true));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("Edit respond marks Routing when the route has matchers", () => {
    const proxy: ProxyEntry = { ...base, staticResponse: { statusCode: 200 }, matchers: { path: ["/health"] } };
    render(<EditRespondDialog proxy={proxy} onSave={vi.fn()} onClose={() => {}} />);
    expect(hasDot("Routing")).toBe(true);
  });

  it("settings a layout doesn't show neither mark a tab nor block Save", async () => {
    // A hand-written static site with forward auth the static dialog has no section for.
    const proxy: ProxyEntry = { ...base, fileServer: { root: "/srv/www" }, forwardAuth: { upstreamUrl: "", copyHeaders: [] } };
    const onSave = vi.fn(async (_e: ProxyEntry) => {});
    render(<EditStaticDialog proxy={proxy} existingPorts={[]} onSave={onSave} onClose={() => {}} />);
    expect(hasDot("Security")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].forwardAuth).toEqual(proxy.forwardAuth);
  });
});
