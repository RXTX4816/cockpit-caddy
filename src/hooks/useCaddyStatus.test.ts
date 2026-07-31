import { describe, it, expect, afterEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { useCaddyStatus } from "./useCaddyStatus";
import { isCaddyManaged } from "../api";
import { mockSpawn } from "../test/setup";
import { mockProcess } from "../test/helpers";

// Regression for #188: Caddy running inside a Docker container has no local
// binary/systemd unit, so getServiceStatus() reports "not-installed" — but the
// Admin API (reached via curl over TCP or a Unix socket) is still perfectly
// reachable. adminApiOk must reflect that regardless of `status`, so the rest
// of the UI (proxy list, Caddyfile editor, etc.) stays usable.
describe("useCaddyStatus", () => {
  afterEach(() => {
    cleanup();
    mockSpawn.mockReset();
  });

  it("reports adminApiOk even when the caddy binary is not installed", async () => {
    mockSpawn.mockImplementation((argv: string[]) => {
      if (argv.includes("command -v caddy")) return Promise.reject(new Error("not found"));
      if (argv[0] === "curl") return Promise.resolve("{}");
      return Promise.reject(new Error(`unexpected spawn: ${argv.join(" ")}`));
    });

    const { result } = renderHook(() => useCaddyStatus());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.status).toBe("not-installed");
    expect(result.current.adminApiOk).toBe(true);
    expect(isCaddyManaged()).toBe(false);
  });

  it("marks Caddy managed again once the binary is found", async () => {
    mockSpawn.mockImplementation((argv: string[]) => {
      if (argv.includes("command -v caddy")) return Promise.resolve("/usr/bin/caddy");
      if (argv.includes("systemctl")) return Promise.resolve("active");
      if (argv[0] === "curl") return Promise.resolve("{}");
      return Promise.reject(new Error(`unexpected spawn: ${argv.join(" ")}`));
    });

    const { result } = renderHook(() => useCaddyStatus());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(isCaddyManaged()).toBe(true);
  });

  // Regression: `systemctl start` can return success at the job-queuing level
  // even when the process immediately crashes afterward (e.g. a port already
  // bound by something else) — the generic "unreachable" alert alone gives no
  // clue why, so a failed unit's status/log detail must be surfaced too.
  it("fetches systemctl status detail when the unit has failed", async () => {
    mockSpawn.mockImplementation((argv: string[]) => {
      if (argv.includes("command -v caddy")) return Promise.resolve("/usr/bin/caddy");
      if (argv.includes("is-active")) return Promise.resolve("failed");
      if (argv.includes("status")) {
        return mockProcess("Active: failed (Result: exit-code)\nbind: address already in use", "exit code 3");
      }
      if (argv[0] === "curl") return Promise.reject(new Error("unreachable"));
      return Promise.reject(new Error(`unexpected spawn: ${argv.join(" ")}`));
    });

    const { result } = renderHook(() => useCaddyStatus());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.status).toBe("failed");
    expect(result.current.failureDetail).toContain("address already in use");
  });
});
