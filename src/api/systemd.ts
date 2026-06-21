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

const SERVICE = "caddy";
const CADDYFILE_PATH = "/etc/caddy/Caddyfile";

export async function readCaddyfile(): Promise<string> {
  return cockpit.file(CADDYFILE_PATH, { superuser: "try" }).read();
}

export async function writeCaddyfile(content: string): Promise<void> {
  await cockpit.file(CADDYFILE_PATH, { superuser: "try" }).replace(content);
}

export async function validateCaddyfile(content: string): Promise<void> {
  const tmp = "/tmp/.cockpit-caddy-validate.conf";
  await cockpit.file(tmp, { superuser: "try" }).replace(content);
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

export const fetchServiceLogs = () => baseFetchServiceLogs(SERVICE);

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
