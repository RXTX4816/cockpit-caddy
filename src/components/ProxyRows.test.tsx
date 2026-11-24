import { describe, it, expect, vi } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import type { ProxyEntry } from "../api";
import { ProxyRows } from "./ProxyRows";

const proxies: ProxyEntry[] = [
  { id: "srv0", serverKey: "srv0", externalPort: 8080, targetHost: "localhost", targetPort: 3000, targetScheme: "http", tls: false, tlsSkipVerify: false, label: "App" },
  { id: "srv1", serverKey: "srv1", externalPort: 443, externalHost: "files.example.com", targetHost: "", targetPort: 0, targetScheme: "http", tls: true, tlsSkipVerify: false, fileServer: { root: "/srv" } },
];

const renderRows = (compact: boolean, onEdit = vi.fn()) => render(
  <ProxyRows proxies={proxies} compact={compact} onEdit={onEdit} onDelete={vi.fn()} onDuplicate={vi.fn()} probeStatuses={new Map()} servers={[]} />,
);

describe("ProxyRows", () => {
  it("wide: a column header and one row per site", () => {
    renderRows(false);
    expect(screen.getByText("Address")).toBeInTheDocument();
    expect(screen.getByText("Target")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  // #258: below md the column header goes away and each site is a two-line card.
  it("compact: no column header; label and type on one line, address on the next, Edit on the right", () => {
    const onEdit = vi.fn();
    renderRows(true, onEdit);
    expect(screen.queryByText("Address")).toBeNull();
    expect(screen.queryByText("Target")).toBeNull();
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);

    const first = within(rows[0]);
    expect(first.getByText("App")).toBeInTheDocument();
    expect(first.getByText("Proxy")).toBeInTheDocument();
    expect(first.getByRole("link", { name: ":8080" })).toBeInTheDocument();
    fireEvent.click(first.getByRole("button", { name: "Edit" }));
    expect(onEdit).toHaveBeenCalledWith(proxies[0]);

    const second = within(rows[1]);
    expect(second.getByText("Static")).toBeInTheDocument();
    expect(second.getByRole("link", { name: /files\.example\.com/ })).toBeInTheDocument();
  });
});
