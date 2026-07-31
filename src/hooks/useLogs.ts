import { useState, useRef, useCallback } from "react";
import { useAutoRefresh } from "@rxtx4816/cockpit-plugin-base-react";
import { fetchServiceLogs, fetchContainerLogs, isCaddyManaged } from "../api";
import { loadLogContainer } from "./useLogContainer";

const POLL_INTERVAL = 5000;

/** Sentinel error value LogsViewer translates into a user-facing message. */
export const CONTAINER_NOT_CONFIGURED = "container-not-configured";

export function useLogs() {
  const [liveLogs, setLiveLogs] = useState("");
  const [frozenLogs, setFrozenLogs] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);

  // Always keep a ref of the latest live logs for the pause snapshot
  const liveRef = useRef("");

  const fetchLogs = useCallback(async () => {
    try {
      if (!isCaddyManaged()) {
        const container = loadLogContainer();
        if (!container) {
          setError(CONTAINER_NOT_CONFIGURED);
          setLiveLogs("");
          liveRef.current = "";
          return;
        }
        const output = await fetchContainerLogs(container);
        const text = output ?? "";
        liveRef.current = text;
        setLiveLogs(text);
        setError(null);
        return;
      }
      const output = await fetchServiceLogs();
      const text = output ?? "";
      liveRef.current = text;
      setLiveLogs(text);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useAutoRefresh(fetchLogs, POLL_INTERVAL);

  const pause = useCallback(() => {
    setFrozenLogs(liveRef.current);
    setPaused(true);
  }, []);

  const resume = useCallback(() => {
    setFrozenLogs(null);
    setPaused(false);
  }, []);

  const refresh = useCallback(async () => {
    resume();
    await fetchLogs();
  }, [fetchLogs, resume]);

  const logs = paused && frozenLogs !== null ? frozenLogs : liveLogs;

  return { logs, loading, error, refresh, paused, pause, resume };
}
