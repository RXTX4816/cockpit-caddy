import { useState, useEffect, useMemo, useCallback } from "react";
import { useAutoRefresh } from "@rxtx4816/cockpit-plugin-base-react";
import {
  parseProxies, mergeProxy, removeProxy,
  readCaddyfile, writeCaddyfile, readProxyConf,
  parseLabelsFromCaddyfile, parseConfTlsMap,
  surgicallyWriteProxy, surgicallyRemoveBlock,
  extractRawBlocksFromCaddyfile, buildMigratedConfContent, writeRawProxyConf,
  writeFile, reloadService,
} from "../api";
import type { ProxyEntry } from "../api";
import { useCaddyConfig } from "./useCaddyConfig";

const CONF_D_GLOB = "import /etc/caddy/conf.d/*";
const CADDYFILE_BAK = "/etc/caddy/Caddyfile.bak";

async function ensureConfDImported(): Promise<void> {
  const content = await readCaddyfile();
  if (!content.includes("conf.d")) {
    await writeCaddyfile(content.trimEnd() + "\n" + CONF_D_GLOB + "\n");
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export function useProxies() {
  const { config, loading, error, refresh, update } = useCaddyConfig();
  const [labels, setLabels] = useState<Record<number, string>>({});
  const [confTls, setConfTls] = useState<Record<number, boolean>>({});
  const [caddyfileContent, setCaddyfileContent] = useState<string>("");

  const syncConf = useCallback(() => {
    void readProxyConf().then(c => {
      setLabels(parseLabelsFromCaddyfile(c));
      setConfTls(parseConfTlsMap(c));
    }).catch(() => {});
  }, []);

  const syncCaddyfile = useCallback(() => {
    void readCaddyfile().then(c => setCaddyfileContent(c ?? "")).catch(() => {});
  }, []);

  // Initial sync
  useEffect(() => {
    syncConf();
    syncCaddyfile();
  }, [syncConf, syncCaddyfile]);

  // Poll conf.d and Caddyfile every 3s (pauses when tab hidden)
  useAutoRefresh(() => { syncConf(); syncCaddyfile(); }, 3000);

  const needsMigration = useMemo(
    () => !caddyfileContent.includes("conf.d") && caddyfileContent.includes("reverse_proxy"),
    [caddyfileContent],
  );

  const proxies = useMemo(
    () => parseProxies(config).map(p => ({
      ...p,
      label: labels[p.externalPort],
      tls: p.tls || (confTls[p.externalPort] ?? false),
    })),
    [config, labels, confTls],
  );

  const addProxy = useCallback(
    async (entry: Omit<ProxyEntry, "id" | "serverKey">) => {
      const newProxy: ProxyEntry = {
        ...entry,
        id: String(entry.externalPort),
        serverKey: `srv${entry.externalPort}`,
      };
      await ensureConfDImported();
      await cockpit.spawn(["mkdir", "-p", "/etc/caddy/conf.d"], { superuser: "try" });
      const current = await readProxyConf();
      await writeRawProxyConf(surgicallyWriteProxy(current, newProxy));
      setLabels(prev => {
        const n = { ...prev };
        if (newProxy.label) n[newProxy.externalPort] = newProxy.label;
        else delete n[newProxy.externalPort];
        return n;
      });
      setConfTls(prev => ({ ...prev, [newProxy.externalPort]: newProxy.tls }));
      await update(mergeProxy(config, newProxy));
    },
    [config, update],
  );

  const editProxy = useCallback(
    async (entry: ProxyEntry) => {
      const originalPort = proxies.find(p => p.serverKey === entry.serverKey)?.externalPort
        ?? entry.externalPort;

      await ensureConfDImported();
      const current = await readProxyConf();

      let updated = current;
      if (originalPort !== entry.externalPort) {
        updated = surgicallyRemoveBlock(updated, originalPort);
      }
      updated = surgicallyWriteProxy(updated, entry);
      await writeRawProxyConf(updated);

      setLabels(prev => {
        const n = { ...prev };
        delete n[originalPort];
        if (entry.label) n[entry.externalPort] = entry.label;
        else delete n[entry.externalPort];
        return n;
      });
      setConfTls(prev => {
        const n = { ...prev };
        delete n[originalPort];
        n[entry.externalPort] = entry.tls;
        return n;
      });
      await update(mergeProxy(config, entry));
    },
    [config, proxies, update],
  );

  const deleteProxy = useCallback(
    async (serverKey: string) => {
      const proxy = proxies.find(p => p.serverKey === serverKey);
      if (!proxy) return;
      const current = await readProxyConf();
      await writeRawProxyConf(surgicallyRemoveBlock(current, proxy.externalPort));
      setLabels(prev => { const n = { ...prev }; delete n[proxy.externalPort]; return n; });
      setConfTls(prev => { const n = { ...prev }; delete n[proxy.externalPort]; return n; });
      await update(removeProxy(config, serverKey));
    },
    [config, proxies, update],
  );

  const migrate = useCallback(async () => {
    const blocks = extractRawBlocksFromCaddyfile(caddyfileContent);
    const content = buildMigratedConfContent(blocks);

    await writeFile(CADDYFILE_BAK, caddyfileContent);
    await cockpit.spawn(["mkdir", "-p", "/etc/caddy/conf.d"], { superuser: "try" });
    await writeRawProxyConf(content);
    await writeCaddyfile(CONF_D_GLOB + "\n");
    await reloadService("caddy");

    await delay(500);

    const newLabels: Record<number, string> = {};
    const newConfTls: Record<number, boolean> = {};
    for (const b of blocks) {
      if (b.label) newLabels[b.port] = b.label;
      newConfTls[b.port] = parseConfTlsMap(content)[b.port] ?? false;
    }
    setLabels(newLabels);
    setConfTls(newConfTls);
    setCaddyfileContent(CONF_D_GLOB + "\n");
    await refresh();
  }, [caddyfileContent, refresh]);

  return { proxies, loading, error, refresh, addProxy, editProxy, deleteProxy, needsMigration, migrate };
}
