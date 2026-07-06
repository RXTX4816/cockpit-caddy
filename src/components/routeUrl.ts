import { buildUrl } from "@rxtx4816/cockpit-plugin-base-react/lib/uri";
import type { ProxyEntry } from "../api";

/**
 * Resolves the public hostname a route actually answers on: its Host matcher
 * (the most authoritative "this is the public subdomain") takes priority over
 * externalHost (the bind address, set whenever a subdomain is typed into
 * Add/Edit Proxy), falling back to the browser's own hostname — e.g. when
 * Cockpit is viewed over an SSH port-forward, `window.location.hostname` is
 * `localhost` and would otherwise silently override a configured subdomain.
 */
export function resolveRouteHost(proxy: Pick<ProxyEntry, "externalHost" | "matchers">): string {
  return proxy.matchers?.host?.[0] || proxy.externalHost || window.location.hostname;
}

/**
 * Builds the clickable URL for a route's external port, including the first
 * path matcher (if any) so links reflect where the route actually answers
 * rather than always pointing at the server root.
 */
export function buildRouteUrl(proto: string, port: number | string, proxy: ProxyEntry): string {
  const firstPath = proxy.matchers?.path?.[0];
  // Strip trailing wildcard: /api/* → /api/  (the prefix the browser navigates to)
  const clean = firstPath ? firstPath.replace(/\/\*$/, "/").replace(/\*$/, "") : "/";
  const path = clean.startsWith("/") ? clean : "/" + clean;
  return buildUrl({ scheme: proto, host: resolveRouteHost(proxy), port: Number(port), path });
}
