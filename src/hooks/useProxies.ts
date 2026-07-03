import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useAutoRefresh } from "@rxtx4816/cockpit-plugin-base-react";
import {
  parseProxies, mergeProxy, removeProxy,
  readCaddyfile, writeCaddyfile, readProxyConf,
  parseLabelsFromCaddyfile, parseConfTlsMap, parseConfExternalAddresses, parseConfAccessLogMap, parseConfForwardAuthMap,
  surgicallyWriteProxy, surgicallyRemoveBlock,
  extractRawBlocksFromCaddyfile, buildMigratedConfContent, writeRawProxyConf, writeRawProxyConfValidated,
  CaddyfileError,
  writeFile, reloadService, syncGlobalTimeouts,
  readServerDefs, writeServerDefs, parseServerDefsFromConf,
  surgicallyWriteServerBlock, surgicallyRemoveServerBlock,
  mergeNamedServer, removeNamedServer,
  deduplicateServerBlocks,
} from "../api";
import type { ProxyEntry, ServerDef } from "../api";
import { useCaddyConfig } from "./useCaddyConfig";

const CONF_D_GLOB = "import /etc/caddy/conf.d/*.conf";
const CADDYFILE_BAK = "/etc/caddy/Caddyfile.bak";

async function ensureConfDImported(): Promise<void> {
  let content = await readCaddyfile();
  if (content.includes("import /etc/caddy/conf.d/*") && !content.includes("import /etc/caddy/conf.d/*.conf")) {
    // Migrate bare wildcard to *.conf so the JSON metadata file is not imported by Caddy
    content = content.replace(/import \/etc\/caddy\/conf\.d\/\*/g, "import /etc/caddy/conf.d/*.conf");
    await writeCaddyfile(content);
    // Delete the old server defs JSON file — defs are now embedded in conf.d blocks
    await cockpit.spawn(["rm", "-f", "/etc/caddy/conf.d/cockpit-caddy-servers.json"], { superuser: "try" }).catch(() => {});
  } else if (!content.includes("conf.d")) {
    await writeCaddyfile(content.trimEnd() + "\n" + CONF_D_GLOB + "\n");
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Throws CaddyfileError if any of def's listen ports conflict with existing proxies.
 *  Pass `ownKey` (= def.key) when editing so the server's own existing routes are excluded. */
function checkServerPortConflicts(
  def: ServerDef,
  proxies: ProxyEntry[],
  ownKey: string | null,
): void {
  for (const addr of def.listenAddresses) {
    const m = addr.match(/:(\d+)$/);
    if (!m) continue;
    const port = parseInt(m[1], 10);
    // Conflict with a standalone proxy
    if (proxies.some(p => p.externalPort === port && !p.namedServerKey)) {
      throw new CaddyfileError(
        `Port ${port} is already used by a standalone proxy. Remove it first or use a different port.`
      );
    }
    // Conflict with a different named server
    const otherServer = proxies.find(p =>
      p.externalPort === port && p.namedServerKey && p.namedServerKey !== ownKey
    );
    if (otherServer) {
      throw new CaddyfileError(`Port ${port} is already used by server "${otherServer.namedServerKey}".`);
    }
  }
}

export function useProxies() {
  const { config, loading, error, refresh, update } = useCaddyConfig();
  const [labels, setLabels] = useState<Record<number, string>>({});
  const [confTls, setConfTls] = useState<Record<number, boolean>>({});
  const [confExternal, setConfExternal] = useState<Record<number, { scheme?: string; host?: string }>>({});
  const [confAccessLog, setConfAccessLog] = useState<Record<number, import("../api").AccessLogConfig>>({});
  const [confForwardAuth, setConfForwardAuth] = useState<Record<number, import("../api").ForwardAuthConfig>>({});
  const [caddyfileContent, setCaddyfileContent] = useState<string>("");
  const [servers, setServers] = useState<ServerDef[]>([]);
  // Guards proxies memo from running before the first conf.d read completes.
  // Without this, config (API) can arrive before servers (disk), causing named-server
  // routes to be misidentified as standalone proxies.
  const [serversLoaded, setServersLoaded] = useState(false);
  // Tracks the timestamp of the last direct mutation to servers state,
  // so stale syncConf promises that started before the mutation don't overwrite it.
  const lastServersMutationAt = useRef(0);
  const confdRepairedRef = useRef(false);

  const syncConf = useCallback(() => {
    const syncStart = Date.now();
    void readProxyConf().then(async c => {
      // One-time repair: remove duplicate server blocks left by the old append bug.
      if (!confdRepairedRef.current) {
        confdRepairedRef.current = true;
        const { content: repaired, changed } = deduplicateServerBlocks(c);
        if (changed) {
          await writeRawProxyConf(repaired);
          return; // let next auto-refresh cycle pick up the repaired state
        }
      }

      setLabels(parseLabelsFromCaddyfile(c));
      setConfTls(parseConfTlsMap(c));
      setConfExternal(parseConfExternalAddresses(c));
      setConfAccessLog(parseConfAccessLogMap(c));
      setConfForwardAuth(parseConfForwardAuthMap(c));
      // Primary: parse server defs from embedded # serverdef: comments in conf.d.
      // Fallback: read old JSON file for blocks that predate the embedded-comment format.
      let defs = parseServerDefsFromConf(c);
      if (defs.length === 0) defs = await readServerDefs();
      setServersLoaded(true);
      // Only update servers if no mutation happened after this sync started
      if (lastServersMutationAt.current <= syncStart) {
        setServers(defs);
      }
    }).catch(() => { setServersLoaded(true); });
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
    () => (!serversLoaded ? [] : parseProxies(config, servers)).map(p => {
      if (p.namedServerKey) {
        const def = servers.find(s => s.key === p.namedServerKey);
        return { ...p, label: def?.routeLabels?.[p.id] };
      }
      return {
        ...p,
        label: labels[p.externalPort],
        tls: p.tls || (confTls[p.externalPort] ?? false),
        externalScheme: p.externalScheme ?? confExternal[p.externalPort]?.scheme,
        externalHost: p.externalHost ?? confExternal[p.externalPort]?.host,
        // Fallback: if the JSON API config doesn't have server.logs (was last pushed by
        // older code), read access log config from the Caddyfile conf.d directly.
        accessLog: p.accessLog ?? confAccessLog[p.externalPort],
        // Fallback: read forward_auth config from conf.d when JSON detection is insufficient.
        forwardAuth: p.forwardAuth ?? confForwardAuth[p.externalPort],
      };
    }),
    [config, labels, confTls, confExternal, confAccessLog, confForwardAuth, servers, serversLoaded],
  );

  const addProxy = useCallback(
    async (entry: Omit<ProxyEntry, "id" | "serverKey">) => {
      if (entry.namedServerKey) {
        const def = servers.find(s => s.key === entry.namedServerKey);
        if (!def) throw new Error(`Named server '${entry.namedServerKey}' not found`);

        const existingRoutes = proxies.filter(p => p.namedServerKey === entry.namedServerKey);
        const newProxy: ProxyEntry = {
          ...entry,
          id: `${entry.namedServerKey}:${existingRoutes.length}`,
          serverKey: entry.namedServerKey,
        };

        let updatedDef = def;
        if (newProxy.label) {
          updatedDef = { ...def, routeLabels: { ...def.routeLabels, [newProxy.id]: newProxy.label } };
          // Set servers early so the label is in state before the config update triggers re-render.
          // No separate writeServerDefs — the def is embedded in the conf.d block.
          const newDefs = servers.map(s => s.key === def.key ? updatedDef : s);
          lastServersMutationAt.current = Date.now();
          setServers(newDefs);
        }

        const allRoutes = [...existingRoutes, newProxy];
        await ensureConfDImported();
        await cockpit.spawn(["mkdir", "-p", "/etc/caddy/conf.d"], { superuser: "try" });
        const current = await readProxyConf();
        await writeRawProxyConfValidated(surgicallyWriteServerBlock(current, updatedDef, allRoutes));
        await update(mergeNamedServer(config, updatedDef, allRoutes));
        return;
      }

      const newProxy: ProxyEntry = {
        ...entry,
        id: String(entry.externalPort),
        serverKey: `srv${entry.externalPort}`,
      };
      // Reject ports already owned by a named server — Caddy cannot have two servers
      // sharing the same listen address.
      const serverConflict = servers.find(s =>
        s.listenAddresses.some(addr => {
          const m = addr.match(/:(\d+)$/);
          return m ? parseInt(m[1], 10) === newProxy.externalPort : false;
        })
      );
      if (serverConflict) {
        throw new CaddyfileError(
          `Port ${newProxy.externalPort} is already used by server "${serverConflict.name}". Add routes to that server tab instead.`
        );
      }
      // Validate + persist server-level timeouts in global Caddyfile first; throws CaddyfileError on failure.
      const afterProxies = [...proxies.filter(p => p.externalPort !== newProxy.externalPort), newProxy];
      await syncGlobalTimeouts(afterProxies);
      const [, , current] = await Promise.all([
        ensureConfDImported(),
        cockpit.spawn(["mkdir", "-p", "/etc/caddy/conf.d"], { superuser: "try" }),
        readProxyConf(),
      ]);
      await writeRawProxyConfValidated(surgicallyWriteProxy(current, newProxy));
      setLabels(prev => {
        const n = { ...prev };
        if (newProxy.label) n[newProxy.externalPort] = newProxy.label;
        else delete n[newProxy.externalPort];
        return n;
      });
      setConfTls(prev => ({ ...prev, [newProxy.externalPort]: newProxy.tls }));
      setConfExternal(prev => ({
        ...prev,
        [newProxy.externalPort]: { scheme: newProxy.externalScheme, host: newProxy.externalHost },
      }));
      await update(mergeProxy(config, newProxy));
    },
    [config, proxies, servers, update],
  );

  const editProxy = useCallback(
    async (entry: ProxyEntry) => {
      if (entry.namedServerKey) {
        const def = servers.find(s => s.key === entry.namedServerKey);
        if (!def) throw new Error(`Named server '${entry.namedServerKey}' not found`);

        const otherRoutes = proxies.filter(p => p.namedServerKey === entry.namedServerKey && p.id !== entry.id);
        const allRoutes = [...otherRoutes, entry].sort((a, b) => {
          const ai = parseInt(a.id.split(":").pop() ?? "0", 10);
          const bi = parseInt(b.id.split(":").pop() ?? "0", 10);
          return ai - bi;
        });

        const newRouteLabels = { ...def.routeLabels };
        if (entry.label) newRouteLabels[entry.id] = entry.label;
        else delete newRouteLabels[entry.id];
        const updatedDef = { ...def, routeLabels: newRouteLabels };

        const current = await readProxyConf();
        await writeRawProxyConfValidated(surgicallyWriteServerBlock(current, updatedDef, allRoutes));
        await update(mergeNamedServer(config, updatedDef, allRoutes));

        const newDefs = servers.map(s => s.key === def.key ? updatedDef : s);
        lastServersMutationAt.current = Date.now();
        setServers(newDefs);
        return;
      }

      const originalPort = proxies.find(p => p.serverKey === entry.serverKey)?.externalPort
        ?? entry.externalPort;

      // Validate + persist server-level timeouts in global Caddyfile first; throws CaddyfileError on failure.
      const afterProxies = [...proxies.filter(p => p.serverKey !== entry.serverKey), entry];
      await syncGlobalTimeouts(afterProxies);

      const [, current] = await Promise.all([
        ensureConfDImported(),
        readProxyConf(),
      ]);

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
      setConfExternal(prev => {
        const n = { ...prev };
        delete n[originalPort];
        n[entry.externalPort] = { scheme: entry.externalScheme, host: entry.externalHost };
        return n;
      });
      await update(mergeProxy(config, entry));
    },
    [config, proxies, servers, update],
  );

  const deleteProxy = useCallback(
    async (proxyId: string) => {
      const proxy = proxies.find(p => p.id === proxyId);
      if (!proxy) return;

      if (proxy.namedServerKey) {
        const def = servers.find(s => s.key === proxy.namedServerKey);
        if (!def) return;

        const remainingRoutes = proxies.filter(
          p => p.namedServerKey === proxy.namedServerKey && p.id !== proxy.id,
        );

        // Renumber remaining routes contiguously and remap labels to new IDs
        const renumbered = remainingRoutes.map((r, i) => ({
          ...r,
          id: `${proxy.namedServerKey}:${i}`,
        }));
        const newRouteLabels: Record<string, string> = {};
        remainingRoutes.forEach((r, i) => {
          const lbl = def.routeLabels?.[r.id];
          if (lbl) newRouteLabels[`${proxy.namedServerKey}:${i}`] = lbl;
        });
        const updatedDef = { ...def, routeLabels: newRouteLabels };

        const current = await readProxyConf();
        if (renumbered.length > 0) {
          await writeRawProxyConfValidated(surgicallyWriteServerBlock(current, updatedDef, renumbered));
          await update(mergeNamedServer(config, updatedDef, renumbered));
          const newDefs = servers.map(s => s.key === def.key ? updatedDef : s);
          lastServersMutationAt.current = Date.now();
          setServers(newDefs);
        } else {
          // Last route removed: remove from conf.d, servers.json (fallback), and state
          await writeRawProxyConf(surgicallyRemoveServerBlock(current, proxy.namedServerKey));
          await writeServerDefs(servers.filter(s => s.key !== proxy.namedServerKey));
          await update(removeNamedServer(config, proxy.namedServerKey));
          lastServersMutationAt.current = Date.now();
          setServers(servers.filter(s => s.key !== proxy.namedServerKey));
        }
        return;
      }

      // Standalone route
      await syncGlobalTimeouts(proxies.filter(p => p.serverKey !== proxy.serverKey));
      const current = await readProxyConf();
      await writeRawProxyConf(surgicallyRemoveBlock(current, proxy.externalPort));
      setLabels(prev => { const n = { ...prev }; delete n[proxy.externalPort]; return n; });
      setConfTls(prev => { const n = { ...prev }; delete n[proxy.externalPort]; return n; });
      setConfExternal(prev => { const n = { ...prev }; delete n[proxy.externalPort]; return n; });
      await update(removeProxy(config, proxy.serverKey));
    },
    [config, proxies, servers, update],
  );

  const addServer = useCallback(
    async (def: ServerDef) => {
      checkServerPortConflicts(def, proxies, null);
      await ensureConfDImported();
      await cockpit.spawn(["mkdir", "-p", "/etc/caddy/conf.d"], { superuser: "try" });
      const current = await readProxyConf();
      await writeRawProxyConfValidated(surgicallyWriteServerBlock(current, def, []));
      lastServersMutationAt.current = Date.now();
      setServers([...servers, def]);
    },
    [servers, proxies],
  );

  const editServer = useCallback(
    async (def: ServerDef) => {
      checkServerPortConflicts(def, proxies, def.key);
      const routes = proxies.filter(p => p.namedServerKey === def.key);
      const current = await readProxyConf();
      await writeRawProxyConfValidated(surgicallyWriteServerBlock(current, def, routes));
      if (routes.length > 0) {
        await update(mergeNamedServer(config, def, routes));
      }
      lastServersMutationAt.current = Date.now();
      setServers(servers.map(s => s.key === def.key ? def : s));
    },
    [config, proxies, servers, update],
  );

  const deleteServer = useCallback(
    async (key: string) => {
      const current = await readProxyConf();
      await writeRawProxyConf(surgicallyRemoveServerBlock(current, key));
      await writeServerDefs(servers.filter(s => s.key !== key));
      await update(removeNamedServer(config, key));
      lastServersMutationAt.current = Date.now();
      setServers(servers.filter(s => s.key !== key));
    },
    [config, servers, update],
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

  return {
    proxies, servers, loading, error, refresh,
    addProxy, editProxy, deleteProxy,
    addServer, editServer, deleteServer,
    needsMigration, migrate,
  };
}
