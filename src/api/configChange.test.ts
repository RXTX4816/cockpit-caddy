import { afterEach, describe, expect, it, vi } from "vitest";
import { resetHost } from "@rxtx4816/cockpit-plugin-base-react/host";
import { FakeHost, installFakeHost } from "@rxtx4816/cockpit-plugin-base-react/testing/host";
import { applyConfigChange, ConfigRestoreError } from "./configChange";

afterEach(() => resetHost());

const MAIN = "/etc/caddy/Caddyfile";
const CONF = "/etc/caddy/conf.d/proxy.conf";
const passes = { validate: async () => {} };
const rejects = (msg: string) => ({ validate: async () => { throw new Error(msg); } });

describe("applyConfigChange", () => {
  it("writes every file, then validates once", async () => {
    const host = installFakeHost({ [MAIN]: "old main", [CONF]: "old conf" });
    const validate = vi.fn(async () => {
      // by the time it validates, both files are already in place
      expect(host.files.get(MAIN)).toBe("new main");
      expect(host.files.get(CONF)).toBe("new conf");
    });
    await applyConfigChange([{ path: MAIN, content: "new main" }, { path: CONF, content: "new conf" }], { validate });
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it("puts every file back when validation fails, including the one written first", async () => {
    const host = installFakeHost({ [MAIN]: "old main", [CONF]: "old conf" });
    await expect(
      applyConfigChange([{ path: MAIN, content: "new main" }, { path: CONF, content: "new conf" }], rejects("bad config")),
    ).rejects.toThrow("bad config");
    expect(host.files.get(MAIN)).toBe("old main");
    expect(host.files.get(CONF)).toBe("old conf");
  });

  it("removes a file that did not exist before when the change fails", async () => {
    const host = installFakeHost({ [MAIN]: "old main" });
    await expect(
      applyConfigChange([{ path: MAIN, content: "m" }, { path: CONF, content: "c" }], rejects("nope")),
    ).rejects.toThrow("nope");
    expect(host.files.has(CONF)).toBe(false);
    expect(host.files.get(MAIN)).toBe("old main");
  });

  it("restores a file whose write itself failed part-way, and the ones before it", async () => {
    const host = installFakeHost({ [MAIN]: "old main", [CONF]: "old conf" });
    const realWrite = host.writeFile.bind(host);
    host.writeFile = async (path, content, options) => {
      if (path === CONF && content === "new conf") { host.files.set(CONF, "new co"); throw new Error("disk full"); }
      return realWrite(path, content, options);
    };
    await expect(
      applyConfigChange([{ path: MAIN, content: "new main" }, { path: CONF, content: "new conf" }], passes),
    ).rejects.toThrow("disk full");
    expect(host.files.get(MAIN)).toBe("old main");
    expect(host.files.get(CONF)).toBe("old conf");
  });

  it("does nothing, and does not validate, when no file changes", async () => {
    const host = installFakeHost({ [MAIN]: "same" });
    const validate = vi.fn(async () => {});
    await applyConfigChange([{ path: MAIN, content: "same" }], { validate });
    expect(validate).not.toHaveBeenCalled();
    expect(host.calls.filter(c => c.kind === "write")).toHaveLength(0);
  });

  it("only writes the files that differ", async () => {
    const host = installFakeHost({ [MAIN]: "same", [CONF]: "old" });
    await applyConfigChange([{ path: MAIN, content: "same" }, { path: CONF, content: "new" }], passes);
    expect(host.calls.filter(c => c.kind === "write").map(c => c.path)).toEqual([CONF]);
  });

  it("lets check refuse the change before any file is touched", async () => {
    const host = installFakeHost({ [CONF]: "old" });
    await expect(
      applyConfigChange([{ path: CONF, content: "new" }], { ...passes, check: async () => { throw new Error("log not writable"); } }),
    ).rejects.toThrow("log not writable");
    expect(host.calls.filter(c => c.kind === "write")).toHaveLength(0);
  });

  it("runs afterCommit with the changed files only after validation passed, and keeps the change if it fails", async () => {
    const host = installFakeHost({ [MAIN]: "old" });
    const afterCommit = vi.fn(async () => { throw new Error("chown failed"); });
    await expect(applyConfigChange([{ path: MAIN, content: "new" }], { ...passes, afterCommit })).rejects.toThrow("chown failed");
    expect(afterCommit).toHaveBeenCalledWith([{ path: MAIN, content: "new" }]);
    expect(host.files.get(MAIN)).toBe("new");
  });

  it("does not run afterCommit when validation failed", async () => {
    installFakeHost({ [MAIN]: "old" });
    const afterCommit = vi.fn(async () => {});
    await expect(applyConfigChange([{ path: MAIN, content: "new" }], { ...rejects("x"), afterCommit })).rejects.toThrow();
    expect(afterCommit).not.toHaveBeenCalled();
  });

  it("says so when the files could not be put back", async () => {
    const host = new FakeHost({ [MAIN]: "old" });
    const realWrite = host.writeFile.bind(host);
    let first = true;
    host.writeFile = async (p, c, o) => { if (!first) throw new Error("read-only"); first = false; return realWrite(p, c, o); };
    const err = await applyConfigChange([{ path: MAIN, content: "new" }], rejects("bad config"), host).catch(e => e);
    expect(err).toBeInstanceOf(ConfigRestoreError);
    expect(err.paths).toEqual([MAIN]);
    expect(err.message).toContain("bad config");
  });

  it("reads and writes with superuser escalation", async () => {
    const host = installFakeHost({ [MAIN]: "old" }).rootOwns("/etc/caddy");
    await applyConfigChange([{ path: MAIN, content: "new" }], passes);
    expect(host.files.get(MAIN)).toBe("new");
  });
});
