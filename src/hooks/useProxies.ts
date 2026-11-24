import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useAutoRefresh } from "@rxtx4816/cockpit-plugin-base-react";
import { i18n } from "@rxtx4816/cockpit-plugin-base-react/i18n";
import {
  parseProxies, mergeProxy, removeProxy,
  readCaddyfile, writeCaddyfile, readProxyConf,
  parseLabelsFromCaddyfile, parseConfTlsMap, parseConfExternalAddresses, parseConfAccessLogMap, parseConfForwardAuthMap, parseConfCustomTlsCaMap, parseClientAuthCaFile, parseConfTlsIssuerMap, parseConfTlsOnDemandMap, parseConfTlsDnsMap, applyDnsSecrets, isSiteDnsVar,
  surgicallyWriteProxy, surgicallyEditProxy, surgicallyRemoveBlock,
  migrateCaddyfile, isStockCaddyfile, mergeMigratedConfContent, writeRawProxyConf, writeRawProxyConfValidated,
  CaddyfileError,
  writeFile, reloadCaddy, saveSiteConfig, ensureConfDDir,
  removeLegacyServerDefsFile, parseServerDefsFromConf,
  surgicallyWriteServerBlock, surgicallyRemoveServerBlock,
  mergeNamedServer, removeNamedServer,
  deduplicateServerBlocks, normalizeManagedHeader, proxyAddressKeys,
  ensureConfDImported,
  resolveInternalIssuerSettings, readGlobalOptions,
  applyGlobalInternalLifetimeToProxy, applyGlobalInternalLifetimeToServer,
  routeHosts, hostsConflict, standaloneProxyId,
  readSnippetsConf, parseSnippets, parseConfSiteBlocks, parseConfSiteImports, separateSnippetSettings, mergeSnippetLists,
} from "../api";
import type { CaddyConfig, DnsChallengeConfig, ProxyEntry, ServerDef, SnippetDef } from "../api";
import { useCaddyConfig } from "./useCaddyConfig";

const CADDYFILE_BAK = "/etc/caddy/Caddyfile.bak";

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
      throw new CaddyfileError(i18n.t("errors.port_used_by_standalone", { port }));
    }
    // Conflict with a different named server
    const otherServer = proxies.find(p =>
      p.externalPort === port && p.namedServerKey && p.namedServerKey !== ownKey
    );
    if (otherServer) {
      throw new CaddyfileError(i18n.t("errors.port_used_by_server", { port, server: otherServer.namedServerKey }));
    }
  }
}

/** A site whose TLS automation only Caddy's Caddyfile adapter builds correctly: automatic
 *  HTTPS (#246) or on-demand TLS (#253). */
function reliesOnCaddyfileTls(p: ProxyEntry): boolean {
  return p.tls && !p.customTls && (p.tlsIssuer === "acme" || !!p.tlsOnDemand);
}

/** The conf.d issuer map after writing `p` under `key` (dropping `oldKey`), before the next poll. */
function withIssuer(
  map: Record<string, "acme" | "internal">, oldKey: string | undefined, key: string, p: ProxyEntry,
): Record<string, "acme" | "internal"> {
  const n = { ...map };
  if (oldKey) delete n[oldKey];
  if (p.tls && !p.customTls) n[key] = p.tlsIssuer ?? "internal";
  else delete n[key];
  return n;
}

/** The conf.d on-demand map after writing `p` under `key` (dropping `oldKey`), before the next poll. */
function withOnDemand(map: Record<string, boolean>, oldKey: string | undefined, key: string, p: ProxyEntry): Record<string, boolean> {
  const n = { ...map };
  if (oldKey) delete n[oldKey];
  if (p.tls && !p.customTls && p.tlsOnDemand) n[key] = true;
  else delete n[key];
  return n;
}

