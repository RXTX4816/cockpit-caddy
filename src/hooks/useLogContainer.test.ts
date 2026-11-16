import { describe, it, expect, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useLogContainer, loadLogContainer, loadLogDockerHost } from "./useLogContainer";

// #191: the optional Docker socket is stored next to the container name.
// Settings saved before it existed (container only) must keep working.
describe("useLogContainer", () => {
  afterEach(() => localStorage.clear());

  it("loads settings saved before the Docker socket existed", () => {
    localStorage.setItem("cockpit-caddy:log-container", "caddy");

    const { result } = renderHook(() => useLogContainer());

    expect(result.current.container).toBe("caddy");
    expect(result.current.dockerHost).toBe("");
    expect(loadLogDockerHost()).toBe("");
  });

  it("saves and reloads the container with a Docker socket", () => {
    const { result } = renderHook(() => useLogContainer());

    act(() => result.current.save("caddy", "unix:///run/user/1000/docker.sock"));

    expect(result.current.dockerHost).toBe("unix:///run/user/1000/docker.sock");
    expect(loadLogContainer()).toBe("caddy");
    expect(loadLogDockerHost()).toBe("unix:///run/user/1000/docker.sock");
    expect(renderHook(() => useLogContainer()).result.current.dockerHost).toBe("unix:///run/user/1000/docker.sock");
  });

  it("saving with an empty Docker socket removes it", () => {
    localStorage.setItem("cockpit-caddy:log-docker-host", "unix:///old.sock");
    const { result } = renderHook(() => useLogContainer());

    act(() => result.current.save("caddy", ""));

    expect(localStorage.getItem("cockpit-caddy:log-container")).toBe("caddy");
    expect(localStorage.getItem("cockpit-caddy:log-docker-host")).toBeNull();
    expect(result.current.dockerHost).toBe("");
  });
});
