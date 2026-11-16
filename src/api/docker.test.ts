import { describe, it, expect, afterEach } from "vitest";
import { fetchContainerLogs, testDockerContainer } from "./systemd";
import { mockSpawn, mockUser } from "../test/setup";

// #191: a Caddy container on a rootless Docker daemon lives behind
// /run/user/<uid>/docker.sock, which the rootful daemon (the default when
// `docker` runs as root) doesn't know about. An optional Docker socket setting
// makes `docker logs` / `docker inspect` talk to that daemon as its owner.
const SOCK = "/run/user/1000/docker.sock";
const HOST = `unix://${SOCK}`;

type Call = [string[], Record<string, unknown>];

function dockerCalls(): Call[] {
  return (mockSpawn.mock.calls as Call[]).filter(([argv]) => argv.includes("docker"));
}

/** Fakes `stat` on the socket and the docker command itself. */
function fakeHost(statResult: { out?: string; err?: string }, docker: () => Promise<string> = () => Promise.resolve("true\n")) {
  mockSpawn.mockImplementation((argv: string[]) => {
    if (argv[0] === "stat") {
      return statResult.err !== undefined
        ? Promise.reject(new Error(statResult.err))
        : Promise.resolve(statResult.out ?? "");
    }
    if (argv.includes("docker")) return docker();
    return Promise.reject(new Error(`unexpected spawn: ${argv.join(" ")}`));
  });
}

describe("docker commands without a Docker socket setting", () => {
  afterEach(() => mockSpawn.mockReset());

  it("fetchContainerLogs spawns exactly as before", async () => {
    mockSpawn.mockResolvedValue("log");
    await fetchContainerLogs("caddy");
    expect(mockSpawn.mock.calls).toEqual([
      [["docker", "logs", "--tail", "300", "caddy"], { superuser: "try", err: "out" }],
    ]);
  });

  it("testDockerContainer spawns exactly as before", async () => {
    mockSpawn.mockResolvedValue("true\n");
    expect(await testDockerContainer("caddy")).toBe("ok");
    expect(mockSpawn.mock.calls).toEqual([
      [["docker", "inspect", "--format", "{{.State.Running}}", "caddy"], { superuser: "try", err: "ignore" }],
    ]);
  });

  it("testDockerContainer reports a stopped or missing container", async () => {
    mockSpawn.mockResolvedValue("false\n");
    expect(await testDockerContainer("caddy")).toBe("not-running");
    mockSpawn.mockRejectedValue(new Error("No such object: caddy"));
    expect(await testDockerContainer("caddy")).toBe("not-running");
  });
});

describe("docker commands with a Docker socket setting", () => {
  afterEach(() => {
    mockSpawn.mockReset();
    mockUser.mockReset();
  });

  it("runs as the logged-in user when that user owns the socket", async () => {
    mockUser.mockResolvedValue({ name: "alice" });
    fakeHost({ out: "socket alice\n" }, () => Promise.resolve("log"));

    await fetchContainerLogs("caddy", HOST);

    expect(dockerCalls()).toEqual([
      [["docker", "--host", HOST, "logs", "--tail", "300", "caddy"], { err: "out" }],
    ]);
  });

  it("runs as the socket's owner via runuser when another user owns it", async () => {
    mockUser.mockResolvedValue({ name: "admin" });
    fakeHost({ out: "socket alice\n" });

    expect(await testDockerContainer("caddy", HOST)).toBe("ok");

    expect(dockerCalls()).toEqual([
      [
        ["runuser", "-u", "alice", "--", "docker", "--host", HOST, "inspect", "--format", "{{.State.Running}}", "caddy"],
        { superuser: "require", err: "message" },
      ],
    ]);
  });

  it("keeps superuser for a root-owned socket at a custom path", async () => {
    mockUser.mockResolvedValue({ name: "admin" });
    fakeHost({ out: "socket root\n" }, () => Promise.resolve("log"));

    await fetchContainerLogs("caddy", "unix:///srv/docker.sock");

    expect(dockerCalls()).toEqual([
      [["docker", "--host", "unix:///srv/docker.sock", "logs", "--tail", "300", "caddy"], { superuser: "try", err: "out" }],
    ]);
  });

  it("accepts a bare socket path", async () => {
    mockUser.mockResolvedValue({ name: "alice" });
    fakeHost({ out: "socket alice\n" }, () => Promise.resolve("log"));

    await fetchContainerLogs("caddy", SOCK);

    expect(dockerCalls()[0][0]).toEqual(["docker", "--host", HOST, "logs", "--tail", "300", "caddy"]);
  });

  it("passes a non-unix host through with today's privilege", async () => {
    mockSpawn.mockResolvedValue("log");

    await fetchContainerLogs("caddy", "tcp://10.0.0.2:2375");

    expect(mockSpawn.mock.calls).toEqual([
      [["docker", "--host", "tcp://10.0.0.2:2375", "logs", "--tail", "300", "caddy"], { superuser: "try", err: "out" }],
    ]);
  });

  it("Test reports a socket that doesn't exist", async () => {
    fakeHost({ err: `stat: cannot statx '${SOCK}': No such file or directory` });
    expect(await testDockerContainer("caddy", HOST)).toBe("socket-missing");
    expect(dockerCalls()).toEqual([]);
  });

  it("Test reports a path that isn't a socket as missing", async () => {
    fakeHost({ out: "regular file alice\n" });
    expect(await testDockerContainer("caddy", HOST)).toBe("socket-missing");
  });

  it("Test reports a socket that can't be read", async () => {
    fakeHost({ err: `stat: cannot statx '${SOCK}': Permission denied` });
    expect(await testDockerContainer("caddy", HOST)).toBe("socket-unreadable");
  });

  it("Test reports a daemon that refuses the connection as unreadable", async () => {
    mockUser.mockResolvedValue({ name: "alice" });
    fakeHost({ out: "socket alice\n" }, () => Promise.reject(new Error(
      "permission denied while trying to connect to the Docker daemon socket at unix:///run/user/1000/docker.sock",
    )));
    expect(await testDockerContainer("caddy", HOST)).toBe("socket-unreadable");
  });

  it("fetchContainerLogs throws a readable error for a missing socket", async () => {
    fakeHost({ err: "No such file or directory" });
    await expect(fetchContainerLogs("caddy", HOST)).rejects.toThrow(`Docker socket not found: ${SOCK}`);
  });
});
