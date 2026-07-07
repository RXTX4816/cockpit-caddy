import { useCallback } from "react";
import { usePollingFetch } from "@rxtx4816/cockpit-plugin-base-react";
import { fetchCaddyConfig, pushCaddyConfig, CaddyApiError, type CaddyConfig } from "../api";

/**
 * "read-only file system" from Caddy's own FileWriter (e.g. an access log path) means the
 * *already-running* caddy process's systemd sandbox mount has gone stale — reproduced
 * directly: `ProtectSystem=strict` + `ReadWritePaths=` bind-mounts are established once at
 * service start, not tracked dynamically, so deleting and recreating a ReadWritePaths
 * directory (e.g. `rm -rf /var/log/caddy && mkdir /var/log/caddy`) while the service is
 * already running leaves its mount namespace referencing the old, now-orphaned mount. No
 * pre-save check run outside that process's namespace (this app's `checkLogFileWritable`
 * included) can ever detect this — it looks perfectly writable from outside. Only a real
 * `systemctl restart caddy` (not reload) re-establishes the sandbox against the current
 * directory, so surface that distinctly instead of the cryptic Caddy internal error.
 */
export function explainCaddyApiError(message: string): string {
  if (/open .+: read-only file system/i.test(message)) {
    return `${message}\n\nThis usually means a directory Caddy writes to (e.g. its log directory) was deleted and recreated while the caddy service was already running — its systemd sandbox can't see the new directory until the service actually restarts. Run "systemctl restart caddy" (not just reload), then try again.`;
  }
  return message;
}

export function useCaddyConfig() {
  const { data: config, loading, error, refresh } = usePollingFetch<CaddyConfig>(
    fetchCaddyConfig,
    {},
    1000,
  );

  const update = useCallback(
    async (next: CaddyConfig) => {
      try {
        await pushCaddyConfig(next);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        throw new CaddyApiError(explainCaddyApiError(message));
      }
      await refresh();
    },
    [refresh],
  );

  return { config, loading, error, refresh, update };
}
