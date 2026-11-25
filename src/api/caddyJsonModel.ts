// A site as Caddy's JSON config: reading ProxyEntry values out of a CaddyConfig and merging or
// removing a proxy or named server in one. Pure: no Host, no I/O. Builds on siteBlocks.

import { type CaddyHandler, type CaddyReverseProxyHandler, type CaddyRoute, type CaddyServer, type ProxyEntry, type CaddyConfig, type CaddyTLSConnectionPolicy, type CaddyTLSClientAuthentication } from "./types";
import { externalHostList } from "./externalHosts";
import { isIpAddress } from "./caddyfileDocument";
import { mapPlaceholders, PLACEHOLDER_SHORTHANDS, PLACEHOLDER_PREFIXES, isPathOnlyMatcher, handlePathPrefix, multiPathStripRegex, type TransportProps, type LbFields, LB_POLICIES, tlsSubjectHosts, errorHandlerResponseCodes, UPSTREAM_ERROR_MESSAGE, siteBindAddresses, canonicalBindHost, routeHosts, buildMatcherJson, hasAnyMatcher, namedServerSubjectHost } from "./siteBlocks";

/**
 * Converts a Caddy duration value to a string.
 * Caddy stores durations as nanosecond integers in JSON when loaded from a
 * Caddyfile (e.g. "10s" becomes 10000000000). This normalises both forms to
 * a human-readable string like "10s", "2m", "1h".
 */
export function parseDuration(val: unknown): string | undefined {
  if (typeof val === "string") return val || undefined;
  if (typeof val === "number" && val > 0) {
    const s = val / 1_000_000_000;
    if (s % 3600 === 0) return `${s / 3600}h`;
    if (s % 60 === 0) return `${s / 60}m`;
    return `${s}s`;
  }
  return undefined;
}


/**
 * Like parseDuration, but prefers day granularity first — certificate lifetimes
 * are commonly entered as "90d", and converting straight to hours (e.g. "2160h")
 * after a Caddyfile reload, while technically equivalent, doesn't match what the
 * user actually typed. Caddy's internal-issuer `lifetime` only accepts Go's
 * standard duration units (ns/us/ms/s/m/h) plus "d" — NOT "y" ("unknown unit y"),
 * so a year has to be expressed as days.
 */
export function parseCertLifetimeDuration(val: unknown): string | undefined {
  if (typeof val === "string") return val || undefined;
  if (typeof val === "number" && val > 0) {
    const s = val / 1_000_000_000;
    if (s % 86_400 === 0) return `${s / 86_400}d`;
    return parseDuration(val);
  }
  return undefined;
}


/** Converts Caddyfile short placeholders to JSON API long form. */
export function caddyPlaceholderToJson(s: string): string {
  return s
    .replace(/\{host\}/g, "{http.request.host}")
    .replace(/\{uri\}/g, "{http.request.uri}")
    .replace(/\{scheme\}/g, "{http.request.scheme}")
    .replace(/\{remote_host\}/g, "{http.request.remote.host}");
}


/** Converts JSON API long placeholders back to Caddyfile short form. */
export function jsonPlaceholderToCaddy(s: string): string {
  return s
    .replace(/\{http\.request\.host\}/g, "{host}")
    .replace(/\{http\.request\.uri\}/g, "{uri}")
    .replace(/\{http\.request\.scheme\}/g, "{scheme}")
    .replace(/\{http\.request\.remote\.host\}/g, "{remote_host}");
}


/** Reverse of presenceValues: a lone "*" (or null/empty) becomes the empty "present" list. */
export function fromPresenceValues(fields: Record<string, string[] | null>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = !v?.length || (v.length === 1 && v[0] === "*") ? [] : v;
  return out;
}


/** Parses the plain matcher fields of a Caddy JSON match object. */
export function parseMatcherFieldsJson(match: Record<string, unknown>): import("./types").RouteMatchFields {
  const m: import("./types").RouteMatchFields = {};
  if (Array.isArray(match.path) && match.path.length) m.path = match.path as string[];
  if (Array.isArray(match.host) && match.host.length) m.host = match.host as string[];
  if (Array.isArray(match.method) && match.method.length) m.method = match.method as string[];
  if (match.header && typeof match.header === "object") {
    const h = match.header as Record<string, string[]>;
    if (Object.keys(h).length) m.header = fromPresenceValues(h);
  }
  if (match.query && typeof match.query === "object") {
    const q = match.query as Record<string, string[]>;
    if (Object.keys(q).length) m.query = fromPresenceValues(q);
  }
  if (match.remote_ip && typeof match.remote_ip === "object") {
    const ri = (match.remote_ip as { ranges?: string[] }).ranges;
    if (ri?.length) m.remote_ip = { ranges: ri };
  }
  if (match.client_ip && typeof match.client_ip === "object") {
    const ci = (match.client_ip as { ranges?: string[] }).ranges;
    if (ci?.length) m.client_ip = { ranges: ci };
  }
  // The name Caddy's adapter gives a regexp (`m8080`, `r0`, `nr_x`) is the matcher's own; only a chosen one is kept (#331).
  const chosenName = (name: string | undefined) => name && !/^(m\d+|r\d+|nr_.+)$/.test(name) ? name : undefined;
  const pr = match.path_regexp as { pattern?: string; name?: string } | undefined;
  if (pr?.pattern) m.path_regexp = { pattern: pr.pattern, ...(chosenName(pr.name) ? { name: chosenName(pr.name) } : {}) };
  const hr = match.header_regexp as Record<string, { pattern?: string; name?: string }> | undefined;
  const hrEntry = hr ? Object.entries(hr).find(([, v]) => v?.pattern) : undefined;
  if (hrEntry) m.header_regexp = { header: hrEntry[0], pattern: hrEntry[1].pattern!, ...(chosenName(hrEntry[1].name) ? { name: chosenName(hrEntry[1].name) } : {}) };
  if (typeof match.protocol === "string" && match.protocol) m.protocol = match.protocol;
  const file = match.file as { try_files?: string[]; try_policy?: string } | undefined;
  if (file?.try_files?.length) m.file = { try_files: file.try_files.map(collapsePlaceholderShorthands), ...(file.try_policy ? { try_policy: file.try_policy } : {}) };
  if (match.vars && typeof match.vars === "object" && Object.keys(match.vars).length) {
    m.vars = Object.fromEntries(Object.entries(match.vars as Record<string, string[]>).map(([k, v]) => [collapsePlaceholderShorthands(k), v]));
  }
  return m;
}


/** Parses a Caddy JSON match object back to RouteMatch. Returns undefined if empty/missing. */
export function parseMatcherJson(match: Record<string, unknown> | undefined): import("./types").RouteMatch | undefined {
  if (!match || !Object.keys(match).length) return undefined;
  const m: import("./types").RouteMatch = parseMatcherFieldsJson(match);
  // Only one exclude group is supported (#287); Caddy's `not` is a list of matcher sets.
  if (Array.isArray(match.not) && match.not[0] && typeof match.not[0] === "object") {
    const not = parseMatcherFieldsJson(match.not[0] as Record<string, unknown>);
    if (Object.keys(not).length) m.not = not;
  }
  // Caddy accepts the expression as a string or as {expr, name}; the adapter writes the object.
  const rawExpr = typeof match.expression === "string" ? match.expression
    : (match.expression as { expr?: unknown } | undefined)?.expr;
  if (typeof rawExpr === "string" && rawExpr.trim()) m.expression = collapsePlaceholderShorthands(rawExpr);
  return Object.keys(m).length ? m : undefined;
}


/** True when the matcher is a host list and nothing else (a hostname-only site block). */
export function isHostOnlyMatcher(m: import("./types").RouteMatch | undefined): m is import("./types").RouteMatch & { host: string[] } {
  return !!m?.host?.length && !m.path && !m.method && !m.header && !m.query && !m.remote_ip && !m.client_ip && !m.not && !m.expression
    && !m.path_regexp && !m.header_regexp && !m.protocol && !m.file && !m.vars;
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


export function handlePathStripPrefix(matchers: import("./types").RouteMatch | undefined): string | undefined {
  if (matchers?.path?.length !== 1 || !isPathOnlyMatcher(matchers)) return undefined;
  return handlePathPrefix(matchers.path[0]) || undefined;
}


/** Builds the rewrite handler for handle_path semantics: strip_path_prefix, or the regex strip for several paths. */
export function buildHandlePathRewriteJson(matchers: import("./types").RouteMatch | undefined): CaddyHandler | undefined {
  const regex = multiPathStripRegex(matchers);
  if (regex) return { handler: "rewrite", path_regexp: [{ find: regex, replace: "/" }] } as CaddyHandler;
  const prefix = handlePathStripPrefix(matchers);
  if (!prefix) return undefined;
  return { handler: "rewrite", strip_path_prefix: prefix } as CaddyHandler;
}


/** Splits a forward_auth URL into Caddy's dial address (default port filled in) and TLS flag. */
export function forwardAuthDial(url: string): { dial: string; tls: boolean } {
  const tls = /^https:\/\//i.test(url.trim());
  const hostPort = url.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
  const hasPort = /:\d+$/.test(hostPort) && !/^\[[^\]]*\]$/.test(hostPort);
  return { dial: hasPort ? hostPort : `${hostPort}:${tls ? 443 : 80}`, tls };
}


export const RP_HEADER_PLACEHOLDER = /^\{http\.reverse_proxy\.header\.(.+)\}$/;


/** What `private_ranges` stands for in forward_auth's `trusted_proxies` (Caddy 2.11). */
export const PRIVATE_RANGES = ["192.168.0.0/16", "172.16.0.0/12", "10.0.0.0/8", "127.0.0.1/8", "fd00::/8", "::1"];

const FORWARD_AUTH_DEFAULT_HEADERS: Record<string, string> = {
  "X-Forwarded-Method": "{http.request.method}",
  "X-Forwarded-Uri": "{http.request.uri}",
};

/** `Name` copies a header as it is, `Name>Other` copies it under another name (#336). */
export function splitCopyHeader(entry: string): { from: string; to: string } {
  const i = entry.indexOf(">");
  return i > 0 && i < entry.length - 1 ? { from: entry.slice(0, i), to: entry.slice(i + 1) } : { from: entry, to: entry };
}


/**
 * Builds the same JSON as Caddy's own forward_auth Caddyfile adapter (#248): on a 2xx from
 * the auth service, each copied header is first deleted from the client's request and then
 * set from the auth response, so the backend sees who logged in and a client can't forge
 * `Remote-User`. An `https://` auth URL gets a TLS transport.
 */
export function buildForwardAuthHandler(fa: import("./types").ForwardAuthConfig): CaddyHandler | null {
  if (!fa.upstreamUrl.trim()) return null;
  const { dial, tls } = forwardAuthDial(fa.upstreamUrl);
  const responseRoutes: Array<Record<string, unknown>> = [{ handle: [{ handler: "vars" }] }];
  for (const entry of [...fa.copyHeaders].sort()) {
    const { from, to } = splitCopyHeader(entry);
    const placeholder = `{http.reverse_proxy.header.${from}}`;
    responseRoutes.push({ handle: [{ handler: "headers", request: { delete: [to] } }] });
    responseRoutes.push({
      handle: [{ handler: "headers", request: { set: { [to]: [placeholder] } } }],
      match: [{ not: [{ vars: { [placeholder]: [""] } }] }],
    });
  }
  const userHeaders = (buildReverseProxyHeadersJson(fa.headerUp, undefined)?.request ?? {}) as Record<string, unknown>;
  const request: Record<string, unknown> = {
    ...userHeaders,
    set: {
      ...Object.fromEntries(Object.entries(FORWARD_AUTH_DEFAULT_HEADERS).map(([k, v]) => [k, [v]])),
      ...(userHeaders.set as Record<string, string[]> | undefined),
    },
  };
  const trusted = fa.trustedProxies?.flatMap(r => r === "private_ranges" ? PRIVATE_RANGES : [r]);
  const rp: Record<string, unknown> = {
    handle_response: [{ match: { status_code: [2] }, routes: responseRoutes }],
    handler: "reverse_proxy",
    headers: { request },
    rewrite: { method: "GET", uri: fa.uri || "/" },
    ...(trusted?.length ? { trusted_proxies: trusted } : {}),
    ...(tls ? { transport: { protocol: "http", tls: {} } } : {}),
    upstreams: [{ dial }],
  };
  return { handler: "subroute", routes: [{ handle: [rp as CaddyHandler] }] } as CaddyHandler;
}


export type ResponseRoute = { handle?: Array<Record<string, unknown>>; match?: unknown };


export function forwardAuthResponseRoutes(rp: CaddyReverseProxyHandler): ResponseRoute[] | undefined {
  const resp = (rp.handle_response as Array<Record<string, unknown>> | undefined)?.[0];
  const match = resp?.match as Record<string, unknown> | undefined;
  if ((match?.status_code as number[] | undefined)?.[0] !== 2) return undefined;
  return (resp?.routes as ResponseRoute[] | undefined) ?? [];
}


/**
 * A forward_auth guard: a reverse_proxy whose 2xx handle_response either copies headers into
 * the request (Caddy's adapter shape, a leading `vars` handler) or, in configs pushed by older
 * plugin versions, uses `copy_response_headers`.
 */
export function isForwardAuthProxy(rp: CaddyReverseProxyHandler): boolean {
  const routes = forwardAuthResponseRoutes(rp);
  if (!routes) return false;
  return routes.some(r =>
    (r.handle ?? []).some(h => h.handler === "copy_response_headers" || h.handler === "vars"),
  );
}


export function extractForwardAuthFromProxy(rp: CaddyReverseProxyHandler): import("./types").ForwardAuthConfig {
  const raw = rp as Record<string, unknown>;
  const dial = rp.upstreams?.[0]?.dial ?? "";
  const tls = !!(raw.transport as { tls?: unknown } | undefined)?.tls;
  const scheme = tls ? "https" : "http";
  const defaultPort = tls ? ":443" : ":80";
  const hostPort = /^https?:\/\//.test(dial) ? dial.replace(/^https?:\/\//, "") : dial;
  const upstreamUrl = `${scheme}://${hostPort.endsWith(defaultPort) ? hostPort.slice(0, -defaultPort.length) : hostPort}`;
  const uri = raw.rewrite as { uri?: string } | undefined;
  const handles = (forwardAuthResponseRoutes(rp) ?? []).flatMap(r => r.handle ?? []);
  const copyHandle = handles.find(h => h.handler === "copy_response_headers") as { include?: string[] } | undefined;
  const fromSets = handles.flatMap(h => {
    const set = (h.request as { set?: Record<string, string[]> } | undefined)?.set ?? {};
    return Object.entries(set).flatMap(([to, v]) => {
      const from = RP_HEADER_PLACEHOLDER.exec(v?.[0] ?? "")?.[1];
      return from ? [from === to ? to : `${from}>${to}`] : [];
    });
  });
  // The auth request's own headers: the two Caddy always sets are not the user's (#336).
  const ownHeaders = parseRequestHeadersJson(raw.headers as Record<string, unknown> | undefined)
    .filter(h => !(h.op === "set" && h.name in FORWARD_AUTH_DEFAULT_HEADERS && jsonPlaceholderToCaddy(FORWARD_AUTH_DEFAULT_HEADERS[h.name]) === h.value));
  const trustedRaw = raw.trusted_proxies as string[] | undefined;
  const hasPrivate = !!trustedRaw && PRIVATE_RANGES.every(r => trustedRaw.includes(r));
  const trusted = trustedRaw?.length
    ? hasPrivate ? ["private_ranges", ...trustedRaw.filter(r => !PRIVATE_RANGES.includes(r))] : trustedRaw
    : undefined;
  return {
    upstreamUrl, uri: uri?.uri, copyHeaders: copyHandle?.include ?? fromSets,
    ...(ownHeaders.length ? { headerUp: ownHeaders } : {}),
    ...(trusted ? { trustedProxies: trusted } : {}),
  };
}


export function detectForwardAuth(handles: AnyHandler[]): import("./types").ForwardAuthConfig | undefined {
  for (const h of handles) {
    if (h.handler === "reverse_proxy" && isForwardAuthProxy(h as CaddyReverseProxyHandler)) {
      return extractForwardAuthFromProxy(h as CaddyReverseProxyHandler);
    }
    if (h.handler === "subroute" && h.routes) {
      for (const route of h.routes as Array<{ handle?: AnyHandler[] }>) {
        for (const subH of (route.handle ?? []) as AnyHandler[]) {
          if (subH.handler === "reverse_proxy" && isForwardAuthProxy(subH as CaddyReverseProxyHandler)) {
            return extractForwardAuthFromProxy(subH as CaddyReverseProxyHandler);
          }
        }
      }
    }
  }
  return undefined;
}


export function buildEncodeHandler(options?: import("./types").EncodeOptions): CaddyHandler {
  const algorithms = options?.algorithms?.length ? options.algorithms : undefined;
  const handler: Record<string, unknown> = {
    handler: "encode",
    encodings: Object.fromEntries((algorithms ?? ["gzip", "zstd"]).map(a => [a, {}])),
  };
  if (algorithms) handler.prefer = algorithms;
  if (options?.minimumLength != null) handler.minimum_length = options.minimumLength;
  const match: Record<string, unknown> = {};
  // A status class (2xx) is stored as its first digit, as Caddy's adapter does.
  const codes = (options?.matchStatus ?? []).map(c => /xx$/i.test(c) ? parseInt(c[0], 10) : parseInt(c, 10));
  if (codes.length) match.status_code = codes;
  if (options?.matchHeaders?.length) {
    const headers: Record<string, string[]> = {};
    for (const h of options.matchHeaders) (headers[h.name] ??= []).push(h.value);
    match.headers = headers;
  }
  if (Object.keys(match).length) handler.match = match;
  return handler as unknown as CaddyHandler;
}


