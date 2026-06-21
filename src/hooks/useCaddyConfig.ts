import { useState, useEffect, useCallback } from "react";
import { useAutoRefresh } from "@rxtx4816/cockpit-plugin-base-react";
import { fetchCaddyConfig, pushCaddyConfig, type CaddyConfig } from "../api";

export function useCaddyConfig() {
  const [config, setConfig] = useState<CaddyConfig>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchConfig = useCallback(async () => {
    setError(null);
    try {
      const c = await fetchCaddyConfig();
      setConfig(c);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Initial load shows spinner
  const refresh = useCallback(async () => {
    setLoading(true);
    await fetchConfig();
    setLoading(false);
  }, [fetchConfig]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Silent background poll every 5s (pauses when tab hidden)
  useAutoRefresh(fetchConfig, 5000);

  const update = useCallback(
    async (next: CaddyConfig) => {
      await pushCaddyConfig(next);
      setConfig(next);
    },
    [],
  );

  return { config, loading, error, refresh, update };
}
