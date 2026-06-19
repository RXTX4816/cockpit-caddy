import { useMemo, useCallback } from "react";
import { parseProxies, mergeProxy, removeProxy } from "../api";
import type { ProxyEntry, CaddyConfig } from "../api";
import { useCaddyConfig } from "./useCaddyConfig";

export function useProxies() {
  const { config, loading, error, refresh, update } = useCaddyConfig();

  const proxies = useMemo(() => parseProxies(config), [config]);

  const addProxy = useCallback(
    async (entry: Omit<ProxyEntry, "id" | "serverKey">) => {
      const serverKey = `srv${entry.externalPort}`;
      const full: ProxyEntry = { ...entry, id: String(entry.externalPort), serverKey };
      const next: CaddyConfig = mergeProxy(config, full);
      await update(next);
    },
    [config, update],
  );

  const editProxy = useCallback(
    async (entry: ProxyEntry) => {
      const next: CaddyConfig = mergeProxy(config, entry);
      await update(next);
    },
    [config, update],
  );

  const deleteProxy = useCallback(
    async (serverKey: string) => {
      const next: CaddyConfig = removeProxy(config, serverKey);
      await update(next);
    },
    [config, update],
  );

  return { proxies, loading, error, refresh, addProxy, editProxy, deleteProxy };
}
