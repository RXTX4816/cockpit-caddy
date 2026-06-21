import { useCallback } from "react";
import { usePollingFetch } from "@rxtx4816/cockpit-plugin-base-react";
import { fetchCaddyConfig, pushCaddyConfig, type CaddyConfig } from "../api";

export function useCaddyConfig() {
  const { data: config, loading, error, refresh } = usePollingFetch<CaddyConfig>(
    fetchCaddyConfig,
    {},
    1000,
  );

  const update = useCallback(
    async (next: CaddyConfig) => {
      await pushCaddyConfig(next);
      await refresh();
    },
    [refresh],
  );

  return { config, loading, error, refresh, update };
}
