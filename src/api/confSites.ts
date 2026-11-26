// The sites as the plugin shows them: the running config's JSON, with what only the Caddyfile
// in conf.d holds layered over it. useProxies builds its list with it, and so does every write
// that rewrites site blocks from the running config, so nothing the JSON lacks is lost there.
import type { AccessLogConfig, CaddyConfig, DnsChallengeConfig, ForwardAuthConfig, ProxyEntry, ServerDef } from "./types";
import { parseProxies, type AcmeAccount } from "./caddyJsonModel";
import {
  parseLabelsFromCaddyfile, parseConfTlsMap, parseConfExternalAddresses, parseConfAccessLogMap, parseConfForwardAuthMap,
  parseConfCustomTlsCaMap, parseConfTlsIssuerMap, parseConfTlsOnDemandMap, parseConfTlsDnsMap,
} from "./caddyfileDocument";
import { parseClientAuthCaFile, proxyAddressKeys, resolveInternalIssuerSettings } from "./caddy";
import { parseConfSiteBlocks, parseConfSiteImports, separateSnippetSettings, type SnippetDef } from "./snippets";

/** What conf.d says about each site, by its address key. */
export interface ConfSiteMaps {
  labels: Record<string, string>;
  tls: Record<string, boolean>;
  external: Record<string, { scheme?: string; host?: string }>;
  accessLog: Record<string, AccessLogConfig>;
  forwardAuth: Record<string, ForwardAuthConfig>;
  customTlsCa: Record<string, string>;
  tlsIssuer: Record<string, "acme" | "internal">;
  tlsOnDemand: Record<string, boolean>;
  tlsDns: Record<string, DnsChallengeConfig>;
  siteBlocks: Record<string, string>;
  imports: Record<string, string[]>;
}

export function confSiteMaps(content: string): ConfSiteMaps {
  return {
    labels: parseLabelsFromCaddyfile(content),
    tls: parseConfTlsMap(content),
    external: parseConfExternalAddresses(content),
    accessLog: parseConfAccessLogMap(content),
    forwardAuth: parseConfForwardAuthMap(content),
    customTlsCa: parseConfCustomTlsCaMap(content),
    tlsIssuer: parseConfTlsIssuerMap(content),
    tlsOnDemand: parseConfTlsOnDemandMap(content),
    tlsDns: parseConfTlsDnsMap(content),
    siteBlocks: parseConfSiteBlocks(content),
    imports: parseConfSiteImports(content),
  };
}

/** The running config's sites with conf.d layered over them, as the plugin shows and saves them. */
export function confSites(
  config: CaddyConfig | null, servers: ServerDef[], maps: ConfSiteMaps, snippets: SnippetDef[], acmeAccount?: AcmeAccount,
): ProxyEntry[] {
  return parseProxies(config ?? {}, servers, acmeAccount).map(p => {
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
    const tls = p.tls || (lookup(maps.tls) ?? false);
    const externalHost = p.externalHost ?? lookup(maps.external)?.host;
    // parseProxies resolves tlsAdvanced.certLifetime/renewalWindowRatio using whatever
    // host it could see in the live JSON route (often none — a server that's the sole
    // occupant of its port has no host matcher at all, since there's nothing else on
    // that listener to disambiguate). externalHost above may have just been recovered
    // from the conf.d fallback instead, so re-resolve with the corrected host and layer
    // it over the already-parsed tlsAdvanced (which still has protocol/cipher/curves).
    const resolved = tls && config ? resolveInternalIssuerSettings(config, externalHost) : {};
    const tlsAdvanced = (p.tlsAdvanced || resolved.certLifetime !== undefined || resolved.renewalWindowRatio !== undefined)
      ? {
          ...p.tlsAdvanced,
          ...(resolved.certLifetime !== undefined ? { certLifetime: resolved.certLifetime } : {}),
          ...(resolved.renewalWindowRatio !== undefined ? { renewalWindowRatio: resolved.renewalWindowRatio } : {}),
        }
      : undefined;
    return separateSnippetSettings({
      ...p,
      imports: lookup(maps.imports),
      // The Tree tab (#333) and the badge for nested blocks (#348) read the site's own text.
      siteText: lookup(maps.siteBlocks),
      label: lookup(maps.labels),
      tls,
      externalScheme: p.externalScheme ?? lookup(maps.external)?.scheme,
      externalHost,
      tlsAdvanced,
      // Fallback: if the JSON API config doesn't have server.logs (was last pushed by
      // older code), read access log config from the Caddyfile conf.d directly.
      accessLog: p.accessLog ?? lookup(maps.accessLog),
      // Fallback: read forward_auth config from conf.d when JSON detection is insufficient.
      forwardAuth: p.forwardAuth ?? lookup(maps.forwardAuth),
      // The CA bundle path (#152) isn't part of Caddy's own JSON model at all — it only
      // ever lives in the Caddyfile comment, so always layer it in from there.
      customTls: p.customTls ? { ...p.customTls, caFile: lookup(maps.customTlsCa) } : undefined,
      // The deprecated trusted_ca_cert_file reaches the JSON as an inlined certificate (#255),
      // so its path is read from the site block.
      mtls: p.mtls && !p.mtls.trustedCaFile
        ? { ...p.mtls, trustedCaFile: parseClientAuthCaFile(lookup(maps.siteBlocks) ?? "") }
        : p.mtls,
      // Automatic HTTPS vs the internal CA (#246) is only visible in the Caddyfile text.
      tlsIssuer: tls && !p.customTls ? lookup(maps.tlsIssuer) : undefined,
      // Per-site on-demand TLS (#253), likewise read from the Caddyfile.
      tlsOnDemand: tls && !p.customTls && lookup(maps.tlsOnDemand) ? true : undefined,
      // The site's own DNS provider (#289), for automatic HTTPS only.
      dnsChallenge: tls && !p.customTls && lookup(maps.tlsIssuer) === "acme" ? lookup(maps.tlsDns) : undefined,
    }, lookup(maps.siteBlocks), snippets);
  });
}
