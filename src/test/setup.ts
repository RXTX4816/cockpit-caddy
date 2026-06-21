import { vi } from "vitest";

// localStorage mock is installed by @rxtx4816/cockpit-plugin-base-react/testing (first setupFile).
// Importing i18n here (after the base setup) ensures localStorage is ready first.
await import("../i18n");

const mockSpawn = vi.fn();
const mockHttp = vi.fn();
vi.stubGlobal("cockpit", { spawn: mockSpawn, http: mockHttp });

export { mockSpawn, mockHttp };