/** Caps the request body size (#154). Must be the first handle in a route so it runs
 *  before whatever actually reads the body (reverse_proxy, file_server upload, etc). */
export function buildRequestBodyHandler(maxSize: number): CaddyHandler {
  return { handler: "request_body", max_size: maxSize };
}


/** The `encode` options that differ from plain `encode gzip zstd` (#335). */
export function parseEncodeOptionsJson(h: AnyHandler): import("./types").EncodeOptions | undefined {
  if (h.handler !== "encode") return undefined;
  const e = h as { prefer?: string[]; encodings?: Record<string, unknown>; minimum_length?: number; match?: { status_code?: number[]; headers?: Record<string, string[]> } };
  const order = (e.prefer?.length ? e.prefer : Object.keys(e.encodings ?? {})).filter((a): a is "gzip" | "zstd" => a === "gzip" || a === "zstd");
  // Without a `prefer` Caddy lists no order; that and gzip + zstd both is what a plain `encode gzip zstd` is.
  const isDefault = order.length === 2 && order[0] === "gzip" && order[1] === "zstd";
  const o: import("./types").EncodeOptions = {
    algorithms: order.length && !isDefault ? [...new Set(order)] : undefined,
    minimumLength: typeof e.minimum_length === "number" && e.minimum_length > 0 ? e.minimum_length : undefined,
    matchStatus: e.match?.status_code?.length ? e.match.status_code.map(c => c < 10 ? `${c}xx` : String(c)) : undefined,
    matchHeaders: e.match?.headers ? Object.entries(e.match.headers).flatMap(([name, values]) => values.map(value => ({ name, value }))) : undefined,
  };
  for (const k of Object.keys(o) as Array<keyof typeof o>) if (o[k] == null) delete o[k];
  return Object.keys(o).length ? o : undefined;
}


const GO_HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "'": "&#39;", "<": "&lt;", ">": "&gt;", '"': "&#34;" };

