import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useCaddyConfig } from "./useCaddyConfig";
import { reloadCaddy, notifyConfigChanged } from "../api";
import { mockSpawn } from "../test/setup";

// #284: every config poll is an Admin API request, and Caddy logs each one. The poll runs at the
// same 5 s cadence as the other background polls, and a change the plugin makes refreshes the
// config right away instead of waiting for the next poll.
const configGets = () =>
  mockSpawn.mock.calls.map(c => c[0] as string[]).filter(argv => argv[0] === "curl" && argv.includes("-sf") && argv.some(a => a.endsWith("/config/"))).length;

const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });

describe("useCaddyConfig polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockSpawn.mockReset();
    mockSpawn.mockImplementation(() => Promise.resolve("{}"));
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    mockSpawn.mockReset();
  });

  it("polls the config every 5 s, not every second", async () => {
    renderHook(() => useCaddyConfig());
    await flush();
    expect(configGets()).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(4900); });
    expect(configGets()).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(configGets()).toBe(2);
  });

  it("refetches right after a reload anywhere in the plugin", async () => {
    renderHook(() => useCaddyConfig());
    await flush();
    await act(async () => { await reloadCaddy(); });
    await flush();
    expect(configGets()).toBe(2);
  });

  it("refetches when a config change is announced", async () => {
    renderHook(() => useCaddyConfig());
    await flush();
    await act(async () => { await notifyConfigChanged(); });
    await flush();
    expect(configGets()).toBe(2);
  });
});
