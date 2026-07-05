import { buildUrl } from "@rxtx4816/cockpit-plugin-base-react/lib/uri";
import type { ProxyEntry } from "../api";

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
  return buildUrl({ scheme: proto, host: window.location.hostname, port: Number(port), path });
}
