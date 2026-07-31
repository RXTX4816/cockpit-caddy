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
    throw new Error(output.trim() || "Invalid Caddyfile");
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
 * Fetches recent log output from a Docker container running Caddy, for use
 * when Caddy has no local systemd unit (`journalctl -u caddy` finds nothing
 * for a containerized process). No `--timestamps` flag — Caddy's own JSON/
 * console log lines already carry a timestamp field, and the log-line parser
 * in LogsViewer already handles both formats without a journalctl-style prefix.
 */
export async function fetchContainerLogs(container: string, lines = 300): Promise<string> {
  return cockpit.spawn(
    ["docker", "logs", "--tail", String(lines), container],
    { superuser: "try", err: "out" },
  );
}

/** Checks that `container` exists and is running, for the log-source "Test" button. */
export async function testDockerContainer(container: string): Promise<boolean> {
  try {
    const out = await cockpit.spawn(
      ["docker", "inspect", "--format", "{{.State.Running}}", container],
      { superuser: "try", err: "ignore" },
    );
    return out.trim() === "true";
  } catch {
    return false;
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
