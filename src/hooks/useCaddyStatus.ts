import { useState, useEffect, useCallback } from "react";
import { getServiceStatus, type ServiceStatus } from "../api";

const POLL_INTERVAL = 5000;

export function useCaddyStatus() {
  const [status, setStatus] = useState<ServiceStatus>("unknown");
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    void getServiceStatus().then(s => {
      setStatus(s);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [refresh]);

  return { status, loading, refresh };
}
