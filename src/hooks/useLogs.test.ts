import { describe, it, expect, afterEach } from "vitest";
import { renderHook, cleanup, act } from "@testing-library/react";
import { useLogs, CONTAINER_NOT_CONFIGURED } from "./useLogs";
import { setCaddyManaged } from "../api";
import { loadLogContainer } from "./useLogContainer";
import { mockSpawn } from "../test/setup";

// Regression for the #188 follow-up: when Caddy has no local systemd unit
// (e.g. running in a container), journalctl -u caddy has nothing to show —
// logs must instead come from `docker logs <container>`, using a container
// name the user configures in Admin API Address settings.
describe("useLogs", () => {
  afterEach(() => {
    cleanup();
    mockSpawn.mockReset();
    setCaddyManaged(true);
    localStorage.clear();
  });

  it("uses journalctl when managed", async () => {
    setCaddyManaged(true);
    mockSpawn.mockImplementation((argv: string[]) => {
      if (argv[0] === "journalctl") return Promise.resolve("caddy log line");
      return Promise.reject(new Error(`unexpected spawn: ${argv.join(" ")}`));
    });

    const { result } = renderHook(() => useLogs());

    await act(() => result.current.refresh());

    expect(result.current.logs).toBe("caddy log line");
    expect(result.current.error).toBeNull();
  });

  it("reports CONTAINER_NOT_CONFIGURED when unmanaged with no container set", async () => {
    setCaddyManaged(false);
    expect(loadLogContainer()).toBe("");
    mockSpawn.mockImplementation((argv: string[]) =>
      Promise.reject(new Error(`unexpected spawn: ${argv.join(" ")}`)));

    const { result } = renderHook(() => useLogs());

    await act(() => result.current.refresh());

    expect(result.current.error).toBe(CONTAINER_NOT_CONFIGURED);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("uses docker logs when unmanaged with a container configured", async () => {
    setCaddyManaged(false);
    localStorage.setItem("cockpit-caddy:log-container", "my-caddy");
    mockSpawn.mockImplementation((argv: string[]) => {
      if (argv[0] === "docker" && argv.includes("logs") && argv.includes("my-caddy")) {
        return Promise.resolve('{"level":"info","msg":"hi"}');
      }
      return Promise.reject(new Error(`unexpected spawn: ${argv.join(" ")}`));
    });

    const { result } = renderHook(() => useLogs());

    await act(() => result.current.refresh());

    expect(result.current.logs).toBe('{"level":"info","msg":"hi"}');
    expect(result.current.error).toBeNull();
  });
});
