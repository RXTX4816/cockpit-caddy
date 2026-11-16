/**
 * A proxy's external host (#208) can name several hostnames, e.g. `example.com` and
 * `www.example.com`, the same way a Caddyfile site block lists several addresses
 * (`example.com, www.example.com {`). ProxyEntry.externalHost keeps them as one string,
 * the names joined by ", ", so a single-host proxy looks and round-trips exactly as it
 * did before. These helpers are the only place that knows about the separator.
 */

import type { ProxyEntry } from "./types";

/** The individual hostnames in an externalHost value; empty when hostless. */
export function externalHostList(externalHost: string | undefined): string[] {
  if (!externalHost) return [];
  return externalHost.split(",").map(h => h.trim()).filter(Boolean);
}

/** Canonical form of a typed host value: names trimmed and joined by ", ", or undefined when empty. */
export function normalizeExternalHost(value: string): string | undefined {
  const hosts = externalHostList(value);
  return hosts.length ? hosts.join(", ") : undefined;
}

export type ExternalHostError =
  | { kind: "empty_entry" }
  | { kind: "space"; host: string }
  | { kind: "scheme_or_port"; host: string }
  | { kind: "duplicate"; host: string };

/**
 * Checks the host field of the proxy dialogs. Protocol and port have their own fields
 * and apply to every name, so an entry carrying its own scheme or port is rejected
 * rather than guessed at. IPv6 literals are only accepted in brackets (`[::1]`), the
 * form Caddy's site addresses use.
 */
export function validateExternalHost(value: string): ExternalHostError | undefined {
  if (!value.trim()) return undefined;
  const entries = value.split(",").map(h => h.trim());
  const seen = new Set<string>();
  for (const host of entries) {
    if (!host) return { kind: "empty_entry" };
    if (/\s/.test(host)) return { kind: "space", host };
    const withoutBrackets = host.startsWith("[") && host.endsWith("]") ? "" : host;
    if (host.includes("://") || withoutBrackets.includes(":")) return { kind: "scheme_or_port", host };
    const key = host.toLowerCase();
    if (seen.has(key)) return { kind: "duplicate", host };
    seen.add(key);
  }
  return undefined;
}

/**
 * The address preview at the top of the proxy dialogs, built from the raw form fields:
 * `scheme://host:port` for each name, `…` for a port not typed yet, or null when
 * neither a host nor a port has been entered.
 */
export function formatExternalAddressPreview(scheme: string, host: string, port: string): string | null {
  const hosts = externalHostList(host);
  if (!hosts.length) return port ? `:${port}` : null;
  const prefix = scheme ? `${scheme}://` : "";
  return hosts.map(h => `${prefix}${h}:${port || "…"}`).join(", ");
}

/** Display form of a proxy's external address: `:port`, `host:port`, or every `host:port` joined by ", ". */
export function formatExternalHostPort(p: Pick<ProxyEntry, "externalHost" | "externalPort">): string {
  const hosts = externalHostList(p.externalHost);
  if (!hosts.length) return `:${p.externalPort}`;
  return hosts.map(h => `${h}:${p.externalPort}`).join(", ");
}
