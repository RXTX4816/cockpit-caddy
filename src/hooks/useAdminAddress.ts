import { useState, useCallback } from "react";
import { setAdminAddress, ADMIN_TCP_DEFAULT, ADMIN_SOCKET_DEFAULT } from "../api/caddy";

const LS_TCP_KEY = "cockpit-caddy:admin-tcp";
const LS_SOCKET_KEY = "cockpit-caddy:admin-socket";

export function loadAdminAddress(): { tcp: string; socket: string } {
  const tcp = localStorage.getItem(LS_TCP_KEY) ?? ADMIN_TCP_DEFAULT;
  const socket = localStorage.getItem(LS_SOCKET_KEY) ?? ADMIN_SOCKET_DEFAULT;
  return { tcp, socket };
}

export function applyStoredAdminAddress(): void {
  const { tcp, socket } = loadAdminAddress();
  setAdminAddress(tcp, socket);
}

/** Stores where the plugin reaches the admin API and uses it from now on. */
export function storeAdminAddress(tcp: string, socket: string): void {
  try {
    if (tcp && tcp !== ADMIN_TCP_DEFAULT) localStorage.setItem(LS_TCP_KEY, tcp);
    else localStorage.removeItem(LS_TCP_KEY);
    if (socket && socket !== ADMIN_SOCKET_DEFAULT) localStorage.setItem(LS_SOCKET_KEY, socket);
    else localStorage.removeItem(LS_SOCKET_KEY);
  } catch { /* storage blocked: the address still applies to this page */ }
  setAdminAddress(tcp, socket);
}

export function useAdminAddress() {
  const [tcp, setTcpState] = useState(() => localStorage.getItem(LS_TCP_KEY) ?? ADMIN_TCP_DEFAULT);
  const [socket, setSocketState] = useState(() => localStorage.getItem(LS_SOCKET_KEY) ?? ADMIN_SOCKET_DEFAULT);

  const save = useCallback((newTcp: string, newSocket: string) => {
    storeAdminAddress(newTcp, newSocket);
    setTcpState(newTcp || ADMIN_TCP_DEFAULT);
    setSocketState(newSocket || ADMIN_SOCKET_DEFAULT);
  }, []);

  return { tcp, socket, save };
}
