import { useState, useEffect, useCallback } from "react";
import { fetchCaddyConfig, pushCaddyConfig, type CaddyConfig } from "../api";

export function useCaddyConfig() {
  const [config, setConfig] = useState<CaddyConfig>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const c = await fetchCaddyConfig();
      setConfig(c);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const update = useCallback(
    async (next: CaddyConfig) => {
      await pushCaddyConfig(next);
      setConfig(next);
    },
    [],
  );

  return { config, loading, error, refresh, update };
}
