import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ProxyEntry } from "../api";

vi.mock("../api", async importOriginal => ({
  ...(await importOriginal<typeof import("../api")>()),
  readProxyConf: vi.fn(async () => ""),
  fetchCaddyConfig: vi.fn(async () => ({})),
}));

import { AddProxyDialog } from "./AddProxyDialog";
import { EditProxyDialog } from "./EditProxyDialog";
import { ProxyCard } from "./ProxyCard";

// jsdom has no layout; EditProxyDialog scrolls its confirm warning into view.
Element.prototype.scrollIntoView = () => {};

const hostInput = () => screen.getByRole("textbox", { name: "External host" });

function fillAdd(host: string) {
  fireEvent.change(hostInput(), { target: { value: host } });
  fireEvent.change(screen.getByRole("spinbutton", { name: "External port" }), { target: { value: "8443" } });
  fireEvent.change(document.getElementById("target-port")!, { target: { value: "8000" } });
}

const existing: ProxyEntry = {
  id: "host:example.com", serverKey: "srv0", externalPort: 443, externalHost: "example.com, www.example.com",
  targetHost: "localhost", targetPort: 8000, targetScheme: "http", tls: true, tlsSkipVerify: false,
};

describe("AddProxyDialog — several hostnames (#208)", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["a.example.com,,b.example.com", /empty entry/i],
    ["a.example.com b.example.com", /can't contain spaces/i],
    ["a.example.com, https://b.example.com", /protocol and port in their own fields/i],
    ["a.example.com:8443, b.example.com", /protocol and port in their own fields/i],
    ["a.example.com, a.example.com", /listed twice/i],
  ])("rejects %s with a clear message", async (host, message) => {
    const onAdd = vi.fn();
    render(<AddProxyDialog existingRoutes={[]} onAdd={onAdd} onClose={() => {}} />);
    fillAdd(host);
    fireEvent.click(screen.getByRole("button", { name: "Add Proxy" }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm" })).not.toBeInTheDocument();
    expect(onAdd).not.toHaveBeenCalled();
  });

  it("saves every name, normalized, and previews each address", async () => {
    const onAdd = vi.fn(async (_entry: Omit<ProxyEntry, "id" | "serverKey">) => {});
    render(<AddProxyDialog existingRoutes={[]} onAdd={onAdd} onClose={() => {}} />);
    fillAdd(" a.example.com,b.example.com ");
    expect(screen.getByText("a.example.com:8443, b.example.com:8443")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add Proxy" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(onAdd).toHaveBeenCalled());
    expect(onAdd.mock.calls[0][0]).toMatchObject({ externalHost: "a.example.com, b.example.com", externalPort: 8443 });
  });

  it("flags a port clash when one of the names is already served on that port", async () => {
    const onAdd = vi.fn();
    render(<AddProxyDialog existingRoutes={[{ externalPort: 8443, externalHost: "b.example.com" }]} onAdd={onAdd} onClose={() => {}} />);
    fillAdd("a.example.com, b.example.com");
    fireEvent.click(screen.getByRole("button", { name: "Add Proxy" }));
    expect(await screen.findByText(/already in use/i)).toBeInTheDocument();
  });
});

describe("EditProxyDialog — several hostnames (#208)", () => {
  it("shows every name in the host field and saves an edited list", async () => {
    const onSave = vi.fn(async (_entry: ProxyEntry) => {});
    render(<EditProxyDialog proxy={existing} existingRoutes={[]} onSave={onSave} onClose={() => {}} />);
    expect(hostInput()).toHaveValue("example.com, www.example.com");
    fireEvent.change(hostInput(), { target: { value: "example.com,www.example.com,api.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0]).toMatchObject({ externalHost: "example.com, www.example.com, api.example.com" });
  });

  it("rejects an empty entry", async () => {
    const onSave = vi.fn();
    render(<EditProxyDialog proxy={existing} existingRoutes={[]} onSave={onSave} onClose={() => {}} />);
    fireEvent.change(hostInput(), { target: { value: "example.com, " } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(await screen.findByText(/empty entry/i)).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe("ProxyCard — several hostnames (#208)", () => {
  it("shows every name and links to the first", () => {
    render(<ProxyCard proxy={existing} onEdit={() => {}} onDelete={() => {}} onDuplicate={() => {}} />);
    const link = screen.getByRole("link", { name: "example.com:443, www.example.com:443" });
    expect(link).toHaveAttribute("href", "https://example.com/");
  });
});
