import { useState, useEffect, useCallback } from "react";
import { useAutoRefresh } from "@rxtx4816/cockpit-plugin-base-react";
import { fetchUpstreamStatus } from "../api";

/** Returns the set of upstream addresses (host:port) that have observed failures. */
export function useUpstreamStatus(): Set<string> {
  const [failing, setFailing] = useState<Set<string>>(new Set());

  const refresh = useCallback(() => {
    void fetchUpstreamStatus().then(list => {
      setFailing(new Set(list.filter(s => s.fails > 0).map(s => s.address)));
    });
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useAutoRefresh(refresh, 5000);

  return failing;
}
