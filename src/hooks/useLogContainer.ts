import { useState, useCallback } from "react";

const LS_CONTAINER_KEY = "cockpit-caddy:log-container";
const LS_DOCKER_HOST_KEY = "cockpit-caddy:log-docker-host";

export function loadLogContainer(): string {
  return localStorage.getItem(LS_CONTAINER_KEY) ?? "";
}

/** Optional Docker socket for the log container (#191); empty = the default daemon. */
export function loadLogDockerHost(): string {
  return localStorage.getItem(LS_DOCKER_HOST_KEY) ?? "";
}

function store(key: string, value: string) {
  if (value) {
    localStorage.setItem(key, value);
  } else {
    localStorage.removeItem(key);
  }
}

export function useLogContainer() {
  const [container, setContainerState] = useState(() => loadLogContainer());
  const [dockerHost, setDockerHostState] = useState(() => loadLogDockerHost());

  const save = useCallback((newContainer: string, newDockerHost: string) => {
    store(LS_CONTAINER_KEY, newContainer);
    store(LS_DOCKER_HOST_KEY, newDockerHost);
    setContainerState(newContainer);
    setDockerHostState(newDockerHost);
  }, []);

  return { container, dockerHost, save };
}
