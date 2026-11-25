// Adding, editing and removing a site: what goes into conf.d, and how the running Caddy learns of it.
//
// The functions here do the disk work (through caddy.ts, so a rejected config leaves every file as it
// was) and decide how Caddy is updated, but they own no UI state: they return what changed and the
// caller (useProxies) applies it to its lists and then to the live Caddy with `liveChangeFor`.
import { i18n } from "@rxtx4816/cockpit-plugin-base-react/i18n";
import {
  CaddyfileError, ensureConfDDir, ensureConfDImported, hostsConflict, mergeNamedServer, mergeProxy,
  applyGlobalInternalLifetimeToProxy, proxyAddressKeys, readGlobalOptions, readProxyConf, removeNamedServer,
  removeProxy, routeHosts, saveSiteConfig, standaloneProxyId, surgicallyEditProxy, surgicallyRemoveBlock,
  surgicallyRemoveServerBlock, surgicallyWriteProxy, surgicallyWriteServerBlock, writeRawProxyConf,
  writeRawProxyConfValidated,
} from "./caddy";
import { applyDnsSecrets, isSiteDnsVar } from "./dnsChallenge";
import { findBlockPositions, findMatchingBlock } from "./caddyfileDocument";
import type { CaddyConfig, DnsChallengeConfig, ProxyEntry, ServerDef } from "./types";
import type { AcmeAccount } from "./caddyJsonModel";

/** What an edit needs to know about the current state: the live config, the sites and the named servers. */
export interface SiteEditContext {
  config: CaddyConfig;
  proxies: ProxyEntry[];
  servers: ServerDef[];
  /** The Caddyfile's global ACME account (#341), when it was read. */
  acmeAccount?: AcmeAccount;
}

/** How the running Caddy is brought up to date: a reload from the Caddyfile, or a JSON push. */
export type LiveChange = { kind: "reload" } | { kind: "push"; config: CaddyConfig };

export interface SiteEditResult {
  live: LiveChange;
  /** The new named-server list, when a named server (or its route labels) changed. */
  servers?: ServerDef[];
  /** The conf.d content a standalone site was saved into. */
  written?: string;
  /** The standalone site as saved, with the address keys the conf.d lookup maps use. */
  site?: { entry: ProxyEntry; key: string; originalKey?: string };
  /** The address key of a removed standalone site. */
  removedKey?: string;
}

/** A site whose TLS automation only Caddy's Caddyfile adapter builds correctly: automatic
 *  HTTPS (#246) or on-demand TLS (#253). */
export function reliesOnCaddyfileTls(p: ProxyEntry): boolean {
  return p.tls && !p.customTls && (p.tlsIssuer === "acme" || !!p.tlsOnDemand);
}

/**
 * Sites whose JSON only Caddy's own Caddyfile adapter builds correctly, so they are applied
 * by reloading instead of pushing hand-built JSON: php_fastcgi (#35) expands into several
 * routes, automatic HTTPS (#246) and on-demand TLS (#253) need automation policies that
 * the JSON push doesn't build, and snippet imports (#288) are only in the Caddyfile.
 */
export function needsCaddyfileReload(p: ProxyEntry): boolean {
  // Snippet imports (#288) only exist in the Caddyfile; hand-built JSON would drop what they add.
  // A client_ip matcher (#286) needs the server's trusted_proxies, which the global options set
  // and only Caddy's adapter puts on the server; the hand-built JSON server has none.
  return !!p.phpFastcgi || reliesOnCaddyfileTls(p) || !!p.imports?.length
    || !!p.matchers?.client_ip?.ranges.length || !!p.matchers?.not?.client_ip?.ranges.length;
}

/**
 * True when `entry`'s port is also claimed by another standalone proxy in `proxies`
 * with a distinct, non-conflicting host (#139) — i.e. two+ sites legitimately sharing
 * one Caddy listener by Host/SNI. The fast JSON push builds exactly one route per port, so
 * only Caddy's own Caddyfile adapter (a reload) can represent the shared listener.
 */
