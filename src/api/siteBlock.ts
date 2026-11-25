/**
 * A site as Caddyfile text: render a proxy to its block, and write or edit that block in a
 * conf.d document without touching the other blocks. Pure functions on strings; caddy.ts
 * re-exports the public ones.
 */
import type { ProxyEntry } from "./types";
import { externalHostList } from "./externalHosts";
import { CONF_HEADER, findBlockPositions, findMatchingBlock, hostsConflict, parseSiteAddresses, sameHostSet, surgicallyRemoveBlock } from "./caddyfileDocument";
import { LB_POLICIES, LbFields, TransportProps, UPSTREAM_ERROR_MESSAGE, bindsToIp, buildLbRetryLines, caddyQuote, dnsProviderLines, errorHandlerResponseCodes, hasAnyMatcher, headerOpLine, isIpAddress, isPathOnlyMatcher, multiPathStripRegex, presenceValues, routeHosts, tlsSubjectHosts } from "./siteShared";


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

export function buildForwardAuthCaddyLines(fa: import("./types").ForwardAuthConfig): string[] {
  if (!fa.upstreamUrl.trim()) return [];
  const lines = [`\tforward_auth ${fa.upstreamUrl} {`];
  lines.push(`\t\turi ${fa.uri || "/"}`);
  if (fa.copyHeaders.length) lines.push(`\t\tcopy_headers ${fa.copyHeaders.join(" ")}`);
  lines.push("\t}");
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

export function buildLogCaddyLines(log: import("./types").AccessLogConfig): string[] {
  const lines = ["\tlog {"];
  const rollLines = log.output === "file" ? buildLogRollLines(log, "\t\t\t") : [];
  if (log.output === "file" && log.filePath) {
    if (rollLines.length) {
      lines.push(`\t\toutput file ${log.filePath} {`, ...rollLines, "\t\t}");
    } else {
      lines.push(`\t\toutput file ${log.filePath}`);
    }
  } else {
    lines.push(`\t\toutput ${log.output}`);
  }
  if (log.format) lines.push(`\t\tformat ${log.format}`);
  if (log.level) lines.push(`\t\tlevel ${log.level}`);
  lines.push("\t}");
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
    || certLifetime || renewalWindowRatio !== undefined
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
    const policy = [...buildTlsPolicyBlockLines(adv, mtls), ...onDemandLines, ...dnsLines];
    return policy.length ? ["\ttls {", ...policy, "\t}"] : [];
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
  lines.push(...buildTlsPolicyBlockLines(adv, mtls));
  lines.push(...onDemandLines);
  lines.push("\t}");
  return lines;
}

/**
 * `root`, the SPA fallback and `file_server` with its options for a static site (#262). A site
 * without the new options writes exactly the lines it always did.
 */
export function buildFileServerLines(fs: import("./types").FileServerConfig, indent: string): string[] {
  const lines = [`${indent}root * ${caddyQuote(fs.root)}`];
  if (fs.spa) lines.push(`${indent}try_files {path} /index.html`);
  const head = fs.browse ? `${indent}file_server browse` : `${indent}file_server`;
  if (!hasFileServerOptions(fs)) {
    lines.push(head);
    return lines;
  }
  lines.push(`${head} {`);
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
  if (index || splitPath?.length || envEntries.length) {
    lines.push(`${indent}php_fastcgi ${upstream} {`);
    if (index) lines.push(`${indent}\tindex ${index}`);
    if (splitPath?.length) lines.push(`${indent}\tsplit ${splitPath.join(" ")}`);
    for (const [k, v] of envEntries) lines.push(`${indent}\tenv ${k} ${caddyQuote(v)}`);
    lines.push(`${indent}}`);
  } else {
    lines.push(`${indent}php_fastcgi ${upstream}`);
  }
  lines.push(`${indent}file_server`);
  return lines;
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
    lines.push(`${indent}redir ${p.redirect.to} ${p.redirect.code}`);
  } else if (p.fileServer) {
    if (p.compress) lines.push(`${indent}encode gzip zstd`);
    if (p.basicAuth?.length) {
      lines.push(`${indent}basic_auth {`);
      for (const a of p.basicAuth) lines.push(`${indent}\t${a.username} ${a.passwordHash}`);
      lines.push(`${indent}}`);
    }
    for (const h of p.responseHeaders ?? []) {
      lines.push(headerOpLine(`${indent}header`, h, { quoteSet: true }));
    }
    lines.push(...buildFileServerLines(p.fileServer, indent));
  } else if (p.phpFastcgi) {
    if (p.compress) lines.push(`${indent}encode gzip zstd`);
    if (p.basicAuth?.length) {
      lines.push(`${indent}basic_auth {`);
      for (const a of p.basicAuth) lines.push(`${indent}\t${a.username} ${a.passwordHash}`);
      lines.push(`${indent}}`);
    }
    for (const h of p.responseHeaders ?? []) {
      lines.push(headerOpLine(`${indent}header`, h, { quoteSet: true }));
    }
    lines.push(...buildPhpFastcgiLines(p.phpFastcgi, indent));
  } else {
    if (p.compress) lines.push(`${indent}encode gzip zstd`);
    if (p.basicAuth?.length) {
      lines.push(`${indent}basic_auth {`);
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

  // The directives the plugin writes again below are dropped here, each with its whole block.
  const rewritten = ["tls", "encode", "root", "file_server", "header", "basic_auth", "forward_auth", "reverse_proxy", "php_fastcgi"];
  // try_files belongs to the static and PHP forms (#262); on any other site it's the user's.
  if (proxy.fileServer || proxy.phpFastcgi) rewritten.push("try_files");

  while (i < closingIdx) {
    const line = lines[i];
    const trimmed = line.trim();

    if (nestDepth === 0 && rewritten.some(name => isDirective(trimmed, name))) {
      skipDirective();
      continue;
    }
    // Snippet imports (#288) follow proxy.imports; file and glob imports are the user's and stay.
    if (nestDepth === 0 && isSnippetImportLine(trimmed)) {
      i++;
      continue;
    }

    nestDepth += braces(trimmed);
    kept.push(line);
    i++;
  }

  // An IP host binds that IP (#254). A `bind` that only repeats the block's old IP header is the
  // one the plugin wrote, so it follows the host field; any other bind is the user's and stays.
  const oldHeader = parseSiteAddresses(lines[0].trim().replace(/\{$/, "").trim());
  const oldIp = oldHeader?.length === 1 && oldHeader[0].host && isIpAddress(oldHeader[0].host) ? oldHeader[0].host : undefined;
  const isOwnBind = (l: string) => !!oldIp && l.trim() === `bind ${oldIp}`;
  for (let k = kept.length - 1; k >= 1; k--) if (isOwnBind(kept[k])) kept.splice(k, 1);
  if (!kept.slice(1).some(l => /^\s*bind(\s|$)/.test(l))) kept.splice(1, 0, ...buildBindLines(proxy));
  kept.splice(1, 0, ...buildImportLines(proxy));
  // Re-add updated directives before closing brace
  kept.push(...buildTlsCaddyLines(proxy, !tlsSubjectHosts(proxy.externalHost).length));
  if (proxy.fileServer) {
    if (proxy.compress) kept.push("\tencode gzip zstd");
    if (proxy.basicAuth?.length) kept.push(...buildBasicAuthCaddyLines(proxy.basicAuth));
    for (const h of proxy.responseHeaders ?? []) {
      kept.push(headerOpLine(`\theader`, h, { quoteSet: true }));
    }
    kept.push(...buildFileServerLines(proxy.fileServer, "\t"));
  } else if (proxy.phpFastcgi) {
    // A hand-written PHP site (#247): its root/php_fastcgi/file_server were skipped above.
    if (proxy.compress) kept.push("\tencode gzip zstd");
    if (proxy.basicAuth?.length) kept.push(...buildBasicAuthCaddyLines(proxy.basicAuth));
    for (const h of proxy.responseHeaders ?? []) kept.push(headerOpLine("\theader", h, { quoteSet: true }));
    kept.push(...buildPhpFastcgiLines(proxy.phpFastcgi, "\t"));
  } else {
    if (proxy.compress) kept.push("\tencode gzip zstd");
    if (proxy.basicAuth?.length) kept.push(...buildBasicAuthCaddyLines(proxy.basicAuth));
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
  const isPluginFormat = !!headerAddresses?.every(a => a.port === proxy.externalPort && !a.path);

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
    updated = surgicallyRemoveBlock(updated, originalPort, originalHosts?.join(", "));
  }
  return surgicallyWriteProxy(updated, entry);
}

export function proxiesToCaddyfile(proxies: ProxyEntry[]): string {
  if (proxies.length === 0) return CONF_HEADER + "\n\n";
  return CONF_HEADER + "\n\n" + proxies.map(proxyToBlock).join("\n\n") + "\n";
}

// ---------------------------------------------------------------------------
// Surgical per-block conf.d editing
// ---------------------------------------------------------------------------


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
  return lines;
}

export function buildBasicAuthCaddyLines(accounts: { username: string; passwordHash: string }[]): string[] {
  return ["\tbasic_auth {", ...accounts.map(a => `\t\t${a.username} ${a.passwordHash}`), "\t}"];
}

export function buildRewriteCaddyLines(rewrite: import("./types").RewriteConfig, indent = "\t"): string[] {
  if (rewrite.type === "strip_prefix") return [`${indent}uri strip_prefix ${rewrite.value}`];
  if (rewrite.type === "add_prefix") return [`${indent}rewrite ${rewrite.value}{uri}`];
  // `uri path_regexp` replaces the matching part of the path, like the JSON rewrite handler's
  // path_regexp; a `path_regexp` matcher + `rewrite` replaced the whole URI instead (#254).
  // Both use Go's $1 backreferences.
  return [`${indent}uri path_regexp ${caddyQuote(rewrite.find)} ${caddyQuote(rewrite.replace)}`];
}

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

/** Generates the Caddyfile block for a single proxy (label comment + block body). */
/**
 * Rotation sub-directives (#155) — only meaningful for a file output. `roll_size` takes an
 * explicit MiB unit since a bare number is parsed as *bytes*, not megabytes (verified
 * against a live instance: `roll_size 100` produced `roll_size_mb: 1`, not 100).
 */
export function buildLogRollLines(log: import("./types").AccessLogConfig, indent: string): string[] {
  const lines: string[] = [];
  if (log.rollSizeMb) lines.push(`${indent}roll_size ${log.rollSizeMb}MiB`);
  if (log.rollKeepCount) lines.push(`${indent}roll_keep ${log.rollKeepCount}`);
  if (log.rollKeepDays) lines.push(`${indent}roll_keep_for ${log.rollKeepDays * 24}h`);
  if (log.rollCompress === false) lines.push(`${indent}roll_uncompressed`);
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
  return !!(fs.index?.length || fs.hide?.length || fs.precompressed?.length);
}

/** `import <snippet>` lines at the top of a site block (#288). */
export function buildImportLines(p: Pick<ProxyEntry, "imports">): string[] {
  return (p.imports ?? []).map(name => `\timport ${name}`);
}

/** `import name` of a snippet, as opposed to `import path/or/*glob`. */
export function isSnippetImportLine(trimmed: string): boolean {
  return /^import\s+[A-Za-z0-9][A-Za-z0-9_.-]*\s*$/.test(trimmed);
}

/**
 * An IP site address only matches the Host header in a Caddyfile and still listens on every
 * interface; `bind` is what restricts the listener, as the instant-apply JSON's `IP:port`
 * listen address does (#254).
 */
export function buildBindLines(proxy: { externalHost?: string }): string[] {
  return bindsToIp(proxy) ? [`\tbind ${proxy.externalHost}`] : [];
}
