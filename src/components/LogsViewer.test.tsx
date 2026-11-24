import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

const LINES = [
  '{"level":"info","ts":1794990000.5,"logger":"http.log.access.log0","msg":"handled request","request":{"method":"GET","host":"app.example.com","uri":"/ok"},"status":200}',
  '{"level":"error","ts":1794990001.25,"logger":"http.log.access.log0","msg":"handled request","request":{"method":"POST","host":"app.example.com","uri":"/boom"},"status":502}',
  '{"level":"warn","ts":1794990002,"logger":"tls","msg":"stapling OCSP"}',
  "-- Boot abc --",
];
// #284: the plugin's own config polls; hidden by default.
const ADMIN_REQUEST = '{"level":"info","ts":1794990003,"logger":"admin.api","msg":"received request","method":"GET","uri":"/config/"}';
const ADMIN_LOAD = '{"level":"info","ts":1794990004,"logger":"admin.api","msg":"load complete"}';
let extraLines: string[] = [];

vi.mock("../hooks/useLogs", () => ({
  CONTAINER_NOT_CONFIGURED: "container-not-configured",
  useLogs: () => ({ logs: [...LINES, ...extraLines].join("\n"), loading: false, error: null, refresh: vi.fn(), paused: false, pause: vi.fn(), resume: vi.fn() }),
}));

const { LogsViewer } = await import("./LogsViewer");

const bodyRows = () => within(screen.getByRole("table", { name: "Log entries" })).getAllByRole("row").slice(1);

// #257: the Logs tab shows Caddy's JSON lines as a table by default.
describe("LogsViewer table mode", () => {
  beforeEach(() => {
    localStorage.clear();
    extraLines = [];
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

describe("LogsViewer admin API requests (#284)", () => {
  beforeEach(() => {
    localStorage.clear();
    extraLines = [ADMIN_REQUEST, ADMIN_LOAD];
  });

  it("hides admin API \"received request\" lines by default, keeping other admin.api lines", () => {
    render(<LogsViewer />);
    expect(screen.queryByText("received request")).toBeNull();
    expect(screen.getByText("load complete")).toBeInTheDocument();
    expect(bodyRows()).toHaveLength(5);
  });

  it("the toggle shows them again", () => {
    render(<LogsViewer />);
    const toggle = screen.getByRole("checkbox", { name: "Show admin API requests" });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(screen.getByText("received request")).toBeInTheDocument();
    expect(bodyRows()).toHaveLength(6);
  });

  it("the raw view hides them too", () => {
    render(<LogsViewer />);
    fireEvent.click(screen.getByRole("button", { name: "Raw" }));
    expect(screen.queryByText(/received request/)).toBeNull();
    expect(screen.getByText(/load complete/)).toBeInTheDocument();
  });
});
