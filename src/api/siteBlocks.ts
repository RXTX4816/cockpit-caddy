// A site as Caddyfile text: rendering a ProxyEntry to its block (matchers, handlers, TLS, logging,
// error pages) and surgically writing, editing or removing that block in a conf.d file, plus the
// named-server (listener) blocks. Pure: no Host, no I/O. Builds on caddyfileDocument and globalOptions.

import { type ProxyEntry, SPA_TRY_FILES } from "./types";
import { externalHostList } from "./externalHosts";
import { hasNestedBlocks } from "./siteTree";
import { dnsProviderLines, buildLogCaddyLines } from "./globalOptions";
import { caddyQuote, parseSiteAddresses, findMatchingBlock, findBlockPositions, CONF_HEADER, sameHostSet, hostsConflict, surgicallyRemoveBlock, isCaddyInternalSubject, findServerBlock, surgicallyRemoveServerBlock } from "./caddyfileDocument";
export { caddyQuote };

// ---------------------------------------------------------------------------
// Caddyfile quoting — #251
// ---------------------------------------------------------------------------



/** Go's regexp.QuoteMeta: `value` as a regexp that matches exactly that text. */
export function quoteRegexp(value: string): string {
  return value.replace(/[\\.+*?()|[\]{}^$]/g, "\\$&");
}

/**
 * One `header` / `header_up` line for a header operation, values quoted for Caddy (#251). `defer` writes a set as `>Name`: the Caddyfile adapter defers only `-`, `?`,
 * `>` and `defer`, so on a proxied route a plain set runs before reverse_proxy adds the upstream's
 * header and both reach the client (#255, checked with `caddy adapt` on 2.11.7).
 *
 * The response `header` directive also has `?Name` (set only when the response has none, which
 * Caddy runs deferred by itself) and a replace, written `>Name` everywhere: undeferred it would
 * run before reverse_proxy or file_server set the header it is meant to change.
 */
