import { useCallback } from "react";
import { usePollingFetch } from "@rxtx4816/cockpit-plugin-base-react";
import { fetchCaddyConfig, pushCaddyConfig, CaddyApiError, type CaddyConfig } from "../api";

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
        throw new CaddyApiError(e instanceof Error ? e.message : String(e));
      }
      await refresh();
    },
    [refresh],
  );

  return { config, loading, error, refresh, update };
}