export function sharesPortWithOtherHost(
  proxies: ProxyEntry[],
  entry: Pick<ProxyEntry, "id" | "externalPort" | "externalHost" | "matchers">,
): boolean {
  return proxies.some(p =>
    p.id !== entry.id && !p.namedServerKey && p.externalPort === entry.externalPort &&
    !hostsConflict(routeHosts(p), routeHosts(entry))
  );
}

/** Reload when any listed site needs Caddy's own TLS automation, otherwise push `next`. */
export function liveChangeFor(proxies: ProxyEntry[], next: CaddyConfig): LiveChange {
  return proxies.some(reliesOnCaddyfileTls) ? { kind: "reload" } : { kind: "push", config: next };
}

/** Throws CaddyfileError if any of def's listen ports conflict with existing proxies.
 *  Pass `ownKey` (= def.key) when editing so the server's own existing routes are excluded. */
export function checkServerPortConflicts(def: ServerDef, proxies: ProxyEntry[], ownKey: string | null): void {
  for (const addr of def.listenAddresses) {
    const m = addr.match(/:(\d+)$/);
    if (!m) continue;
    const port = parseInt(m[1], 10);
    if (proxies.some(p => p.externalPort === port && !p.namedServerKey)) {
      throw new CaddyfileError(i18n.t("errors.port_used_by_standalone", { port }));
    }
    const otherServer = proxies.find(p => p.externalPort === port && p.namedServerKey && p.namedServerKey !== ownKey);
    if (otherServer) {
      throw new CaddyfileError(i18n.t("errors.port_used_by_server", { port, server: otherServer.namedServerKey }));
    }
  }
}

/** The conf.d issuer map after writing `p` under `key` (dropping `oldKey`), before the next poll. */
export function withIssuer(
  map: Record<string, "acme" | "internal">, oldKey: string | undefined, key: string, p: ProxyEntry,
): Record<string, "acme" | "internal"> {
  const n = { ...map };
  if (oldKey) delete n[oldKey];
  if (p.tls && !p.customTls) n[key] = p.tlsIssuer ?? "internal";
  else delete n[key];
  return n;
}

/** The conf.d on-demand map after writing `p` under `key` (dropping `oldKey`), before the next poll. */
export function withOnDemand(map: Record<string, boolean>, oldKey: string | undefined, key: string, p: ProxyEntry): Record<string, boolean> {
  const n = { ...map };
  if (oldKey) delete n[oldKey];
  if (p.tls && !p.customTls && p.tlsOnDemand) n[key] = true;
  else delete n[key];
  return n;
}

/** The conf.d per-site DNS map (#289) after writing `p` under `key` (dropping `oldKey`). */
export function withDns(map: Record<string, DnsChallengeConfig>, oldKey: string | undefined, key: string, p: ProxyEntry): Record<string, DnsChallengeConfig> {
  const n = { ...map };
  if (oldKey) delete n[oldKey];
  if (p.tls && !p.customTls && p.tlsIssuer === "acme" && p.dnsChallenge) n[key] = p.dnsChallenge;
  else delete n[key];
  return n;
}

function findNamedServer(servers: ServerDef[], key: string): ServerDef {
  const def = servers.find(s => s.key === key);
  if (!def) throw new Error(`Named server '${key}' not found`);
  return def;
}