/** The conf.d per-site DNS map (#289) after writing `p` under `key` (dropping `oldKey`). */
function withDns(map: Record<string, DnsChallengeConfig>, oldKey: string | undefined, key: string, p: ProxyEntry): Record<string, DnsChallengeConfig> {
  const n = { ...map };
  if (oldKey) delete n[oldKey];
  if (p.tls && !p.customTls && p.tlsIssuer === "acme" && p.dnsChallenge) n[key] = p.dnsChallenge;
  else delete n[key];
  return n;
}

/**
 * Sites whose JSON only Caddy's own Caddyfile adapter builds correctly, so they are applied
 * by reloading instead of pushing hand-built JSON: php_fastcgi (#35) expands into several
 * routes, automatic HTTPS (#246) and on-demand TLS (#253) need automation policies that
 * the JSON push doesn't build, and snippet imports (#288) are only in the Caddyfile.
 */
function needsCaddyfileReload(p: ProxyEntry): boolean {
  // Snippet imports (#288) only exist in the Caddyfile; hand-built JSON would drop what they add.
  // A client_ip matcher (#286) needs the server's trusted_proxies, which the global options set
  // and only Caddy's adapter puts on the server; the hand-built JSON server has none.
  return !!p.phpFastcgi || reliesOnCaddyfileTls(p) || !!p.imports?.length
    || !!p.matchers?.client_ip?.ranges.length || !!p.matchers?.not?.client_ip?.ranges.length;
}

/**
 * True when `entry`'s port is also claimed by another standalone proxy in `proxies`
 * with a distinct, non-conflicting host (#139) — i.e. two+ sites legitimately sharing
 * one Caddy listener by Host/SNI. In that case the fast "instant apply" path (pushing
 * a hand-built single-route JSON server straight to the Admin API — see mergeProxy/
 * buildServerEntry) cannot represent the shared listener correctly: it always builds
 * exactly one route per port. Only Caddy's own Caddyfile-adapter (triggered by a
 * service reload) knows how to merge multiple host-matched routes onto one listener,
 * so callers must skip the instant JSON push and prompt a reload instead.
 */
function sharesPortWithOtherHost(
  proxies: ProxyEntry[],
  entry: Pick<ProxyEntry, "id" | "externalPort" | "externalHost" | "matchers">,
): boolean {
  return proxies.some(p =>
    p.id !== entry.id && !p.namedServerKey && p.externalPort === entry.externalPort &&
    !hostsConflict(routeHosts(p), routeHosts(entry))
  );
}

