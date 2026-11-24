import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

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
