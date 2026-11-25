/**
 * Helpers both sides of a site use: the Caddyfile text (siteBlock.ts) and the Admin API JSON
 * (caddy.ts) have to quote, match and name things the same way.
 */
import type { ProxyEntry } from "./types";
import { externalHostList } from "./externalHosts";


/**
 * One `header` / `header_up` line for a header operation, values quoted for Caddy (#251). `defer` writes a set as `>Name`: the Caddyfile adapter defers only `-`, `?`,
 * `>` and `defer`, so on a proxied route a plain set runs before reverse_proxy adds the upstream's
 * header and both reach the client (#255, checked with `caddy adapt` on 2.11.7).
 */
export function headerOpLine(prefix: string, h: import("./types").HeaderOperation, opts: { quoteSet?: boolean; defer?: boolean } = {}): string {
  if (h.op === "delete") return `${prefix} -${h.name}`;
  if (h.op === "add") return `${prefix} +${h.name} ${caddyQuote(h.value ?? "")}`;
  return `${prefix} ${opts.defer ? ">" : ""}${h.name} ${caddyQuote(h.value ?? "", { always: opts.quoteSet })}`;
}

// ---------------------------------------------------------------------------
// Route Matcher helpers — #48
// ---------------------------------------------------------------------------

/** RouteMatch stores "must be present" as an empty value list; Caddy spells it "*". */
export function presenceValues(vals: string[] | null | undefined): string[] {
  return vals?.length ? vals : ["*"];
}

/** True when any matcher (include, exclude or expression) is set. */
export function hasAnyMatcher(m: import("./types").RouteMatch | undefined): m is import("./types").RouteMatch {
  return !!m && Object.keys(buildMatcherJson(m)).length > 0;
}

/** Returns true when only path matchers are set (needed for handle_path eligibility). */
export function isPathOnlyMatcher(m: import("./types").RouteMatch | undefined): boolean {
  return !!m && !!(m.path?.length) && !m.host?.length && !m.method?.length && !m.header && !m.query && !m.remote_ip && !m.client_ip
    && !(m.not && Object.keys(matcherFieldsJson(m.not)).length) && !m.expression?.trim();
}

/**
 * Caddy's handle_path accepts a single path (#255). For several strip-prefix paths the plugin
 * writes the named matcher and `uri path_regexp <this> /`, which strips whichever prefix matched
 * and keeps the leading slash, as handle_path's strip_path_prefix does. Longest prefix first, so
 * `/a` doesn't win over `/ab`. Checked live with Caddy 2.11.7: /a/x → /x, /apix → /x.
 */
