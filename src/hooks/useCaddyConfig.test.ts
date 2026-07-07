import { describe, it, expect } from "vitest";
import { explainCaddyApiError } from "./useCaddyConfig";

// Regression: reproduced directly against a live instance — deleting and recreating a
// systemd ReadWritePaths= directory (e.g. rm -rf /var/log/caddy && mkdir /var/log/caddy)
// while caddy.service is already running leaves its sandboxed mount namespace stale,
// surfacing as "read-only file system" even though the path is perfectly writable from
// outside that process. No pre-save check can detect this from outside the sandbox, so
// the error message itself must explain it and point at the real fix (a full restart).
describe("explainCaddyApiError", () => {
  it("appends a restart explanation for a read-only file system error", () => {
    const raw = 'loading new config: setting up custom log \'log0\': opening log writer using &logging.FileWriter{...}: open /var/log/caddy/access.log: read-only file system';
    const result = explainCaddyApiError(raw);
    expect(result).toContain(raw);
    expect(result).toContain("systemctl restart caddy");
  });

  it("leaves other error messages untouched", () => {
    const raw = "open /var/log/caddy/access.log: permission denied";
    expect(explainCaddyApiError(raw)).toBe(raw);
  });

  it("leaves unrelated errors untouched", () => {
    const raw = "some other Caddy config error";
    expect(explainCaddyApiError(raw)).toBe(raw);
  });
});
