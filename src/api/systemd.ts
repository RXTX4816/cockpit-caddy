export {
  getServiceStatus,
  startService,
  stopService,
  restartService,
  reloadService,
  readFile,
  writeFile,
} from "@rxtx4816/cockpit-plugin-base-react/systemd";

import { fetchServiceLogs as baseFetchServiceLogs } from "@rxtx4816/cockpit-plugin-base-react/systemd";
import { readFile as fsReadFile, writeFile as fsWriteFile } from "@rxtx4816/cockpit-plugin-base-react/lib/cockpit-fs";
import { i18n } from "@rxtx4816/cockpit-plugin-base-react/i18n";

const SERVICE = "caddy";
const CADDYFILE_PATH = "/etc/caddy/Caddyfile";

export async function readCaddyfile(): Promise<string> {
  return (await fsReadFile(CADDYFILE_PATH, "try")) ?? "";
}

export async function writeCaddyfile(content: string): Promise<void> {
  await fsWriteFile(CADDYFILE_PATH, content, "try");
}

export async function validateCaddyfile(content: string): Promise<void> {
  const tmp = "/tmp/.cockpit-caddy-validate.conf";
  await fsWriteFile(tmp, content, "try");
  let output = "";
  try {
    const proc = cockpit.spawn(
      ["caddy", "validate", "--config", tmp, "--adapter", "caddyfile"],
      { superuser: "try", err: "out" },
    );
    proc.stream(chunk => { output += chunk; });
    await proc;
  } catch {
    throw new Error(output.trim() || i18n.t("errors.invalid_caddyfile"));
  } finally {
    await cockpit.spawn(["rm", "-f", tmp], { superuser: "try" }).catch(() => { /* ignore */ });
  }
}

export const fetchServiceLogs = () => baseFetchServiceLogs(SERVICE, 1000);

/**
 * Fetches `systemctl status` for the given unit (recent log lines included),
 * for surfacing *why* a start/restart failed — `systemctl start` can return
 * success at the job-queuing level even when the process then immediately
 * exits (e.g. a port already bound by something else), so the generic
 * "unreachable" messaging alone isn't actionable. `systemctl status` exits
 * non-zero for a failed unit, so output is streamed to capture it even
 * though the process itself rejects.
 */
export async function fetchServiceFailureReason(unit: string): Promise<string> {
  let output = "";
  const proc = cockpit.spawn(["systemctl", "status", unit, "--no-pager", "-l"], { err: "out" });
  proc.stream(chunk => { output += chunk; });
  try {
    await proc;
  } catch { /* non-zero exit for a failed/inactive unit is expected */ }
  return output.trim();
}

/**
 * Outcome of the log-source "Test" button. The socket-* results only occur
 * with a Docker socket set.
 */
export type DockerTestResult = "ok" | "not-running" | "socket-missing" | "socket-unreadable";

/** The configured Docker socket can't be used; `reason` is a {@link DockerTestResult}. */
export class DockerSocketError extends Error {
  constructor(public readonly reason: "socket-missing" | "socket-unreadable", message: string) {
    super(message);
    this.name = "DockerSocketError";
  }
}

/** Accepts a bare socket path as shorthand for `unix://<path>`. */
export function normalizeDockerHost(host: string): string {
  const trimmed = host.trim();
  return trimmed.startsWith("/") ? `unix://${trimmed}` : trimmed;
}

/** Owner of the unix socket at `path`; throws a {@link DockerSocketError} when it's unusable. */
async function dockerSocketOwner(path: string): Promise<string> {
  let out: string;
  try {
    // Superuser so the check also sees into another user's 0700 /run/user/<uid>.
    out = await cockpit.spawn(["stat", "-L", "-c", "%F %U", path], { superuser: "try", err: "message" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such file/i.test(msg)) {
      throw new DockerSocketError("socket-missing", `Docker socket not found: ${path}`);
    }
    throw new DockerSocketError("socket-unreadable", `Docker socket can't be read: ${path}`);
  }
  const line = out.trim();
  const sep = line.lastIndexOf(" ");
  if (sep < 0 || line.slice(0, sep) !== "socket") {
    throw new DockerSocketError("socket-missing", `Docker socket not found: ${path} is not a socket`);
  }
  return line.slice(sep + 1);
}

/**
 * Builds the argv and spawn options for a `docker` subcommand. Without a
 * Docker socket this is the same as it always was: `docker <args>` with
 * superuser "try", which talks to the rootful daemon. With a unix socket set
 * (#191, rootless Docker at /run/user/<uid>/docker.sock), docker runs as the
 * socket's owner: directly when that is the logged-in user, through `runuser`
 * otherwise, and with superuser only for a root-owned socket. Other hosts
 * (tcp://, ssh://) keep today's privilege.
 */
async function dockerCommand(
  args: string[],
  dockerHost: string,
  err: string,
): Promise<[string[], { superuser?: "try" | "require"; err: string }]> {
  const host = normalizeDockerHost(dockerHost);
  if (!host) return [["docker", ...args], { superuser: "try", err }];
  const docker = ["docker", "--host", host, ...args];
  if (!host.startsWith("unix://")) return [docker, { superuser: "try", err }];
  const owner = await dockerSocketOwner(host.slice("unix://".length));
  if (owner === "root") return [docker, { superuser: "try", err }];
  if (owner === (await cockpit.user()).name) return [docker, { err }];
  return [["runuser", "-u", owner, "--", ...docker], { superuser: "require", err }];
}

/**
 * Fetches recent log output from a Docker container running Caddy, for use
 * when Caddy has no local systemd unit (`journalctl -u caddy` finds nothing
 * for a containerized process). No `--timestamps` flag — Caddy's own JSON/
 * console log lines already carry a timestamp field, and the log-line parser
 * in LogsViewer already handles both formats without a journalctl-style prefix.
 * `dockerHost` is the optional Docker socket setting (empty = default daemon).
 */
export async function fetchContainerLogs(container: string, dockerHost = "", lines = 300): Promise<string> {
  const [argv, options] = await dockerCommand(["logs", "--tail", String(lines), container], dockerHost, "out");
  return cockpit.spawn(argv, options);
}

/** Checks that `container` exists and is running, for the log-source "Test" button. */
export async function testDockerContainer(container: string, dockerHost = ""): Promise<DockerTestResult> {
  const hasHost = normalizeDockerHost(dockerHost) !== "";
  try {
    const [argv, options] = await dockerCommand(
      ["inspect", "--format", "{{.State.Running}}", container],
      dockerHost,
      // With a socket set, keep the message to tell a refused connection apart.
      hasHost ? "message" : "ignore",
    );
    const out = await cockpit.spawn(argv, options);
    return out.trim() === "true" ? "ok" : "not-running";
  } catch (e) {
    if (e instanceof DockerSocketError) return e.reason;
    if (hasHost && e instanceof Error && /permission denied|cannot connect to the docker daemon/i.test(e.message)) {
      return "socket-unreadable";
    }
    return "not-running";
  }
}

export async function listConfDFiles(): Promise<string[]> {
  try {
    const out = await cockpit.spawn(
      ["find", "/etc/caddy/conf.d", "-maxdepth", "1", "-type", "f"],
      { superuser: "try" },
    );
    return out.trim().split("\n").filter(Boolean).sort();
  } catch {
    return [];
  }
}
