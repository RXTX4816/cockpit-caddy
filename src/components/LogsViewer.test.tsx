import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

const LINES = [
  '{"level":"info","ts":1794990000.5,"logger":"http.log.access.log0","msg":"handled request","request":{"method":"GET","host":"app.example.com","uri":"/ok"},"status":200}',
  '{"level":"error","ts":1794990001.25,"logger":"http.log.access.log0","msg":"handled request","request":{"method":"POST","host":"app.example.com","uri":"/boom"},"status":502}',
  '{"level":"warn","ts":1794990002,"logger":"tls","msg":"stapling OCSP"}',
  "-- Boot abc --",
];

vi.mock("../hooks/useLogs", () => ({
  CONTAINER_NOT_CONFIGURED: "container-not-configured",
  useLogs: () => ({ logs: LINES.join("\n"), loading: false, error: null, refresh: vi.fn(), paused: false, pause: vi.fn(), resume: vi.fn() }),
}));

const { LogsViewer } = await import("./LogsViewer");

const bodyRows = () => within(screen.getByRole("table", { name: "Log entries" })).getAllByRole("row").slice(1);

// #257: the Logs tab shows Caddy's JSON lines as a table by default.
describe("LogsViewer table mode", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders one row per line with the parsed columns", () => {
    render(<LogsViewer />);
    for (const name of ["Time", "Level", "Logger", "Host", "Request", "Status", "Message"]) {
      expect(screen.getByRole("columnheader", { name })).toBeInTheDocument();
    }
    const rows = bodyRows();
    expect(rows).toHaveLength(4);
    expect(within(rows[1]).getByText("POST /boom")).toBeInTheDocument();
    expect(within(rows[1]).getByText("502")).toBeInTheDocument();
    expect(within(rows[1]).getByText("error")).toBeInTheDocument();
    expect(within(rows[3]).getByText("-- Boot abc --")).toBeInTheDocument();
  });

  it("opening a row shows the full JSON", () => {
    render(<LogsViewer />);
    fireEvent.click(bodyRows()[2]);
    expect(bodyRows()[2]).toHaveAttribute("aria-expanded", "true");
    const detail = document.querySelector("pre")!;
    expect(detail.textContent).toContain('"msg": "stapling OCSP"');
    expect(detail.textContent).toContain('"logger": "tls"');
  });

  it("the level filter and the search narrow the rows", () => {
    render(<LogsViewer />);
    fireEvent.click(screen.getByText("Warn"));
    expect(bodyRows()).toHaveLength(2);
    const all = screen.getAllByText("All");
    fireEvent.click(all[all.length - 1]);
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "boom" } });
    expect(bodyRows()).toHaveLength(1);
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "\"status\":(200|502)" } });
    expect(screen.queryByRole("table", { name: "Log entries" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /regex/i }));
    expect(bodyRows()).toHaveLength(2);
  });

  it("Raw shows the plain line view and the choice is remembered", () => {
    const { unmount } = render(<LogsViewer />);
    fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    expect(screen.queryByRole("table", { name: "Log entries" })).toBeNull();
    expect(screen.getByText("-- Boot abc --")).toBeInTheDocument();
    unmount();
    render(<LogsViewer />);
    expect(screen.queryByRole("table", { name: "Log entries" })).toBeNull();
  });
});
