import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ToastProvider } from "@rxtx4816/cockpit-plugin-base-react/components";
import { ServiceControl } from "./ServiceControl";
import type { ServiceStatus } from "../api";

const renderWith = (status: ServiceStatus, unmanaged = false) =>
  render(<ToastProvider><ServiceControl status={status} loading={false} onRefresh={() => {}} unmanaged={unmanaged} /></ToastProvider>);

// #259: status + one visible action + a kebab for the rest.
describe("ServiceControl", () => {
  it("running: Restart is the visible action, Stop and Reload are in the kebab", () => {
    renderWith("active");
    expect(screen.getByRole("button", { name: "Restart" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More service actions" }));
    expect(screen.getByRole("menuitem", { name: "Stop" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Reload config" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Reload Caddy config?");
  });

  it("stopped: Start is the visible action", () => {
    renderWith("inactive");
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Restart" })).toBeNull();
  });

  it("unmanaged: no systemd actions, Reload stays", () => {
    renderWith("unknown", true);
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Restart" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More service actions" }));
    expect(screen.queryByRole("menuitem", { name: "Stop" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Reload config" })).toBeInTheDocument();
  });
});
