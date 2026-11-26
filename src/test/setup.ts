import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// PatternFly's Tabs (setAccentStyles, run on mount and from every Tab's effect) starts a
// setTimeout(0) that calls setState and is never cleared on unmount. When a file ends with a
// synchronous test, vitest can tear the jsdom environment down before those timers get a turn;
// React then reads `window.event` while scheduling the update and every pending timer throws
// "ReferenceError: window is not defined". Vitest reports them as unhandled errors and the run
// exits 1 although all tests passed. Unmount, then yield one macrotask so the 0ms timers fire
// while the environment still exists (as no-op updates on unmounted components).
afterEach(async () => {
  cleanup();
  if (vi.isFakeTimers()) return;
  await new Promise(resolve => setTimeout(resolve, 0));
});

// localStorage mock is installed by @rxtx4816/cockpit-plugin-base-react/testing (first setupFile).
// Importing i18n here (after the base setup) ensures localStorage is ready first.
await import("../i18n");

const mockSpawn = vi.fn();
const mockHttp = vi.fn();
const mockUser = vi.fn();
// Tests answer spawn with a plain promise; the Host expects a process (stream, input, close).
// Give a bare promise those, and leave a real fake process (mockProcess) alone.
function asProcess(result: unknown): unknown {
  if (!result || typeof (result as Promise<unknown>).then !== "function") return result;
  const p = result as Record<string, unknown> & Promise<unknown>;
  if (typeof p.stream !== "function") p.stream = () => p;
  if (typeof p.input !== "function") p.input = () => {};
  if (typeof p.close !== "function") p.close = () => {};
  return p;
}
vi.stubGlobal("cockpit", { spawn: (...args: unknown[]) => asProcess(mockSpawn(...args)), http: mockHttp, user: mockUser });

export { mockSpawn, mockHttp, mockUser };
