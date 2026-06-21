import { useState, useCallback } from "react";
import { useAutoRefresh } from "@rxtx4816/cockpit-plugin-base-react";
import { getServiceStatus, pingCaddyApi, type ServiceStatus } from "../api";

const POLL_INTERVAL = 5000;

export function useCaddyStatus() {
  const [status, setStatus] = useState<ServiceStatus>("unknown");
  const [adminApiOk, setAdminApiOk] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const s = await getServiceStatus("caddy");
    setStatus(s);
    if (s === "active") {
      setAdminApiOk(await pingCaddyApi());
    } else {
      setAdminApiOk(false);
    }
    setLoading(false);
  }, []);

  useAutoRefresh(refresh, POLL_INTERVAL);

  return { status, adminApiOk, loading, refresh };
}