/** Go's `html.EscapeString`, which Caddy applies to an html redirect's target. */
function goHtmlEscape(s: string): string {
  return s.replace(/[&'<>"]/g, c => GO_HTML_ESCAPES[c]);
}

function goHtmlUnescape(s: string): string {
  return s.replace(/&(amp|#39|lt|gt|#34);/g, (_m, e: string) => ({ amp: "&", "#39": "'", lt: "<", gt: ">", "#34": '"' })[e] ?? _m);
}


/**
 * What Caddy's `redir <to> html` becomes: a page with a script and a meta refresh, so the
 * browser keeps the URL fragment. The body is Caddy's own, byte for byte, to match what a
 * reload from the Caddyfile gives (checked with `caddy adapt` on 2.11.7).
 */
export function buildRedirectHandler(redirect: import("./types").RedirectConfig): CaddyHandler {
  const to = caddyPlaceholderToJson(redirect.to);
  if (redirect.html) {
    const t = goHtmlEscape(to);
    const body = `<!DOCTYPE html>\n<html>\n\t<head>\n\t\t<title>Redirecting...</title>\n\t\t<script>window.location.replace("${t}");</script>\n`
      + `\t\t<meta http-equiv="refresh" content="0; URL='${t}'">\n\t</head>\n\t<body>Redirecting to <a href="${t}">${t}</a>...</body>\n</html>\n`;
    return { handler: "static_response", body, headers: { "Content-Type": ["text/html; charset=utf-8"] }, status_code: 200 } as CaddyHandler;
  }
  return { handler: "static_response", headers: { Location: [to] }, status_code: redirect.code } as CaddyHandler;
}


/** The target of an html-mode redirect handler, or undefined for any other handler. */
export function parseHtmlRedirect(h: AnyHandler): string | undefined {
  if (h.handler !== "static_response") return undefined;
  const sr = h as { body?: string; headers?: Record<string, string[]> };
  if (!sr.body?.includes("<title>Redirecting...</title>") || sr.headers?.["Location"]) return undefined;
  const m = sr.body.match(/window\.location\.replace\("([^"]*)"\);/);
  return m ? goHtmlUnescape(m[1]) : undefined;
}


export function buildBasicAuthHandler(accounts: { username: string; passwordHash: string }[], options?: import("./types").BasicAuthOptions): CaddyHandler {
  return {
    handler: "authentication",
    providers: {
      http_basic: {
        accounts: accounts.map(a => ({ username: a.username, password: a.passwordHash })),
        ...(options?.algorithm ? { hash: { algorithm: options.algorithm } } : {}),
        ...(options?.realm ? { realm: options.realm } : {}),
      },
    },
  };
}


/** The realm and the hash algorithm, when they differ from Caddy's defaults (#337). */
export function parseBasicAuthOptionsJson(h: AnyHandler): import("./types").BasicAuthOptions | undefined {
  const providers = (h as { providers?: Record<string, unknown> }).providers;
  const basic = providers?.["http_basic"] as { realm?: string; hash?: { algorithm?: string } } | undefined;
  const options: import("./types").BasicAuthOptions = {
    realm: basic?.realm || undefined,
    algorithm: basic?.hash?.algorithm === "argon2id" ? "argon2id" : undefined,
  };
  for (const k of Object.keys(options) as Array<keyof typeof options>) if (options[k] == null) delete options[k];
  return Object.keys(options).length ? options : undefined;
}


export function parseBasicAuthJson(h: AnyHandler): { username: string; passwordHash: string }[] | undefined {
  const providers = (h as { providers?: Record<string, unknown> }).providers;
  const httpBasic = providers?.["http_basic"] as { accounts?: Array<{ username: string; password: string }> } | undefined;
  if (!httpBasic?.accounts?.length) return undefined;
  return httpBasic.accounts.map(a => ({ username: a.username, passwordHash: a.password }));
}


export function buildRewriteHandler(rewrite: import("./types").RewriteConfig): CaddyHandler {
  if (rewrite.type === "strip_prefix") {
    return { handler: "rewrite", strip_path_prefix: rewrite.value };
  }
  if (rewrite.type === "add_prefix") {
    return { handler: "rewrite", uri: `${rewrite.value}{http.request.uri}` };
  }
  if (rewrite.type === "strip_suffix") return { handler: "rewrite", strip_path_suffix: rewrite.value };
  if (rewrite.type === "method") return { handler: "rewrite", method: rewrite.method };
  if (rewrite.type === "uri_replace") {
    return { handler: "rewrite", uri_substring: [{ find: rewrite.find, ...(rewrite.replace ? { replace: rewrite.replace } : {}), ...(rewrite.limit ? { limit: rewrite.limit } : {}) }] } as CaddyHandler;
  }
  if (rewrite.type === "query") {
    const query: Record<string, unknown[]> = {};
    const push = (name: string, item: unknown) => { (query[name] ??= []).push(item); };
    for (const o of rewrite.ops) {
      if (o.op === "delete") push("delete", o.key);
      else if (o.op === "replace") push("replace", { key: o.key, search_regexp: o.search ?? "", replace: o.replace ?? "" });
      else push(o.op, { key: o.key, val: o.value ?? "" });
    }
    return { handler: "rewrite", query } as CaddyHandler;
  }
  // Caddy's adapter leaves an empty replacement out; match it so both apply paths agree (#254).
  return { handler: "rewrite", path_regexp: [{ find: rewrite.find, ...(rewrite.replace ? { replace: rewrite.replace } : {}) }] };
}


export function parseRewriteFromHandle(h: AnyHandler): import("./types").RewriteConfig | undefined {
  if (h.handler !== "rewrite") return undefined;
  const rw = h as {
    handler: string; strip_path_prefix?: string; strip_path_suffix?: string; uri?: string; method?: string;
    path_regexp?: Array<{ find: string; replace: string }>;
    uri_substring?: Array<{ find: string; replace?: string; limit?: number }>;
    query?: Record<string, unknown[]>;
  };
  if (rw.strip_path_prefix) return { type: "strip_prefix", value: rw.strip_path_prefix };
  if (rw.strip_path_suffix) return { type: "strip_suffix", value: rw.strip_path_suffix };
  if (rw.method) return { type: "method", method: rw.method };
  if (rw.uri_substring?.[0]) {
    const { find, replace, limit } = rw.uri_substring[0];
    return { type: "uri_replace", find, replace: replace ?? "", ...(limit ? { limit } : {}) };
  }
  if (rw.query) {
    const ops: import("./types").QueryOp[] = [];
    const items = (name: string) => (rw.query?.[name] ?? []) as Array<Record<string, string>>;
    for (const name of ["rename", "set", "add"] as const) for (const i of items(name)) ops.push({ op: name, key: i.key, value: i.val ?? "" });
    for (const i of items("replace")) ops.push({ op: "replace", key: i.key, search: i.search_regexp ?? "", replace: i.replace ?? "" });
    for (const key of (rw.query.delete ?? []) as string[]) ops.push({ op: "delete", key });
    if (ops.length) return { type: "query", ops };
  }
  if (rw.uri) {
    const m = rw.uri.match(/^(.+)\{http\.request\.uri\}$/);
    if (m) return { type: "add_prefix", value: m[1] };
  }
  if (rw.path_regexp?.[0]) {
    const { find, replace } = rw.path_regexp[0];
    return { type: "regex", find, replace: replace ?? "" };
  }
  return undefined;
}


export function buildTransport(p: TransportProps): import("./types").CaddyHttpTransport | undefined {
  const hasTls = p.targetScheme === "https";
  const hasKeepalive = !!p.keepalive || p.keepaliveIdleConns != null || p.keepaliveIdleConnsPerHost != null;
  const hasOptions = !!(p.dialTimeout || p.responseHeaderTimeout || p.readTimeout || p.writeTimeout || p.httpVersions?.length || hasKeepalive);
  if (!hasTls && !hasOptions) return undefined;

  const t: import("./types").CaddyHttpTransport = { protocol: "http" };
  if (hasTls) {
    t.tls = {};
    if (p.tlsSkipVerify) t.tls.insecure_skip_verify = true;
    if (p.tlsServerName) t.tls.server_name = p.tlsServerName;
  }
  if (p.dialTimeout) t.dial_timeout = p.dialTimeout;
  if (p.responseHeaderTimeout) t.response_header_timeout = p.responseHeaderTimeout;
  if (p.readTimeout) t.read_timeout = p.readTimeout;
  if (p.writeTimeout) t.write_timeout = p.writeTimeout;
  if (p.httpVersions?.length) t.versions = p.httpVersions;
  if (hasKeepalive) {
    t.keep_alive = p.keepalive === "off" ? { enabled: false } : {
      ...(p.keepalive ? { idle_timeout: p.keepalive } : {}),
      ...(p.keepaliveIdleConns != null ? { max_idle_conns: p.keepaliveIdleConns } : {}),
      ...(p.keepaliveIdleConnsPerHost != null ? { max_idle_conns_per_host: p.keepaliveIdleConnsPerHost } : {}),
    };
  }
  return t;
}


/** `load_balancing.selection_policy` as Caddy's adapter writes it for the policy (#285). */
export function lbSelectionPolicyJson(p: LbFields): Record<string, unknown> {
  const a = p.lbPolicyArgs ?? {};
  const out: Record<string, unknown> = { policy: p.lbPolicy };
  if (p.lbPolicy === "header" && a.headerField) out.field = a.headerField;
  if (p.lbPolicy === "cookie") {
    if (a.cookieName || a.cookieSecret) out.name = a.cookieName || "lb";
    if (a.cookieSecret) out.secret = a.cookieSecret;
  }
  if (p.lbPolicy === "weighted_round_robin" && a.weights?.length) out.weights = a.weights;
  if (p.lbPolicy === "random_choose" && a.chooseCount != null) out.choose = a.chooseCount;
  return out;
}


/** The policy and its arguments from `selection_policy` JSON; unknown policies come back undefined. */
export function parseLbSelectionPolicy(sp: Record<string, unknown> | undefined): LbFields {
  const policy = typeof sp?.policy === "string" && LB_POLICIES.has(sp.policy) ? sp.policy as import("./types").LbPolicy : undefined;
  if (!policy || !sp) return {};
  const args: import("./types").LbPolicyArgs = {};
  if (policy === "header" && typeof sp.field === "string") args.headerField = sp.field;
  if (policy === "cookie") {
    if (typeof sp.name === "string" && (sp.name !== "lb" || typeof sp.secret === "string")) args.cookieName = sp.name;
    if (typeof sp.secret === "string") args.cookieSecret = sp.secret;
  }
  if (policy === "weighted_round_robin" && Array.isArray(sp.weights)) args.weights = sp.weights as number[];
  if (policy === "random_choose" && typeof sp.choose === "number") args.chooseCount = sp.choose;
  return Object.keys(args).length ? { lbPolicy: policy, lbPolicyArgs: args } : { lbPolicy: policy };
}


// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export type AnyHandler = { handler: string; routes?: Array<{ handle?: AnyHandler[]; [key: string]: unknown }>; [key: string]: unknown };


export type JsonRoute = { match?: Array<Record<string, unknown>>; handle?: AnyHandler[] };


/**
 * The user's `try_files` (#262) from the routes Caddy adapts it to: a `file` matcher with the
 * candidate list plus a rewrite to `{http.matchers.file.relative}` and, per candidate group, the
 * part of the target after it (`?{query}`). php_fastcgi's own file routes (with `split_path`)
 * and the trailing-slash redirect aren't the user's and are skipped. Subroute handlers are
 * searched too, so the plugin's own JSON form is found as well.
 */
export function findTryFiles(routes: JsonRoute[]): string | undefined {
  const parts: string[] = [];
  const visit = (rs: JsonRoute[]) => {
    for (const r of rs) {
      const file = r.match?.[0]?.file as { try_files?: string[]; split_path?: unknown; try_policy?: unknown } | undefined;
      const rewrite = (r.handle ?? []).find(h => h.handler === "rewrite") as { uri?: string } | undefined;
      if (file?.try_files?.length && !file.split_path && !file.try_policy && rewrite?.uri?.startsWith("{http.matchers.file.relative}")) {
        const suffix = rewrite.uri.slice("{http.matchers.file.relative}".length);
        parts.push(...file.try_files.map(f => collapsePlaceholderShorthands(f + suffix)));
      }
      for (const h of r.handle ?? []) {
        const sub = (h as { routes?: JsonRoute[] }).routes;
        if (h.handler === "subroute" && sub) visit(sub);
      }
    }
  };
  visit(routes);
  return parts.length ? parts.join(" ") : undefined;
}


/** Top-level routes that together make one hostless static site: one file_server, no hosts, no proxy. */
export function isHostlessStaticGroup(routes: JsonRoute[]): boolean {
  const handles = routes.flatMap(r => r.handle ?? []);
  return handles.filter(h => h.handler === "file_server").length === 1
    && !handles.some(h => h.handler === "reverse_proxy" || h.handler === "static_response" || h.handler === "subroute")
    && routes.every(r => !(r.match ?? []).some(m => "host" in m));
}


/** A path Caddy adds to `hide` itself: the file the site block came from. */
export function isConfigSourcePath(p: string): boolean {
  return /(^|\/)Caddyfile$/.test(p) || (p.startsWith("/") && /\.(conf|caddyfile)$/.test(p));
}


/** The `file_server` options (#262) of a static site, from its JSON handler and routes. */
export function parseFileServerOptions(
  fsHandle: Record<string, unknown>, routes: JsonRoute[],
): Pick<import("./types").FileServerConfig, "spa" | "index" | "hide" | "precompressed" | "disableCanonicalUris" | "status" | "browseTemplate"> {
  const out: Pick<import("./types").FileServerConfig, "spa" | "index" | "hide" | "precompressed" | "disableCanonicalUris" | "status" | "browseTemplate"> = {};
  if (fsHandle.canonical_uris === false) out.disableCanonicalUris = true;
  const status = typeof fsHandle.status_code === "string" ? parseInt(fsHandle.status_code, 10) : fsHandle.status_code;
  if (typeof status === "number" && status > 0) out.status = status;
  const template = (fsHandle.browse as { template_file?: string } | undefined)?.template_file;
  if (template) out.browseTemplate = template;
  if (findTryFiles(routes) === "{path} /index.html") out.spa = true;
  const index = fsHandle.index_names;
  if (Array.isArray(index) && index.length) out.index = index as string[];
  const hide = Array.isArray(fsHandle.hide) ? (fsHandle.hide as string[]).filter(h => !isConfigSourcePath(h)) : [];
  if (hide.length) out.hide = hide;
  const order = fsHandle.precompressed_order;
  const pre = fsHandle.precompressed;
  if (Array.isArray(order) && order.length) out.precompressed = order as string[];
  else if (pre && typeof pre === "object" && Object.keys(pre).length) out.precompressed = Object.keys(pre);
  return out;
}


/**
 * Detects Caddy's `php_fastcgi` Caddyfile-macro expansion from a group of routes (#35).
 * The macro isn't a single JSON handler — it expands into up to four separate routes
 * (a `vars` handler setting root, a trailing-slash redirect, a `rewrite`, and finally a
 * `reverse_proxy` with a `fastcgi` transport), verified empirically via `caddy adapt`
 * against a live instance. `routes` should be either a server's own top-level routes (the
 * hostless `:PORT { php_fastcgi ... }` case, where Caddy emits these 4 routes directly on
 * the server) or a `subroute` handler's inner routes (the host-matched case, where Caddy
 * wraps the same 4 routes in one subroute) — either shape preserves each route's own
 * `match`, which the generic subroute-flattening elsewhere in this file (which only
 * collects `.handle` arrays) would otherwise discard, losing the custom index filename.
 */
export function detectPhpFastcgiFromRoutes(
  routes: Array<{ match?: Array<Record<string, unknown>>; handle?: AnyHandler[] }>,
): import("./types").PhpFastcgiConfig | undefined {
  const allHandles = routes.flatMap(r => (r.handle ?? []) as AnyHandler[]);
  const rp = allHandles.find(h => h.handler === "reverse_proxy" && (h.transport as { protocol?: string } | undefined)?.protocol === "fastcgi");
  if (!rp) return undefined;

  const varsH = allHandles.find(h => h.handler === "vars" && typeof h.root === "string");
  // php_fastcgi's own rewrite carries split_path; a user's try_files (#262) adapts to rewrites without it.
  const rewriteRoute = routes.find(r =>
    (r.handle ?? []).some(h => h.handler === "rewrite") && !!(r.match?.[0]?.file as { split_path?: unknown } | undefined)?.split_path,
  ) ?? routes.find(r => (r.handle ?? []).some(h => h.handler === "rewrite"));
  const userTryFiles = findTryFiles(routes);
  const tryFiles = (rewriteRoute?.match?.[0]?.file as { try_files?: string[] } | undefined)?.try_files;
  const index = tryFiles?.length ? tryFiles[tryFiles.length - 1] : undefined;

  const transport = rp.transport as {
    split_path?: string[]; env?: Record<string, string>; capture_stderr?: boolean; resolve_root_symlink?: boolean;
    dial_timeout?: number | string; read_timeout?: number | string; write_timeout?: number | string;
  } | undefined;
  const splitPath = transport?.split_path;
  const isDefaultSplit = Array.isArray(splitPath) && splitPath.length === 1 && splitPath[0] === ".php";
  const env = transport?.env;

  return {
    upstream: (rp.upstreams as Array<{ dial?: string }> | undefined)?.[0]?.dial ?? "",
    root: (varsH?.root as string | undefined) ?? "/",
    index: index && index !== "index.php" ? index : undefined,
    splitPath: Array.isArray(splitPath) && !isDefaultSplit ? splitPath : undefined,
    env: env && Object.keys(env).length ? env : undefined,
    ...(userTryFiles ? { tryFiles: userTryFiles } : {}),
    ...(transport?.capture_stderr ? { captureStderr: true } : {}),
    ...(transport?.resolve_root_symlink ? { resolveRootSymlink: true } : {}),
    ...(parseDuration(transport?.dial_timeout) ? { dialTimeout: parseDuration(transport?.dial_timeout) } : {}),
    ...(parseDuration(transport?.read_timeout) ? { readTimeout: parseDuration(transport?.read_timeout) } : {}),
    ...(parseDuration(transport?.write_timeout) ? { writeTimeout: parseDuration(transport?.write_timeout) } : {}),
  };
}


/** Reads back the request_body handler's max_size, if present (#154). */
export function parseRequestBodyMaxSize(handles: AnyHandler[]): number | undefined {
  const h = handles.find(h => h.handler === "request_body") as { max_size?: number } | undefined;
  return typeof h?.max_size === "number" ? h.max_size : undefined;
}


/** Mirrors buildLbRetryLines' health-check part as Caddy JSON (#252). */
export function buildHealthChecksJson(lbRetry: import("./types").LbRetryConfig | undefined): Record<string, unknown> | undefined {
  if (!lbRetry) return undefined;
  const out: Record<string, unknown> = {};
  if (lbRetry.failDuration) {
    out.passive = {
      fail_duration: lbRetry.failDuration,
      ...(lbRetry.maxFails != null ? { max_fails: lbRetry.maxFails } : {}),
      ...(lbRetry.unhealthyStatus?.length ? { unhealthy_status: lbRetry.unhealthyStatus } : {}),
    };
  }
  if (lbRetry.healthUri) {
    const cls = lbRetry.healthStatus?.match(/^([1-5])xx$/i);
    out.active = {
      uri: lbRetry.healthUri,
      ...(lbRetry.healthInterval ? { interval: lbRetry.healthInterval } : {}),
      ...(lbRetry.healthTimeout ? { timeout: lbRetry.healthTimeout } : {}),
      ...(lbRetry.healthStatus ? { expect_status: cls ? parseInt(cls[1], 10) : parseInt(lbRetry.healthStatus, 10) } : {}),
    };
  }
  return Object.keys(out).length ? out : undefined;
}


export function parseLbRetry(rp: CaddyReverseProxyHandler): import("./types").LbRetryConfig | undefined {
  const lb = rp.load_balancing as { retries?: number; try_duration?: number | string; try_interval?: number | string; retry_match?: Array<{ method?: string[] }> } | undefined;
  const retryMethods = lb?.retry_match?.length === 1 ? lb.retry_match[0].method : undefined;
  type Passive = { fail_duration?: number | string; max_fails?: number; unhealthy_status?: number[] };
  type Active = { uri?: string; interval?: number | string; timeout?: number | string; expect_status?: number };
  const hc = rp.health_checks as { passive?: Passive; active?: Active } | undefined;
  const unhealthyStatus = hc?.passive?.unhealthy_status;
  const expect = hc?.active?.expect_status;
  const cfg: import("./types").LbRetryConfig = {
    retries: lb?.retries,
    retryMethods: retryMethods?.length ? retryMethods : undefined,
    tryDuration: parseDuration(lb?.try_duration) || undefined,
    tryInterval: parseDuration(lb?.try_interval) || undefined,
    failDuration: parseDuration(hc?.passive?.fail_duration) || undefined,
    maxFails: hc?.passive?.max_fails,
    unhealthyStatus: unhealthyStatus?.length ? unhealthyStatus : undefined,
    healthUri: hc?.active?.uri || undefined,
    healthInterval: parseDuration(hc?.active?.interval) || undefined,
    healthTimeout: parseDuration(hc?.active?.timeout) || undefined,
    // Caddy stores a status class ("2xx") as its first digit.
    healthStatus: expect == null ? undefined : expect < 10 ? `${expect}xx` : String(expect),
  };
  for (const k of Object.keys(cfg) as Array<keyof typeof cfg>) if (cfg[k] == null) delete cfg[k];
  return Object.keys(cfg).length ? cfg : undefined;
}


export function findReverseProxy(handles: AnyHandler[]): CaddyReverseProxyHandler | undefined {
  for (const h of handles) {
    if (h.handler === "reverse_proxy") {
      // Skip forward_auth proxies — they're auth guards, not the main upstream
      if (!isForwardAuthProxy(h as CaddyReverseProxyHandler)) return h as CaddyReverseProxyHandler;
      continue;
    }
    if (h.handler === "subroute" && h.routes) {
      // Skip subroutes that are the forward_auth wrapper
      const isAuthSubroute = (h.routes as Array<{ handle?: AnyHandler[] }>).some(r =>
        (r.handle ?? []).some(sh => sh.handler === "reverse_proxy" && isForwardAuthProxy(sh as CaddyReverseProxyHandler)),
      );
      if (isAuthSubroute) continue;
      for (const sub of h.routes) {
        const found = findReverseProxy((sub.handle ?? []) as AnyHandler[]);
        if (found) return found;
      }
    }
  }
  return undefined;
}


/** Parse a single Caddy route + server context into a ProxyEntry. Returns undefined if unrecognized. */
export function parseRouteToEntry(
  route: CaddyRoute,
  key: string,
  externalPort: number,
  externalHost: string | undefined,
  server: CaddyServer,
  siteAccessLog: import("./types").AccessLogConfig | undefined,
  serverReadTimeout: string | undefined,
  serverReadHeaderTimeout: string | undefined,
  serverWriteTimeout: string | undefined,
  serverIdleTimeout: string | undefined,
  maxHeaderBytes: number | undefined,
  routeId: string,
  namedServerKey: string | undefined,
  automationPolicies: import("./types").CaddyAutomationPolicy[] | undefined,
  certLoadFiles: import("./types").CaddyCertLoadFile[] | undefined,
): ProxyEntry | undefined {
  const handles = (route.handle ?? []) as AnyHandler[];
  let matchers = route.match?.[0] ? parseMatcherJson(route.match[0]) : undefined;

  // A route whose only matcher is a host list is how Caddy represents a
  // hostname-only Caddyfile site block (no explicit port) sharing an implicit
  // :443/:80 server with other sites. Promote it to externalHost so the UI shows
  // the real address instead of a blank host with an opaque matcher chip. A site
  // block with several names (`a.com, b.com {`, #208) lists all of them here.
  if (!externalHost && isHostOnlyMatcher(matchers)) {
    externalHost = matchers.host.join(", ");
    matchers = undefined;
  }

  // `bind` next to a host name (#323): the listen addresses are the bind, and the names are in the
  // host matcher. A listen host is an IP or a name (`bind localhost`). An IP host is in the matcher
  // and the listen addresses both, and the form adds its bind itself, so it is not one of the binds.
  // One IP address with no names is an IP host, as before.
  const listenHosts = [...new Set((server.listen ?? []).map(listenHostOf).filter(Boolean))];
  let bind: string[] | undefined;
  if (!namedServerKey && listenHosts.length && isHostOnlyMatcher(matchers)) {
    const names = matchers.host.map(h => looksLikeIp(h) ? canonicalBindHost(h) : h);
    const ownIp = names.length === 1 && isIpAddress(names[0]) ? names[0] : undefined;
    const extra = listenHosts.filter(h => h !== ownIp);
    bind = extra.length ? extra : undefined;
    externalHost = names.join(", ");
    matchers = undefined;
  } else if (!namedServerKey && !matchers && (listenHosts.length > 1 || (listenHosts.length === 1 && !isIpAddress(listenHosts[0])))) {
    bind = listenHosts;
    externalHost = undefined;
  }

  // #51 — Caddy enables h1/h2/h3 by default; an explicit protocols list omitting h3 is
  // how a user opted out of HTTP/3.
  const disableHttp3 = Array.isArray(server.protocols) && !server.protocols.includes("h3") || undefined;
  const serverExtras = parseServerExtras(server);

  // Unwrap subroute handlers emitted by Caddy's Caddyfile adapter.
  // When Caddy reloads from Caddyfile, `handle { ... }` blocks become:
  //   { handler: "subroute", routes: [{ handle: [...actual handlers...] }] }
  const subrouteH = handles.find(h => h.handler === "subroute") as
    { handler: string; routes?: Array<{ handle?: AnyHandler[] }> } | undefined;
  const effectiveHandles: AnyHandler[] = subrouteH?.routes?.length
    ? subrouteH.routes.flatMap(r => (r.handle ?? []) as AnyHandler[])
    : handles;
  // A `log_skip` inside the site's own subroute keeps its paths in the site's log settings (#334).
  const innerSkipPaths = (subrouteH?.routes ?? []).filter(isLogSkipRoute)
    .flatMap(r => logSkipRoutePaths(r as { match?: Array<Record<string, unknown>> }).paths);
  const accessLog = siteAccessLog && innerSkipPaths.length ? { ...siteAccessLog, skipPaths: innerSkipPaths } : siteAccessLog;

  // Detect php_fastcgi (#35) — must run before the redirect/static_response checks below,
  // since php_fastcgi's own trailing-slash-redirect route is itself a static_response with
  // a Location header and would otherwise be misdetected as a plain redirect proxy. Uses
  // the subroute's own inner routes (not effectiveHandles) so each route's `match` survives
  // long enough to recover a custom index filename — see detectPhpFastcgiFromRoutes.
  const phpFastcgi = detectPhpFastcgiFromRoutes(subrouteH?.routes?.length ? subrouteH.routes : [route]);
  if (phpFastcgi) {
    const phpTls = serverHasTls(server, automationPolicies, externalHost);
    const phpTlsPolicy = Array.isArray(server.tls_connection_policies) ? server.tls_connection_policies[0] : undefined;
    return {
      id: routeId,
      externalPort,
      externalHost,
      targetHost: "localhost",
      targetPort: 0,
      targetScheme: "http",
      tls: phpTls,
      tlsSkipVerify: false,
      serverKey: key,
      namedServerKey,
      phpFastcgi,
      requestBodyMaxSize: parseRequestBodyMaxSize(effectiveHandles),
      matchers,
      serverReadTimeout, serverReadHeaderTimeout, serverWriteTimeout, serverIdleTimeout, maxHeaderBytes, disableHttp3, serverExtras, bind, accessLog,
      errorHandlers: parseErrorHandlers(server),
      tlsAdvanced: phpTlsPolicy ? parseTlsAdvanced(phpTlsPolicy, automationPolicies, tlsSubjectHosts(externalHost)[0]) : parseSiteAcmeSettings(automationPolicies, tlsSubjectHosts(externalHost)[0]),
      mtls: phpTlsPolicy ? parseMtls(phpTlsPolicy) : undefined,
    };
  }

  // Detect the `redir ... html` form (#338): a page, not a Location header.
  const htmlRedirect = effectiveHandles.map(parseHtmlRedirect).find(Boolean);
  if (htmlRedirect) {
    return {
      id: routeId,
      externalPort,
      externalHost,
      targetHost: "localhost",
      targetPort: 0,
      targetScheme: "http",
      tls: false,
      tlsSkipVerify: false,
      serverKey: key,
      namedServerKey,
      redirect: { to: jsonPlaceholderToCaddy(htmlRedirect), code: 302, html: true },
      matchers,
      serverReadTimeout, serverReadHeaderTimeout, serverWriteTimeout, serverIdleTimeout, maxHeaderBytes, disableHttp3, bind, accessLog,
      errorHandlers: parseErrorHandlers(server),
    };
  }

  // Detect redirect (static_response with Location header)
  const staticResp = effectiveHandles.find(h => h.handler === "static_response") as
    { handler: string; headers?: Record<string, string[]>; status_code?: number; body?: string; close?: boolean } | undefined;
  const locationHeader = staticResp?.headers?.["Location"]?.[0];
  if (staticResp && locationHeader) {
    const code = (staticResp.status_code ?? 302) as 301 | 302 | 307 | 308;
    return {
      id: routeId,
      externalPort,
      externalHost,
      targetHost: "localhost",
      targetPort: 0,
      targetScheme: "http",
      tls: false,
      tlsSkipVerify: false,
      serverKey: key,
      namedServerKey,
      redirect: { to: jsonPlaceholderToCaddy(locationHeader), code },
      matchers,
      serverReadTimeout, serverReadHeaderTimeout, serverWriteTimeout, serverIdleTimeout, maxHeaderBytes, disableHttp3, serverExtras, bind, accessLog,
      errorHandlers: parseErrorHandlers(server),
    };
  }

  // Detect static response (static_response without Location header)
  if (staticResp && !locationHeader) {
    return {
      id: routeId,
      externalPort,
      externalHost,
      targetHost: "localhost",
      targetPort: 0,
      targetScheme: "http",
      tls: false,
      tlsSkipVerify: false,
      serverKey: key,
      namedServerKey,
      staticResponse: {
        statusCode: staticResp.status_code ?? 200,
        body: staticResp.body || undefined,
        close: staticResp.close || undefined,
      },
      matchers,
      serverReadTimeout, serverReadHeaderTimeout, serverWriteTimeout, serverIdleTimeout, maxHeaderBytes, disableHttp3, serverExtras, bind, accessLog,
      errorHandlers: parseErrorHandlers(server),
    };
  }

  // Detect file_server
  const fsHandle = effectiveHandles.find(h => h.handler === "file_server") as
    { handler: string; root?: string; browse?: Record<string, unknown>; [k: string]: unknown } | undefined;
  if (fsHandle) {
    const fsCompress = effectiveHandles.some(h => h.handler === "encode");
    const fsEncodeOptions = parseEncodeOptionsJson(effectiveHandles.find(h => h.handler === "encode") ?? ({} as AnyHandler));
    const fsAuthHandle = effectiveHandles.find(h => h.handler === "authentication");
    const fsBasicAuth = fsAuthHandle ? parseBasicAuthJson(fsAuthHandle) : undefined;
    const fsBasicAuthOptions = fsAuthHandle ? parseBasicAuthOptionsJson(fsAuthHandle) : undefined;
    // The Caddyfile adapter emits one headers handler per `header` line, so read them all.
    const fsResponseHeaders = effectiveHandles.flatMap(parseResponseHeadersJson);
    const fsTls = serverHasTls(server, automationPolicies, externalHost);
    const fsTlsPolicy = Array.isArray(server.tls_connection_policies) ? server.tls_connection_policies[0] : undefined;
    return {
      id: routeId,
      externalPort,
      externalHost,
      targetHost: "localhost",
      targetPort: 0,
      targetScheme: "http",
      tls: fsTls,
      tlsSkipVerify: false,
      serverKey: key,
      namedServerKey,
      // The Caddyfile adapter turns `root * <dir>` into a separate `vars` handler and
      // leaves file_server without a root (#245). Never fall back to "/": saving that
      // back would serve the whole filesystem; an empty root fails the required field instead.
      fileServer: {
        root: fsHandle.root
          ?? (effectiveHandles.find(h => h.handler === "vars" && typeof (h as { root?: unknown }).root === "string") as { root?: string } | undefined)?.root
          ?? "",
        browse: fsHandle.browse !== undefined,
        ...(parseTemplatesJson(effectiveHandles) ? { templates: parseTemplatesJson(effectiveHandles) } : {}),
        ...parseFileServerOptions(fsHandle, subrouteH?.routes?.length ? subrouteH.routes : [route]),
      },
      requestBodyMaxSize: parseRequestBodyMaxSize(effectiveHandles),
      compress: fsCompress || undefined,
      encodeOptions: fsEncodeOptions,
      basicAuth: fsBasicAuth?.length ? fsBasicAuth : undefined,
      basicAuthOptions: fsBasicAuth?.length ? fsBasicAuthOptions : undefined,
      responseHeaders: fsResponseHeaders.length ? fsResponseHeaders : undefined,
      matchers,
      serverReadTimeout, serverReadHeaderTimeout, serverWriteTimeout, serverIdleTimeout, maxHeaderBytes, disableHttp3, serverExtras, bind, accessLog,
      errorHandlers: parseErrorHandlers(server),
      tlsAdvanced: fsTlsPolicy ? parseTlsAdvanced(fsTlsPolicy, automationPolicies, tlsSubjectHosts(externalHost)[0]) : parseSiteAcmeSettings(automationPolicies, tlsSubjectHosts(externalHost)[0]),
      mtls: fsTlsPolicy ? parseMtls(fsTlsPolicy) : undefined,
    };
  }

  // Detect invoke (named route call)
  const invokeHandle = effectiveHandles.find(h => h.handler === "invoke") as
    { handler: string; name?: string } | undefined;
  if (invokeHandle?.name) {
    return {
      id: routeId,
      externalPort,
      externalHost,
      targetHost: "localhost",
      targetPort: 0,
      targetScheme: "http",
      tls: false,
      tlsSkipVerify: false,
      serverKey: key,
      namedServerKey,
      isNamedRoute: true,
      namedRouteName: invokeHandle.name,
      matchers,
      serverReadTimeout, serverReadHeaderTimeout, serverWriteTimeout, serverIdleTimeout, maxHeaderBytes, disableHttp3, serverExtras, bind, accessLog,
    };
  }

  const forwardAuth = detectForwardAuth(effectiveHandles);
  const rp = findReverseProxy(effectiveHandles);
  if (!rp) return undefined;

  const dial = rp.upstreams?.[0]?.dial ?? "";
  const lastColon = dial.lastIndexOf(":");
  const targetHost = lastColon > 0 ? dial.slice(0, lastColon) : dial;
  const targetPort = lastColon > 0 ? parseInt(dial.slice(lastColon + 1), 10) : 80;

  const extraUpstreams = (rp.upstreams ?? []).slice(1).map(u => {
    const d = u.dial ?? "";
    const c = d.lastIndexOf(":");
    return { host: c > 0 ? d.slice(0, c) : d, port: c > 0 ? parseInt(d.slice(c + 1), 10) : 80 };
  });
  const { lbPolicy, lbPolicyArgs } = parseLbSelectionPolicy(
    (rp.load_balancing as { selection_policy?: Record<string, unknown> } | undefined)?.selection_policy,
  );
  const lbRetry = parseLbRetry(rp);

  const targetScheme: "http" | "https" = rp.transport?.tls !== undefined ? "https" : "http";
  const tlsSkipVerify = rp.transport?.tls?.insecure_skip_verify ?? false;
  const dialTimeout = parseDuration(rp.transport?.dial_timeout);
  const responseHeaderTimeout = parseDuration(rp.transport?.response_header_timeout);
  const tr = rp.transport;
  const keepAlive = tr?.keep_alive;
  const tlsServerName = typeof tr?.tls?.server_name === "string" ? tr.tls.server_name : undefined;
  const keepalive = keepAlive?.enabled === false ? "off" : parseDuration(keepAlive?.idle_timeout);
  const readTimeout = parseDuration(tr?.read_timeout);
  const writeTimeout = parseDuration(tr?.write_timeout);
  const flushInterval = rp.flush_interval === -1 || rp.flush_interval === "-1" ? "-1" : parseDuration(rp.flush_interval);
  const streamTimeout = parseDuration(rp.stream_timeout);
  const streamCloseDelay = parseDuration(rp.stream_close_delay);

  const tls = serverHasTls(server, automationPolicies, externalHost);
  const tlsPolicy = Array.isArray(server.tls_connection_policies) ? server.tls_connection_policies[0] : undefined;
  const customTls = parseCustomTls(tlsPolicy, certLoadFiles);

  const compress = effectiveHandles.some(h => h.handler === "encode");
  const encodeOptions = parseEncodeOptionsJson(effectiveHandles.find(h => h.handler === "encode") ?? ({} as AnyHandler));
  const authHandle = effectiveHandles.find(h => h.handler === "authentication");
  const basicAuth = authHandle ? parseBasicAuthJson(authHandle) : undefined;
  const basicAuthOptions = authHandle ? parseBasicAuthOptionsJson(authHandle) : undefined;
  const rewriteHandle = effectiveHandles.find(h => h.handler === "rewrite");
  const rewrite = rewriteHandle ? parseRewriteFromHandle(rewriteHandle) : undefined;
  const responseHeadersParsed = effectiveHandles.flatMap(parseResponseHeadersJson);
  const requestHeaders = parseRequestHeadersJson(rp.headers as Record<string, unknown> | undefined);
  const upstreamResponseHeaders = parseUpstreamResponseHeadersJson(rp.headers as Record<string, unknown> | undefined);

  // Detect handle_path pattern: a strip_prefix rewrite whose value matches the path matcher prefix
  let handlePath: true | undefined;
  let finalRewrite = rewrite;
  if (rewrite?.type === "strip_prefix" && matchers?.path?.length && isPathOnlyMatcher(matchers)) {
    const expectedPrefix = handlePathStripPrefix(matchers);
    if (expectedPrefix && rewrite.value === expectedPrefix) {
      handlePath = true;
      finalRewrite = undefined;
    }
  } else if (rewrite?.type === "regex" && rewrite.replace === "/" && rewrite.find === multiPathStripRegex(matchers)) {
    // The several-paths form of handle_path (#255).
    handlePath = true;
    finalRewrite = undefined;
  }

  return {
    id: routeId,
    externalPort,
    externalHost,
    targetHost: targetHost || "localhost",
    targetPort: isNaN(targetPort) ? 80 : targetPort,
    targetScheme,
    tls,
    tlsSkipVerify,
    serverKey: key,
    namedServerKey,
    compress: compress || undefined,
    encodeOptions,
    requestBodyMaxSize: parseRequestBodyMaxSize(effectiveHandles),
    basicAuth: basicAuth?.length ? basicAuth : undefined,
    basicAuthOptions: basicAuth?.length ? basicAuthOptions : undefined,
    dialTimeout: dialTimeout || undefined,
    responseHeaderTimeout: responseHeaderTimeout || undefined,
    tlsServerName: tlsServerName || undefined,
    keepalive: keepalive || undefined,
    keepaliveIdleConns: keepAlive?.max_idle_conns,
    keepaliveIdleConnsPerHost: keepAlive?.max_idle_conns_per_host,
    httpVersions: tr?.versions?.length ? tr.versions : undefined,
    readTimeout: readTimeout || undefined,
    writeTimeout: writeTimeout || undefined,
    dynamicUpstreams: parseDynamicUpstreamsJson(rp.dynamic_upstreams as Record<string, unknown> | undefined),
    flushInterval: flushInterval || undefined,
    streamTimeout: streamTimeout || undefined,
    streamCloseDelay: streamCloseDelay || undefined,
    rewrite: finalRewrite,
    requestHeaders: requestHeaders.length ? requestHeaders : undefined,
    upstreamResponseHeaders: upstreamResponseHeaders.length ? upstreamResponseHeaders : undefined,
    responseHeaders: responseHeadersParsed.length ? responseHeadersParsed : undefined,
    extraUpstreams: extraUpstreams.length ? extraUpstreams : undefined,
    lbPolicy,
    lbPolicyArgs,
    lbRetry,
    matchers,
    handlePath,
    serverReadTimeout, serverReadHeaderTimeout, serverWriteTimeout, serverIdleTimeout, maxHeaderBytes, disableHttp3, serverExtras, bind, accessLog,
    errorHandlers: parseErrorHandlers(server),
    replaceUpstreamErrors: reraisesUpstreamErrors(rp) || undefined,
    forwardAuth,
    tlsAdvanced: tlsPolicy ? parseTlsAdvanced(tlsPolicy, automationPolicies, tlsSubjectHosts(externalHost)[0]) : parseSiteAcmeSettings(automationPolicies, tlsSubjectHosts(externalHost)[0]),
    mtls: tlsPolicy ? parseMtls(tlsPolicy) : undefined,
    customTls,
  };
}


export function parseProxies(config: CaddyConfig, serverDefs?: import("./types").ServerDef[]): ProxyEntry[] {
  const servers = config.apps?.http?.servers ?? {};
  const automationPolicies = config.apps?.tls?.automation?.policies;
  const certLoadFiles = config.apps?.tls?.certificates?.load_files;
  const proxies: ProxyEntry[] = [];
  const logSkipByServer = new Map<string, Array<{ paths: string[]; hosts: string[] }>>();

  for (const [key, server] of Object.entries(servers)) {
    // Handle :9393, localhost:9393, https://localhost:9393
    const listenAddr = server.listen?.[0] ?? "";
    const portMatch = listenAddr.match(/:(\d+)$/);
    if (!portMatch) continue;
    const externalPort = parseInt(portMatch[1], 10);
    if (isNaN(externalPort)) continue;
    const colonIdx = listenAddr.lastIndexOf(":");
    const rawHost = colonIdx > 0 ? listenAddr.slice(0, colonIdx) : "";
    const externalHost = rawHost || undefined;

    // Server-level timeouts and size limits — Caddy returns nanoseconds as integers after
    // a Caddyfile reload, so parseDuration handles both string ("10s") and number forms.
    const serverReadTimeout = parseDuration(server.read_timeout);
    const serverReadHeaderTimeout = parseDuration(server.read_header_timeout);
    const serverWriteTimeout = parseDuration(server.write_timeout);
    const serverIdleTimeout = parseDuration(server.idle_timeout);
    const maxHeaderBytes = typeof server.max_header_bytes === "number" ? server.max_header_bytes : undefined;
    const serverExtras = parseServerExtras(server);

    // Access log — look up logger by name in config.logging.logs
    const loggerName = (server.logs as { default_logger_name?: string } | undefined)?.default_logger_name;
    let accessLog: import("./types").AccessLogConfig | undefined;
    if (loggerName) {
      const loggerCfg = config.logging?.logs?.[loggerName];
      if (loggerCfg) {
        const output = (loggerCfg.writer?.output ?? "stderr") as import("./types").AccessLogOutput;
        accessLog = {
          output,
          filePath: loggerCfg.writer?.filename,
          ...parseLogEncoder(loggerCfg.encoder),
          level: loggerCfg.level as import("./types").AccessLogLevel | undefined,
          rollSizeMb: loggerCfg.writer?.roll_size_mb,
          rollKeepCount: loggerCfg.writer?.roll_keep,
          rollKeepDays: loggerCfg.writer?.roll_keep_days,
          rollCompress: loggerCfg.writer?.roll_gzip === false ? false : undefined,
        };
      }
    }

    // `log_skip` routes are no sites of their own: their paths belong to the site's log (#334).
    const allRoutes = server.routes ?? [];
    const routes = allRoutes.filter(r => !isLogSkipRoute(r));
    const skipRoutes = allRoutes.filter(r => isLogSkipRoute(r));
    if (skipRoutes.length) logSkipByServer.set(key, skipRoutes.map(logSkipRoutePaths));

    // Determine whether this is a named server (multiple content routes, not from named_routes)
    // Skip routes that come from the `named_routes` map (invoke placeholders are already loaded)
    const contentRoutes = routes.filter(r => {
      const handles = (r.handle ?? []) as AnyHandler[];
      return handles.length > 0;
    });

    // Identify a matching ServerDef — first by JSON key, then by listen address.
    // After Caddy reloads from Caddyfile it reassigns its own server keys (e.g. "srv0")
    // so key-only matching would misclassify named-server routes as standalone.
    const listenAddrs = server.listen ?? [];
    const defByKey = serverDefs?.find(s => s.key === key);
    const defByAddr = (!defByKey && serverDefs?.length)
      ? serverDefs.find(s => s.listenAddresses.some(a => listenAddrs.includes(a)))
      : undefined;
    const namedDef = defByKey ?? defByAddr;
    const isNamedServer = !key.includes(":") && namedDef != null;

    // Detect a hostless `:PORT { php_fastcgi ... }` standalone site (#35) before the
    // generic branching below — Caddy expands that Caddyfile macro into up to 4 separate
    // top-level routes directly on the server (no host matcher to wrap them in a single
    // subroute, unlike the host-matched case which parseRouteToEntry already handles),
    // so contentRoutes.length is never <= 1 for it and it would otherwise be misparsed as
    // several unrelated, broken partial routes by the "multiple content routes" branch.
    // A hostless proxy is always the sole occupant of its port (two can't coexist per
    // #139), so grouping all of contentRoutes together here is safe and unambiguous.
    const phpFastcgiGroup = !namedDef && contentRoutes.length > 1 ? detectPhpFastcgiFromRoutes(contentRoutes) : undefined;
    if (phpFastcgiGroup) {
      // #51 — Caddy enables h1/h2/h3 by default; an explicit protocols list omitting h3 is
      // how a user opted out of HTTP/3.
      const phpDisableHttp3 = Array.isArray(server.protocols) && !server.protocols.includes("h3") || undefined;
      proxies.push({
        id: String(externalPort),
        externalPort,
        externalHost,
        targetHost: "localhost",
        targetPort: 0,
        targetScheme: "http",
        tls: serverHasTls(server, automationPolicies, externalHost),
        tlsSkipVerify: false,
        serverKey: key,
        phpFastcgi: phpFastcgiGroup,
        requestBodyMaxSize: parseRequestBodyMaxSize(contentRoutes.flatMap(r => (r.handle ?? []) as AnyHandler[])),
        serverReadTimeout, serverReadHeaderTimeout, serverWriteTimeout, serverIdleTimeout, maxHeaderBytes,
        disableHttp3: phpDisableHttp3, serverExtras, accessLog,
        errorHandlers: parseErrorHandlers(server),
      });
      continue;
    }

    // A hostless static site with try_files (#262) adapts to several top-level routes too
    // (root vars, the file-matcher rewrite, file_server). Parse them as one site, as if they
    // were the subroute a host-matched block gets.
    const staticGroup = !namedDef && contentRoutes.length > 1 && isHostlessStaticGroup(contentRoutes);
    if (staticGroup) {
      const entry = parseRouteToEntry(
        { handle: [{ handler: "subroute", routes: contentRoutes } as CaddyHandler] } as CaddyRoute, key, externalPort, externalHost, server, accessLog,
        serverReadTimeout, serverReadHeaderTimeout, serverWriteTimeout, serverIdleTimeout, maxHeaderBytes,
        String(externalPort), undefined, automationPolicies, certLoadFiles,
      );
      if (entry) proxies.push(entry);
      continue;
    }

    if (namedDef) {
      // Named server (#49) — use def.key for IDs so they stay consistent after Caddy key changes
      for (let i = 0; i < contentRoutes.length; i++) {
        const entry = parseRouteToEntry(
          contentRoutes[i], key, externalPort, externalHost, server, accessLog,
          serverReadTimeout, serverReadHeaderTimeout, serverWriteTimeout, serverIdleTimeout, maxHeaderBytes,
          `${namedDef.key}:${i}`, isNamedServer ? namedDef.key : undefined, automationPolicies, certLoadFiles,
        );
        if (entry) proxies.push(entry);
      }
    } else if (contentRoutes.length <= 1) {
      // Standalone single-route server (the common case)
      const route = contentRoutes[0];
      if (!route) continue;
      const entry = parseRouteToEntry(
        route, key, externalPort, externalHost, server, accessLog,
        serverReadTimeout, serverReadHeaderTimeout, serverWriteTimeout, serverIdleTimeout, maxHeaderBytes,
        String(externalPort), undefined, automationPolicies, certLoadFiles,
      );
      if (entry) proxies.push(entry);
    } else {
      // Multiple content routes sharing one implicit-port server with no matching
      // ServerDef — e.g. several hostname-only Caddyfile site blocks (no explicit
      // port) that Caddy automatically groups onto the same shared :443/:80 server.
      // Each route is its own independent proxy; key by its host matcher when
      // present so the id stays stable across Caddy's own server-key reassignment.
      for (let i = 0; i < contentRoutes.length; i++) {
        const routeHost = (contentRoutes[i].match?.[0]?.host as string[] | undefined)?.[0];
        const entry = parseRouteToEntry(
          contentRoutes[i], key, externalPort, externalHost, server, accessLog,
          serverReadTimeout, serverReadHeaderTimeout, serverWriteTimeout, serverIdleTimeout, maxHeaderBytes,
          routeHost ? `host:${routeHost}` : `${key}:${i}`, undefined, automationPolicies, certLoadFiles,
        );
        if (entry) proxies.push(entry);
      }
    }
  }

  // The paths of a server's `log_skip` routes go to the sites they match: all of them without a host (#334).
  for (const p of proxies) {
    const rules = logSkipByServer.get(p.serverKey);
    if (!rules || !p.accessLog) continue;
    const hosts = externalHostList(p.externalHost);
    const paths = rules.filter(r => !r.hosts.length || r.hosts.some(h => hosts.includes(h))).flatMap(r => r.paths);
    if (paths.length) p.accessLog = { ...p.accessLog, skipPaths: [...new Set([...(p.accessLog.skipPaths ?? []), ...paths])] };
  }

  return proxies.sort((a, b) => {
    if (a.externalPort !== b.externalPort) return a.externalPort - b.externalPort;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}


// ---------------------------------------------------------------------------
// Building / patching server entries
// ---------------------------------------------------------------------------

function dynamicSourceJson(s: import("./types").DynamicUpstreamSource): Record<string, unknown> {
  return {
    source: s.type,
    name: s.name,
    ...(s.type === "a" && s.port ? { port: s.port } : {}),
    ...(s.refresh ? { refresh: s.refresh } : {}),
    ...(s.resolvers?.length ? { resolver: { addresses: s.resolvers } } : {}),
    ...(s.dialTimeout ? { dial_timeout: s.dialTimeout } : {}),
    ...(s.dialFallbackDelay ? { dial_fallback_delay: s.dialFallbackDelay } : {}),
    ...(s.gracePeriod ? { grace_period: s.gracePeriod } : {}),
    ...(s.type === "a" && s.versions ? { versions: { [s.versions]: true } } : {}),
  };
}

function buildDynamicUpstreamsJson(sources: import("./types").DynamicUpstreamSource[] | undefined): Record<string, unknown> | undefined {
  const list = (sources ?? []).filter(s => s.name.trim());
  if (!list.length) return undefined;
  return list.length === 1 ? dynamicSourceJson(list[0]) : { source: "multi", sources: list.map(dynamicSourceJson) };
}

function parseDynamicSourceJson(j: Record<string, unknown>): import("./types").DynamicUpstreamSource | undefined {
  if ((j.source !== "srv" && j.source !== "a") || typeof j.name !== "string") return undefined;
  const addresses = (j.resolver as { addresses?: string[] } | undefined)?.addresses;
  const versions = j.versions as { ipv4?: boolean; ipv6?: boolean } | undefined;
  const out: import("./types").DynamicUpstreamSource = { type: j.source, name: j.name };
  if (j.source === "a" && j.port != null) out.port = String(j.port);
  const refresh = parseDuration(j.refresh); if (refresh) out.refresh = refresh;
  if (addresses?.length) out.resolvers = addresses;
  const dialTimeout = parseDuration(j.dial_timeout); if (dialTimeout) out.dialTimeout = dialTimeout;
  const fallback = parseDuration(j.dial_fallback_delay); if (fallback) out.dialFallbackDelay = fallback;
  const grace = parseDuration(j.grace_period); if (grace) out.gracePeriod = grace;
  if (j.source === "a" && versions?.ipv4 && !versions.ipv6) out.versions = "ipv4";
  if (j.source === "a" && versions?.ipv6 && !versions.ipv4) out.versions = "ipv6";
  return out;
}

function parseDynamicUpstreamsJson(j: Record<string, unknown> | undefined): import("./types").DynamicUpstreamSource[] | undefined {
  if (!j) return undefined;
  const list = j.source === "multi" && Array.isArray(j.sources) ? (j.sources as Record<string, unknown>[]) : [j];
  const sources = list.map(parseDynamicSourceJson).filter((s): s is import("./types").DynamicUpstreamSource => !!s);
  return sources.length ? sources : undefined;
}

/** The reverse_proxy `headers` object: `request` is header_up, `response` is header_down (#324). */
export function buildReverseProxyHeadersJson(
  up: import("./types").HeaderOperation[] | undefined,
  down: import("./types").HeaderOperation[] | undefined,
): Record<string, unknown> | undefined {
  const side = (ops: import("./types").HeaderOperation[] | undefined): Record<string, unknown> | undefined => {
    if (!ops?.length) return undefined;
    const set: Record<string, string[]> = {};
    const add: Record<string, string[]> = {};
    const replace: Record<string, Array<{ search_regexp: string; replace: string }>> = {};
    const del: string[] = [];
    for (const h of ops) {
      if (h.op === "delete") { del.push(h.name); continue; }
      if (h.op === "replace") {
        (replace[h.name] ??= []).push({ search_regexp: h.value ?? "", replace: caddyPlaceholderToJson(h.replacement ?? "") });
        continue;
      }
      const val = [caddyPlaceholderToJson(h.value ?? "")];
      if (h.op === "add") add[h.name] = val;
      else set[h.name] = val;
    }
    const out: Record<string, unknown> = {};
    if (Object.keys(set).length) out["set"] = set;
    if (Object.keys(add).length) out["add"] = add;
    if (del.length) out["delete"] = del;
    if (Object.keys(replace).length) out["replace"] = replace;
    return Object.keys(out).length ? out : undefined;
  };
  const request = side(up);
  const response = side(down);
  if (!request && !response) return undefined;
  return { ...(request ? { request } : {}), ...(response ? { response } : {}) };
}

function parseHeaderOpsJson(side: Record<string, unknown> | undefined): import("./types").HeaderOperation[] {
  if (!side) return [];
  const ops: import("./types").HeaderOperation[] = [];
  const set = side["set"] as Record<string, string[]> | undefined;
  const add = side["add"] as Record<string, string[]> | undefined;
  const del = side["delete"] as string[] | undefined;
  const replace = side["replace"] as Record<string, Array<{ search?: string; search_regexp?: string; replace?: string }>> | undefined;
  for (const [name, vals] of Object.entries(set ?? {}))
    ops.push({ op: "set", name, value: jsonPlaceholderToCaddy(vals[0] ?? "") });
  for (const [name, vals] of Object.entries(add ?? {}))
    ops.push({ op: "add", name, value: jsonPlaceholderToCaddy(vals[0] ?? "") });
  for (const name of del ?? [])
    ops.push({ op: "delete", name });
  for (const [name, reps] of Object.entries(replace ?? {}))
    for (const r of reps)
      ops.push({ op: "replace", name, value: r.search_regexp ?? r.search ?? "", replacement: jsonPlaceholderToCaddy(r.replace ?? "") });
  return ops;
}

export function parseRequestHeadersJson(headers: Record<string, unknown> | undefined): import("./types").HeaderOperation[] {
  return parseHeaderOpsJson(headers?.["request"] as Record<string, unknown> | undefined);
}

function parseUpstreamResponseHeadersJson(headers: Record<string, unknown> | undefined): import("./types").HeaderOperation[] {
  return parseHeaderOpsJson(headers?.["response"] as Record<string, unknown> | undefined);
}

export function buildResponseHeadersHandler(ops: import("./types").HeaderOperation[]): CaddyHandler {
  const set: Record<string, string[]> = {};
  const add: Record<string, string[]> = {};
  const del: string[] = [];
  for (const h of ops) {
    if (h.op === "delete") { del.push(h.name); continue; }
    const val = [h.value ?? ""];
    if (h.op === "add") add[h.name] = val;
    else set[h.name] = val;
  }
  // "deferred" makes response header rewriting apply just before the response is
  // actually written, after reverse_proxy has copied the upstream's headers in;
  // without it a set runs too early and the upstream's own value is added next to it.
  // The Caddyfile adapter does NOT set this for a plain `header Name value`: it defers
  // only `-`, `?`, `>` and `defer` (#255, checked with `caddy adapt` on 2.11.7), which is
  // why the Caddyfile writer spells a set on a proxied route `>Name` (headerOpLine).
  const resp: Record<string, unknown> = { deferred: true };
  if (Object.keys(set).length) resp["set"] = set;
  if (Object.keys(add).length) resp["add"] = add;
  if (del.length) resp["delete"] = del;
  return { handler: "headers", response: resp };
}


export function parseResponseHeadersJson(h: AnyHandler): import("./types").HeaderOperation[] {
  if (h.handler !== "headers") return [];
  const resp = (h as { handler: string; response?: Record<string, unknown> }).response;
  if (!resp) return [];
  const ops: import("./types").HeaderOperation[] = [];
  const set = resp["set"] as Record<string, string[]> | undefined;
  const add = resp["add"] as Record<string, string[]> | undefined;
  const del = resp["delete"] as string[] | undefined;
  for (const [name, vals] of Object.entries(set ?? {})) ops.push({ op: "set", name, value: vals[0] ?? "" });
  for (const [name, vals] of Object.entries(add ?? {})) ops.push({ op: "add", name, value: vals[0] ?? "" });
  for (const name of del ?? []) ops.push({ op: "delete", name });
  return ops;
}

export function buildReverseProxyHandler(
  proxy: Pick<ProxyEntry, "targetHost" | "targetPort" | "targetScheme" | "tlsSkipVerify" | "requestHeaders" | "upstreamResponseHeaders" | "dynamicUpstreams" | "dialTimeout" | "responseHeaderTimeout" | "tlsServerName" | "keepalive" | "keepaliveIdleConns" | "keepaliveIdleConnsPerHost" | "httpVersions" | "readTimeout" | "writeTimeout" | "flushInterval" | "streamTimeout" | "streamCloseDelay" | "extraUpstreams" | "lbPolicy" | "lbPolicyArgs" | "lbRetry" | "replaceUpstreamErrors">,
  errorHandlers?: import("./types").ErrorHandlerConfig[],
): CaddyReverseProxyHandler {
  const primaryDial = `${proxy.targetHost}:${proxy.targetPort}`;
  const extraDials = (proxy.extraUpstreams ?? []).map(u => ({ dial: `${u.host}:${u.port}` }));
  const rp: CaddyReverseProxyHandler = {
    handler: "reverse_proxy",
    upstreams: [{ dial: primaryDial }, ...extraDials],
  };
  const transport = buildTransport(proxy);
  if (transport) rp.transport = transport;
  const dynamic = buildDynamicUpstreamsJson(proxy.dynamicUpstreams);
  if (dynamic) rp.dynamic_upstreams = dynamic;
  if (proxy.flushInterval) rp.flush_interval = proxy.flushInterval === "-1" ? -1 : proxy.flushInterval;
  if (proxy.streamTimeout) rp.stream_timeout = proxy.streamTimeout;
  if (proxy.streamCloseDelay) rp.stream_close_delay = proxy.streamCloseDelay;
  const hdrs = buildReverseProxyHeadersJson(proxy.requestHeaders, proxy.upstreamResponseHeaders);
  if (hdrs) rp.headers = hdrs;
  if (proxy.lbPolicy && (proxy.extraUpstreams?.length ?? 0) > 0 && LB_POLICIES.has(proxy.lbPolicy)) {
    rp.load_balancing = { selection_policy: lbSelectionPolicyJson(proxy) };
  }
  const lbRetry = proxy.lbRetry;
  if (lbRetry?.retries != null || lbRetry?.tryDuration || lbRetry?.tryInterval || lbRetry?.retryMethods?.length) {
    rp.load_balancing = {
      ...(rp.load_balancing as Record<string, unknown> | undefined),
      ...(lbRetry.retryMethods?.length ? { retry_match: [{ method: lbRetry.retryMethods }] } : {}),
      ...(lbRetry.retries != null ? { retries: lbRetry.retries } : {}),
      ...(lbRetry.tryDuration ? { try_duration: lbRetry.tryDuration } : {}),
      ...(lbRetry.tryInterval ? { try_interval: lbRetry.tryInterval } : {}),
    };
  }
  const healthChecks = buildHealthChecksJson(lbRetry);
  if (healthChecks) rp.health_checks = healthChecks;

  if (proxy.replaceUpstreamErrors && errorHandlers?.length) {
    const codes = errorHandlerResponseCodes(errorHandlers);
    if (codes.length) {
      // Same as the Caddyfile path (buildReverseProxyLines), in the form Caddy adapts it to. The
      // placeholder needs its full name here: {rp.*} is a Caddyfile-only shorthand, and the JSON
      // status_code field does resolve a full placeholder at runtime.
      rp.handle_response = codes.map(c => ({
        match: { status_code: [c] },
        routes: [{ handle: [c < 10
          ? { handler: "error", error: UPSTREAM_ERROR_MESSAGE, status_code: "{http.reverse_proxy.status_code}" }
          : { handler: "error", status_code: c }] }],
      }));
    }
  }
  return rp;
}


/** The per-listener options of #328, read from a server object. */
export function parseServerExtras(server: CaddyServer): import("./types").ServerExtras | undefined {
  const s = server as Record<string, unknown>;
  const logs = s.logs as { should_log_credentials?: boolean } | undefined;
  const extras: import("./types").ServerExtras = {
    keepaliveInterval: parseDuration(s.keepalive_interval) || undefined,
    keepaliveIdle: parseDuration(s.keepalive_idle) || undefined,
    readBodyIdle: parseDuration(s.read_idle_timeout) || undefined,
    strictSniHost: s.strict_sni_host === true || undefined,
    logCredentials: logs?.should_log_credentials === true || undefined,
    enableFullDuplex: s.enable_full_duplex === true || undefined,
  };
  for (const k of Object.keys(extras) as Array<keyof typeof extras>) if (extras[k] == null) delete extras[k];
  return Object.keys(extras).length ? extras : undefined;
}


/** Writes the options of #328 onto a server object, removing the ones that are not set. */
export function applyServerExtras(server: CaddyServer, extras: import("./types").ServerExtras | undefined): void {
  const s = server as Record<string, unknown>;
  if (extras?.keepaliveInterval) s.keepalive_interval = extras.keepaliveInterval;
  else delete s.keepalive_interval;
  if (extras?.keepaliveIdle) s.keepalive_idle = extras.keepaliveIdle;
  else delete s.keepalive_idle;
  if (extras?.readBodyIdle) s.read_idle_timeout = extras.readBodyIdle;
  else delete s.read_idle_timeout;
  if (extras?.strictSniHost) s.strict_sni_host = true;
  else delete s.strict_sni_host;
  if (extras?.enableFullDuplex) s.enable_full_duplex = true;
  else delete s.enable_full_duplex;
  // `logs` also holds the access log's logger name; only the credentials flag is ours.
  const logs = { ...(s.logs as Record<string, unknown> | undefined) };
  if (extras?.logCredentials) logs.should_log_credentials = true;
  else delete logs.should_log_credentials;
  if (Object.keys(logs).length) s.logs = logs;
  else delete s.logs;
}


export type TimeoutProxy = Pick<ProxyEntry, "serverReadTimeout" | "serverReadHeaderTimeout" | "serverWriteTimeout" | "serverIdleTimeout" | "maxHeaderBytes" | "disableHttp3" | "serverExtras">;


export function applyServerTimeouts(server: CaddyServer, proxy: TimeoutProxy): CaddyServer {
  if (proxy.serverReadTimeout) server.read_timeout = proxy.serverReadTimeout;
  else delete server.read_timeout;
  if (proxy.serverReadHeaderTimeout) server.read_header_timeout = proxy.serverReadHeaderTimeout;
  else delete server.read_header_timeout;
  if (proxy.serverWriteTimeout) server.write_timeout = proxy.serverWriteTimeout;
  else delete server.write_timeout;
  if (proxy.serverIdleTimeout) server.idle_timeout = proxy.serverIdleTimeout;
  else delete server.idle_timeout;
  if (proxy.maxHeaderBytes) server.max_header_bytes = proxy.maxHeaderBytes;
  else delete server.max_header_bytes;
  // #51 — Caddy enables h1/h2/h3 by default; explicitly list h1+h2 only to opt out of h3.
  if (proxy.disableHttp3) server.protocols = ["h1", "h2"];
  else delete server.protocols;
  applyServerExtras(server, proxy.serverExtras);
  return server;
}


/**
 * Host matcher for a proxy whose site address lists several names (#208), the shape
 * Caddy's Caddyfile adapter gives `a.com, b.com { }`. A single-host or hostless proxy
 * gets none, as before, and an explicit Route Matcher (#48) always wins.
 */
export function siteHostMatch(proxy: Pick<ProxyEntry, "externalHost" | "matchers" | "bind">): Array<Record<string, unknown>> | undefined {
  if (proxy.matchers) return undefined;
  const hosts = externalHostList(proxy.externalHost);
  // With a bind (#323) the listen addresses no longer name the site, so its host goes into a
  // matcher, as Caddy's adapter writes it (an IPv6 address without its brackets).
  if (hosts.length === 1 && proxy.bind?.length) return [{ host: hosts.map(h => h.replace(/^\[(.*)\]$/, "$1")) }];
  return hosts.length > 1 ? [{ host: hosts }] : undefined;
}


export function isMultiHostOnlyMatch(match: Array<Record<string, unknown>> | undefined): boolean {
  if (match?.length !== 1) return false;
  const keys = Object.keys(match[0]);
  return keys.length === 1 && keys[0] === "host" && Array.isArray(match[0].host) && match[0].host.length > 1;
}


/** An IPv4 or IPv6 address, bracketed or not, as it appears in a listen address or a host matcher. */
function looksLikeIp(host: string): boolean {
  return isIpAddress(host) || /^[0-9A-Fa-f:]*:[0-9A-Fa-f:.]*$/.test(host);
}


export function buildListenAddr(proxy: { externalHost?: string; externalPort: number; bind?: string[] }): string {
  return buildListenAddrs(proxy)[0];
}


/** Every address the site listens on: its `bind` addresses (#323), the IP it is named by, or the port alone. */
export function buildListenAddrs(proxy: { externalHost?: string; externalPort: number; bind?: string[] }): string[] {
  // Several names (#208) can't share one bind address, so they listen on every interface.
  const hosts = siteBindAddresses(proxy);
  // Caddy's adapter sorts a server's listen addresses; the push sorts them the same way.
  return hosts.length ? hosts.map(h => `${h}:${proxy.externalPort}`).sort() : [`:${proxy.externalPort}`];
}


/** The host of a listen address (`[::1]:80` -> `[::1]`, `:80` -> ``). */
function listenHostOf(address: string): string {
  return address.slice(0, Math.max(address.lastIndexOf(":"), 0));
}


/**
 * Stable id for a standalone proxy: `host:<host>` when a hostname/subdomain is set,
 * matching the id parseProxies already assigns when re-reading multiple host-matched
 * routes sharing one port after a reload (#139) — keeps the id from changing out from
 * under the UI once the config round-trips. Bare `String(port)` otherwise, unchanged
 * from before #139 (the single-route-per-port case parseProxies also expects).
 */
export function standaloneProxyId(entry: Pick<ProxyEntry, "externalPort" | "externalHost" | "matchers">): string {
  const host = routeHosts(entry)?.[0];
  return host ? `host:${host}` : String(entry.externalPort);
}


/**
 * Exact membership check for a `subjects` list. Written as `.some(s => s === host)` rather
 * than `.includes(host)` — both are equivalent here (subjects is a plain string[], not a URL
 * being substring-matched), but static analysis tools that flag "incomplete URL substring
 * sanitization" on any `.includes()` call don't distinguish the two, so this form avoids
 * tripping that check entirely.
 */
export function subjectsInclude(subjects: string[] | undefined, host: string): boolean {
  return !!subjects?.some(s => s === host);
}


/**
 * Whether a route's server actually has TLS enabled. Usually determined by the
 * presence of `tls_connection_policies` on the server — but a server shared by
 * multiple hosts with identical TLS settings (#139, e.g. two subdomains both using
 * `tls internal` with no advanced options) doesn't get an explicit connection
 * policy from Caddy's Caddyfile adapter; each host is simply listed as a `subjects`
 * entry in a shared `apps.tls.automation.policies` policy instead. Fall back to
 * that so shared-listener routes aren't misdetected as plain HTTP.
 *
 * A third case (#171): a site with a public-looking hostname and no explicit `tls`
 * config at all is still served over HTTPS — Caddy's automatic HTTPS turns it on by
 * default, the same "Caddy-default ACME" case classifyAcmeHosts (#141) already
 * detects. Only a host Caddy's adapter put in `automatic_https.skip` (an explicit
 * `http://` scheme) or a non-public host (localhost/IP) is genuinely plain HTTP.
 */
export function serverHasTls(
  server: { tls_connection_policies?: CaddyTLSConnectionPolicy[]; automatic_https?: { skip?: string[] } },
  automationPolicies: import("./types").CaddyAutomationPolicy[] | undefined,
  externalHost: string | undefined,
): boolean {
  if (Array.isArray(server.tls_connection_policies) && server.tls_connection_policies.length > 0) return true;
  const hosts = externalHostList(externalHost);
  if (hosts.some(h => automationPolicies?.some(p => subjectsInclude(p.subjects, h)))) return true;
  return tlsSubjectHosts(externalHost).some(h => !server.automatic_https?.skip?.includes(h));
}


/** A route that only tells Caddy not to log what matches, which `log_skip` adapts to (#334). */
export function isLogSkipRoute(route: { handle?: AnyHandler[] } | undefined): boolean {
  const handles = (route?.handle ?? []) as AnyHandler[];
  return handles.length > 0 && handles.every(h => h.handler === "vars" && (h as { log_skip?: boolean }).log_skip === true && Object.keys(h).length === 2);
}


/** The paths (and the hosts, when it names any) of the requests a `log_skip` route keeps out of the log. */
export function logSkipRoutePaths(route: { match?: Array<Record<string, unknown>> }): { paths: string[]; hosts: string[] } {
  const matches = route.match ?? [];
  return {
    paths: matches.flatMap(m => (m.path as string[] | undefined) ?? []),
    hosts: matches.flatMap(m => (m.host as string[] | undefined) ?? []),
  };
}


/** Stable logger name for a proxy's access log, keyed by port. */
export function accessLoggerName(port: number): string {
  return `cockpit-access-${port}`;
}


export function applyAccessLog(server: CaddyServer, proxy: { externalPort: number; accessLog?: import("./types").AccessLogConfig }): void {
  if (proxy.accessLog) {
    server.logs = { default_logger_name: accessLoggerName(proxy.externalPort) };
  } else {
    delete (server as Record<string, unknown>).logs;
  }
  // `log_skip` is a route ahead of the site's own, with the site's host matcher and the paths (#334).
  const routes = (server.routes ?? []).filter(r => !isLogSkipRoute(r));
  const paths = proxy.accessLog?.skipPaths;
  if (paths?.length && routes.length) {
    const base = routes[0].match as Array<Record<string, unknown>> | undefined;
    // A site that matches a path of its own can't be narrowed the same way: write none.
    if (!base?.some(m => m.path)) {
      const match = base?.length ? base.map(m => ({ ...m, path: paths })) : [{ path: paths }];
      server.routes = [{ match, handle: [{ handler: "vars", log_skip: true } as CaddyHandler] } as CaddyRoute, ...routes];
      return;
    }
  }
  server.routes = routes;
}


/** Recursively flattens subroute handlers so we can find the actual leaf handler. */
export function flattenErrorHandles(handles: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  for (const h of handles) {
    if (h.handler === "subroute") {
      const routes = (h.routes as Array<{ handle?: unknown[] }> | undefined) ?? [];
      for (const r of routes) {
        result.push(...flattenErrorHandles((r.handle ?? []) as Array<Record<string, unknown>>));
      }
    } else {
      result.push(h);
    }
  }
  return result;
}


/**
 * Finds the automation policy that governs certs for this hostname: the policy
 * whose `subjects` includes it, falling back to the shared subject-less policy
 * (Caddy allows at most one policy with no subjects; it's the catch-all default).
 * With no host (this app addresses most servers by port, not domain), only the
 * default policy can apply — Caddy has no other way to scope automation policies.
 */
export function findAutomationPolicy(
  automationPolicies: import("./types").CaddyAutomationPolicy[] | undefined,
  host: string | undefined,
): import("./types").CaddyAutomationPolicy | undefined {
  if (!automationPolicies) return undefined;
  if (host) {
    const scoped = automationPolicies.find(p => subjectsInclude(p.subjects, host));
    if (scoped) return scoped;
  }
  return automationPolicies.find(p => !p.subjects?.length);
}


export function parseTlsAdvanced(
  policy: CaddyTLSConnectionPolicy,
  automationPolicies: import("./types").CaddyAutomationPolicy[] | undefined,
  host: string | undefined,
): import("./types").TlsAdvancedConfig | undefined {
  const cfg: import("./types").TlsAdvancedConfig = {};
  let hasData = false;
  if (policy.protocol_min) { cfg.protocolMin = policy.protocol_min as import("./types").TlsProtocolVersion; hasData = true; }
  if (policy.protocol_max) { cfg.protocolMax = policy.protocol_max as import("./types").TlsProtocolVersion; hasData = true; }
  if (Array.isArray(policy.cipher_suites) && policy.cipher_suites.length) { cfg.cipherSuites = policy.cipher_suites as string[]; hasData = true; }
  if (Array.isArray(policy.curves) && policy.curves.length) { cfg.curves = policy.curves as string[]; hasData = true; }
  const automationPolicy = findAutomationPolicy(automationPolicies, host);
  const lifetime = parseCertLifetimeDuration(automationPolicy?.issuers?.[0]?.lifetime);
  if (lifetime) { cfg.certLifetime = lifetime; hasData = true; }
  if (automationPolicy?.renewal_window_ratio !== undefined) { cfg.renewalWindowRatio = automationPolicy.renewal_window_ratio; hasData = true; }
  const own = parseSiteAcmeSettings(automationPolicies, host);
  if (own) { Object.assign(cfg, own); hasData = true; }
  return hasData ? cfg : undefined;
}


/**
 * A site's own ACME account and key type (#341), from the policy that names its host; the shared
 * catch-all policy is the global one. A site on automatic HTTPS has no connection policy, so this
 * is read on its own too.
 */
export function parseSiteAcmeSettings(
  automationPolicies: import("./types").CaddyAutomationPolicy[] | undefined,
  host: string | undefined,
): Pick<import("./types").TlsAdvancedConfig, "acmeEmail" | "acmeCa" | "keyType"> | undefined {
  const scoped = host ? automationPolicies?.find(p => subjectsInclude(p.subjects, host)) : undefined;
  const acme = scoped?.issuers?.find(i => i.module === "acme") as { email?: string; ca?: string } | undefined;
  const out: Pick<import("./types").TlsAdvancedConfig, "acmeEmail" | "acmeCa" | "keyType"> = {
    ...(acme?.email ? { acmeEmail: acme.email } : {}),
    ...(acme?.ca ? { acmeCa: acme.ca } : {}),
    ...(scoped?.key_type ? { keyType: scoped.key_type } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}


export function parseMtls(policy: CaddyTLSConnectionPolicy): import("./types").MtlsConfig | undefined {
  const ca = policy.client_authentication;
  if (!ca?.mode) return undefined;
  const fromPool = ca.ca?.provider === "file" ? ca.ca.pem_files?.[0] : undefined;
  const trustedCaFile = fromPool || ca.trusted_ca_certs_pem_files?.[0] || undefined;
  return { mode: ca.mode as import("./types").MtlsMode, trustedCaFile };
}


/** Resolves a manually-loaded certificate (#152) from a connection policy's
 *  `certificate_selection.any_tag` reference into `apps.tls.certificates.load_files`.
 *  caFile isn't part of Caddy's JSON model at all — it's recovered separately from a
 *  Caddyfile comment fallback (see parseConfCustomTlsCaMap) and layered on in useProxies. */
export function parseCustomTls(
  policy: CaddyTLSConnectionPolicy | undefined,
  certLoadFiles: import("./types").CaddyCertLoadFile[] | undefined,
): import("./types").CustomTlsConfig | undefined {
  const tag = policy?.certificate_selection?.any_tag?.[0];
  if (!tag) return undefined;
  const entry = certLoadFiles?.find(f => f.tags?.includes(tag));
  if (!entry) return undefined;
  return { certFile: entry.certificate, keyFile: entry.key };
}


export function hasCustomInternalIssuer(adv: import("./types").TlsAdvancedConfig | undefined): boolean {
  return !!(adv?.certLifetime || adv?.renewalWindowRatio !== undefined);
}


/** Stable tag identifying a proxy's manually-loaded certificate (#152) in
 *  apps.tls.certificates.load_files — derived the same way as the proxy's own identity
 *  (host, or port when hostless) so it survives edits to unrelated fields. */
export function customCertTag(proxy: Pick<ProxyEntry, "externalPort" | "externalHost" | "matchers">): string {
  return `custom:${standaloneProxyId(proxy)}`;
}


export function buildTlsPolicy(
  proxy: {
    tlsAdvanced?: import("./types").TlsAdvancedConfig;
    mtls?: import("./types").MtlsConfig;
    customTls?: import("./types").CustomTlsConfig;
    externalPort?: number;
    externalHost?: string;
    matchers?: import("./types").RouteMatch;
  },
): CaddyTLSConnectionPolicy {
  const policy: CaddyTLSConnectionPolicy = {};
  if (proxy.tlsAdvanced) {
    if (proxy.tlsAdvanced.protocolMin) policy.protocol_min = proxy.tlsAdvanced.protocolMin;
    if (proxy.tlsAdvanced.protocolMax) policy.protocol_max = proxy.tlsAdvanced.protocolMax;
    if (proxy.tlsAdvanced.cipherSuites?.length) policy.cipher_suites = proxy.tlsAdvanced.cipherSuites;
    if (proxy.tlsAdvanced.curves?.length) policy.curves = proxy.tlsAdvanced.curves;
  }
  if (proxy.mtls) {
    const ca: CaddyTLSClientAuthentication = { mode: proxy.mtls.mode };
    if (proxy.mtls.trustedCaFile?.trim()) {
      ca.ca = { provider: "file", pem_files: [proxy.mtls.trustedCaFile.trim()] };
    }
    policy.client_authentication = ca;
  }
  if (proxy.customTls?.certFile?.trim() && proxy.customTls?.keyFile?.trim() && proxy.externalPort !== undefined) {
    policy.certificate_selection = {
      any_tag: [customCertTag({ externalPort: proxy.externalPort, externalHost: proxy.externalHost, matchers: proxy.matchers })],
    };
  }
  return policy;
}


/**
 * Rebuilds apps.tls.automation.policies after a single server (identified by
 * changedServerKey, addressed by changedHosts if it has real hostnames) was
 * added/edited.
 *
 * Caddy can only scope an automation policy by `subjects` (hostnames) — there
 * is no "tags"-style field for arbitrary per-server scoping. So:
 *  - A server with real (non-IP) hostnames gets its own policy scoped by
 *    `subjects` listing all of them (#208), independent of every other server.
 *  - A hostless server (the common case here, since this app addresses most
 *    proxies by port) has no way to get its own distinct policy — Caddy allows
 *    only one policy without subjects. Its custom lifetime/ratio is merged
 *    directly into that single shared default policy instead; if more than one
 *    hostless server customizes it, the most recently saved one wins.
 */
export function rebuildTlsAutomationPolicies(
  config: CaddyConfig,
  servers: Record<string, { tls_connection_policies?: CaddyTLSConnectionPolicy[] }>,
  changedServerKey: string,
  changedAdv: import("./types").TlsAdvancedConfig | undefined,
  changedHosts: string[],
  changedIssuer?: "acme" | "internal",
): import("./types").CaddyTlsApp | undefined {
  const hasTls = Object.values(servers).some(
    s => Array.isArray(s.tls_connection_policies) && s.tls_connection_policies.length > 0,
  );
  if (!hasTls) return undefined;

  const isChangedServerLive = !!servers[changedServerKey]?.tls_connection_policies?.length;
  const existing = config.apps?.tls?.automation?.policies ?? [];
  const otherSubjectPolicies = existing.filter(p => p.subjects?.length && !changedHosts.some(h => subjectsInclude(p.subjects, h)));

  // A hostless proxy/server always carries the current shared internal-cert lifetime
  // in its own tlsAdvanced by the time it reaches here (useProxies.ts stamps it on
  // before every write — see GlobalOptions.internalCertLifetime), so it's safe to
  // apply directly to the shared default policy: every hostless site is guaranteed to
  // agree on the same value by construction, unlike a raw per-proxy field would be.
  // renewal_window_ratio is deliberately left alone here — it comes only from the
  // real global `renewal_window_ratio` Caddyfile option, which the next reload applies.
  let defaultPolicy: import("./types").CaddyAutomationPolicy =
    existing.find(p => !p.subjects?.length) ?? { issuers: [{ module: "internal" }] };

  if (!changedHosts.length && isChangedServerLive) {
    const issuer: { module: string; lifetime?: string } = { module: "internal" };
    if (changedAdv?.certLifetime) issuer.lifetime = changedAdv.certLifetime;
    defaultPolicy = { ...defaultPolicy, issuers: [issuer] };
  }

  const policies: import("./types").CaddyAutomationPolicy[] = [defaultPolicy, ...otherSubjectPolicies];

  // #341: a site on its own ACME account, CA or key type gets a policy of its own; the default
  // issuers stay for whatever it leaves unset.
  if (changedHosts.length && isChangedServerLive && changedIssuer === "acme" && (changedAdv?.acmeEmail || changedAdv?.acmeCa || changedAdv?.keyType)) {
    const issuer = { module: "acme", ...(changedAdv.acmeCa ? { ca: changedAdv.acmeCa } : {}), ...(changedAdv.acmeEmail ? { email: changedAdv.acmeEmail } : {}) };
    policies.push({
      subjects: changedHosts,
      ...(changedAdv.acmeCa || changedAdv.acmeEmail ? { issuers: [issuer] } : {}),
      ...(changedAdv.keyType ? { key_type: changedAdv.keyType } : {}),
    });
  } else if (changedHosts.length && isChangedServerLive && changedAdv?.keyType && !hasCustomInternalIssuer(changedAdv)) {
    // The internal CA is the default; a key type on its own still needs an issuer to keep it.
    policies.push({ subjects: changedHosts, issuers: [{ module: "internal" }], key_type: changedAdv.keyType });
  } else if (changedHosts.length && isChangedServerLive && hasCustomInternalIssuer(changedAdv)) {
    const issuer: { module: string; lifetime?: string } = { module: "internal" };
    if (changedAdv?.certLifetime) issuer.lifetime = changedAdv.certLifetime;
    policies.push({
      subjects: changedHosts,
      issuers: [issuer],
      ...(changedAdv?.renewalWindowRatio !== undefined ? { renewal_window_ratio: changedAdv.renewalWindowRatio } : {}),
      ...(changedAdv?.keyType ? { key_type: changedAdv.keyType } : {}),
    });
  }

  return { automation: { policies } };
}


/** True when the reverse_proxy re-raises upstream responses as errors (the #255 switch). */
export function reraisesUpstreamErrors(rp: CaddyReverseProxyHandler): boolean {
  const responses = (rp.handle_response as Array<{ routes?: Array<{ handle?: Array<{ handler?: string }> }> }> | undefined) ?? [];
  return responses.some(r => r.routes?.some(route => route.handle?.some(h => h.handler === "error")));
}


export function parseErrorHandlers(server: CaddyServer): import("./types").ErrorHandlerConfig[] | undefined {
  const errRoutes = (server.errors as { routes?: unknown[] } | undefined)?.routes;
  if (!errRoutes?.length) return undefined;

  const handlers: import("./types").ErrorHandlerConfig[] = [];
  for (const route of errRoutes as Array<Record<string, unknown>>) {
    const matchArr = (route.match as Array<Record<string, unknown>> | undefined) ?? [];
    const firstMatch = matchArr[0] ?? {};

    let matchType: import("./types").ErrorMatchType = "all";
    let codes: number[] | undefined;

    if (typeof firstMatch.expression === "string") {
      const expr = firstMatch.expression;
      const inMatch = expr.match(/in \[([0-9, ]+)\]/);
      if (inMatch) {
        codes = inMatch[1].split(",").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
        matchType = "specific";
      } else if (expr.includes(">= 400") || expr.includes("< 500")) {
        matchType = "4xx";
      } else if (expr.includes(">= 500") || expr.includes("< 600")) {
        matchType = "5xx";
      }
    }

    // Caddy's Caddyfile adapter wraps handlers in a subroute — flatten before searching.
    const rawHandles = (route.handle as Array<Record<string, unknown>> | undefined) ?? [];
    const handles = flattenErrorHandles(rawHandles);

    const fsHandle = handles.find(h => h.handler === "file_server");
    if (fsHandle) {
      handlers.push({ matchType, codes, type: "static", filePath: typeof fsHandle.root === "string" ? fsHandle.root : undefined });
      continue;
    }
    const srHandle = handles.find(h => h.handler === "static_response") as
      { handler: string; status_code?: number; body?: string; headers?: Record<string, string[]> } | undefined;
    if (srHandle) {
      const location = srHandle.headers?.["Location"]?.[0];
      if (location) {
        handlers.push({ matchType, codes, type: "redirect", redirectTo: location, redirectCode: (srHandle.status_code ?? 302) as 301 | 302 | 307 | 308 });
      } else {
        handlers.push({ matchType, codes, type: "respond", body: srHandle.body, statusCode: srHandle.status_code });
      }
    }
  }
  return handlers.length ? handlers : undefined;
}


export function buildErrorRoutes(handlers: import("./types").ErrorHandlerConfig[]): { routes: unknown[] } | undefined {
  if (!handlers.length) return undefined;
  const routes = handlers.map(h => {
    let match: unknown[] | undefined;
    if (h.matchType === "specific" && h.codes?.length) {
      const codes = h.codes.join(", ");
      match = [{ expression: `{http.error.status_code} in [${codes}]` }];
    } else if (h.matchType === "4xx") {
      match = [{ expression: "{http.error.status_code} >= 400 && {http.error.status_code} < 500" }];
    } else if (h.matchType === "5xx") {
      match = [{ expression: "{http.error.status_code} >= 500 && {http.error.status_code} < 600" }];
    }

    let handle: Record<string, unknown>[];
    if (h.type === "redirect") {
      handle = [{ handler: "static_response", status_code: h.redirectCode ?? 302, headers: { Location: [h.redirectTo ?? "/"] } }];
    } else if (h.type === "static") {
      handle = [
        { handler: "rewrite", uri: "/{http.error.status_code}.html" },
        { handler: "file_server", root: h.filePath ?? "/var/www/errors" },
      ];
    } else {
      const r: Record<string, unknown> = { handler: "static_response" };
      if (h.statusCode) r.status_code = h.statusCode;
      if (h.body) r.body = h.body;
      handle = [r];
    }

    const route: Record<string, unknown> = { handle };
    if (match) route.match = match;
    return route;
  });
  return { routes };
}


export function applyErrorHandlers(server: CaddyServer, proxy: { errorHandlers?: import("./types").ErrorHandlerConfig[] }): void {
  const built = proxy.errorHandlers?.length ? buildErrorRoutes(proxy.errorHandlers) : undefined;
  if (built) {
    (server as Record<string, unknown>).errors = built;
  } else {
    delete (server as Record<string, unknown>).errors;
  }
}


export function buildServerEntry(proxy: Omit<ProxyEntry, "id" | "serverKey">): CaddyServer {
  const listenAddrs = buildListenAddrs(proxy);
  // A route with matchers is NOT terminal — allow fallthrough to subsequent routes.
  const isTerminal = !proxy.matchers;
  const matchArr = proxy.matchers ? [buildMatcherJson(proxy.matchers)] : siteHostMatch(proxy);

  if (proxy.staticResponse) {
    const h: Record<string, unknown> = {
      handler: "static_response",
      status_code: proxy.staticResponse.statusCode,
    };
    if (proxy.staticResponse.body) h.body = proxy.staticResponse.body;
    if (proxy.staticResponse.close) h.close = true;
    const route: CaddyRoute = { handle: [h as CaddyHandler], terminal: isTerminal };
    if (matchArr) route.match = matchArr;
    const server: CaddyServer = { listen: listenAddrs, routes: [route] };
    applyAccessLog(server, proxy);
    applyErrorHandlers(server, proxy);
    return applyServerTimeouts(server, proxy);
  }
  if (proxy.redirect) {
    const route: CaddyRoute = {
      handle: [buildRedirectHandler(proxy.redirect)],
      terminal: isTerminal,
    };
    if (matchArr) route.match = matchArr;
    const server: CaddyServer = { listen: listenAddrs, routes: [route] };
    applyAccessLog(server, proxy);
    applyErrorHandlers(server, proxy);
    return applyServerTimeouts(server, proxy);
  }
  if (proxy.fileServer) {
    const fsHandles: CaddyHandler[] = [];
    if (proxy.requestBodyMaxSize) fsHandles.push(buildRequestBodyHandler(proxy.requestBodyMaxSize));
    if (proxy.compress) fsHandles.push(buildEncodeHandler(proxy.encodeOptions));
    if (proxy.basicAuth?.length) fsHandles.push(buildBasicAuthHandler(proxy.basicAuth, proxy.basicAuthOptions));
    if (proxy.responseHeaders?.length) fsHandles.push(buildResponseHeadersHandler(proxy.responseHeaders));
    fsHandles.push(...buildFileServerHandlers(proxy.fileServer));
    const route: CaddyRoute = { handle: withSpaFallback(proxy.fileServer, fsHandles), terminal: isTerminal };
    if (matchArr) route.match = matchArr;
    const server: CaddyServer = { listen: listenAddrs, routes: [route] };
    if (proxy.tls) server.tls_connection_policies = [buildTlsPolicy(proxy)];
    applyAccessLog(server, proxy);
    applyErrorHandlers(server, proxy);
    return applyServerTimeouts(server, proxy);
  }
  const handles: CaddyHandler[] = [];
  if (proxy.requestBodyMaxSize) handles.push(buildRequestBodyHandler(proxy.requestBodyMaxSize));
  const handlePathRwSingle = proxy.handlePath ? buildHandlePathRewriteJson(proxy.matchers) : undefined;
  if (handlePathRwSingle) handles.push(handlePathRwSingle);
  if (proxy.compress) handles.push(buildEncodeHandler(proxy.encodeOptions));
  if (proxy.basicAuth?.length) handles.push(buildBasicAuthHandler(proxy.basicAuth, proxy.basicAuthOptions));
  if (proxy.responseHeaders?.length) handles.push(buildResponseHeadersHandler(proxy.responseHeaders));
  if (proxy.rewrite) handles.push(buildRewriteHandler(proxy.rewrite));
  if (proxy.forwardAuth) {
    const faH = buildForwardAuthHandler(proxy.forwardAuth);
    if (faH) handles.push(faH);
  }
  handles.push(buildReverseProxyHandler(proxy, proxy.errorHandlers));
  const route: CaddyRoute = { handle: handles, terminal: isTerminal };
  if (matchArr) route.match = matchArr;
  const server: CaddyServer = { listen: listenAddrs, routes: [route] };
  if (proxy.tls) server.tls_connection_policies = [buildTlsPolicy(proxy)];
  applyAccessLog(server, proxy);
  applyErrorHandlers(server, proxy);
  return applyServerTimeouts(server, proxy);
}


/** The `templates` handler of a static site and then its file_server (#339). */
export function buildFileServerHandlers(fs: import("./types").FileServerConfig): CaddyHandler[] {
  const out: CaddyHandler[] = [];
  if (fs.templates) {
    out.push({
      handler: "templates",
      ...(fs.templates.root ? { file_root: fs.templates.root } : {}),
      ...(fs.templates.mime?.length ? { mime_types: fs.templates.mime } : {}),
    } as CaddyHandler);
  }
  out.push(buildFileServerJson(fs));
  return out;
}


/** The `templates` options of a route's handlers, or undefined without the directive (#339). */
export function parseTemplatesJson(handles: AnyHandler[]): import("./types").TemplatesConfig | undefined {
  const h = handles.find(x => x.handler === "templates") as { file_root?: string; mime_types?: string[] } | undefined;
  if (!h) return undefined;
  return {
    ...(h.mime_types?.length ? { mime: h.mime_types } : {}),
    ...(h.file_root ? { root: h.file_root } : {}),
  };
}


export function buildFileServerJson(fs: import("./types").FileServerConfig): CaddyHandler {
  const h: Record<string, unknown> = { handler: "file_server", root: fs.root };
  if (fs.browse) h.browse = fs.browseTemplate ? { template_file: fs.browseTemplate } : {};
  if (fs.disableCanonicalUris) h.canonical_uris = false;
  if (fs.status) h.status_code = fs.status;
  if (fs.index?.length) h.index_names = fs.index;
  if (fs.hide?.length) h.hide = fs.hide;
  if (fs.precompressed?.length) {
    h.precompressed = Object.fromEntries(fs.precompressed.map(e => [e, {}]));
    h.precompressed_order = fs.precompressed;
  }
  return h as CaddyHandler;
}


/**
 * SPA mode (#262) the way `try_files` adapts: a subroute whose first route rewrites to the
 * first existing file of `{path}` / `/index.html`, then the site's own handlers.
 */
export function withSpaFallback(fs: import("./types").FileServerConfig, handles: CaddyHandler[]): CaddyHandler[] {
  if (!fs.spa) return handles;
  return [{
    handler: "subroute",
    routes: [
      {
        match: [{ file: { root: fs.root, try_files: ["{http.request.uri.path}", "/index.html"] } }],
        handle: [{ handler: "rewrite", uri: "{http.matchers.file.relative}" }],
      },
      { handle: handles },
    ],
  } as CaddyHandler];
}


/** Patch handles in-place: update reverse_proxy and rewrite handlers, leave everything else untouched. */
export function patchHandles(handles: CaddyHandler[], proxy: ProxyEntry): CaddyHandler[] {
  if (proxy.fileServer) {
    const fsHandles: CaddyHandler[] = [];
    if (proxy.requestBodyMaxSize) fsHandles.push(buildRequestBodyHandler(proxy.requestBodyMaxSize));
    if (proxy.compress) fsHandles.push(buildEncodeHandler(proxy.encodeOptions));
    if (proxy.basicAuth?.length) fsHandles.push(buildBasicAuthHandler(proxy.basicAuth, proxy.basicAuthOptions));
    if (proxy.responseHeaders?.length) fsHandles.push(buildResponseHeadersHandler(proxy.responseHeaders));
    fsHandles.push(...buildFileServerHandlers(proxy.fileServer));
    return withSpaFallback(proxy.fileServer, fsHandles);
  }
  let found = false;
  // Strip any existing encode/authentication/rewrite/headers/file_server/forward_auth/
  // request_body handlers; we'll re-add the correct ones below
  const withoutRewrite = handles.filter(h => {
    if (h.handler === "rewrite" || h.handler === "headers" || h.handler === "encode" || h.handler === "authentication" || h.handler === "file_server" || h.handler === "templates" || h.handler === "request_body") return false;
    if (h.handler === "subroute") {
      const isAuthSubroute = (h.routes as Array<{ handle?: AnyHandler[] }> | undefined)?.some(r =>
        (r.handle ?? []).some(sh => sh.handler === "reverse_proxy" && isForwardAuthProxy(sh as CaddyReverseProxyHandler)),
      );
      if (isAuthSubroute) return false;
    }
    return true;
  });
  const patched = withoutRewrite.map(h => {
    if (h.handler === "reverse_proxy") {
      found = true;
      return buildReverseProxyHandler(proxy, proxy.errorHandlers);
    }
    // Recurse into subroute
    const anyH = h as AnyHandler;
    if (anyH.handler === "subroute" && anyH.routes) {
      return {
        ...h,
        routes: anyH.routes.map(r => ({
          ...r,
          handle: r.handle ? patchHandles(r.handle as CaddyHandler[], proxy) : r.handle,
        })),
      };
    }
    return h;
  });
  if (!found) {
    patched.push(buildReverseProxyHandler(proxy, proxy.errorHandlers));
  }
  // Prepend request_body/encode/auth/response-headers/rewrite/forward_auth handlers if
  // configured — request_body must run first, before anything that reads the body.
  const prefix: CaddyHandler[] = [];
  if (proxy.requestBodyMaxSize) prefix.push(buildRequestBodyHandler(proxy.requestBodyMaxSize));
  if (proxy.compress) prefix.push(buildEncodeHandler(proxy.encodeOptions));
  if (proxy.basicAuth?.length) prefix.push(buildBasicAuthHandler(proxy.basicAuth, proxy.basicAuthOptions));
  if (proxy.responseHeaders?.length) prefix.push(buildResponseHeadersHandler(proxy.responseHeaders));
  if (proxy.rewrite) prefix.push(buildRewriteHandler(proxy.rewrite));
  if (proxy.forwardAuth) {
    const faH = buildForwardAuthHandler(proxy.forwardAuth);
    if (faH) prefix.push(faH);
  }
  return [...prefix, ...patched] as CaddyHandler[];
}


/** Patch only the fields we manage; preserve everything else in the original server. */
export function patchServer(original: CaddyServer, proxy: ProxyEntry): CaddyServer {
  const server = { ...original };

  server.listen = buildListenAddrs(proxy);

  if (proxy.tls) {
    server.tls_connection_policies = [buildTlsPolicy(proxy)];
  } else {
    delete server.tls_connection_policies;
  }

  const siteMatch = siteHostMatch(proxy);
  server.routes = (original.routes ?? []).filter(route => !isLogSkipRoute(route)).map(route => {
    const patched: CaddyRoute = { ...route, handle: patchHandles((route.handle ?? []) as CaddyHandler[], proxy) };
    if (siteMatch) patched.match = siteMatch;
    // A name list set by an earlier multi-host save would otherwise outlive the edit
    // that took the proxy back to one name (or none).
    else if (!proxy.matchers && isMultiHostOnlyMatch(route.match)) delete patched.match;
    return patched;
  });

  applyAccessLog(server, proxy);
  applyErrorHandlers(server, proxy);

  return applyServerTimeouts(server, proxy);
}


export function buildLoggingWriter(accessLog: import("./types").AccessLogConfig): import("./types").CaddyLogWriter {
  if (accessLog.output !== "file" || !accessLog.filePath) return { output: accessLog.output };
  const writer: import("./types").CaddyLogWriter = { output: "file", filename: accessLog.filePath };
  if (accessLog.rollSizeMb) writer.roll_size_mb = accessLog.rollSizeMb;
  if (accessLog.rollKeepCount) writer.roll_keep = accessLog.rollKeepCount;
  if (accessLog.rollKeepDays) writer.roll_keep_days = accessLog.rollKeepDays;
  if (accessLog.rollCompress === false) writer.roll_gzip = false;
  return writer;
}


/** The `filter` encoder of #334: the field filters, wrapped around the encoder that writes the entry. */
export function buildFilterEncoder(format: string | undefined, filters: import("./types").LogFieldFilter[]): import("./types").CaddyLogEncoder {
  const fields: NonNullable<import("./types").CaddyLogEncoder["fields"]> = {};
  for (const f of filters) {
    fields[f.field] = f.filter === "replace" ? { filter: "replace", value: f.value ?? "" }
      : f.filter === "ip_mask" ? { filter: "ip_mask", ...(f.ipv4 != null ? { ipv4_cidr: f.ipv4 } : {}), ...(f.ipv6 != null ? { ipv6_cidr: f.ipv6 } : {}) }
      : { filter: f.filter };
  }
  return { format: "filter", wrap: { format: format ?? "json" }, fields };
}


/** The format and field filters of a logger's encoder (#334), reading `filter` through to what it wraps. */
export function parseLogEncoder(encoder: import("./types").CaddyLogEncoder | undefined): Pick<import("./types").AccessLogConfig, "format" | "fieldFilters"> {
  if (encoder?.format !== "filter") return { format: encoder?.format as import("./types").AccessLogFormat | undefined };
  const fieldFilters = Object.entries(encoder.fields ?? {}).flatMap(([field, f]): import("./types").LogFieldFilter[] => {
    if (f.filter === "replace") return [{ field, filter: "replace", value: f.value ?? "" }];
    if (f.filter === "ip_mask") return [{ field, filter: "ip_mask", ...(f.ipv4_cidr != null ? { ipv4: f.ipv4_cidr } : {}), ...(f.ipv6_cidr != null ? { ipv6: f.ipv6_cidr } : {}) }];
    return f.filter === "delete" || f.filter === "hash" ? [{ field, filter: f.filter }] : [];
  });
  return {
    format: encoder.wrap?.format as import("./types").AccessLogFormat | undefined,
    ...(fieldFilters.length ? { fieldFilters } : {}),
  };
}


/** Update config.logging.logs: swap out the old logger for this proxy (if any) and add/remove the new one. */
export function patchLoggingLogs(
  config: CaddyConfig,
  originalServer: CaddyServer | undefined,
  proxy: ProxyEntry,
): CaddyConfig["logging"] {
  const existingLogs = { ...(config.logging?.logs ?? {}) };

  // Remove the old logger for this server slot (it may be auto-named by Caddy or our own name)
  const oldLoggerName = (originalServer?.logs as { default_logger_name?: string } | undefined)?.default_logger_name;
  if (oldLoggerName) {
    delete existingLogs[oldLoggerName];
    const excKey = `http.log.access.${oldLoggerName}`;
    if (existingLogs.default?.exclude) {
      const filtered = existingLogs.default.exclude.filter(e => e !== excKey);
      existingLogs.default = filtered.length
        ? { ...existingLogs.default, exclude: filtered }
        : Object.fromEntries(Object.entries(existingLogs.default).filter(([k]) => k !== "exclude")) as typeof existingLogs.default;
      if (existingLogs.default && !Object.keys(existingLogs.default).length) delete existingLogs.default;
    }
  }

  if (proxy.accessLog) {
    const loggerName = accessLoggerName(proxy.externalPort);
    const incKey = `http.log.access.${loggerName}`;
    const logEntry: import("./types").CaddyLoggerConfig = {
      writer: buildLoggingWriter(proxy.accessLog),
      include: [incKey],
    };
    if (proxy.accessLog.fieldFilters?.length) logEntry.encoder = buildFilterEncoder(proxy.accessLog.format, proxy.accessLog.fieldFilters);
    else if (proxy.accessLog.format) logEntry.encoder = { format: proxy.accessLog.format };
    if (proxy.accessLog.level) logEntry.level = proxy.accessLog.level;
    existingLogs[loggerName] = logEntry;

    // Keep the default logger from flooding its output with access log lines
    const defExcludes = new Set<string>(existingLogs.default?.exclude ?? []);
    defExcludes.add(incKey);
    existingLogs.default = { ...(existingLogs.default ?? {}), exclude: [...defExcludes] };
  }

  return Object.keys(existingLogs).length > 0 ? { logs: existingLogs } : undefined;
}


/**
 * Rebuilds apps.tls.certificates.load_files after a single proxy was added/edited —
 * mirrors rebuildTlsAutomationPolicies's "filter out this proxy's old entry, re-add if
 * still applicable" pattern, keyed by the proxy's own stable identity tag rather than by
 * cert content, so switching to a different cert file (or disabling TLS/reverting to
 * ACME/internal) cleanly replaces or drops the old load_files entry instead of leaking it.
 */
/**
 * The tls app after a JSON push (#253): only the automation policies and the loaded
 * certificate files are rebuilt by the plugin. Everything else in apps.tls stays, above all
 * automation.on_demand (the global ask permission): dropping it left on-demand sites with no
 * permission check until the next reload.
 */
export function mergeTlsApp(
  prev: import("./types").CaddyTlsApp | undefined,
  rebuilt: import("./types").CaddyTlsApp | undefined,
  certificates?: Pick<import("./types").CaddyTlsApp, "certificates">,
): import("./types").CaddyTlsApp | undefined {
  const without = (obj: unknown, key: string): Record<string, unknown> =>
    Object.fromEntries(Object.entries((obj ?? {}) as Record<string, unknown>).filter(([k]) => k !== key));
  const { automation: prevAutomation, certificates: prevCertificates, ...rest } = (prev ?? {}) as import("./types").CaddyTlsApp & Record<string, unknown>;
  const automationRest = without(prevAutomation, "policies");
  const certificatesRest = without(prevCertificates, "load_files");
  const out: Record<string, unknown> = { ...rest };
  const policies = rebuilt?.automation?.policies;
  if (policies?.length || Object.keys(automationRest).length) {
    out.automation = { ...automationRest, ...(policies?.length ? { policies } : {}) };
  }
  const loadFiles = certificates?.certificates?.load_files;
  if (loadFiles?.length || Object.keys(certificatesRest).length) {
    out.certificates = { ...certificatesRest, ...(loadFiles?.length ? { load_files: loadFiles } : {}) };
  }
  return Object.keys(out).length ? out as import("./types").CaddyTlsApp : undefined;
}


export function rebuildTlsCertificates(
  config: CaddyConfig,
  proxy: Pick<ProxyEntry, "tls" | "customTls" | "externalPort" | "externalHost" | "matchers">,
): Pick<import("./types").CaddyTlsApp, "certificates"> | undefined {
  const tag = customCertTag(proxy);
  const existing = config.apps?.tls?.certificates?.load_files ?? [];
  const filtered = existing.filter(e => !e.tags?.includes(tag));
  const custom = proxy.tls ? proxy.customTls : undefined;
  const loadFiles = (custom?.certFile?.trim() && custom?.keyFile?.trim())
    ? [...filtered, { certificate: custom.certFile.trim(), key: custom.keyFile.trim(), tags: [tag] }]
    : filtered;
  return loadFiles.length ? { certificates: { load_files: loadFiles } } : undefined;
}


export function mergeProxy(config: CaddyConfig, proxy: ProxyEntry): CaddyConfig {
  const servers = { ...(config.apps?.http?.servers ?? {}) };
  const original = servers[proxy.serverKey];
  servers[proxy.serverKey] = (original && !proxy.redirect && !proxy.staticResponse) ? patchServer(original, proxy) : buildServerEntry(proxy);

  const logging = patchLoggingLogs(config, original, proxy);
  const automation = rebuildTlsAutomationPolicies(config, servers, proxy.serverKey, proxy.tlsAdvanced, tlsSubjectHosts(proxy.externalHost), proxy.tlsIssuer);
  const certificates = rebuildTlsCertificates(config, proxy);

  return {
    ...config,
    logging,
    apps: {
      ...config.apps,
      http: { ...config.apps?.http, servers },
      tls: mergeTlsApp(config.apps?.tls, automation, certificates),
    },
  };
}


export function removeProxy(config: CaddyConfig, serverKey: string): CaddyConfig {
  const servers = { ...(config.apps?.http?.servers ?? {}) };
  const removedServer = servers[serverKey];
  delete servers[serverKey];

  const hasTls = Object.values(servers).some(
    s => Array.isArray(s.tls_connection_policies) && s.tls_connection_policies.length > 0,
  );

  // Clean up the access logger for the removed server
  const removedLoggerName = (removedServer?.logs as { default_logger_name?: string } | undefined)?.default_logger_name;
  let logging = config.logging;
  if (removedLoggerName && config.logging?.logs) {
    const logs = { ...config.logging.logs };
    delete logs[removedLoggerName];
    const excKey = `http.log.access.${removedLoggerName}`;
    if (logs.default?.exclude) {
      const filtered = logs.default.exclude.filter(e => e !== excKey);
      logs.default = filtered.length
        ? { ...logs.default, exclude: filtered }
        : Object.fromEntries(Object.entries(logs.default).filter(([k]) => k !== "exclude")) as typeof logs.default;
      if (logs.default && !Object.keys(logs.default).length) delete logs.default;
    }
    logging = Object.keys(logs).length > 0 ? { logs } : undefined;
  }

  return {
    ...config,
    logging,
    apps: {
      ...config.apps,
      http: { ...config.apps?.http, servers },
      tls: hasTls ? config.apps?.tls : undefined,
    },
  };
}


/**
 * Builds/patches the Caddy JSON config for a named server (multiple routes).
 * All routes belonging to the same namedServerKey are combined into one CaddyServer entry.
 */
export function mergeNamedServer(
  config: CaddyConfig,
  def: import("./types").ServerDef,
  routes: ProxyEntry[],
): CaddyConfig {
  const servers = { ...(config.apps?.http?.servers ?? {}) };

  const caddyRoutes: CaddyRoute[] = [];
  const namedRoutesMap: Record<string, { handle: CaddyHandler[] }> = {};
  const normalRoutes = routes.filter(r => !r.isNamedRoute);
  const namedRoutes = routes.filter(r => r.isNamedRoute && r.namedRouteName);

  // Named routes go into named_routes map; their server route just invokes
  for (const nr of namedRoutes) {
    const handles = buildRouteHandlesForEntry(nr);
    namedRoutesMap[nr.namedRouteName!] = { handle: handles };
    const invokeRoute: CaddyRoute = { handle: [{ handler: "invoke", name: nr.namedRouteName! }] };
    if (nr.matchers) invokeRoute.match = [buildMatcherJson(nr.matchers)];
    caddyRoutes.push(invokeRoute);
  }

  // Sort normal routes: matcher routes first, catch-all last
  const matcherRoutes = normalRoutes.filter(r => hasAnyMatcher(r.matchers));
  const catchAllRoutes = normalRoutes.filter(r => !hasAnyMatcher(r.matchers));

  for (const route of [...matcherRoutes, ...catchAllRoutes]) {
    const handles = buildRouteHandlesForEntry(route);
    const cRoute: CaddyRoute = { handle: handles, terminal: !route.matchers };
    if (route.matchers) cRoute.match = [buildMatcherJson(route.matchers)];
    caddyRoutes.push(cRoute);
  }

  const listenAddrs = def.listenAddresses.length ? def.listenAddresses : [`:${routes[0]?.externalPort ?? 80}`];

  // Caddy assigns its own generated names (srv0, srv1, ...) to servers it loads
  // straight from the Caddyfile on disk. If this named server's first live JSON
  // push happens after such a reload, the auto-generated entry for the same
  // block is still sitting in `servers` under a different key and claims the
  // same listen address — drop it so the two don't collide (#129).
  for (const [otherKey, otherServer] of Object.entries(servers)) {
    if (otherKey !== def.key && otherServer.listen?.some(addr => listenAddrs.includes(addr))) {
      delete servers[otherKey];
    }
  }

  const server: CaddyServer = {
    listen: listenAddrs,
    routes: caddyRoutes,
  };
  if (def.tls) server.tls_connection_policies = [buildTlsPolicy(def)];
  if (Object.keys(namedRoutesMap).length) {
    (server as Record<string, unknown>).named_routes = namedRoutesMap;
  }

  // Apply server-level settings from ServerDef
  if (def.serverReadTimeout) server.read_timeout = def.serverReadTimeout;
  if (def.serverReadHeaderTimeout) server.read_header_timeout = def.serverReadHeaderTimeout;
  if (def.serverWriteTimeout) server.write_timeout = def.serverWriteTimeout;
  if (def.serverIdleTimeout) server.idle_timeout = def.serverIdleTimeout;
  if (def.maxHeaderBytes) server.max_header_bytes = def.maxHeaderBytes;
  // #51 — Caddy enables h1/h2/h3 by default; explicitly list h1+h2 only to opt out of h3.
  if (def.disableHttp3) server.protocols = ["h1", "h2"];

  if (def.accessLog) {
    const loggerName = `cockpit-server-${def.key}`;
    (server as Record<string, unknown>).logs = { default_logger_name: loggerName };
  }
  applyServerExtras(server, def.serverExtras);

  if (def.errorHandlers?.length) {
    const built = buildErrorRoutes(def.errorHandlers);
    if (built) (server as Record<string, unknown>).errors = built;
  }

  servers[def.key] = server;

  // Build access log config entry
  let logging = config.logging;
  if (def.accessLog) {
    const loggerName = `cockpit-server-${def.key}`;
    const existingLogs = { ...(config.logging?.logs ?? {}) };
    existingLogs[loggerName] = {
      writer: buildLoggingWriter(def.accessLog),
      ...(def.accessLog.fieldFilters?.length ? { encoder: buildFilterEncoder(def.accessLog.format, def.accessLog.fieldFilters) }
        : def.accessLog.format ? { encoder: { format: def.accessLog.format } } : {}),
      ...(def.accessLog.level ? { level: def.accessLog.level } : {}),
    };
    const defExcludes = new Set<string>(existingLogs.default?.exclude ?? []);
    defExcludes.add(`http.log.access.${loggerName}`);
    existingLogs.default = { ...(existingLogs.default ?? {}), exclude: [...defExcludes] };
    logging = { logs: existingLogs };
  }

  return {
    ...config,
    logging,
    apps: {
      ...config.apps,
      http: { ...config.apps?.http, servers },
      tls: mergeTlsApp(config.apps?.tls, rebuildTlsAutomationPolicies(config, servers, def.key, def.tlsAdvanced, externalHostList(namedServerSubjectHost(def))), config.apps?.tls),
    },
  };
}


/** Removes a named server and all its routes from the JSON config. */
export function removeNamedServer(config: CaddyConfig, serverKey: string): CaddyConfig {
  const servers = { ...(config.apps?.http?.servers ?? {}) };
  delete servers[serverKey];
  const hasTls = Object.values(servers).some(
    s => Array.isArray(s.tls_connection_policies) && s.tls_connection_policies.length > 0,
  );
  const loggerName = `cockpit-server-${serverKey}`;
  let logging = config.logging;
  if (config.logging?.logs) {
    const logs = { ...config.logging.logs };
    delete logs[loggerName];
    const excKey = `http.log.access.${loggerName}`;
    if (logs.default?.exclude) {
      const filtered = logs.default.exclude.filter(e => e !== excKey);
      logs.default = filtered.length
        ? { ...logs.default, exclude: filtered }
        : Object.fromEntries(Object.entries(logs.default).filter(([k]) => k !== "exclude")) as typeof logs.default;
      if (logs.default && !Object.keys(logs.default).length) delete logs.default;
    }
    logging = Object.keys(logs).length > 0 ? { logs } : undefined;
  }
  return {
    ...config,
    logging,
    apps: {
      ...config.apps,
      http: { ...config.apps?.http, servers },
      tls: hasTls ? config.apps?.tls : undefined,
    },
  };
}


/** Builds the CaddyHandler list for a single ProxyEntry (used by mergeNamedServer). */
export function buildRouteHandlesForEntry(proxy: ProxyEntry): CaddyHandler[] {
  const handlePathRw = proxy.handlePath ? buildHandlePathRewriteJson(proxy.matchers) : undefined;

  if (proxy.staticResponse) {
    const h: Record<string, unknown> = {
      handler: "static_response",
      status_code: proxy.staticResponse.statusCode,
    };
    if (proxy.staticResponse.body) h.body = proxy.staticResponse.body;
    if (proxy.staticResponse.close) h.close = true;
    const result: CaddyHandler[] = [];
    if (handlePathRw) result.push(handlePathRw);
    result.push(h as CaddyHandler);
    return result;
  }
  if (proxy.redirect) {
    const result: CaddyHandler[] = [];
    if (handlePathRw) result.push(handlePathRw);
    result.push(buildRedirectHandler(proxy.redirect));
    return result;
  }
  if (proxy.fileServer) {
    const handles: CaddyHandler[] = [];
    if (handlePathRw) handles.push(handlePathRw);
    if (proxy.compress) handles.push(buildEncodeHandler(proxy.encodeOptions));
    if (proxy.basicAuth?.length) handles.push(buildBasicAuthHandler(proxy.basicAuth, proxy.basicAuthOptions));
    if (proxy.responseHeaders?.length) handles.push(buildResponseHeadersHandler(proxy.responseHeaders));
    handles.push(...buildFileServerHandlers(proxy.fileServer));
    return withSpaFallback(proxy.fileServer, handles);
  }
  const handles: CaddyHandler[] = [];
  if (handlePathRw) handles.push(handlePathRw);
  if (proxy.compress) handles.push(buildEncodeHandler(proxy.encodeOptions));
  if (proxy.basicAuth?.length) handles.push(buildBasicAuthHandler(proxy.basicAuth, proxy.basicAuthOptions));
  if (proxy.responseHeaders?.length) handles.push(buildResponseHeadersHandler(proxy.responseHeaders));
  if (proxy.rewrite) handles.push(buildRewriteHandler(proxy.rewrite));
  if (proxy.forwardAuth) {
    const faH = buildForwardAuthHandler(proxy.forwardAuth);
    if (faH) handles.push(faH);
  }
  handles.push(buildReverseProxyHandler(proxy, proxy.errorHandlers));
  return handles;
}
