import type { ServiceStatus } from "./types";

const SERVICE = "caddy";

export async function getServiceStatus(): Promise<ServiceStatus> {
  try {
    await cockpit.spawn(["which", "caddy"]);
  } catch {
    return "not-installed";
  }

  try {
    const status = await cockpit.spawn(["systemctl", "is-active", SERVICE]);
    const trimmed = status.trim();
    if (trimmed === "active") return "active";
    if (trimmed === "inactive") return "inactive";
    if (trimmed === "failed") return "failed";
    return "unknown";
  } catch {
    return "unknown";
  }
}

export async function startService(): Promise<void> {
  await cockpit.spawn(["systemctl", "start", SERVICE], { superuser: "try" });
}

export async function stopService(): Promise<void> {
  await cockpit.spawn(["systemctl", "stop", SERVICE], { superuser: "try" });
}

export async function restartService(): Promise<void> {
  await cockpit.spawn(["systemctl", "restart", SERVICE], { superuser: "try" });
}

export async function reloadService(): Promise<void> {
  await cockpit.spawn(["systemctl", "reload", SERVICE], { superuser: "try" });
}
