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
  deduplicateServerBlocks, proxyAddressKeys, findGlobalBlock,
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
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [confTls, setConfTls] = useState<Record<string, boolean>>({});
  const [confExternal, setConfExternal] = useState<Record<string, { scheme?: string; host?: string }>>({});
  const [confAccessLog, setConfAccessLog] = useState<Record<string, import("../api").AccessLogConfig>>({});
  const [confForwardAuth, setConfForwardAuth] = useState<Record<string, import("../api").ForwardAuthConfig>>({});
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

  // Any site-address block left in the main Caddyfile means migration is needed —
  // whether it's a legacy file with no conf.d import at all, or one that already
  // imports conf.d but also has extra hand-added blocks sitting alongside it.
  const needsMigration = useMemo(
    () => extractRawBlocksFromCaddyfile(caddyfileContent).length > 0,
    [caddyfileContent],
  );

  const proxies = useMemo(
    () => (!serversLoaded ? [] : parseProxies(config, servers)).map(p => {
      if (p.namedServerKey) {
        const def = servers.find(s => s.key === p.namedServerKey);
        return { ...p, label: def?.routeLabels?.[p.id] };
      }
      // A bare-hostname conf.d block has no explicit port, so its on-disk address
      // key won't match buildExternalAddress(p) (which always includes the port) —
      // try each candidate key (host:port, then bare host) in turn.
      const keys = proxyAddressKeys(p);
      const lookup = <T,>(map: Record<string, T>): T | undefined => {
        for (const k of keys) if (k in map) return map[k];
        return undefined;
      };
      return {
        ...p,
        label: lookup(labels),
        tls: p.tls || (lookup(confTls) ?? false),
        externalScheme: p.externalScheme ?? lookup(confExternal)?.scheme,
        externalHost: p.externalHost ?? lookup(confExternal)?.host,
        // Fallback: if the JSON API config doesn't have server.logs (was last pushed by
        // older code), read access log config from the Caddyfile conf.d directly.
        accessLog: p.accessLog ?? lookup(confAccessLog),
        // Fallback: read forward_auth config from conf.d when JSON detection is insufficient.
        forwardAuth: p.forwardAuth ?? lookup(confForwardAuth),
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
      const newProxyKey = proxyAddressKeys(newProxy)[0];
      setLabels(prev => {
        const n = { ...prev };
        if (newProxy.label) n[newProxyKey] = newProxy.label;
        else delete n[newProxyKey];
        return n;
      });
      setConfTls(prev => ({ ...prev, [newProxyKey]: newProxy.tls }));
      setConfExternal(prev => ({
        ...prev,
        [newProxyKey]: { scheme: newProxy.externalScheme, host: newProxy.externalHost },
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

      const originalProxy = proxies.find(p => p.serverKey === entry.serverKey);
      const originalPort = originalProxy?.externalPort ?? entry.externalPort;
      const originalKey = originalProxy ? proxyAddressKeys(originalProxy)[0] : proxyAddressKeys(entry)[0];
      const entryKey = proxyAddressKeys(entry)[0];

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
        delete n[originalKey];
        if (entry.label) n[entryKey] = entry.label;
        else delete n[entryKey];
        return n;
      });
      setConfTls(prev => {
        const n = { ...prev };
        delete n[originalKey];
        n[entryKey] = entry.tls;
        return n;
      });
      setConfExternal(prev => {
        const n = { ...prev };
        delete n[originalKey];
        n[entryKey] = { scheme: entry.externalScheme, host: entry.externalHost };
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
      const proxyKey = proxyAddressKeys(proxy)[0];
      setLabels(prev => { const n = { ...prev }; delete n[proxyKey]; return n; });
      setConfTls(prev => { const n = { ...prev }; delete n[proxyKey]; return n; });
      setConfExternal(prev => { const n = { ...prev }; delete n[proxyKey]; return n; });
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
    // Merge with whatever conf.d already manages — migration must be additive,
    // not destructive, when the user already has proxies set up there.
    const newBlocks = extractRawBlocksFromCaddyfile(caddyfileContent);
    const existingBlocks = extractRawBlocksFromCaddyfile(await readProxyConf());
    const blocks = [...existingBlocks, ...newBlocks];
    const content = buildMigratedConfContent(blocks);

    // Preserve the original global options block (admin, email, acme_ca, etc.) —
    // migration should only move site blocks to conf.d, not discard global settings.
    const gb = findGlobalBlock(caddyfileContent);
    const globalBlock = gb ? caddyfileContent.slice(gb.open, gb.close + 1) : null;
    const newCaddyfile = globalBlock ? `${globalBlock}\n\n${CONF_D_GLOB}\n` : `${CONF_D_GLOB}\n`;

    await writeFile(CADDYFILE_BAK, caddyfileContent);
    await cockpit.spawn(["mkdir", "-p", "/etc/caddy/conf.d"], { superuser: "try" });
    await writeRawProxyConf(content);
    await writeCaddyfile(newCaddyfile);
    await reloadService("caddy");

    await delay(500);

    const newLabels: Record<string, string> = {};
    const newConfTlsMap = parseConfTlsMap(content);
    const newConfTls: Record<string, boolean> = {};
    for (const b of blocks) {
      if (b.label) newLabels[b.address] = b.label;
      newConfTls[b.address] = newConfTlsMap[b.address] ?? false;
    }
    setLabels(newLabels);
    setConfTls(newConfTls);
    setCaddyfileContent(newCaddyfile);
    await refresh();
  }, [caddyfileContent, refresh]);

  return {
    proxies, servers, loading, error, refresh,
    addProxy, editProxy, deleteProxy,
    addServer, editServer, deleteServer,
    needsMigration, migrate,
  };
}
