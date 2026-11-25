import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useAutoRefresh } from "@rxtx4816/cockpit-plugin-base-react";
import {
  parseProxies, readCaddyfile, writeCaddyfile, readProxyConf,
  parseLabelsFromCaddyfile, parseConfTlsMap, parseConfExternalAddresses, parseConfAccessLogMap, parseConfForwardAuthMap, parseConfCustomTlsCaMap, parseClientAuthCaFile, parseConfTlsIssuerMap, parseConfTlsOnDemandMap, parseConfTlsDnsMap, migrateCaddyfile, isStockCaddyfile, mergeMigratedConfContent, writeRawProxyConf, writeRawProxyConfValidated,
  writeFile, reloadCaddy, ensureConfDDir,
  removeLegacyServerDefsFile, parseServerDefsFromConf,
  surgicallyWriteServerBlock, surgicallyRemoveServerBlock,
  mergeNamedServer, removeNamedServer,
  deduplicateServerBlocks, normalizeManagedHeader, proxyAddressKeys,
  ensureConfDImported,
  resolveInternalIssuerSettings, readGlobalOptions,
  applyGlobalInternalLifetimeToServer,
  readSnippetsConf, parseSnippets, parseConfSiteBlocks, parseConfSiteImports, separateSnippetSettings, mergeSnippetLists,
  parseGlobalOptions,
} from "../api";
import { acmeAccountOf } from "../api/caddyJsonModel";
import type { CaddyConfig, DnsChallengeConfig, ProxyEntry, ServerDef, SnippetDef } from "../api";
import {
  addSite, editSite, replaceSiteText, removeSite, liveChangeFor, checkServerPortConflicts, withIssuer, withOnDemand, withDns,
  type SiteEditResult,
} from "../api/siteEditing";
import { useCaddyConfig } from "./useCaddyConfig";

const CADDYFILE_BAK = "/etc/caddy/Caddyfile.bak";

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
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
  /** Whether caddyfileContent was read, so an empty one means an empty Caddyfile. */
  const [caddyfileRead, setCaddyfileRead] = useState(false);
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
    void readCaddyfile().then(c => { setCaddyfileContent(c ?? ""); setCaddyfileRead(true); }).catch(() => {});
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

  // The global ACME account (#341): the JSON only shows it when some site shares the global policy.
  const acmeAccount = useMemo(
    () => caddyfileRead ? acmeAccountOf(parseGlobalOptions(caddyfileContent)) : undefined,
    [caddyfileRead, caddyfileContent],
  );

  const proxies = useMemo(
    () => (!serversLoaded ? [] : parseProxies(config, servers, acmeAccount)).map(p => {
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
        // The Tree tab (#333) and the badge for nested blocks (#348) read the site's own text.
        siteText: lookup(confSiteBlocks),
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
    [config, labels, confTls, confExternal, confAccessLog, confForwardAuth, confCustomTlsCa, confTlsIssuer, confTlsOnDemand, confTlsDns, confSiteBlocks, confImports, snippets, servers, serversLoaded, acmeAccount],
  );

  // #246: while any site relies on automatic HTTPS, Caddy's own Caddyfile adapter has to build
  // the TLS automation. The hand-built JSON only knows the internal issuer, and its catch-all
  // policy would take over the ACME sites' public names, so reload from the Caddyfile instead.
  const apply = useCallback(async (next: CaddyConfig) => {
    const live = liveChangeFor(proxies, next);
    if (live.kind === "reload") await reloadCaddy(); // refetches the config (onConfigChanged)
    else await update(live.config);
  }, [proxies, update]);

  /** Brings the running Caddy up to date, and puts what changed into the lists the page shows. */
  const finish = useCallback(async (result: SiteEditResult) => {
    if (result.servers) {
      lastServersMutationAt.current = Date.now();
      setServers(result.servers);
    }
    if (result.written !== undefined) noteConfSites(result.written);
    if (result.live.kind === "reload") await reloadCaddy(); // refetches the config (onConfigChanged)
    else await update(result.live.config);
  }, [noteConfSites, update]);

  const addProxy = useCallback(
    async (entry: Omit<ProxyEntry, "id" | "serverKey">) => {
      const result = await addSite({ config, proxies, servers, acmeAccount }, entry);
      const site = result.site;
      if (site) {
        const { entry: saved, key } = site;
        setLabels(prev => {
          const n = { ...prev };
          if (saved.label) n[key] = saved.label;
          else delete n[key];
          return n;
        });
        setConfTls(prev => ({ ...prev, [key]: saved.tls }));
        setConfTlsIssuer(prev => withIssuer(prev, undefined, key, saved));
        setConfTlsOnDemand(prev => withOnDemand(prev, undefined, key, saved));
        setConfTlsDns(prev => withDns(prev, undefined, key, saved));
        setConfExternal(prev => ({ ...prev, [key]: { scheme: saved.externalScheme, host: saved.externalHost } }));
      }
      await finish(result);
    },
    [config, proxies, servers, acmeAccount, finish],
  );

  const editProxy = useCallback(
    async (entry: ProxyEntry) => {
      const result = await editSite({ config, proxies, servers, acmeAccount }, entry);
      const site = result.site;
      if (site) {
        const { entry: saved, key, originalKey } = site;
        setLabels(prev => {
          const n = { ...prev };
          if (originalKey) delete n[originalKey];
          if (saved.label) n[key] = saved.label;
          else delete n[key];
          return n;
        });
        setConfTls(prev => {
          const n = { ...prev };
          if (originalKey) delete n[originalKey];
          n[key] = saved.tls;
          return n;
        });
        setConfTlsIssuer(prev => withIssuer(prev, originalKey, key, saved));
        setConfTlsOnDemand(prev => withOnDemand(prev, originalKey, key, saved));
        setConfTlsDns(prev => withDns(prev, originalKey, key, saved));
        setConfExternal(prev => {
          const n = { ...prev };
          if (originalKey) delete n[originalKey];
          n[key] = { scheme: saved.externalScheme, host: saved.externalHost };
          return n;
        });
      }
      await finish(result);
    },
    [config, proxies, servers, acmeAccount, finish],
  );

  /** Saves the text the Tree tab made for a site's block (#350). */
  const saveSiteText = useCallback(
    async (proxy: ProxyEntry, text: string) => {
      await finish(await replaceSiteText(proxy, text));
    },
    [finish],
  );

  const deleteProxy = useCallback(
    async (proxyId: string) => {
      const result = await removeSite({ config, proxies, servers, acmeAccount }, proxyId);
      if (!result) return;
      const key = result.removedKey;
      if (key) {
        setLabels(prev => { const n = { ...prev }; delete n[key]; return n; });
        setConfTls(prev => { const n = { ...prev }; delete n[key]; return n; });
        setConfExternal(prev => { const n = { ...prev }; delete n[key]; return n; });
        setConfTlsDns(prev => { const n = { ...prev }; delete n[key]; return n; });
      }
      await finish(result);
    },
    [config, proxies, servers, acmeAccount, finish],
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
    addProxy, editProxy, saveSiteText, deleteProxy,
    addServer, editServer, deleteServer,
    needsMigration, migrate,
  };
}