export function headerOpLine(prefix: string, h: import("./types").HeaderOperation, opts: { quoteSet?: boolean; defer?: boolean } = {}): string {
  const response = /(^|\s)header$/.test(prefix);
  if (h.op === "delete") return `${prefix} -${h.name}`;
  if (h.op === "default") return `${prefix} ?${h.name} ${caddyQuote(h.value ?? "", { always: opts.quoteSet })}`;
  if (h.op === "replace") {
    // Go expands `$1` in the replacement, so plain text doubles its `$`.
    const find = h.literal ? quoteRegexp(h.value ?? "") : h.value ?? "";
    const replacement = h.literal ? (h.replacement ?? "").replace(/\$/g, "$$$$") : h.replacement ?? "";
    return `${prefix} ${response ? ">" : ""}${h.name} ${caddyQuote(find)} ${caddyQuote(replacement)}`;
  }
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


/** The matcher-field lines (path, host, ...) shared by a named matcher and its `not` block. */
export function matcherFieldLines(m: import("./types").RouteMatchFields, indent: string): string[] {
  const lines: string[] = [];
  if (m.path?.length) lines.push(`${indent}path ${m.path.join(" ")}`);
  if (m.host?.length) lines.push(`${indent}host ${m.host.join(" ")}`);
  if (m.method?.length) lines.push(`${indent}method ${m.method.join(" ")}`);
  // Caddy's Caddyfile syntax has no bare "present" form for either matcher (#250): presence is
  // the "*" value, and query takes `param=value` pairs.
  if (m.header) {
    for (const [hdr, vals] of Object.entries(m.header)) {
      lines.push(`${indent}header ${hdr} ${presenceValues(vals).map(v => caddyQuote(v)).join(" ")}`);
    }
  }
  if (m.query) {
    const pairs = Object.entries(m.query).flatMap(([param, vals]) => presenceValues(vals).map(v => caddyQuote(`${param}=${v}`)));
    if (pairs.length) lines.push(`${indent}query ${pairs.join(" ")}`);
  }
  if (m.remote_ip?.ranges.length) {
    lines.push(`${indent}remote_ip ${m.remote_ip.ranges.join(" ")}`);
  }
  if (m.client_ip?.ranges.length) {
    lines.push(`${indent}client_ip ${m.client_ip.ranges.join(" ")}`);
  }
  // Caddy takes one regular expression per matcher (#331), so a second one is the writer's to refuse.
  if (m.path_regexp?.pattern) lines.push(`${indent}path_regexp ${m.path_regexp.name ? `${m.path_regexp.name} ` : ""}${caddyQuote(m.path_regexp.pattern)}`);
  if (m.header_regexp?.pattern) lines.push(`${indent}header_regexp ${m.header_regexp.name ? `${m.header_regexp.name} ` : ""}${m.header_regexp.header} ${caddyQuote(m.header_regexp.pattern)}`);
  if (m.protocol) lines.push(`${indent}protocol ${m.protocol}`);
  if (m.file?.try_files.length) {
    lines.push(`${indent}file {`, `${indent}\ttry_files ${m.file.try_files.join(" ")}`);
    if (m.file.try_policy) lines.push(`${indent}\ttry_policy ${m.file.try_policy}`);
    lines.push(`${indent}}`);
  }
  for (const [name, values] of Object.entries(m.vars ?? {})) {
    if (values.length) lines.push(`${indent}vars ${name} ${values.map(v => caddyQuote(v)).join(" ")}`);
  }
  return lines;
}


/**
 * Generates named-matcher lines for a Caddyfile block.
 * Uses block form `@name { ... }` always (more stable for round-trips than inline form).
 */
export function buildMatcherCaddyLines(m: import("./types").RouteMatch, name: string, indent: string): string[] {
  const lines: string[] = [`${indent}@${name} {`, ...matcherFieldLines(m, `${indent}\t`)];
  const notLines = m.not ? matcherFieldLines(m.not, `${indent}\t\t`) : [];
  if (notLines.length) lines.push(`${indent}\tnot {`, ...notLines, `${indent}\t}`);
  if (m.expression?.trim()) lines.push(`${indent}\texpression ${caddyQuote(m.expression.trim(), { always: true })}`);
  lines.push(`${indent}}`);
  return lines;
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
  if (m.path_regexp?.pattern) obj.path_regexp = { ...(m.path_regexp.name ? { name: m.path_regexp.name } : {}), pattern: m.path_regexp.pattern };
  if (m.header_regexp?.pattern) obj.header_regexp = { [m.header_regexp.header]: { ...(m.header_regexp.name ? { name: m.header_regexp.name } : {}), pattern: m.header_regexp.pattern } };
  if (m.protocol) obj.protocol = m.protocol;
  if (m.file?.try_files.length) obj.file = { try_files: m.file.try_files.map(expandPlaceholderShorthands), ...(m.file.try_policy ? { try_policy: m.file.try_policy } : {}) };
  const vars = Object.entries(m.vars ?? {}).filter(([, v]) => v.length);
  if (vars.length) obj.vars = Object.fromEntries(vars.map(([k, v]) => [expandPlaceholderShorthands(k), v]));
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


/** True when any matcher (include, exclude or expression) is set. */
export function hasAnyMatcher(m: import("./types").RouteMatch | undefined): m is import("./types").RouteMatch {
  return !!m && Object.keys(buildMatcherJson(m)).length > 0;
}


/** Returns true when only path matchers are set (needed for handle_path eligibility). */
export function isPathOnlyMatcher(m: import("./types").RouteMatch | undefined): boolean {
  return !!m && !!(m.path?.length) && !m.host?.length && !m.method?.length && !m.header && !m.query && !m.remote_ip && !m.client_ip
    && !m.path_regexp && !m.header_regexp && !m.protocol && !m.file && !m.vars
    && !(m.not && Object.keys(matcherFieldsJson(m.not)).length) && !m.expression?.trim();
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


/** `{path}` → `{http.request.uri.path}`, the way Caddy's Caddyfile adapter expands shorthands. */
export function expandPlaceholderShorthands(text: string): string {
  return mapPlaceholders(text, name => {
    const exact = PLACEHOLDER_SHORTHANDS.find(([s]) => s === name);
    if (exact) return exact[1];
    const prefix = PLACEHOLDER_PREFIXES.find(([s]) => name.startsWith(s));
    return prefix ? prefix[1] + name.slice(prefix[0].length) : name;
  });
}


/** Derives the strip-prefix value from the first path pattern, e.g. "/api/*" → "/api". */
/** The prefix handle_path strips for one path: `/api/*` and `/api*` both strip `/api`. */
export const handlePathPrefix = (path: string) => path.replace(/\/\*$/, "").replace(/\*$/, "");


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



// ---------------------------------------------------------------------------
// Forward authentication helpers
// ---------------------------------------------------------------------------

export function buildForwardAuthCaddyLines(fa: import("./types").ForwardAuthConfig): string[] {
  if (!fa.upstreamUrl.trim()) return [];
  const lines = [`\tforward_auth ${fa.upstreamUrl} {`];
  lines.push(`\t\turi ${fa.uri || "/"}`);
  if (fa.copyHeaders.length) lines.push(`\t\tcopy_headers ${fa.copyHeaders.join(" ")}`);
  for (const h of fa.headerUp ?? []) lines.push(headerOpLine("\t\theader_up", h));
  if (fa.trustedProxies?.length) lines.push(`\t\ttrusted_proxies ${fa.trustedProxies.join(" ")}`);
  lines.push("\t}");
  return lines;
}


/**
 * `encode <algorithms>`, with its options in a block (#335). Caddy's `status 2xx` is a class and
 * `header Name value` takes one value, so a header with several values is written as several lines.
 */
export function buildEncodeLines(indent: string, options?: import("./types").EncodeOptions): string[] {
  // A plain `encode` is Caddy's default: zstd and gzip, zstd preferred.
  const head = `${indent}encode${options?.algorithms?.length ? ` ${options.algorithms.join(" ")}` : ""}`;
  const inner: string[] = [];
  if (options?.minimumLength != null) inner.push(`${indent}\tminimum_length ${options.minimumLength}`);
  const match: string[] = [];
  if (options?.matchStatus?.length) match.push(`${indent}\t\tstatus ${options.matchStatus.join(" ")}`);
  for (const h of options?.matchHeaders ?? []) match.push(`${indent}\t\theader ${h.name} ${caddyQuote(h.value)}`);
  if (match.length) inner.push(`${indent}\tmatch {`, ...match, `${indent}\t}`);
  return inner.length ? [`${head} {`, ...inner, `${indent}}`] : [head];
}


/** `basic_auth [<algorithm> [<realm>]] {`: a realm needs the algorithm before it, so bcrypt is spelled out then. */
export function basicAuthOpenLine(indent: string, options?: import("./types").BasicAuthOptions): string {
  const algorithm = options?.algorithm ?? (options?.realm ? "bcrypt" : undefined);
  return `${indent}basic_auth${algorithm ? ` ${algorithm}` : ""}${options?.realm ? ` ${caddyQuote(options.realm)}` : ""} {`;
}


export function buildBasicAuthCaddyLines(accounts: { username: string; passwordHash: string }[], options?: import("./types").BasicAuthOptions): string[] {
  return [basicAuthOpenLine("\t", options), ...accounts.map(a => `\t\t${a.username} ${a.passwordHash}`), "\t}"];
}


export function buildRewriteCaddyLines(rewrite: import("./types").RewriteConfig, indent = "\t"): string[] {
  if (rewrite.type === "strip_prefix") return [`${indent}uri strip_prefix ${rewrite.value}`];
  if (rewrite.type === "add_prefix") return [`${indent}rewrite ${rewrite.value}{uri}`];
  if (rewrite.type === "strip_suffix") return [`${indent}uri strip_suffix ${rewrite.value}`];
  if (rewrite.type === "method") return [`${indent}method ${rewrite.method}`];
  if (rewrite.type === "uri_replace") {
    return [`${indent}uri replace ${caddyQuote(rewrite.find)} ${caddyQuote(rewrite.replace, { always: true })}${rewrite.limit ? ` ${rewrite.limit}` : ""}`];
  }
  if (rewrite.type === "query") {
    const line = (o: import("./types").QueryOp) =>
      o.op === "delete" ? `-${o.key}`
        : o.op === "add" ? `+${o.key} ${caddyQuote(o.value ?? "", { always: true })}`
        : o.op === "rename" ? `${o.key}>${o.value ?? ""}`
        : o.op === "replace" ? `${o.key} ${caddyQuote(o.search ?? "", { always: true })} ${caddyQuote(o.replace ?? "", { always: true })}`
        : `${o.key} ${caddyQuote(o.value ?? "", { always: true })}`;
    return rewrite.ops.length === 1
      ? [`${indent}uri query ${line(rewrite.ops[0])}`]
      : [`${indent}uri query {`, ...rewrite.ops.map(o => `${indent}\t${line(o)}`), `${indent}}`];
  }
  // `uri path_regexp` replaces the matching part of the path, like the JSON rewrite handler's
  // path_regexp; a `path_regexp` matcher + `rewrite` replaced the whole URI instead (#254).
  // Both use Go's $1 backreferences.
  return [`${indent}uri path_regexp ${caddyQuote(rewrite.find)} ${caddyQuote(rewrite.replace)}`];
}


export type TransportProps = Pick<ProxyEntry, "targetScheme" | "tlsSkipVerify" | "dialTimeout" | "responseHeaderTimeout" | "tlsServerName" | "keepalive" | "keepaliveIdleConns" | "keepaliveIdleConnsPerHost" | "httpVersions" | "readTimeout" | "writeTimeout">;


export function buildTransportLines(p: TransportProps): string[] {
  const needsSkipVerify = p.targetScheme === "https" && p.tlsSkipVerify;
  const serverName = p.targetScheme === "https" ? p.tlsServerName : undefined;

  const inner: string[] = [];
  if (needsSkipVerify) inner.push("\t\t\ttls_insecure_skip_verify");
  if (serverName) inner.push(`\t\t\ttls_server_name ${caddyQuote(serverName)}`);
  if (p.dialTimeout) inner.push(`\t\t\tdial_timeout ${p.dialTimeout}`);
  if (p.responseHeaderTimeout) inner.push(`\t\t\tresponse_header_timeout ${p.responseHeaderTimeout}`);
  if (p.readTimeout) inner.push(`\t\t\tread_timeout ${p.readTimeout}`);
  if (p.writeTimeout) inner.push(`\t\t\twrite_timeout ${p.writeTimeout}`);
  if (p.keepalive) inner.push(`\t\t\tkeepalive ${p.keepalive}`);
  if (p.keepaliveIdleConns != null) inner.push(`\t\t\tkeepalive_idle_conns ${p.keepaliveIdleConns}`);
  if (p.keepaliveIdleConnsPerHost != null) inner.push(`\t\t\tkeepalive_idle_conns_per_host ${p.keepaliveIdleConnsPerHost}`);
  if (p.httpVersions?.length) inner.push(`\t\t\tversions ${p.httpVersions.join(" ")}`);
  if (!inner.length) return [];
  return ["\t\ttransport http {", ...inner, "\t\t}"];
}


export function buildUpstreamList(p: Pick<ProxyEntry, "targetScheme" | "targetHost" | "targetPort" | "extraUpstreams">): string[] {
  const scheme = p.targetScheme === "https" ? "https://" : "http://";
  const primary = `${scheme}${p.targetHost}:${p.targetPort}`;
  const extra = (p.extraUpstreams ?? []).map(u => `${scheme}${u.host}:${u.port}`);
  return [primary, ...extra];
}


export const LB_POLICIES: ReadonlySet<string> = new Set<import("./types").LbPolicy>([
  "round_robin", "random", "least_conn", "first", "ip_hash", "client_ip_hash", "uri_hash",
  "header", "cookie", "weighted_round_robin", "random_choose",
]);


export type LbFields = Pick<ProxyEntry, "lbPolicy" | "lbPolicyArgs">;


/** The `lb_policy` arguments (#285), Caddyfile tokens. */
export function lbPolicyTokens(p: LbFields): string[] {
  const a = p.lbPolicyArgs ?? {};
  switch (p.lbPolicy) {
    case "header": return a.headerField ? [caddyQuote(a.headerField)] : [];
    case "cookie":
      if (a.cookieSecret) return [caddyQuote(a.cookieName || "lb"), caddyQuote(a.cookieSecret)];
      return a.cookieName ? [caddyQuote(a.cookieName)] : [];
    case "weighted_round_robin": return (a.weights ?? []).map(String);
    case "random_choose": return a.chooseCount != null ? [String(a.chooseCount)] : [];
    default: return [];
  }
}


/** Builds the reverse_proxy directive lines for a proxy (tab-indented). */
export function buildLbRetryLines(lbRetry: import("./types").LbRetryConfig | undefined): string[] {
  if (!lbRetry) return [];
  const lines: string[] = [];
  if (lbRetry.retries != null) lines.push(`\t\tlb_retries ${lbRetry.retries}`);
  if (lbRetry.tryDuration) lines.push(`\t\tlb_try_duration ${lbRetry.tryDuration}`);
  if (lbRetry.tryInterval) lines.push(`\t\tlb_try_interval ${lbRetry.tryInterval}`);
  if (lbRetry.retryMethods?.length) lines.push("\t\tlb_retry_match {", `\t\t\tmethod ${lbRetry.retryMethods.join(" ")}`, "\t\t}");
  // Passive checks are off in Caddy without fail_duration (#252), so the options that only
  // feed them are written only alongside it.
  if (lbRetry.failDuration) {
    lines.push(`\t\tfail_duration ${lbRetry.failDuration}`);
    if (lbRetry.maxFails != null) lines.push(`\t\tmax_fails ${lbRetry.maxFails}`);
    if (lbRetry.unhealthyStatus?.length) lines.push(`\t\tunhealthy_status ${lbRetry.unhealthyStatus.join(" ")}`);
  }
  // Caddy runs active checks once a path or a port is set; the other options only tune them.
  if (lbRetry.healthUri || lbRetry.healthPort) {
    if (lbRetry.healthUri) lines.push(`\t\thealth_uri ${lbRetry.healthUri}`);
    if (lbRetry.healthPort) lines.push(`\t\thealth_port ${lbRetry.healthPort}`);
    if (lbRetry.healthInterval) lines.push(`\t\thealth_interval ${lbRetry.healthInterval}`);
    if (lbRetry.healthTimeout) lines.push(`\t\thealth_timeout ${lbRetry.healthTimeout}`);
    if (lbRetry.healthStatus) lines.push(`\t\thealth_status ${lbRetry.healthStatus}`);
    const headers = Object.entries(lbRetry.healthHeaders ?? {}).flatMap(([name, vals]) => vals.map(v => `\t\t\t${name} ${caddyQuote(v)}`));
    if (headers.length) lines.push("\t\thealth_headers {", ...headers, "\t\t}");
    if (lbRetry.healthPasses != null) lines.push(`\t\thealth_passes ${lbRetry.healthPasses}`);
    if (lbRetry.healthFails != null) lines.push(`\t\thealth_fails ${lbRetry.healthFails}`);
  }
  return lines;
}


function dynamicSourceLines(s: import("./types").DynamicUpstreamSource, indent: string): string[] {
  const head = `${s.type} ${caddyQuote(s.name)}${s.type === "a" && s.port ? ` ${s.port}` : ""}`;
  const inner = [
    s.refresh ? `refresh ${s.refresh}` : "",
    s.resolvers?.length ? `resolvers ${s.resolvers.join(" ")}` : "",
    s.dialTimeout ? `dial_timeout ${s.dialTimeout}` : "",
    s.dialFallbackDelay ? `dial_fallback_delay ${s.dialFallbackDelay}` : "",
    s.gracePeriod ? `grace_period ${s.gracePeriod}` : "",
    s.type === "a" && s.versions ? `versions ${s.versions}` : "",
  ].filter(Boolean);
  return inner.length ? [`${indent}${head} {`, ...inner.map(l => `${indent}\t${l}`), `${indent}}`] : [`${indent}${head}`];
}

/** `dynamic srv|a` for one source, `dynamic multi` for several (#326). */
export function buildDynamicUpstreamLines(sources: import("./types").DynamicUpstreamSource[] | undefined): string[] {
  const list = (sources ?? []).filter(s => s.name.trim());
  if (!list.length) return [];
  if (list.length === 1) {
    const [first, ...rest] = dynamicSourceLines(list[0], "\t\t");
    return [first.replace(/^(\t+)/, "$1dynamic "), ...rest];
  }
  return ["\t\tdynamic multi {", ...list.flatMap(s => dynamicSourceLines(s, "\t\t\t")), "\t\t}"];
}

export function buildReverseProxyLines(
  p: Pick<ProxyEntry, "targetScheme" | "targetHost" | "targetPort" | "tlsSkipVerify" | "requestHeaders" | "upstreamResponseHeaders" | "dynamicUpstreams" | "dialTimeout" | "responseHeaderTimeout" | "tlsServerName" | "keepalive" | "keepaliveIdleConns" | "keepaliveIdleConnsPerHost" | "httpVersions" | "readTimeout" | "writeTimeout" | "flushInterval" | "streamTimeout" | "streamCloseDelay" | "extraUpstreams" | "lbPolicy" | "lbPolicyArgs" | "lbRetry" | "replaceUpstreamErrors">,
  errorHandlers?: import("./types").ErrorHandlerConfig[],
): string[] {
  const upstreams = buildUpstreamList(p);

  const headerLines = (p.requestHeaders ?? []).map(h => {
    return headerOpLine("\t\theader_up", h);
  }).concat((p.upstreamResponseHeaders ?? []).map(h => headerOpLine("\t\theader_down", h)));

  const transportLines = buildTransportLines(p);
  const dynamicLines = buildDynamicUpstreamLines(p.dynamicUpstreams);
  const streamingLines = [
    p.flushInterval ? `\t\tflush_interval ${p.flushInterval}` : "",
    p.streamTimeout ? `\t\tstream_timeout ${p.streamTimeout}` : "",
    p.streamCloseDelay ? `\t\tstream_close_delay ${p.streamCloseDelay}` : "",
  ].filter(Boolean);
  const lbLines = (p.lbPolicy && upstreams.length > 1 && LB_POLICIES.has(p.lbPolicy))
    ? [[`\t\tlb_policy`, p.lbPolicy, ...lbPolicyTokens(p)].join(" ")]
    : [];
  const lbRetryLines = buildLbRetryLines(p.lbRetry);

  // With "also replace the app's own error pages" on (#255), intercept upstream HTTP error
  // responses and re-raise them as Caddy errors so that handle_errors blocks fire. Without it
  // only Caddy's own errors reach handle_errors, as in plain Caddy, and the app's JSON 404s or
  // a 401 with WWW-Authenticate pass through untouched.
  // A category (4xx/5xx) uses the two-argument `error "<msg>" {rp.status_code}`, which keeps the
  // upstream's real code (checked live with Caddy 2.11.7: 404, 418 and 503 stay as they are).
  // The one-argument `error {rp.status_code}` doesn't: Caddy reads a non-integer single argument
  // as the message and the status falls back to 500. Exact codes stay literal.
  const errorPassthroughLines: string[] = [];
  if (p.replaceUpstreamErrors && errorHandlers?.length) {
    const codes = errorHandlerResponseCodes(errorHandlers);
    codes.forEach((c, i) => {
      const statusToken = c < 10 ? `${c}xx` : String(c);
      errorPassthroughLines.push(
        `\t\t@upstream_error${i} status ${statusToken}`,
        `\t\thandle_response @upstream_error${i} {`,
        c < 10 ? `\t\t\terror "${UPSTREAM_ERROR_MESSAGE}" {rp.status_code}` : `\t\t\terror ${c}`,
        `\t\t}`,
      );
    });
  }

  const needsBlock = transportLines.length > 0 || dynamicLines.length > 0 || streamingLines.length > 0 || headerLines.length > 0 || lbLines.length > 0 || lbRetryLines.length > 0 || errorPassthroughLines.length > 0;
  if (!needsBlock) return [`\treverse_proxy ${upstreams.join(" ")}`];

  return [`\treverse_proxy ${upstreams.join(" ")} {`, ...lbLines, ...lbRetryLines, ...dynamicLines, ...streamingLines, ...transportLines, ...headerLines, ...errorPassthroughLines, "\t}"];
}


/**
 * `https://` (or any scheme implying TLS) in a Caddyfile site address triggers Caddy's
 * automatic HTTPS on its own, independent of anything else in the block — so a proxy
 * with externalScheme="https" but tls=false would still get an implicit, ungoverned
 * internal-issuer policy from Caddy, which then conflicts with any hostless proxy that
 * *does* have an explicit shared lifetime ("automation policy from site block is also
 * default/catch-all policy ... in conflict"). Only honor the scheme when TLS is
 * actually enabled, so the address never implies more than our own config does.
 *
 * Conversely, a TLS-disabled site with NO scheme prefix at all is *also* not safe:
 * Caddy's own `isAllHTTP()` check (caddyconfig/httpcaddyfile/directives.go) only skips
 * automation-policy handling for a site when its address explicitly says `http://` —
 * a bare `:port` with no scheme still counts as eligible for automatic HTTPS and can
 * silently claim the shared catch-all policy with no issuer configured at all, which
 * then conflicts with any other hostless site that has an explicit custom lifetime.
 * So TLS-disabled sites always get an explicit `http://`, never a bare address.
 */
export function buildExternalAddress(p: Pick<ProxyEntry, "externalPort" | "externalScheme" | "externalHost" | "tls">): string {
  const hosts = externalHostList(p.externalHost);
  if (!hosts.length) return p.tls ? `:${p.externalPort}` : `http://:${p.externalPort}`;
  // Several names (#208) share one site block: every address carries the same scheme
  // and port, since Caddy would otherwise default a portless name to :443.
  const prefix = !p.tls ? "http://" : p.externalScheme ? `${p.externalScheme}://` : "";
  return hosts.map(h => `${prefix}${h}:${p.externalPort}`).join(", ");
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


/** Converts a list of error handler configs to `handle_errors` Caddyfile lines. */
export function buildErrorHandlerCaddyLines(handlers: import("./types").ErrorHandlerConfig[]): string[] {
  const lines: string[] = [];
  for (const h of handlers) {
    const matchSuffix =
      h.matchType === "specific" && h.codes?.length
        ? " " + h.codes.join(" ")
        : h.matchType === "4xx" ? " 4xx"
        : h.matchType === "5xx" ? " 5xx"
        : "";
    lines.push(`\thandle_errors${matchSuffix} {`);
    if (h.type === "redirect") {
      lines.push(`\t\tredir ${h.redirectTo ?? "/"} ${h.redirectCode ?? 302}`);
    } else if (h.type === "static") {
      lines.push(`\t\trewrite * /{http.error.status_code}.html`);
      lines.push(`\t\tfile_server {`);
      lines.push(`\t\t\troot ${caddyQuote(h.filePath ?? "/var/www/errors")}`);
      lines.push(`\t\t}`);
    } else {
      const body = h.body ?? "{http.error.status_code} {http.error.status_text}";
      const sc = h.statusCode ? ` ${h.statusCode}` : "";
      lines.push(`\t\trespond ${caddyQuote(body, { always: true })}${sc}`);
    }
    lines.push("\t}");
  }
  return lines;
}


/**
 * Builds the per-site `tls { }` Caddyfile block.
 *
 * `certLifetime` for a HOSTLESS proxy/server must always be the exact same value
 * across every hostless site in the whole Caddyfile — Caddy forces every hostless
 * site's automation policy to be the same object as the shared catch-all, then
 * rejects the config if a site's own (freshly-parsed) issuer isn't `reflect.DeepEqual`
 * to what's already there, even for a bare `tls internal` with no lifetime of its own
 * ("automation policy from site block is also default/catch-all policy ... in
 * conflict"). Callers (useProxies.ts) are responsible for stamping the current shared
 * value (from GlobalOptions.internalCertLifetime) onto every hostless proxy/server's
 * tlsAdvanced before calling this — this function just emits whatever it's given.
 *
 * `renewalWindowRatio` has no such conflict (Caddy applies it unconditionally, last
 * write wins, no error) but is still suppressed here for hostless proxies to avoid
 * that silent, order-dependent overwrite — hostless renewal window only comes from
 * the real global `renewal_window_ratio` Caddyfile option instead.
 */
export function buildTlsCaddyLines(p: Pick<ProxyEntry, "tls" | "tlsIssuer" | "tlsOnDemand" | "dnsChallenge" | "tlsAdvanced" | "mtls" | "customTls">, hostless: boolean): string[] {
  if (!p.tls) return [];
  const adv = p.tlsAdvanced;
  const mtls = p.mtls;
  const custom = p.customTls;
  const hasCustomCert = !!(custom?.certFile?.trim() && custom?.keyFile?.trim());

  // A manually-loaded certificate (#152) has no issuer of its own — protocols/ciphers/
  // curves/client_auth still apply to the connection, but certLifetime/renewalWindowRatio
  // (internal-issuer-only settings) never do, so they're deliberately excluded here.
  const certLifetime = hasCustomCert ? undefined : adv?.certLifetime;
  const renewalWindowRatio = (hostless || hasCustomCert) ? undefined : adv?.renewalWindowRatio;
  const hasAdvanced = adv && (
    adv.protocolMin || adv.protocolMax || adv.cipherSuites?.length || adv.curves?.length
    || certLifetime || renewalWindowRatio !== undefined || adv.keyType
  );
  const hasMtls = mtls?.mode;
  // #253: a certificate file has nothing to obtain, so on_demand only goes with an issuer.
  const onDemandLines = p.tlsOnDemand ? ["\t\ton_demand"] : [];

  if (hasCustomCert) {
    const certLine = `\ttls ${custom!.certFile.trim()} ${custom!.keyFile.trim()}`;
    // Caddy has no field for a separate CA bundle/intermediate chain on a manually-loaded
    // certificate — stash the path in a comment (like route labels) purely so the UI can
    // show it back to the user; it plays no role in Caddy's own TLS behavior.
    const caComment = custom!.caFile?.trim() ? [`\t# tls_ca_bundle: ${custom!.caFile.trim()}`] : [];
    if (!hasAdvanced && !hasMtls) return [certLine, ...caComment];
    const lines: string[] = [`${certLine} {`];
    lines.push(...buildTlsPolicyBlockLines(adv, mtls));
    lines.push("\t}");
    lines.push(...caComment);
    return lines;
  }

  // Automatic HTTPS (#246): Caddy's default issuers (ACME) apply when the block names no
  // issuer at all. It needs a public name, so a hostless site keeps the internal CA. The
  // internal-issuer settings (lifetime, renewal ratio) don't apply here.
  if (p.tlsIssuer === "acme" && !hostless) {
    // #289: a site's own DNS provider; Caddy fills in the global acme_dns one only when unset.
    const dnsLines = p.dnsChallenge?.provider ? dnsProviderLines("dns", p.dnsChallenge, "\t\t") : [];
    // #341: the site's own account email, CA and key type; unset ones fall back to the global ones.
    const email = adv?.acmeEmail?.trim();
    const own = [
      ...(adv?.acmeCa?.trim() ? [`\t\tca ${adv.acmeCa.trim()}`] : []),
      ...(adv?.keyType ? [`\t\tkey_type ${adv.keyType}`] : []),
    ];
    const policy = [...own, ...buildTlsPolicyBlockLines(adv, mtls), ...onDemandLines, ...dnsLines];
    if (!policy.length) return email ? [`\ttls ${email}`] : [];
    return [`\ttls${email ? ` ${email}` : ""} {`, ...policy, "\t}"];
  }

  if (!hasAdvanced && !hasMtls && !onDemandLines.length) return ["\ttls internal"];

  const lines: string[] = ["\ttls {"];
  if (certLifetime) {
    lines.push("\t\tissuer internal {");
    lines.push(`\t\t\tlifetime ${certLifetime}`);
    lines.push("\t\t}");
  } else {
    lines.push("\t\tissuer internal");
  }
  if (renewalWindowRatio !== undefined) {
    lines.push(`\t\trenewal_window_ratio ${renewalWindowRatio}`);
  }
  if (adv?.keyType) lines.push(`\t\tkey_type ${adv.keyType}`);
  lines.push(...buildTlsPolicyBlockLines(adv, mtls));
  lines.push(...onDemandLines);
  lines.push("\t}");
  return lines;
}


/** Shared protocols/ciphers/curves/client_auth sub-directive lines, used inside both the
 *  internal-issuer `tls { }` block and the custom-certificate `tls cert key { }` block. */
export function buildTlsPolicyBlockLines(
  adv: import("./types").TlsAdvancedConfig | undefined,
  mtls: import("./types").MtlsConfig | undefined,
): string[] {
  const lines: string[] = [];
  if (adv?.protocolMin) {
    lines.push(adv.protocolMax
      ? `\t\tprotocols ${adv.protocolMin} ${adv.protocolMax}`
      : `\t\tprotocols ${adv.protocolMin}`);
  } else if (adv?.protocolMax) {
    lines.push(`\t\tprotocols tls1.2 ${adv.protocolMax}`);
  }
  if (adv?.cipherSuites?.length) {
    lines.push(`\t\tciphers ${adv.cipherSuites.join(" ")}`);
  }
  if (adv?.curves?.length) {
    lines.push(`\t\tcurves ${adv.curves.join(" ")}`);
  }
  if (mtls?.mode) {
    lines.push("\t\tclient_auth {");
    lines.push(`\t\t\tmode ${mtls.mode}`);
    if (mtls.trustedCaFile?.trim()) {
      // trust_pool replaces the deprecated trusted_ca_cert_file (#255), and unlike it keeps the
      // path in the adapted JSON instead of inlining the certificate.
      lines.push(`\t\t\ttrust_pool file ${mtls.trustedCaFile.trim()}`);
    }
    lines.push("\t\t}");
  }
  return lines;
}


/** True when a static site has any `file_server` sub-directive set (#262). */
export function hasFileServerOptions(fs: import("./types").FileServerConfig): boolean {
  return !!(fs.index?.length || fs.hide?.length || fs.precompressed?.length || fs.disableCanonicalUris || fs.status || (fs.browse && (fs.browseTemplate || hasBrowseOptions(fs))));
}

/** True when the listing has options of its own, which need a `browse { … }` block (#340). */
function hasBrowseOptions(fs: import("./types").FileServerConfig): boolean {
  return !!(fs.browseRevealSymlinks || fs.browseSort || fs.browseFileLimit);
}


/**
 * `root`, the SPA fallback and `file_server` with its options for a static site (#262). A site
 * without the new options writes exactly the lines it always did.
 */
export function buildFileServerLines(fs: import("./types").FileServerConfig, indent: string): string[] {
  const lines = [`${indent}root * ${caddyQuote(fs.root)}`];
  if (fs.spa) lines.push(`${indent}try_files ${SPA_TRY_FILES}`);
  else if (fs.tryFiles?.trim()) lines.push(`${indent}try_files ${fs.tryFiles.trim()}`);
  // A listing template or listing options go on the block's own `browse`, so then the head has none.
  const template = fs.browse ? fs.browseTemplate : undefined;
  const browseBlock = !!fs.browse && hasBrowseOptions(fs);
  if (fs.templates) {
    const t = fs.templates;
    if (t.mime?.length || t.root) {
      lines.push(`${indent}templates {`);
      if (t.mime?.length) lines.push(`${indent}\tmime ${t.mime.join(" ")}`);
      if (t.root) lines.push(`${indent}\troot ${caddyQuote(t.root)}`);
      lines.push(`${indent}}`);
    } else {
      lines.push(`${indent}templates`);
    }
  }
  const head = fs.browse && !template && !browseBlock ? `${indent}file_server browse` : `${indent}file_server`;
  if (!hasFileServerOptions(fs)) {
    lines.push(head);
    return lines;
  }
  lines.push(`${head} {`);
  if (browseBlock) {
    lines.push(`${indent}\tbrowse${template ? ` ${caddyQuote(template)}` : ""} {`);
    if (fs.browseRevealSymlinks) lines.push(`${indent}\t\treveal_symlinks`);
    if (fs.browseSort) lines.push(`${indent}\t\tsort ${fs.browseSort.by}${fs.browseSort.order ? ` ${fs.browseSort.order}` : ""}`);
    if (fs.browseFileLimit) lines.push(`${indent}\t\tfile_limit ${fs.browseFileLimit}`);
    lines.push(`${indent}\t}`);
  } else if (template) {
    lines.push(`${indent}\tbrowse ${caddyQuote(template)}`);
  }
  if (fs.disableCanonicalUris) lines.push(`${indent}\tdisable_canonical_uris`);
  if (fs.status) lines.push(`${indent}\tstatus ${fs.status}`);
  if (fs.index?.length) lines.push(`${indent}\tindex ${fs.index.map(v => caddyQuote(v)).join(" ")}`);
  if (fs.hide?.length) lines.push(`${indent}\thide ${fs.hide.map(v => caddyQuote(v)).join(" ")}`);
  if (fs.precompressed?.length) lines.push(`${indent}\tprecompressed ${fs.precompressed.join(" ")}`);
  lines.push(`${indent}}`);
  return lines;
}


/**
 * `root` + `php_fastcgi` + `file_server` for a PHP site. php_fastcgi only proxies `*.php` and
 * rewrites other existing files to themselves, so without file_server nothing serves CSS, JS or
 * images (#247). Caddy's docs say it "should almost always be paired with" both.
 */
export function buildPhpFastcgiLines(php: import("./types").PhpFastcgiConfig, indent: string): string[] {
  const lines = [`${indent}root * ${caddyQuote(php.root)}`];
  if (php.tryFiles?.trim()) lines.push(`${indent}try_files ${php.tryFiles.trim()}`);
  const { upstream, index, splitPath, env } = php;
  const envEntries = env ? Object.entries(env) : [];
  const hasOptions = !!(php.captureStderr || php.resolveRootSymlink || php.dialTimeout || php.readTimeout || php.writeTimeout);
  if (index || splitPath?.length || envEntries.length || hasOptions) {
    lines.push(`${indent}php_fastcgi ${upstream} {`);
    if (index) lines.push(`${indent}\tindex ${index}`);
    if (splitPath?.length) lines.push(`${indent}\tsplit ${splitPath.join(" ")}`);
    for (const [k, v] of envEntries) lines.push(`${indent}\tenv ${k} ${caddyQuote(v)}`);
    if (php.captureStderr) lines.push(`${indent}\tcapture_stderr`);
    if (php.resolveRootSymlink) lines.push(`${indent}\tresolve_root_symlink`);
    if (php.dialTimeout) lines.push(`${indent}\tdial_timeout ${php.dialTimeout}`);
    if (php.readTimeout) lines.push(`${indent}\tread_timeout ${php.readTimeout}`);
    if (php.writeTimeout) lines.push(`${indent}\twrite_timeout ${php.writeTimeout}`);
    lines.push(`${indent}}`);
  } else {
    lines.push(`${indent}php_fastcgi ${upstream}`);
  }
  lines.push(`${indent}file_server`);
  return lines;
}


/** `import <snippet>` lines at the top of a site block (#288). */
export function buildImportLines(p: Pick<ProxyEntry, "imports">): string[] {
  return (p.imports ?? []).map(name => `\timport ${name}`);
}


/** `import name` of a snippet, as opposed to `import path/or/*glob`. */
export function isSnippetImportLine(trimmed: string): boolean {
  return /^import\s+[A-Za-z0-9][A-Za-z0-9_.-]*\s*$/.test(trimmed);
}


/** Builds handler lines for a route, at the given indent level (default single-tab). */
export function buildRouteHandlerLines(p: ProxyEntry, indent: string): string[] {
  const lines: string[] = [];
  // request_body must run before the handler that actually consumes the body (#154) —
  // static_response/redir never read the body at all, so the limit is skipped there.
  if (p.requestBodyMaxSize && !p.staticResponse && !p.redirect) {
    lines.push(`${indent}request_body {`, `${indent}\tmax_size ${p.requestBodyMaxSize}`, `${indent}}`);
  }
  if (p.staticResponse) {
    const { statusCode, body, close } = p.staticResponse;
    if (body && close) {
      lines.push(`${indent}respond ${caddyQuote(body, { always: true })} ${statusCode} {`);
      lines.push(`${indent}\tclose`);
      lines.push(`${indent}}`);
    } else if (body) {
      lines.push(`${indent}respond ${caddyQuote(body, { always: true })} ${statusCode}`);
    } else if (close) {
      lines.push(`${indent}respond ${statusCode} {`);
      lines.push(`${indent}\tclose`);
      lines.push(`${indent}}`);
    } else {
      lines.push(`${indent}respond ${statusCode}`);
    }
  } else if (p.redirect) {
    lines.push(`${indent}redir ${p.redirect.to} ${p.redirect.html ? "html" : p.redirect.code}`);
  } else if (p.fileServer) {
    if (p.compress) lines.push(...buildEncodeLines(indent, p.encodeOptions));
    if (p.basicAuth?.length) {
      lines.push(basicAuthOpenLine(indent, p.basicAuthOptions));
      for (const a of p.basicAuth) lines.push(`${indent}\t${a.username} ${a.passwordHash}`);
      lines.push(`${indent}}`);
    }
    for (const h of p.responseHeaders ?? []) {
      lines.push(headerOpLine(`${indent}header`, h, { quoteSet: true }));
    }
    lines.push(...buildFileServerLines(p.fileServer, indent));
  } else if (p.phpFastcgi) {
    if (p.compress) lines.push(...buildEncodeLines(indent, p.encodeOptions));
    if (p.basicAuth?.length) {
      lines.push(basicAuthOpenLine(indent, p.basicAuthOptions));
      for (const a of p.basicAuth) lines.push(`${indent}\t${a.username} ${a.passwordHash}`);
      lines.push(`${indent}}`);
    }
    for (const h of p.responseHeaders ?? []) {
      lines.push(headerOpLine(`${indent}header`, h, { quoteSet: true }));
    }
    lines.push(...buildPhpFastcgiLines(p.phpFastcgi, indent));
  } else {
    if (p.compress) lines.push(...buildEncodeLines(indent, p.encodeOptions));
    if (p.basicAuth?.length) {
      lines.push(basicAuthOpenLine(indent, p.basicAuthOptions));
      for (const a of p.basicAuth) lines.push(`${indent}\t${a.username} ${a.passwordHash}`);
      lines.push(`${indent}}`);
    }
    for (const h of p.responseHeaders ?? []) {
      lines.push(headerOpLine(`${indent}header`, h, { quoteSet: true, defer: true }));
    }
    if (p.rewrite) lines.push(...buildRewriteCaddyLines(p.rewrite, indent));
    if (p.forwardAuth) {
      // forward_auth needs slightly adjusted indentation relative to base
      const faLines = buildForwardAuthCaddyLines(p.forwardAuth).map(l => indent + l.replace(/^\t/, ""));
      lines.push(...faLines);
    }
    lines.push(...buildReverseProxyLines(p, p.errorHandlers).map(l => indent + l.replace(/^\t/, "")));
  }
  return lines;
}


export function proxyToBlock(p: ProxyEntry): string {
  // Plain-port redirect/respond blocks force http:// even when tls is on, since a
  // redirect/static response has no need for its own cert. buildExternalAddress already
  // forces http:// unconditionally whenever tls is off, so this only needs to handle the
  // tls-on case here — applying it regardless of p.tls would double up the prefix.
  const isPlainHttp = p.tls && !p.externalScheme && !p.externalHost && (p.redirect || p.staticResponse);
  const hostless = !tlsSubjectHosts(p.externalHost).length;
  const rawAddr = buildExternalAddress(p);
  const header = isPlainHttp ? `http://${rawAddr}` : rawAddr;
  const lines = p.label ? [`# label: ${p.label}`, `${header} {`] : [`${header} {`];
  lines.push(...buildImportLines(p));
  lines.push(...buildBindLines(p));

  if (hasAnyMatcher(p.matchers)) {
    const matcherName = `m${p.externalPort}`;
    const useHandlePath = p.handlePath && isPathOnlyMatcher(p.matchers) && !!(p.matchers.path?.length);
    // handle_path takes one path only (#255); several get a named matcher + a regex strip.
    const stripRegex = useHandlePath ? multiPathStripRegex(p.matchers) : undefined;
    const singleHandlePath = useHandlePath && !stripRegex;

    // handle_path strips the matched prefix itself and needs no named matcher.
    if (!singleHandlePath) lines.push(...buildMatcherCaddyLines(p.matchers, matcherName, "\t"));
    if (!p.staticResponse && !p.redirect) lines.push(...buildTlsCaddyLines(p, hostless));
    if (p.accessLog) lines.push(...buildLogCaddyLines(p.accessLog));
    lines.push(singleHandlePath ? `\thandle_path ${p.matchers.path!.join(" ")} {` : `\thandle @${matcherName} {`);
    if (stripRegex) lines.push(`\t\turi path_regexp ${caddyQuote(stripRegex)} /`);
    lines.push(...buildRouteHandlerLines(p, "\t\t"));
    lines.push("\t}");
  } else {
    // No matchers — original flat structure
    if (p.staticResponse) {
      if (p.accessLog) lines.push(...buildLogCaddyLines(p.accessLog));
      lines.push(...buildRouteHandlerLines(p, "\t"));
    } else if (p.redirect) {
      if (p.accessLog) lines.push(...buildLogCaddyLines(p.accessLog));
      lines.push(...buildRouteHandlerLines(p, "\t"));
    } else if (p.fileServer) {
      lines.push(...buildTlsCaddyLines(p, hostless));
      if (p.accessLog) lines.push(...buildLogCaddyLines(p.accessLog));
      lines.push(...buildRouteHandlerLines(p, "\t"));
    } else {
      lines.push(...buildTlsCaddyLines(p, hostless));
      if (p.accessLog) lines.push(...buildLogCaddyLines(p.accessLog));
      lines.push(...buildRouteHandlerLines(p, "\t"));
    }
  }

  if (p.errorHandlers?.length) lines.push(...buildErrorHandlerCaddyLines(p.errorHandlers));
  lines.push("}");
  return lines.join("\n");
}


/**
 * Patches a raw existing block in-place: preserves the header line and any custom
 * directives, while replacing only the top-level `tls` and `reverse_proxy` entries
 * with values from `proxy`. Used when the block was not created by this plugin
 * (e.g. migrated from a Caddyfile with `https://host:PORT {` headers).
 */
export function patchRawBlock(raw: string, proxy: ProxyEntry): string {
  const lines = raw.split("\n");
  const closingIdx = lines.length - 1;
  const kept: string[] = [lines[0]]; // preserve header exactly as-is
  let i = 1;
  let nestDepth = 0;
  const braces = (t: string) => (t.match(/\{/g) ?? []).length - (t.match(/\}/g) ?? []).length;
  /** Drops the directive at line i together with its nested `{ ... }` block, if it has one. */
  const skipDirective = () => {
    let depth = braces(lines[i].trim());
    i++;
    while (i < closingIdx && depth > 0) {
      depth += braces(lines[i].trim());
      i++;
    }
  };
  const isDirective = (trimmed: string, name: string) =>
    trimmed === name || trimmed.startsWith(`${name} `) || trimmed.startsWith(`${name}\t`) || trimmed === `${name}{`;

  // A site with `route` or nested `handle` blocks (#348) is edited in its Tree tab or the raw editor:
  // what the form owns here is the site's address, binds, imports and TLS, and the blocks stay as written.
  const nested = hasNestedBlocks(raw);
  // The directives the plugin writes again below are dropped here, each with its whole block
  // (tls, bind and snippet imports on every site, and these).
  const rewritten = nested ? [] : ["encode", "root", "templates", "file_server", "header", "basic_auth", "forward_auth", "reverse_proxy", "php_fastcgi"];
  // try_files belongs to the static and PHP forms (#262); on any other site it's the user's.
  if ((proxy.fileServer || proxy.phpFastcgi) && !nested) rewritten.push("try_files");

  // Where the block had its snippet imports, binds and tls: they are written again in that place,
  // so a save that changes none of them leaves the text as it was (#349).
  // Each place is [index in kept, how many places were found before it], which orders two at one index.
  let importSlot: [number, number] | undefined;
  let bindSlot: [number, number] | undefined;
  let tlsSlot: [number, number] | undefined;
  let found = 0;
  const here = (): [number, number] => [kept.length, found++];
  while (i < closingIdx) {
    const line = lines[i];
    const trimmed = line.trim();

    if (nestDepth === 0 && isDirective(trimmed, "tls")) {
      tlsSlot ??= here();
      skipDirective();
      continue;
    }
    if (nestDepth === 0 && rewritten.some(name => isDirective(trimmed, name))) {
      skipDirective();
      continue;
    }
    // Snippet imports (#288) follow proxy.imports; file and glob imports are the user's and stay.
    if (nestDepth === 0 && isSnippetImportLine(trimmed)) {
      importSlot ??= here();
      i++;
      continue;
    }
    // The form shows every bind the site has (#323), its own and hand-written ones, so it owns the
    // bind line: a cleared field removes it.
    if (nestDepth === 0 && isDirective(trimmed, "bind")) {
      bindSlot ??= here();
      i++;
      continue;
    }

    nestDepth += braces(trimmed);
    kept.push(line);
    i++;
  }

  const tlsLines = buildTlsCaddyLines(proxy, !tlsSubjectHosts(proxy.externalHost).length);
  // Inserted from the last place to the first, so the earlier places keep their index.
  // New imports and a new bind line go first in the block, imports before the bind.
  const inserts = [
    { at: importSlot ?? [1, -2], add: buildImportLines(proxy) },
    { at: bindSlot ?? [1, -1], add: buildBindLines(proxy) },
    ...(tlsSlot ? [{ at: tlsSlot, add: tlsLines }] : []),
  ].sort((a, b) => b.at[0] - a.at[0] || b.at[1] - a.at[1]);
  for (const { at, add } of inserts) kept.splice(at[0], 0, ...add);
  // A block without a tls directive gets it before the handlers the form writes.
  if (tlsSlot === undefined) kept.push(...tlsLines);
  if (nested) {
    kept.push(lines[closingIdx]);
    return kept.join("\n");
  }
  if (proxy.fileServer) {
    if (proxy.compress) kept.push(...buildEncodeLines("\t", proxy.encodeOptions));
    if (proxy.basicAuth?.length) kept.push(...buildBasicAuthCaddyLines(proxy.basicAuth, proxy.basicAuthOptions));
    for (const h of proxy.responseHeaders ?? []) {
      kept.push(headerOpLine(`\theader`, h, { quoteSet: true }));
    }
    kept.push(...buildFileServerLines(proxy.fileServer, "\t"));
  } else if (proxy.phpFastcgi) {
    // A hand-written PHP site (#247): its root/php_fastcgi/file_server were skipped above.
    if (proxy.compress) kept.push(...buildEncodeLines("\t", proxy.encodeOptions));
    if (proxy.basicAuth?.length) kept.push(...buildBasicAuthCaddyLines(proxy.basicAuth, proxy.basicAuthOptions));
    for (const h of proxy.responseHeaders ?? []) kept.push(headerOpLine("\theader", h, { quoteSet: true }));
    kept.push(...buildPhpFastcgiLines(proxy.phpFastcgi, "\t"));
  } else {
    if (proxy.compress) kept.push(...buildEncodeLines("\t", proxy.encodeOptions));
    if (proxy.basicAuth?.length) kept.push(...buildBasicAuthCaddyLines(proxy.basicAuth, proxy.basicAuthOptions));
    // `header` lines were dropped above with the other rewritten directives.
    for (const h of proxy.responseHeaders ?? []) kept.push(headerOpLine("\theader", h, { quoteSet: true, defer: true }));
    if (proxy.forwardAuth) kept.push(...buildForwardAuthCaddyLines(proxy.forwardAuth));
    kept.push(...buildReverseProxyLines(proxy, proxy.errorHandlers));
  }
  if (proxy.errorHandlers?.length) kept.push(...buildErrorHandlerCaddyLines(proxy.errorHandlers));
  kept.push(lines[closingIdx]); // closing }
  return kept.join("\n");
}


/**
 * Writes a proxy to the conf.d content surgically:
 * - If the block doesn't exist yet: appends a fresh plugin-format block.
 * - If the block was created by this plugin (`:PORT {` header): replaces it entirely.
 * - If the block was migrated (e.g. `https://host:PORT {` header): patches only the
 *   `tls` and `reverse_proxy` directives, preserving the header and any other directives.
 */
export function surgicallyWriteProxy(content: string, proxy: ProxyEntry): string {
  const lines = content.split("\n");
  const pos = findMatchingBlock(findBlockPositions(lines), proxy.externalPort, proxy.externalHost);

  if (!pos) {
    const base = content.trim() ? content.trimEnd() : CONF_HEADER;
    return base + "\n\n" + proxyToBlock(proxy) + "\n";
  }

  const start = pos.labelLine ?? pos.headerLine;
  const headerLine = lines[pos.headerLine].trim();
  // Recognizes every shape buildExternalAddress can produce for this port — bare
  // `:PORT`, `http://:PORT`, `host:PORT`, and `scheme://host:PORT`, or a list of
  // them for several names (#208) — so a header the plugin previously wrote with a
  // hostname/scheme is still safe to fully regenerate (needed to let a later edit
  // clear the hostname/scheme again; otherwise it looked like a hand-edited block
  // and was preserved verbatim).
  const headerAddresses = parseSiteAddresses(headerLine.replace(/\{$/, "").trim());
  const isPluginFormat = !!headerAddresses?.every(a => a.port === proxy.externalPort && !a.path)
    // A block with route or nested handle blocks (#348) is never written afresh, whoever wrote it.
    && !hasNestedBlocks(lines.slice(pos.headerLine, pos.closingLine + 1).join("\n"));

  let body: string;
  if (isPluginFormat) {
    body = proxyToBlock(proxy);
  } else {
    const existingRaw = lines.slice(pos.headerLine, pos.closingLine + 1).join("\n");
    let patchedBody = patchRawBlock(existingRaw, proxy);
    // A hand-written header stays as written while it still names the same hosts;
    // once the names change, it is the old address and gets replaced (#208).
    if (!sameHostSet(pos.hosts, externalHostList(proxy.externalHost))) {
      const nl = patchedBody.indexOf("\n");
      patchedBody = `${buildExternalAddress(proxy)} {` + (nl === -1 ? "" : patchedBody.slice(nl));
    }
    body = proxy.label ? `# label: ${proxy.label}\n${patchedBody}` : patchedBody;
  }

  return [
    ...lines.slice(0, start),
    body,
    ...lines.slice(pos.closingLine + 1),
  ].join("\n");
}


/**
 * conf.d content after editing a standalone proxy. While the edited site still shares a
 * name with the original (or both are hostless), surgicallyWriteProxy finds and rewrites
 * the original block in place, so a name added to or dropped from the list (#208) keeps
 * the block where it was. A new port or an unrelated name removes the old block and
 * writes the site afresh.
 */
export function surgicallyEditProxy(
  content: string,
  original: Pick<ProxyEntry, "externalPort" | "externalHost" | "matchers"> | undefined,
  entry: ProxyEntry,
): string {
  const originalPort = original?.externalPort ?? entry.externalPort;
  const originalHosts = original ? routeHosts(original) : undefined;
  let updated = content;
  if (originalPort !== entry.externalPort || !hostsConflict(originalHosts, routeHosts(entry))) {
    // A site with route or nested handle blocks (#348) moves to its new address with its blocks.
    const lines = content.split("\n");
    const pos = findMatchingBlock(findBlockPositions(lines), originalPort, originalHosts?.join(", "));
    const raw = pos ? lines.slice(pos.headerLine, pos.closingLine + 1).join("\n") : undefined;
    if (pos && raw && hasNestedBlocks(raw)) {
      const patched = patchRawBlock(raw, entry);
      const nl = patched.indexOf("\n");
      const moved = `${buildExternalAddress(entry)} {` + (nl === -1 ? "" : patched.slice(nl));
      const body = entry.label ? `# label: ${entry.label}\n${moved}` : moved;
      const start = pos.labelLine ?? pos.headerLine;
      return [...lines.slice(0, start), body, ...lines.slice(pos.closingLine + 1)].join("\n");
    }
    updated = surgicallyRemoveBlock(updated, originalPort, originalHosts?.join(", "));
  }
  return surgicallyWriteProxy(updated, entry);
}


export function proxiesToCaddyfile(proxies: ProxyEntry[]): string {
  if (proxies.length === 0) return CONF_HEADER + "\n\n";
  return CONF_HEADER + "\n\n" + proxies.map(proxyToBlock).join("\n\n") + "\n";
}


/** The error message upstream errors are re-raised with (#255); handle_errors sees it as {err.message}. */
export const UPSTREAM_ERROR_MESSAGE = "upstream error";


/**
 * The site's `bind` line. The host only matches the Host header, an IP host too: as in Caddy,
 * only `bind` restricts the listener (#323). The JSON push listens on the same addresses (#254).
 */
export function buildBindLines(proxy: { externalHost?: string; bind?: string[] }): string[] {
  const addresses = siteBindAddresses(proxy);
  return addresses.length ? [`\tbind ${addresses.join(" ")}`] : [];
}


/** A bind or listen host as Caddy writes it in a listen address: an IPv6 address in brackets. */
export function canonicalBindHost(host: string): string {
  const h = host.trim();
  return !h.startsWith("[") && h.includes(":") && /^[0-9A-Fa-f:.]+(%[\w.-]+)?$/.test(h) ? `[${h}]` : h;
}


/**
 * Every address a site binds to, once each, as Caddy writes them (#323). The Caddyfile's `bind`
 * line and the JSON push's listen addresses are both built from it.
 */
export function siteBindAddresses(proxy: { bind?: string[] }): string[] {
  return [...new Set((proxy.bind ?? []).map(canonicalBindHost).filter(Boolean))];
}


/** A hostname usable as an automation-policy `subjects` entry — a real public-looking domain. */
export function tlsSubjectHost(host: string | undefined): string | undefined {
  return host && !isCaddyInternalSubject(host) ? host : undefined;
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


/** Extracts a usable subject hostname from a named server's first listen address, if any (e.g. "example.com:443"). */
export function namedServerSubjectHost(def: { listenAddresses: string[] }): string | undefined {
  const addr = def.listenAddresses[0];
  if (!addr) return undefined;
  const colonIdx = addr.lastIndexOf(":");
  const host = colonIdx > 0 ? addr.slice(0, colonIdx) : "";
  return tlsSubjectHost(host || undefined);
}


/** True if none of a named server's listen addresses have a real (non-IP) hostname. Used by the TLS UI to warn that a lifetime/renewal-window setting is shared across every hostless internal-TLS proxy/server. */
export function namedServerIsHostless(listenAddresses: string[]): boolean {
  return !namedServerSubjectHost({ listenAddresses });
}


export function parseServerDefsFromConf(content: string): import("./types").ServerDef[] {
  const defs: import("./types").ServerDef[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const keyMatch = lines[i].match(/^# server: (.+)$/);
    if (!keyMatch) continue;
    const key = keyMatch[1].trim();

    // Optional embedded serverdef comment on the very next line
    const nextLine = lines[i + 1] ?? "";
    const defMatch = nextLine.match(/^# serverdef: (.+)$/);

    // Resolve listen addresses from the first non-comment, non-blank block header line
    const listenAddresses: string[] = [];
    const scanFrom = defMatch ? i + 2 : i + 1;
    for (let j = scanFrom; j < lines.length; j++) {
      const line = lines[j].trim();
      if (!line || line.startsWith("#")) continue;
      const m = line.match(/^(.+?)\s*\{/);
      if (m) {
        // Strip the http:// forced onto a TLS-disabled server's addresses (see
        // serverDefToBlock) — listenAddresses itself never carries a scheme.
        const parts = m[1].trim().split(/\s+/).map(p => p.replace(/^https?:\/\//, ""));
        listenAddresses.push(...parts.filter(p => /:\d+/.test(p)));
      }
      break;
    }

    if (defMatch) {
      try {
        const p = JSON.parse(defMatch[1]) as Partial<import("./types").ServerDef>;
        defs.push({
          key,
          name: p.name ?? key,
          listenAddresses,
          tls: p.tls ?? false,
          tlsAdvanced: p.tlsAdvanced,
          mtls: p.mtls,
          serverReadTimeout: p.serverReadTimeout,
          serverReadHeaderTimeout: p.serverReadHeaderTimeout,
          serverWriteTimeout: p.serverWriteTimeout,
          serverIdleTimeout: p.serverIdleTimeout,
          maxHeaderBytes: p.maxHeaderBytes,
          disableHttp3: p.disableHttp3,
          serverExtras: p.serverExtras,
          accessLog: p.accessLog,
          errorHandlers: p.errorHandlers,
          routeLabels: p.routeLabels,
        });
      } catch {
        defs.push({ key, name: key, listenAddresses, tls: false });
      }
    } else {
      // Legacy block without embedded comment — minimal def
      defs.push({ key, name: key, listenAddresses, tls: false });
    }
  }
  return defs;
}


/** Builds a single route's handler lines for use inside a server block (at depth-2). */
export function buildRouteBodyForServer(route: ProxyEntry): string[] {
  return buildRouteHandlerLines(route, "\t\t");
}


/**
 * Generates the complete Caddyfile block for a named multi-route server.
 * Returns the block string (including `# server: key` comment header).
 * Named routes (isNamedRoute=true) are also emitted as snippet preamble.
 */
export function serverDefToBlock(def: import("./types").ServerDef, routes: ProxyEntry[]): { preamble: string; block: string } {
  const snippets: string[] = [];
  const namedRoutes = routes.filter(r => r.isNamedRoute && r.namedRouteName);
  const normalRoutes = routes.filter(r => !r.isNamedRoute);

  // Snippets go before the server block in the conf.d file
  for (const nr of namedRoutes) {
    snippets.push(`&(${nr.namedRouteName!}) {`);
    snippets.push(...buildRouteBodyForServer(nr));
    snippets.push("}");
  }

  if (def.listenAddresses.length === 0) {
    throw new Error(`Server '${def.key}' has no listen addresses — cannot generate Caddyfile block`);
  }
  // A schemeless address with TLS off is still eligible for Caddy's automatic HTTPS
  // (only an explicit http:// scheme is excluded — see buildExternalAddress), so it can
  // silently claim the shared internal-issuer catch-all policy and conflict with any
  // other hostless site that has an explicit custom lifetime. Force http:// on every
  // listen address when TLS is disabled, same as buildExternalAddress does for proxies.
  const addr = def.tls
    ? def.listenAddresses.join(" ")
    : def.listenAddresses.map(a => `http://${a}`).join(" ");
  // Embed server def as a comment so syncConf can reconstruct it without a separate JSON file.
  // Keys with undefined values are omitted by JSON.stringify.
  const defPayload = {
    name: def.name,
    tls: def.tls || undefined,
    tlsAdvanced: def.tlsAdvanced,
    mtls: def.mtls,
    serverReadTimeout: def.serverReadTimeout,
    serverReadHeaderTimeout: def.serverReadHeaderTimeout,
    serverWriteTimeout: def.serverWriteTimeout,
    serverIdleTimeout: def.serverIdleTimeout,
    maxHeaderBytes: def.maxHeaderBytes,
    disableHttp3: def.disableHttp3 || undefined,
    serverExtras: def.serverExtras,
    accessLog: def.accessLog,
    errorHandlers: def.errorHandlers?.length ? def.errorHandlers : undefined,
    routeLabels: def.routeLabels && Object.keys(def.routeLabels).length ? def.routeLabels : undefined,
  };
  const lines: string[] = [`# server: ${def.key}`, `# serverdef: ${JSON.stringify(defPayload)}`, `${addr} {`];

  // Server-level TLS
  if (def.tls) {
    const tlsMock = { tls: def.tls, tlsAdvanced: def.tlsAdvanced, mtls: def.mtls };
    lines.push(...buildTlsCaddyLines(tlsMock, namedServerIsHostless(def.listenAddresses)));
  }
  // Server-level access log
  if (def.accessLog) lines.push(...buildLogCaddyLines(def.accessLog));

  // Routes: matcher routes first, catch-all last
  const matcherRoutes = normalRoutes.filter(r => hasAnyMatcher(r.matchers));
  const catchAllRoutes = normalRoutes.filter(r => !hasAnyMatcher(r.matchers));

  for (let i = 0; i < matcherRoutes.length; i++) {
    const route = matcherRoutes[i];
    const matcherName = `r${i}`;
    const useHandlePath = route.handlePath && isPathOnlyMatcher(route.matchers!) && !!(route.matchers!.path?.length);
    const stripRegex = useHandlePath ? multiPathStripRegex(route.matchers) : undefined;
    if (useHandlePath && !stripRegex) {
      const paths = route.matchers!.path!.join(" ");
      lines.push(`\thandle_path ${paths} {`);
      lines.push(...buildRouteBodyForServer(route));
      lines.push("\t}");
    } else {
      lines.push(...buildMatcherCaddyLines(route.matchers!, matcherName, "\t"));
      lines.push(`\thandle @${matcherName} {`);
      // handle_path takes one path only (#255); several get a regex strip.
      if (stripRegex) lines.push(`\t\turi path_regexp ${caddyQuote(stripRegex)} /`);
      lines.push(...buildRouteBodyForServer(route));
      lines.push("\t}");
    }
  }

  for (const route of catchAllRoutes) {
    lines.push("\thandle {");
    lines.push(...buildRouteBodyForServer(route));
    lines.push("\t}");
  }

  // Named-route invoke directives
  for (const nr of namedRoutes) {
    if (hasAnyMatcher(nr.matchers)) {
      const matcherName = `nr_${nr.namedRouteName!}`;
      lines.push(...buildMatcherCaddyLines(nr.matchers, matcherName, "\t"));
      lines.push(`\thandle @${matcherName} {`);
      lines.push(`\t\tinvoke ${nr.namedRouteName!}`);
      lines.push("\t}");
    } else {
      lines.push(`\tinvoke ${nr.namedRouteName!}`);
    }
  }

  // Server-level error handlers
  if (def.errorHandlers?.length) lines.push(...buildErrorHandlerCaddyLines(def.errorHandlers));

  lines.push("}");

  return {
    preamble: snippets.join("\n"),
    block: lines.join("\n"),
  };
}


/**
 * Writes (inserts or replaces) a named server block in conf.d content.
 * Removes ALL existing blocks for the key first (deduplicates from past append bugs),
 * then appends the freshly generated block.
 */
export function surgicallyWriteServerBlock(content: string, def: import("./types").ServerDef, routes: ProxyEntry[]): string {
  const { preamble, block } = serverDefToBlock(def, routes);
  const fullBlock = preamble ? `${preamble}\n\n${block}` : block;

  // Remove every existing block for this key so we never produce duplicates
  let cleaned = content;
  while (findServerBlock(cleaned.split("\n"), def.key)) {
    cleaned = surgicallyRemoveServerBlock(cleaned, def.key);
  }

  const base = cleaned.trim() ? cleaned.trimEnd() : CONF_HEADER;
  return base + "\n\n" + fullBlock + "\n";
}
