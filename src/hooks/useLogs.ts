import { useState, useCallback } from "react";
import { useAutoRefresh } from "@rxtx4816/cockpit-plugin-base-react";
import { fetchServiceLogs } from "../api";

const POLL_INTERVAL = 10000;

export function useLogs() {
  const [logs, setLogs] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const output = await fetchServiceLogs();
      setLogs(output ?? "");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useAutoRefresh(refresh, POLL_INTERVAL);

  return { logs, loading, error, refresh };
}
