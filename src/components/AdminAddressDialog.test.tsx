import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { DockerTestResult } from "../api";

const testDockerContainer = vi.fn<(container: string, dockerHost?: string) => Promise<DockerTestResult>>();

vi.mock("../api", () => ({
  testTcpConnection: vi.fn(async () => true),
  testUnixSocket: vi.fn(async () => false),
  testDockerContainer: (container: string, dockerHost?: string) => testDockerContainer(container, dockerHost),
}));

import { AdminAddressDialog } from "./AdminAddressDialog";

const SOCK = "unix:///run/user/1000/docker.sock";

// #191: the Docker socket setting for a Caddy container on a rootless daemon.
describe("AdminAddressDialog Docker socket (#191)", () => {
  beforeEach(() => {
    testDockerContainer.mockReset();
    localStorage.setItem("cockpit-caddy:log-container", "caddy");
  });
  afterEach(() => localStorage.clear());

  function testWith(socket: string) {
    render(<AdminAddressDialog onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Docker socket (optional)"), { target: { value: socket } });
    fireEvent.click(screen.getByRole("button", { name: "Test container" }));
  }

  it("tests the container through the socket", async () => {
    testDockerContainer.mockResolvedValue("ok");
    testWith(SOCK);
    await waitFor(() => expect(testDockerContainer).toHaveBeenCalledWith("caddy", SOCK));
    // One from the TCP auto-test on open, one from the container test.
    await waitFor(() => expect(screen.getAllByText("Connection successful")).toHaveLength(2));
  });

  it("says when the socket doesn't exist", async () => {
    testDockerContainer.mockResolvedValue("socket-missing");
    testWith(SOCK);
    expect(await screen.findByText(/Docker socket not found/)).toBeInTheDocument();
  });

  it("says when the socket can't be read", async () => {
    testDockerContainer.mockResolvedValue("socket-unreadable");
    testWith(SOCK);
    expect(await screen.findByText(/Docker socket can't be read/)).toBeInTheDocument();
  });

  it("saves the socket next to the container name", async () => {
    testDockerContainer.mockResolvedValue("ok");
    const onClose = vi.fn();
    render(<AdminAddressDialog onClose={onClose} />);
    fireEvent.change(screen.getByLabelText("Docker socket (optional)"), { target: { value: SOCK } });
    // Save needs a working Admin API connection; the mocked TCP test passes.
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(localStorage.getItem("cockpit-caddy:log-docker-host")).toBe(SOCK);
    expect(onClose).toHaveBeenCalled();
  });
});
