import { useState, useCallback } from "react";

const LS_CONTAINER_KEY = "cockpit-caddy:log-container";

export function loadLogContainer(): string {
  return localStorage.getItem(LS_CONTAINER_KEY) ?? "";
}

export function useLogContainer() {
  const [container, setContainerState] = useState(() => loadLogContainer());

  const save = useCallback((newContainer: string) => {
    if (newContainer) {
      localStorage.setItem(LS_CONTAINER_KEY, newContainer);
    } else {
      localStorage.removeItem(LS_CONTAINER_KEY);
    }
    setContainerState(newContainer);
  }, []);

  return { container, save };
}