export async function addSite(ctx: SiteEditContext, entry: Omit<ProxyEntry, "id" | "serverKey">): Promise<SiteEditResult> {
  const { config, proxies, servers } = ctx;
  if (entry.namedServerKey) {
    const def = findNamedServer(servers, entry.namedServerKey);
    const existingRoutes = proxies.filter(p => p.namedServerKey === entry.namedServerKey);
    const newProxy: ProxyEntry = {
      ...entry,
      id: `${entry.namedServerKey}:${existingRoutes.length}`,
      serverKey: entry.namedServerKey,
    };
    const updatedDef = newProxy.label
      ? { ...def, routeLabels: { ...def.routeLabels, [newProxy.id]: newProxy.label } }
      : def;
    const allRoutes = [...existingRoutes, newProxy];
    await ensureConfDImported();
    await ensureConfDDir();
    const current = await readProxyConf();
    await writeRawProxyConfValidated(surgicallyWriteServerBlock(current, updatedDef, allRoutes));
    return {
      live: liveChangeFor(proxies, mergeNamedServer(config, updatedDef, allRoutes)),
      servers: servers.map(s => s.key === def.key ? updatedDef : s),
    };
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
  const site = { entry: newProxy, key: proxyAddressKeys(newProxy)[0] };
  // A hand-built single-route JSON push can't represent a listener shared by multiple hosts (#139),
  // nor a php_fastcgi route's four-route macro expansion (#35): reload from the Caddyfile instead.
  if (sharesPortWithOtherHost(afterProxies, newProxy) || needsCaddyfileReload(newProxy)) {
    return { live: { kind: "reload" }, written, site };
  }
  return { live: liveChangeFor(proxies, mergeProxy(config, newProxy, ctx.acmeAccount)), written, site };
}

export async function editSite(ctx: SiteEditContext, entry: ProxyEntry): Promise<SiteEditResult> {
  const { config, proxies, servers } = ctx;
  if (entry.namedServerKey) {
    const def = findNamedServer(servers, entry.namedServerKey);
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
    return {
      live: liveChangeFor(proxies, mergeNamedServer(config, updatedDef, allRoutes)),
      servers: servers.map(s => s.key === def.key ? updatedDef : s),
    };
  }

  // Every hostless proxy/server must carry the identical internal-cert lifetime, or
  // Caddy refuses to reload — see applyGlobalInternalLifetimeToProxy.
  if (entry.tls) {
    const globalOpts = await readGlobalOptions();
    entry = { ...entry, tlsAdvanced: applyGlobalInternalLifetimeToProxy(entry, globalOpts.internalCertLifetime) };
  }

  // entry.id still holds the *original* id at this point — EditProxyDialog deliberately
  // doesn't recompute it — so this always finds the exact proxy being edited, even when
  // sibling proxies share a port with different hosts (#139).
  const originalProxy = proxies.find(p => p.id === entry.id);

  // Recompute id for the post-edit host/port now that the original has been located.
  // serverKey is deliberately left untouched: mergeProxy indexes the live JSON server by
  // serverKey, and keeping it stable moves the *same* server object to its new listen
  // address in place instead of leaving an orphan under the old key.
  entry = { ...entry, id: standaloneProxyId(entry) };

  const originalKey = originalProxy ? proxyAddressKeys(originalProxy)[0] : proxyAddressKeys(entry)[0];
  const key = proxyAddressKeys(entry)[0];

  // Only drop the proxy actually being edited (by its original id) — a standalone sibling
  // coexisting on the same port via a distinct host (#139) must stay in the timeout-sync input.
  const afterProxies = [...proxies.filter(p => p.id !== originalProxy?.id), entry];
  await ensureConfDImported(); // before the read: may migrate a stock Caddyfile (#256)
  const current = await readProxyConf();
  const written = surgicallyEditProxy(current, originalProxy, entry);
  // Timeouts and conf.d are saved as one change: throws CaddyfileError, leaving both as they were.
  await saveSiteConfig(afterProxies, written);
  const site = { entry, key, originalKey };

  // See addSite. patchServer also leaves a live route's matchers as they were, so a matcher
  // change (e.g. client_ip <-> remote_ip, #286) goes through Caddy's adapter as well.
  const matchersChanged = JSON.stringify(originalProxy?.matchers ?? null) !== JSON.stringify(entry.matchers ?? null);
  if (sharesPortWithOtherHost(afterProxies, entry) || needsCaddyfileReload(entry) || matchersChanged) {
    return { live: { kind: "reload" }, written, site };
  }
  return { live: liveChangeFor(proxies, mergeProxy(config, entry, ctx.acmeAccount)), written, site };
}

/**
 * Writes a new text for a site's block (#350), the one the Tree tab edited. The block is found by
 * the hosts the site answers on, as surgicallyEditProxy finds it, and replaced as it is, so what the
 * form owns (label, header comments around it) and every other site stay as they were. `expected`
 * is the text the edit started from: when the block on disk is no longer that, someone changed it
 * meanwhile and nothing is written. The config is checked before it is kept: throws CaddyfileError,
 * leaving the file as it was, when Caddy would not take it.
 */
export async function replaceSiteText(proxy: ProxyEntry, newText: string, expected: string): Promise<SiteEditResult> {
  await ensureConfDImported();
  const current = await readProxyConf();
  const lines = current.split("\n");
  const pos = findMatchingBlock(findBlockPositions(lines), proxy.externalPort, routeHosts(proxy)?.join(", "));
  if (!pos) throw new CaddyfileError(i18n.t("tree.block_not_found"));
  if (lines.slice(pos.headerLine, pos.closingLine + 1).join("\n") !== expected) throw new CaddyfileError(i18n.t("tree.changed_meanwhile"));
  const written = [...lines.slice(0, pos.headerLine), newText, ...lines.slice(pos.closingLine + 1)].join("\n");
  await writeRawProxyConfValidated(written);
  return { live: { kind: "reload" }, written };
}

/** Removes a site; resolves to `undefined` when there is no such site. */
export async function removeSite(ctx: SiteEditContext, proxyId: string): Promise<SiteEditResult | undefined> {
  const { config, proxies, servers } = ctx;
  const proxy = proxies.find(p => p.id === proxyId);
  if (!proxy) return undefined;
  await ensureConfDImported(); // may migrate a stock Caddyfile first (#256)

  if (proxy.namedServerKey) {
    const def = servers.find(s => s.key === proxy.namedServerKey);
    if (!def) return undefined;
    const remainingRoutes = proxies.filter(p => p.namedServerKey === proxy.namedServerKey && p.id !== proxy.id);

    // Renumber remaining routes contiguously and remap labels to new IDs
    const renumbered = remainingRoutes.map((r, i) => ({ ...r, id: `${proxy.namedServerKey}:${i}` }));
    const newRouteLabels: Record<string, string> = {};
    remainingRoutes.forEach((r, i) => {
      const lbl = def.routeLabels?.[r.id];
      if (lbl) newRouteLabels[`${proxy.namedServerKey}:${i}`] = lbl;
    });
    const updatedDef = { ...def, routeLabels: newRouteLabels };

    const current = await readProxyConf();
    if (renumbered.length > 0) {
      await writeRawProxyConfValidated(surgicallyWriteServerBlock(current, updatedDef, renumbered));
      return {
        live: liveChangeFor(proxies, mergeNamedServer(config, updatedDef, renumbered)),
        servers: servers.map(s => s.key === def.key ? updatedDef : s),
      };
    }
    // Last route removed: the server goes with it.
    await writeRawProxyConf(surgicallyRemoveServerBlock(current, proxy.namedServerKey));
    return {
      live: liveChangeFor(proxies, removeNamedServer(config, proxy.namedServerKey)),
      servers: servers.filter(s => s.key !== proxy.namedServerKey),
    };
  }

  // Standalone route
  const remainingProxies = proxies.filter(p => p.id !== proxy.id);
  const current = await readProxyConf();
  const written = surgicallyRemoveBlock(current, proxy.externalPort, routeHosts(proxy)?.join(", "));
  await saveSiteConfig(remainingProxies, written);
  // #289: the site's own DNS credentials leave the env file with it.
  const siteVars = Object.values(proxy.dnsChallenge?.credentials ?? {}).filter(isSiteDnsVar);
  if (siteVars.length) await applyDnsSecrets({}, siteVars);
  const removedKey = proxyAddressKeys(proxy)[0];
  // A shared listener's live JSON server object holds every sibling's route (#139) — removing it
  // by serverKey would delete a still-live sibling too. Reload instead.
  if (sharesPortWithOtherHost(proxies, proxy)) return { live: { kind: "reload" }, written, removedKey };
  return { live: liveChangeFor(proxies, removeProxy(config, proxy.serverKey)), written, removedKey };
}