export function useProxies() {
  const { config, loading, error, refresh, update } = useCaddyConfig();
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [confTls, setConfTls] = useState<Record<string, boolean>>({});
  const [confExternal, setConfExternal] = useState<Record<string, { scheme?: string; host?: string }>>({});
  const [confAccessLog, setConfAccessLog] = useState<Record<string, import("../api").AccessLogConfig>>({});
  const [confForwardAuth, setConfForwardAuth] = useState<Record<string, import("../api").ForwardAuthConfig>>({});
  const [confCustomTlsCa, setConfCustomTlsCa] = useState<Record<string, string>>({});
  const [confTlsIssuer, setConfTlsIssuer] = useState<Record<string, "acme" | "internal">>({});
  const [confTlsOnDemand, setConfTlsOnDemand] = useState<Record<string, boolean>>({});
  const [confTlsDns, setConfTlsDns] = useState<Record<string, DnsChallengeConfig>>({});
  const [confSiteBlocks, setConfSiteBlocks] = useState<Record<string, string>>({});
  const [confImports, setConfImports] = useState<Record<string, string[]>>({});
  const [pluginSnippets, setPluginSnippets] = useState<SnippetDef[]>([]);
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

  /** Site imports (#288) right after a write, so the list never shows a site without them. */
  const noteConfSites = useCallback((content: string) => {
    setConfSiteBlocks(parseConfSiteBlocks(content));
    setConfImports(parseConfSiteImports(content));
  }, []);

  const syncConf = useCallback(() => {
    const syncStart = Date.now();
    void readProxyConf().then(async c => {
      // One-time repair: remove duplicate server blocks left by older append/migration
      // bugs, bring the header comment up to date, and delete the server-defs JSON file
      // older versions mirrored the `# serverdef:` comments into.
      if (!confdRepairedRef.current) {
        confdRepairedRef.current = true;
        await removeLegacyServerDefsFile();
        const { content: dedupedServers, changed: serversChanged } = deduplicateServerBlocks(c);
        const { content: repaired, changed: headerChanged } = normalizeManagedHeader(dedupedServers);
        if (serversChanged || headerChanged) {
          await writeRawProxyConf(repaired);
          return; // let next auto-refresh cycle pick up the repaired state
        }
      }

      setLabels(parseLabelsFromCaddyfile(c));
      setConfTls(parseConfTlsMap(c));
      setConfExternal(parseConfExternalAddresses(c));
      setConfAccessLog(parseConfAccessLogMap(c));
      setConfForwardAuth(parseConfForwardAuthMap(c));
      setConfCustomTlsCa(parseConfCustomTlsCaMap(c));
      setConfTlsIssuer(parseConfTlsIssuerMap(c));
      setConfTlsOnDemand(parseConfTlsOnDemandMap(c));
      setConfTlsDns(parseConfTlsDnsMap(c));
      noteConfSites(c);
      setPluginSnippets(parseSnippets(await readSnippetsConf(), "plugin"));
      const defs = parseServerDefsFromConf(c);
      setServersLoaded(true);
      // Only update servers if no mutation happened after this sync started
      if (lastServersMutationAt.current <= syncStart) {
        setServers(defs);
      }
    }).catch(() => { setServersLoaded(true); });
  }, [noteConfSites]);

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
  // The distro's own Caddyfile (#256) isn't a migration case: its welcome site moves into
  // conf.d on the first save (ensureConfDImported), without a warning or a gate.
  const needsMigration = useMemo(
    () => !isStockCaddyfile(caddyfileContent) && migrateCaddyfile(caddyfileContent).blocks.length > 0,
    [caddyfileContent],
  );

  const snippets = useMemo(
    () => mergeSnippetLists(pluginSnippets, parseSnippets(caddyfileContent, "caddyfile")),
    [pluginSnippets, caddyfileContent],
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
      const tls = p.tls || (lookup(confTls) ?? false);
      const externalHost = p.externalHost ?? lookup(confExternal)?.host;
      // parseProxies resolves tlsAdvanced.certLifetime/renewalWindowRatio using whatever
      // host it could see in the live JSON route (often none — a server that's the sole
      // occupant of its port has no host matcher at all, since there's nothing else on
      // that listener to disambiguate). externalHost above may have just been recovered
      // from the conf.d fallback instead, so re-resolve with the corrected host and layer
      // it over the already-parsed tlsAdvanced (which still has protocol/cipher/curves).
      const resolved = tls ? resolveInternalIssuerSettings(config, externalHost) : {};
      const tlsAdvanced = (p.tlsAdvanced || resolved.certLifetime !== undefined || resolved.renewalWindowRatio !== undefined)
        ? {
            ...p.tlsAdvanced,
            ...(resolved.certLifetime !== undefined ? { certLifetime: resolved.certLifetime } : {}),
            ...(resolved.renewalWindowRatio !== undefined ? { renewalWindowRatio: resolved.renewalWindowRatio } : {}),
          }
        : undefined;
      const imports = lookup(confImports);
      return separateSnippetSettings({
        ...p,
        imports,
        label: lookup(labels),
        tls,
        externalScheme: p.externalScheme ?? lookup(confExternal)?.scheme,
        externalHost,
        tlsAdvanced,
        // Fallback: if the JSON API config doesn't have server.logs (was last pushed by
        // older code), read access log config from the Caddyfile conf.d directly.
        accessLog: p.accessLog ?? lookup(confAccessLog),
        // Fallback: read forward_auth config from conf.d when JSON detection is insufficient.
        forwardAuth: p.forwardAuth ?? lookup(confForwardAuth),
        // The CA bundle path (#152) isn't part of Caddy's own JSON model at all — it only
        // ever lives in the Caddyfile comment, so always layer it in from there.
        customTls: p.customTls ? { ...p.customTls, caFile: lookup(confCustomTlsCa) } : undefined,
        // The deprecated trusted_ca_cert_file reaches the JSON as an inlined certificate (#255),
        // so its path is read from the site block.
        mtls: p.mtls && !p.mtls.trustedCaFile
          ? { ...p.mtls, trustedCaFile: parseClientAuthCaFile(lookup(confSiteBlocks) ?? "") }
          : p.mtls,
        // Automatic HTTPS vs the internal CA (#246) is only visible in the Caddyfile text.
        tlsIssuer: tls && !p.customTls ? lookup(confTlsIssuer) : undefined,
        // Per-site on-demand TLS (#253), likewise read from the Caddyfile.
        tlsOnDemand: tls && !p.customTls && lookup(confTlsOnDemand) ? true : undefined,
        // The site's own DNS provider (#289), for automatic HTTPS only.
        dnsChallenge: tls && !p.customTls && lookup(confTlsIssuer) === "acme" ? lookup(confTlsDns) : undefined,
      }, lookup(confSiteBlocks), snippets);
    }),
    [config, labels, confTls, confExternal, confAccessLog, confForwardAuth, confCustomTlsCa, confTlsIssuer, confTlsOnDemand, confTlsDns, confSiteBlocks, confImports, snippets, servers, serversLoaded],
  );

  // #246: while any site relies on automatic HTTPS, Caddy's own Caddyfile adapter has to build
  // the TLS automation. The hand-built JSON only knows the internal issuer, and its catch-all
  // policy would take over the ACME sites' public names, so reload from the Caddyfile instead.
  const apply = useCallback(async (next: CaddyConfig) => {
    if (proxies.some(reliesOnCaddyfileTls)) {
      await reloadCaddy(); // refetches the config (onConfigChanged)
      return;
    }
    await update(next);
  }, [proxies, update]);

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
          // The def is embedded in the conf.d block, written below.
          const newDefs = servers.map(s => s.key === def.key ? updatedDef : s);
          lastServersMutationAt.current = Date.now();
          setServers(newDefs);
        }

        const allRoutes = [...existingRoutes, newProxy];
        await ensureConfDImported();
        await ensureConfDDir();
        const current = await readProxyConf();
        await writeRawProxyConfValidated(surgicallyWriteServerBlock(current, updatedDef, allRoutes));
        await apply(mergeNamedServer(config, updatedDef, allRoutes));
        return;
      }

      let newProxy: ProxyEntry = {
        ...entry,
        id: standaloneProxyId(entry),
        serverKey: `srv${entry.externalPort}`,
      };
      // Every hostless proxy/server must carry the identical internal-cert lifetime, or
      // Caddy refuses to reload — see applyGlobalInternalLifetimeToProxy.
      if (newProxy.tls) {
        const globalOpts = await readGlobalOptions();
        newProxy = { ...newProxy, tlsAdvanced: applyGlobalInternalLifetimeToProxy(newProxy, globalOpts.internalCertLifetime) };
      }
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
          i18n.t("errors.port_used_by_server_add", { port: newProxy.externalPort, server: serverConflict.name }),
        );
      }
      // Only drop existing proxies that genuinely conflict with the new one (#139) — a
      // standalone proxy already coexisting on this port via a distinct host must stay in
      // the timeout-sync input, or its own settings would be silently dropped.
      const afterProxies = [
        ...proxies.filter(p => !(p.externalPort === newProxy.externalPort && hostsConflict(routeHosts(p), routeHosts(newProxy)))),
        newProxy,
      ];
      // Sequential: a stock Caddyfile's migration (#256) writes conf.d before it is read.
      await ensureConfDImported();
      await ensureConfDDir();
      const current = await readProxyConf();
      const written = surgicallyWriteProxy(current, newProxy);
      // Timeouts and conf.d are saved as one change: throws CaddyfileError, leaving both as they were.
      await saveSiteConfig(afterProxies, written);
      noteConfSites(written);
      const newProxyKey = proxyAddressKeys(newProxy)[0];
      setLabels(prev => {
        const n = { ...prev };
        if (newProxy.label) n[newProxyKey] = newProxy.label;
        else delete n[newProxyKey];
        return n;
      });
      setConfTls(prev => ({ ...prev, [newProxyKey]: newProxy.tls }));
      setConfTlsIssuer(prev => withIssuer(prev, undefined, newProxyKey, newProxy));
      setConfTlsOnDemand(prev => withOnDemand(prev, undefined, newProxyKey, newProxy));
      setConfTlsDns(prev => withDns(prev, undefined, newProxyKey, newProxy));
      setConfExternal(prev => ({
        ...prev,
        [newProxyKey]: { scheme: newProxy.externalScheme, host: newProxy.externalHost },
      }));
      // A hand-built single-route JSON push can't represent a listener shared by
      // multiple hosts (#139) — only Caddy's own Caddyfile adapter can build that
      // correctly, so reload instead of pushing a JSON patch that would silently
      // misrepresent (or clobber) the shared listener. php_fastcgi (#35) is a Caddyfile
      // macro that expands into four separate JSON routes (vars/redirect/rewrite/
      // reverse_proxy) with no single-handler equivalent — mergeProxy can't construct
      // that either, so it always needs the same reload-from-Caddyfile path.
      if (sharesPortWithOtherHost(afterProxies, newProxy) || needsCaddyfileReload(newProxy)) {
        await reloadCaddy(); // refetches the config (onConfigChanged)
        return;
      }
      await apply(mergeProxy(config, newProxy));
    },
    [config, proxies, servers, apply, noteConfSites],
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

        await ensureConfDImported();
        const current = await readProxyConf();
        await writeRawProxyConfValidated(surgicallyWriteServerBlock(current, updatedDef, allRoutes));
        await apply(mergeNamedServer(config, updatedDef, allRoutes));

        const newDefs = servers.map(s => s.key === def.key ? updatedDef : s);
        lastServersMutationAt.current = Date.now();
        setServers(newDefs);
        return;
      }

      // Every hostless proxy/server must carry the identical internal-cert lifetime, or
      // Caddy refuses to reload — see applyGlobalInternalLifetimeToProxy.
      if (entry.tls) {
        const globalOpts = await readGlobalOptions();
        entry = { ...entry, tlsAdvanced: applyGlobalInternalLifetimeToProxy(entry, globalOpts.internalCertLifetime) };
      }

      // entry.id still holds the *original* id at this point — EditProxyDialog deliberately
      // doesn't recompute it — so this always finds the exact proxy being edited, even when
      // sibling proxies share a port with different hosts (#139) and would make a serverKey-
      // based lookup ambiguous (serverKey isn't unique per route once Caddy assigns its own
      // shared JSON server key across those routes on reload).
      const originalProxy = proxies.find(p => p.id === entry.id);

      // Recompute id for the post-edit host/port now that the original has been located
      // above. serverKey is deliberately left untouched (still the original proxy's key,
      // via the ...proxy spread in EditProxyDialog) — mergeProxy indexes the live JSON
      // server object by serverKey, and keeping it stable is what lets patchServer move
      // the *same* server object to its new listen address in place. Recomputing it here
      // would instead create a second, orphaned server object under the old key.
      entry = { ...entry, id: standaloneProxyId(entry) };

      const originalKey = originalProxy ? proxyAddressKeys(originalProxy)[0] : proxyAddressKeys(entry)[0];
      const entryKey = proxyAddressKeys(entry)[0];

      // Only drop the proxy actually being edited (by its original id) — a standalone sibling
      // coexisting on the same port via a distinct host (#139) must stay in the timeout-sync
      // input, or its own settings would be silently dropped.
      const afterProxies = [...proxies.filter(p => p.id !== originalProxy?.id), entry];
      await ensureConfDImported(); // before the read: may migrate a stock Caddyfile (#256)
      const current = await readProxyConf();

      const written = surgicallyEditProxy(current, originalProxy, entry);
      // Timeouts and conf.d are saved as one change: throws CaddyfileError, leaving both as they were.
      await saveSiteConfig(afterProxies, written);
      noteConfSites(written);

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
      setConfTlsIssuer(prev => withIssuer(prev, originalKey, entryKey, entry));
      setConfTlsOnDemand(prev => withOnDemand(prev, originalKey, entryKey, entry));
      setConfTlsDns(prev => withDns(prev, originalKey, entryKey, entry));
      setConfExternal(prev => {
        const n = { ...prev };
        delete n[originalKey];
        n[entryKey] = { scheme: entry.externalScheme, host: entry.externalHost };
        return n;
      });
      // See addProxy: a hand-built single-route JSON push can't represent a listener
      // shared by multiple hosts (#139), nor a php_fastcgi route's four-route Caddyfile
      // macro expansion (#35) — reload instead so Caddy's own Caddyfile adapter builds it.
      // patchServer leaves a live route's matchers as they were, so a matcher change (e.g.
      // client_ip ↔ remote_ip, #286) goes through Caddy's adapter as well.
      const matchersChanged = JSON.stringify(originalProxy?.matchers ?? null) !== JSON.stringify(entry.matchers ?? null);
      if (sharesPortWithOtherHost(afterProxies, entry) || needsCaddyfileReload(entry) || matchersChanged) {
        await reloadCaddy(); // refetches the config (onConfigChanged)
        return;
      }
      await apply(mergeProxy(config, entry));
    },
    [config, proxies, servers, apply, noteConfSites],
  );

  const deleteProxy = useCallback(
    async (proxyId: string) => {
      const proxy = proxies.find(p => p.id === proxyId);
      if (!proxy) return;
      await ensureConfDImported(); // may migrate a stock Caddyfile first (#256)

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
          await apply(mergeNamedServer(config, updatedDef, renumbered));
          const newDefs = servers.map(s => s.key === def.key ? updatedDef : s);
          lastServersMutationAt.current = Date.now();
          setServers(newDefs);
        } else {
          // Last route removed: remove from conf.d and state
          await writeRawProxyConf(surgicallyRemoveServerBlock(current, proxy.namedServerKey));
          await apply(removeNamedServer(config, proxy.namedServerKey));
          lastServersMutationAt.current = Date.now();
          setServers(servers.filter(s => s.key !== proxy.namedServerKey));
        }
        return;
      }

      // Standalone route
      const remainingProxies = proxies.filter(p => p.id !== proxy.id);
      const current = await readProxyConf();
      const written = surgicallyRemoveBlock(current, proxy.externalPort, routeHosts(proxy)?.join(", "));
      await saveSiteConfig(remainingProxies, written);
      noteConfSites(written);
      const proxyKey = proxyAddressKeys(proxy)[0];
      setLabels(prev => { const n = { ...prev }; delete n[proxyKey]; return n; });
      setConfTls(prev => { const n = { ...prev }; delete n[proxyKey]; return n; });
      setConfExternal(prev => { const n = { ...prev }; delete n[proxyKey]; return n; });
      setConfTlsDns(prev => { const n = { ...prev }; delete n[proxyKey]; return n; });
      // #289: the site's own DNS credentials leave the env file with it.
      const siteVars = Object.values(proxy.dnsChallenge?.credentials ?? {}).filter(isSiteDnsVar);
      if (siteVars.length) await applyDnsSecrets({}, siteVars);
      // A shared listener's live JSON server object holds every sibling's route (#139) —
      // removing it by serverKey would delete a still-live sibling too. Reload instead so
      // Caddy's own Caddyfile adapter rebuilds the listener from the (now-correct) text.
      if (sharesPortWithOtherHost(proxies, proxy)) {
        await reloadCaddy(); // refetches the config (onConfigChanged)
        return;
      }
      await apply(removeProxy(config, proxy.serverKey));
    },
    [config, proxies, servers, apply, noteConfSites],
  );

  const addServer = useCallback(
    async (def: ServerDef) => {
      checkServerPortConflicts(def, proxies, null);
      // Every hostless proxy/server must carry the identical internal-cert lifetime, or
      // Caddy refuses to reload — see applyGlobalInternalLifetimeToServer.
      if (def.tls) {
        const globalOpts = await readGlobalOptions();
        def = { ...def, tlsAdvanced: applyGlobalInternalLifetimeToServer(def, globalOpts.internalCertLifetime) };
      }
      await ensureConfDImported();
      await ensureConfDDir();
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
      if (def.tls) {
        const globalOpts = await readGlobalOptions();
        def = { ...def, tlsAdvanced: applyGlobalInternalLifetimeToServer(def, globalOpts.internalCertLifetime) };
      }
      const routes = proxies.filter(p => p.namedServerKey === def.key);
      await ensureConfDImported();
      const current = await readProxyConf();
      await writeRawProxyConfValidated(surgicallyWriteServerBlock(current, def, routes));
      if (routes.length > 0) {
        await apply(mergeNamedServer(config, def, routes));
      }
      lastServersMutationAt.current = Date.now();
      setServers(servers.map(s => s.key === def.key ? def : s));
    },
    [config, proxies, servers, apply],
  );

  const deleteServer = useCallback(
    async (key: string) => {
      await ensureConfDImported();
      const current = await readProxyConf();
      await writeRawProxyConf(surgicallyRemoveServerBlock(current, key));
      await apply(removeNamedServer(config, key));
      lastServersMutationAt.current = Date.now();
      setServers(servers.filter(s => s.key !== key));
    },
    [config, servers, apply],
  );

  const migrate = useCallback(async () => {
    // Merge with whatever conf.d already manages — migration must be additive,
    // not destructive, when the user already has proxies set up there. The
    // existing conf.d content is kept verbatim (see mergeMigratedConfContent)
    // so its `# label:`/`# server:`/`# serverdef:` comments survive.
    // Only site blocks move (#267): the global options, snippets, other imports and an
    // existing conf.d import stay in the main Caddyfile as the user wrote them.
    const { blocks: newBlocks, caddyfile: newCaddyfile } = migrateCaddyfile(caddyfileContent);
    const existingConfD = await readProxyConf();
    const content = mergeMigratedConfContent(existingConfD, newBlocks);

    await writeFile(CADDYFILE_BAK, caddyfileContent);
    await ensureConfDDir();
    await writeRawProxyConf(content);
    await writeCaddyfile(newCaddyfile);
    await reloadCaddy();

    await delay(500);

    // Existing conf.d entries (labels, TLS) are untouched by the merge — only
    // layer in the newly migrated blocks on top of what's already tracked.
    const newConfTlsMap = parseConfTlsMap(content);
    const newLabels: Record<string, string> = { ...labels };
    const newConfTls: Record<string, boolean> = { ...confTls };
    for (const b of newBlocks) {
      if (b.label) newLabels[b.address] = b.label;
      newConfTls[b.address] = newConfTlsMap[b.address] ?? false;
    }
    setLabels(newLabels);
    setConfTls(newConfTls);
    setCaddyfileContent(newCaddyfile);
    await refresh();
  }, [caddyfileContent, labels, confTls, refresh]);

  return {
    snippets,
    proxies, servers, loading, error, refresh,
    addProxy, editProxy, deleteProxy,
    addServer, editServer, deleteServer,
    needsMigration, migrate,
  };
}