export function multiPathStripRegex(matchers: import("./types").RouteMatch | undefined): string | undefined {
  if (!matchers?.path || matchers.path.length < 2 || !isPathOnlyMatcher(matchers)) return undefined;
  const prefixes = matchers.path.map(handlePathPrefix).filter(Boolean);
  if (!prefixes.length) return undefined;
  const escaped = [...new Set(prefixes)].sort((a, b) => b.length - a.length).map(p => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return `^(?:${escaped.join("|")})/?`;
}

export type TransportProps = Pick<ProxyEntry, "targetScheme" | "tlsSkipVerify" | "dialTimeout" | "responseHeaderTimeout">;

export const LB_POLICIES: ReadonlySet<string> = new Set<import("./types").LbPolicy>([
  "round_robin", "random", "least_conn", "first", "ip_hash", "client_ip_hash", "uri_hash",
  "header", "cookie", "weighted_round_robin", "random_choose",
]);

export type LbFields = Pick<ProxyEntry, "lbPolicy" | "lbPolicyArgs">;

/** Builds the reverse_proxy directive lines for a proxy (tab-indented). */
export function buildLbRetryLines(lbRetry: import("./types").LbRetryConfig | undefined): string[] {
  if (!lbRetry) return [];
  const lines: string[] = [];
  if (lbRetry.retries != null) lines.push(`\t\tlb_retries ${lbRetry.retries}`);
  if (lbRetry.tryDuration) lines.push(`\t\tlb_try_duration ${lbRetry.tryDuration}`);
  if (lbRetry.tryInterval) lines.push(`\t\tlb_try_interval ${lbRetry.tryInterval}`);
  // Passive checks are off in Caddy without fail_duration (#252), so the options that only
  // feed them are written only alongside it.
  if (lbRetry.failDuration) {
    lines.push(`\t\tfail_duration ${lbRetry.failDuration}`);
    if (lbRetry.maxFails != null) lines.push(`\t\tmax_fails ${lbRetry.maxFails}`);
    if (lbRetry.unhealthyStatus?.length) lines.push(`\t\tunhealthy_status ${lbRetry.unhealthyStatus.join(" ")}`);
  }
  if (lbRetry.healthUri) {
    lines.push(`\t\thealth_uri ${lbRetry.healthUri}`);
    if (lbRetry.healthInterval) lines.push(`\t\thealth_interval ${lbRetry.healthInterval}`);
    if (lbRetry.healthTimeout) lines.push(`\t\thealth_timeout ${lbRetry.healthTimeout}`);
    if (lbRetry.healthStatus) lines.push(`\t\thealth_status ${lbRetry.healthStatus}`);
  }
  return lines;
}

/**
 * Computes the status code tokens needed for a `handle_response` or `handle_errors`
 * matcher that covers all configured error handlers.
 * Returns single-digit prefixes (4 = 4xx, 5 = 5xx) or exact codes (404, 502, …).
 */
export function errorHandlerResponseCodes(handlers: import("./types").ErrorHandlerConfig[]): number[] {
  const prefixes = new Set<number>();
  const exact = new Set<number>();
  for (const h of handlers) {
    if (h.matchType === "all")     { prefixes.add(4); prefixes.add(5); break; }
    if (h.matchType === "4xx")     prefixes.add(4);
    if (h.matchType === "5xx")     prefixes.add(5);
    if (h.matchType === "specific") h.codes?.forEach(c => exact.add(c));
  }
  const result = [...prefixes];
  for (const c of exact) {
    if (!prefixes.has(Math.floor(c / 100))) result.push(c);
  }
  return result;
}

/** The error message upstream errors are re-raised with (#255); handle_errors sees it as {err.message}. */
export const UPSTREAM_ERROR_MESSAGE = "upstream error";

/** Returns true only for numeric IP addresses — these are valid TCP bind targets. Hostnames are site labels in Caddyfile, not bind interfaces. */
export function isIpAddress(host: string): boolean {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || host.startsWith("[");
}

/** True when the host field is one IP address, which the plugin treats as the bind address. */
export function bindsToIp(proxy: { externalHost?: string }): boolean {
  return !!proxy.externalHost && externalHostList(proxy.externalHost).length === 1 && isIpAddress(proxy.externalHost);
}

/**
 * The public-looking names of a proxy's externalHost, which may list several (#208).
 * Empty means the proxy is hostless as far as TLS automation is concerned.
 */
export function tlsSubjectHosts(externalHost: string | undefined): string[] {
  return externalHostList(externalHost).filter(h => !isCaddyInternalSubject(h));
}

/**
 * The hostname(s) a proxy actually answers on: its Host matcher (#48) if one was set
 * explicitly, otherwise its externalHost (the bind address typed into Add/Edit Proxy).
 * Returns undefined when the proxy has no host restriction at all — it then catches
 * every request on its port, same as a bare `:port` Caddyfile block.
 */
export function routeHosts(p: Pick<ProxyEntry, "externalHost" | "matchers">): string[] | undefined {
  if (p.matchers?.host?.length) return p.matchers.host;
  const hosts = externalHostList(p.externalHost);
  return hosts.length ? hosts : undefined;
}

/**
 * `<directive> <provider> [{ <option> {env.NAME} … }]` (#261 acme_dns, #289 tls { dns }).
 * Credentials are written only as env references; literal values from a hand-written config
 * come back as they were.
 */
export function dnsProviderLines(directive: string, cfg: import("./types").DnsChallengeConfig, indent: string): string[] {
  const inline = cfg.literal?.[""];
  const head = `${indent}${directive} ${cfg.provider}${inline ? ` ${inline}` : ""}`;
  const entries = [
    ...Object.entries(cfg.credentials).map(([k, v]) => `${indent}\t${k} {env.${v}}`),
    ...Object.entries(cfg.literal ?? {}).filter(([k]) => k).map(([k, v]) => `${indent}\t${k} ${v}`),
  ];
  return entries.length ? [`${head} {`, ...entries, `${indent}}`] : [head];
}


/**
 * Turns a user-entered value into exactly one Caddyfile token that Caddy reads back verbatim.
 * Plain values stay as they are (unless `always`); otherwise double quotes with `\"` escapes.
 * Caddy's lexer has no escape for a backslash, so a value with `\` right before a quote or at
 * the end uses backticks (no escapes at all), and a value with newlines, or one that fits
 * neither form, uses a heredoc whose marker occurs nowhere in the value. The body and marker sit at column 0, so Caddy strips
 * no indentation from it.
 */
export function caddyQuote(value: string, opts: { always?: boolean } = {}): string {
  const needsQuotes = opts.always || value === "" || /[\s"`\\]/.test(value) || value.startsWith("#") || value === "{" || value === "}";
  if (!value.includes("\n") && !value.includes("\r")) {
    if (!needsQuotes) return value;
    if (!/\\("|$)/.test(value)) return `"${value.replace(/"/g, '\\"')}"`;
    if (!value.includes("`")) return `\`${value}\``;
  }
  // Caddy's lexer ends a heredoc as soon as the text read so far ends with the marker, even
  // mid-line, so the marker must not occur anywhere in the value.
  let marker = "END";
  for (let i = 1; value.includes(marker); i++) marker = `END${i}`;
  return `<<${marker}\n${value}\n${marker}`;
}

/** Caddy JSON for the plain matcher fields. */
export function matcherFieldsJson(m: import("./types").RouteMatchFields): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  if (m.path?.length) obj.path = m.path;
  if (m.host?.length) obj.host = m.host;
  if (m.method?.length) obj.method = m.method;
  if (m.header && Object.keys(m.header).length) {
    const h: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(m.header)) h[k] = presenceValues(v);
    obj.header = h;
  }
  if (m.query && Object.keys(m.query).length) {
    const q: Record<string, string[]> = {};
    // An empty list never matches in Caddy's query matcher; "*" means "present".
    for (const [k, v] of Object.entries(m.query)) q[k] = presenceValues(v);
    obj.query = q;
  }
  if (m.remote_ip?.ranges.length) obj.remote_ip = { ranges: m.remote_ip.ranges };
  if (m.client_ip?.ranges.length) obj.client_ip = { ranges: m.client_ip.ranges };
  return obj;
}

/** Converts RouteMatch to Caddy JSON match object. */
export function buildMatcherJson(m: import("./types").RouteMatch): Record<string, unknown> {
  const obj = matcherFieldsJson(m);
  const not = m.not ? matcherFieldsJson(m.not) : {};
  if (Object.keys(not).length) obj.not = [not];
  // The Caddyfile adapter expands placeholder shorthands; JSON pushed directly must do the same.
  if (m.expression?.trim()) obj.expression = { expr: expandPlaceholderShorthands(m.expression.trim()) };
  return obj;
}

/** Derives the strip-prefix value from the first path pattern, e.g. "/api/*" → "/api". */
/** The prefix handle_path strips for one path: `/api/*` and `/api*` both strip `/api`. */
export const handlePathPrefix = (path: string) => path.replace(/\/\*$/, "").replace(/\*$/, "");

/**
 * Mirrors certmagic.SubjectIsInternal (github.com/caddyserver/certmagic), which Caddy
 * itself uses to decide whether a hostname can get its own scoped automation policy.
 * Hosts that match this are folded into the shared catch-all/default policy no matter
 * what — giving them a `subjects`-scoped policy of our own would fight Caddy's own
 * classification and produce "automation policy from site block is also default/
 * catch-all policy ... in conflict" at reload. localhost/.local/.internal/.home.arpa
 * and private IPs all count, not just literal IP addresses.
 */
export function isCaddyInternalSubject(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return h === "localhost"
    || h.endsWith(".localhost")
    || h.endsWith(".local")
    || h.endsWith(".internal")
    || h.endsWith(".home.arpa")
    || isIpAddress(h);
}


/** `{path}` → `{http.request.uri.path}`, the way Caddy's Caddyfile adapter expands shorthands. */
export function expandPlaceholderShorthands(text: string): string {
  return mapPlaceholders(text, name => {
    const exact = PLACEHOLDER_SHORTHANDS.find(([s]) => s === name);
    if (exact) return exact[1];
    const prefix = PLACEHOLDER_PREFIXES.find(([s]) => name.startsWith(s));
    return prefix ? prefix[1] + name.slice(prefix[0].length) : name;
  });
}

/** Reverse of expandPlaceholderShorthands, so an expression reads back as it was written. */
export function collapsePlaceholderShorthands(text: string): string {
  return mapPlaceholders(text, name => {
    const exact = PLACEHOLDER_SHORTHANDS.find(([, l]) => l === name);
    if (exact) return exact[0];
    const prefix = PLACEHOLDER_PREFIXES
      .filter(([, l]) => name.startsWith(l))
      .sort((a, b) => b[1].length - a[1].length)[0];
    return prefix ? prefix[0] + name.slice(prefix[1].length) : name;
  });
}


// Caddyfile placeholder shorthands (#287), as Caddy 2.11's adapter expands them. Exact ones first,
// then prefixes; collapsing tries the longest long form first so `{http.request.uri.path.dir}`
// becomes `{dir}`, not `{path.dir}`.
export const PLACEHOLDER_SHORTHANDS: Array<[string, string]> = [
  ["host", "http.request.host"],
  ["hostport", "http.request.hostport"],
  ["port", "http.request.port"],
  ["orig_method", "http.request.orig_method"],
  ["orig_uri", "http.request.orig_uri"],
  ["orig_path", "http.request.orig_uri.path"],
  ["orig_dir", "http.request.orig_uri.path.dir"],
  ["orig_file", "http.request.orig_uri.path.file"],
  ["orig_query", "http.request.orig_uri.query"],
  ["method", "http.request.method"],
  ["uri", "http.request.uri"],
  ["path", "http.request.uri.path"],
  ["dir", "http.request.uri.path.dir"],
  ["file", "http.request.uri.path.file"],
  ["query", "http.request.uri.query"],
  ["remote", "http.request.remote"],
  ["remote_host", "http.request.remote.host"],
  ["remote_port", "http.request.remote.port"],
  ["scheme", "http.request.scheme"],
  ["uuid", "http.request.uuid"],
  ["tls_cipher", "http.request.tls.cipher_suite"],
  ["tls_version", "http.request.tls.version"],
  ["tls_client_fingerprint", "http.request.tls.client.fingerprint"],
  ["tls_client_issuer", "http.request.tls.client.issuer"],
  ["tls_client_serial", "http.request.tls.client.serial"],
  ["tls_client_subject", "http.request.tls.client.subject"],
  ["tls_client_certificate_pem", "http.request.tls.client.certificate_pem"],
  ["tls_client_certificate_der_base64", "http.request.tls.client.certificate_der_base64"],
  ["upstream_hostport", "http.reverse_proxy.upstream.hostport"],
  ["client_ip", "http.vars.client_ip"],
];

export const PLACEHOLDER_PREFIXES: Array<[string, string]> = [
  ["header.", "http.request.header."],
  ["cookie.", "http.request.cookie."],
  ["labels.", "http.request.host.labels."],
  ["path.", "http.request.uri.path."],
  ["file.", "http.request.uri.path.file."],
  ["query.", "http.request.uri.query."],
  ["re.", "http.regexp."],
  ["vars.", "http.vars."],
  ["rp.", "http.reverse_proxy."],
  ["resp.", "http.intercept."],
  ["err.", "http.error."],
  ["file_match.", "http.matchers.file."],
];

export function mapPlaceholders(text: string, fn: (name: string) => string): string {
  return text.replace(/\{([^{}\s]+)\}/g, (_, name: string) => `{${fn(name)}}`);
}
