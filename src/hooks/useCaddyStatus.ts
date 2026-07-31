import { useState, useCallback, useEffect } from "react";
import { useAutoRefresh } from "@rxtx4816/cockpit-plugin-base-react";
import { getServiceStatus, pingCaddyApi, setCaddyManaged, fetchServiceFailureReason, type ServiceStatus } from "../api";

const POLL_INTERVAL = 5000;

export function useCaddyStatus() {
  const [status, setStatus] = useState<ServiceStatus>("unknown");
  const [adminApiOk, setAdminApiOk] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failureDetail, setFailureDetail] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const s = await getServiceStatus("caddy");
    setStatus(s);
    // Only "active" means the *local* systemd unit is confirmed to be the
    // thing actually serving requests — inactive/failed/unknown/not-installed
    // all mean local systemd/`caddy` tooling would act on the wrong target (or
    // nothing at all), even if the binary is installed, so those all route
    // reload/validate through the Admin API instead (see reloadCaddy).
    setCaddyManaged(s === "active");
    setAdminApiOk(await pingCaddyApi());
    setFailureDetail(s === "failed" || s === "unknown" ? await fetchServiceFailureReason("caddy") : null);
    setLoading(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useAutoRefresh(refresh, POLL_INTERVAL);

  return { status, adminApiOk, loading, failureDetail, refresh };
}
