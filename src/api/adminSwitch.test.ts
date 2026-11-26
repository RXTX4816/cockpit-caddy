import { describe, it, expect, vi } from "vitest";
import { adminTarget, adminMoves, switchAdminEndpoint, AdminRejectedError, AdminSwitchError, type AdminSwitchSteps } from "./adminSwitch";

const current = { tcp: "http://127.0.0.1:2019", socket: "/run/caddy/admin.socket" };

describe("adminTarget (#330)", () => {
  it("maps a TCP admin address to the plugin's URL, localhost and no host as 127.0.0.1", () => {
    expect(adminTarget("localhost:2020", current)).toEqual({ transport: "tcp", tcp: "http://127.0.0.1:2020", socket: current.socket });
    expect(adminTarget(":2021", current).tcp).toBe("http://127.0.0.1:2021");
    expect(adminTarget("tcp/10.0.0.5:2019", current).tcp).toBe("http://10.0.0.5:2019");
    expect(adminTarget("[::1]:2019", current).tcp).toBe("http://[::1]:2019");
  });

  it("maps an unset address to Caddy's default", () => {
    expect(adminTarget(undefined, current)).toEqual({ transport: "tcp", tcp: "http://127.0.0.1:2019", socket: current.socket });
  });

  it("maps a unix socket, quoted or with a file mode, and keeps the TCP setting", () => {
    expect(adminTarget('"unix//run/caddy/other.sock"', current)).toEqual({ transport: "unix", tcp: current.tcp, socket: "/run/caddy/other.sock" });
    expect(adminTarget("unix//run/a.sock|0660", current).socket).toBe("/run/a.sock");
  });

  it("knows when the endpoint moves", () => {
    expect(adminMoves(undefined, "localhost:2019", current)).toBe(false);
    expect(adminMoves("localhost:2019", "127.0.0.1:2019", current)).toBe(false);
    expect(adminMoves(undefined, "localhost:2020", current)).toBe(true);
    expect(adminMoves("unix//a.sock", "unix//b.sock", current)).toBe(true);
    expect(adminMoves("unix//a.sock", "localhost:2019", current)).toBe(true);
  });
});

describe("switchAdminEndpoint (#330)", () => {
  const target = adminTarget("localhost:2020", current);
  function steps(probeAnswers: boolean[], over: Partial<AdminSwitchSteps> = {}) {
    const answers = [...probeAnswers];
    return {
      apply: vi.fn(async () => {}),
      probe: vi.fn(async () => answers.shift() ?? false),
      switchTo: vi.fn(),
      restore: vi.fn(async () => {}),
      sleep: vi.fn(async () => {}),
      ...over,
    };
  }

  it("switches once the new address answers", async () => {
    const s = steps([false, false, true]);
    await switchAdminEndpoint(target, s);
    expect(s.apply).toHaveBeenCalledOnce();
    expect(s.probe).toHaveBeenCalledTimes(3);
    expect(s.switchTo).toHaveBeenCalledWith(target);
    expect(s.restore).not.toHaveBeenCalled();
  });

  it("probes ten times a second apart, then restores and throws", async () => {
    const s = steps([]);
    const err = await switchAdminEndpoint(target, s).catch(e => e);
    expect(err).toBeInstanceOf(AdminSwitchError);
    expect(err).toMatchObject({ rejection: undefined, restored: true });
    expect(s.probe).toHaveBeenCalledTimes(10);
    expect(s.sleep).toHaveBeenCalledTimes(9);
    expect(s.sleep).toHaveBeenCalledWith(1000);
    expect(s.switchTo).not.toHaveBeenCalled();
    expect(s.restore).toHaveBeenCalledOnce();
  });

  it("probes anyway when the answer to the load was cut off", async () => {
    const s = steps([true], { apply: vi.fn(async () => { throw new Error("connection reset"); }) });
    await switchAdminEndpoint(target, s);
    expect(s.switchTo).toHaveBeenCalledWith(target);
  });

  it("restores right away when Caddy refuses the config", async () => {
    const s = steps([true], { apply: vi.fn(async () => { throw new AdminRejectedError("listen tcp: bind: permission denied"); }) });
    const err = await switchAdminEndpoint(target, s).catch(e => e);
    expect(err).toMatchObject({ rejection: "listen tcp: bind: permission denied", restored: true });
    expect(s.probe).not.toHaveBeenCalled();
    expect(s.restore).toHaveBeenCalledOnce();
  });

  it("says so when the restore fails too", async () => {
    const s = steps([], { restore: vi.fn(async () => { throw new Error("no"); }) });
    await expect(switchAdminEndpoint(target, s)).rejects.toMatchObject({ restored: false });
  });
});
