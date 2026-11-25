// The global options block of the main Caddyfile and the plugin's managed sections around it:
// parsing it into GlobalOptions, patching changed options back in, the metrics site block and the
// DNS-challenge provider lines. Pure: no Host, no I/O. Builds on caddyfileDocument.

import { caddyQuote, findGlobalBlock, parseDnsProviderDirective } from "./caddyfileDocument";

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


/**
 * `servers` lines for the per-listener options of #328. Written in every `servers` block
 * that covers the listener, like the other options there.
 */
export function buildServerExtrasLines(extras: import("./types").ServerExtras | undefined, indent: string): string[] {
  const lines: string[] = [];
  if (extras?.keepaliveInterval) lines.push(`${indent}keepalive_interval ${extras.keepaliveInterval}`);
  if (extras?.keepaliveIdle) lines.push(`${indent}keepalive_idle ${extras.keepaliveIdle}`);
  if (extras?.strictSniHost) lines.push(`${indent}strict_sni_host`);
  if (extras?.logCredentials) lines.push(`${indent}log_credentials`);
  if (extras?.enableFullDuplex) lines.push(`${indent}enable_full_duplex`);
  return lines;
}


/**
 * Trusted proxy config lines for a `servers { }` block (#153) — used both for the global
 * (portless) block and merged into each per-port managed servers block, since Caddy's
 * per-port `servers :PORT { }` fully replaces (doesn't merge with) the global block's
 * settings for that port, verified against a live instance.
 */
export function buildTrustedProxiesLines(tp: import("./types").TrustedProxiesConfig, indent: string): string[] {
  const lines: string[] = [];
  if (tp.ranges.length) lines.push(`${indent}trusted_proxies static ${tp.ranges.join(" ")}`);
  if (tp.strict) lines.push(`${indent}trusted_proxies_strict`);
  if (tp.headers?.length) lines.push(`${indent}client_ip_headers ${tp.headers.join(" ")}`);
  return lines;
}


/**
 * PROXY protocol config lines for a `servers { }` block (#157) — same global/per-port-block
 * duplication requirement as buildTrustedProxiesLines, for the identical reason (a per-port
 * `servers :PORT { }` block fully replaces the global block's settings for that port).
 */
export function buildProxyProtocolLines(pp: import("./types").ProxyProtocolConfig, indent: string): string[] {
  const inner: string[] = [];
  if (pp.timeout) inner.push(`${indent}\t\ttimeout ${pp.timeout}`);
  if (pp.allow?.length) inner.push(`${indent}\t\tallow ${pp.allow.join(" ")}`);
  const lines = [`${indent}listener_wrappers {`];
  if (inner.length) {
    lines.push(`${indent}\tproxy_protocol {`, ...inner, `${indent}\t}`);
  } else {
    lines.push(`${indent}\tproxy_protocol`);
  }
  lines.push(`${indent}}`);
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

export const GLOBAL_MANAGED_BEGIN = "# cockpit-caddy:begin";

export const GLOBAL_MANAGED_END = "# cockpit-caddy:end";

export const GLOBAL_OPTS_BEGIN = "# cockpit-caddy:opts:begin";

export const GLOBAL_OPTS_END = "# cockpit-caddy:opts:end";


/**
 * Generic pure helper: inserts/replaces/removes a named managed section (delimited
 * by `beginMarker` / `endMarker`) inside the main Caddyfile global options block.
 * `body` is the new content between the markers (empty string = remove the section).
 */
export function patchManagedSection(content: string, beginMarker: string, endMarker: string, body: string): string {
  const bi = content.indexOf(beginMarker);
  const ei = content.indexOf(endMarker);

  if (bi !== -1 && ei !== -1) {
    if (!body) {
      const before = content.slice(0, bi).replace(/\n[ \t]*\n?$/, "\n");
      const after = content.slice(ei + endMarker.length).replace(/^[ \t]*\n/, "");
      const joined = before.trimEnd() + "\n" + after.trimStart();
      // If the global block is now entirely empty, remove it
      const gb = findGlobalBlock(joined);
      if (gb && !joined.slice(gb.open + 1, gb.close).trim()) {
        return joined.slice(0, gb.open).trimEnd() + "\n" + joined.slice(gb.close + 1).trimStart();
      }
      return joined;
    }
    return (
      content.slice(0, bi + beginMarker.length) +
      "\n" + body + "\n" +
      content.slice(ei)
    );
  }

  if (!body) return content;

  const managed = `${beginMarker}\n${body}\n${endMarker}`;
  const gb = findGlobalBlock(content);
  if (gb) {
    return content.slice(0, gb.close) + "\n" + managed + "\n" + content.slice(gb.close);
  }
  return "{\n" + managed + "\n}\n" + content;
}


/**
 * Pure function: inserts/replaces/removes the cockpit-caddy server-timeouts managed
 * section. `blocks` is the new servers block content (empty = remove).
 */
export function patchMainCaddyfile(content: string, blocks: string): string {
  return patchManagedSection(content, GLOBAL_MANAGED_BEGIN, GLOBAL_MANAGED_END, blocks);
}


// ---------------------------------------------------------------------------
// Global Caddy options (http_port, https_port, debug, grace_period, shutdown_delay)
// ---------------------------------------------------------------------------

export interface GlobalOptions {
  httpPort?: number;
  httpsPort?: number;
  debug?: boolean;
  gracePeriod?: string;
  shutdownDelay?: string;
  /** ACME registration email address */
  email?: string;
  /** ACME CA directory URL */
  acmeCA?: string;
  /** Path to a PEM file of trusted roots for connecting to the ACME CA (optional) */
  acmeCARoot?: string;
  /** External Account Binding key ID */
  acmeEabKeyId?: string;
  /** External Account Binding MAC key */
  acmeEabMacKey?: string;
  /** Global ACME DNS challenge provider (#261), `acme_dns`. */
  acmeDns?: import("./types").DnsChallengeConfig;
  /** Enable on-demand TLS certificate provisioning */
  onDemandEnabled?: boolean;
  /** Authorization URL Caddy queries before issuing an on-demand certificate */
  onDemandAsk?: string;
  /** Rate limit window for on-demand certificate issuance (Go duration, e.g. "2m") */
  onDemandInterval?: string;
  /** Maximum certificates that may be issued per rate-limit interval */
  onDemandBurst?: number;
  /**
   * Validity duration for internal-issuer certificates on hostless proxies/servers
   * (Caddy duration, e.g. "90d"). Stored as a comment marker (not a real Caddy
   * directive) and stamped identically onto every hostless proxy/server's own
   * `tls { issuer internal { lifetime } } }` block — see applyHostlessLifetime and
   * the comment on INTERNAL_LIFETIME_MARKER for why it can't be a real global option.
   */
  internalCertLifetime?: string;
  /** Global `renewal_window_ratio` (0-1): fraction of lifetime remaining before Caddy renews. */
  renewalWindowRatio?: number;
  /** Custom root path for the `file_system` certificate/config storage backend (#46).
   *  Unset means Caddy's own default ($XDG_DATA_HOME/caddy, /var/lib/caddy under systemd). */
  storagePath?: string;
  /**
   * Prometheus-compatible metrics endpoint (#43). Enabling this writes two things: the
   * global `metrics` option (turns on request-level `caddy_http_*` instrumentation across
   * every server — without it, `/metrics` only ever shows admin/Go-runtime metrics, not
   * anything about actual proxied traffic) and a small dedicated site block exposing the
   * endpoint at `metricsListenAddress`. A listen address is required whenever this is
   * enabled: the admin API here runs on a Unix socket, so metrics can't "share the admin
   * port" the way they could if admin were on TCP.
   */
  metricsEnabled?: boolean;
  /** Listen address for the dedicated metrics site, e.g. ":2019" or "127.0.0.1:2019". */
  metricsListenAddress?: string;
  /** Path the metrics endpoint is served at. Defaults to "/metrics" when unset. */
  metricsPath?: string;
  /**
   * Maps to Caddy's `disable_openmetrics` on the `metrics` handler — switches the response
   * from OpenMetrics format to plain Prometheus text exposition format. Doesn't remove any
   * metrics (Go runtime/process metrics are always included; Caddy has no toggle for
   * those), just a slightly less verbose wire format.
   */
  metricsPlainFormat?: boolean;
  /** The global `metrics { per_host }` option: label the request metrics with the host (#342). */
  metricsPerHost?: boolean;
  /**
   * Caddy's own runtime/error log (#158) — startup messages, reload results, TLS/ACME
   * errors, config errors — as opposed to per-site access logs (AccessLogConfig on each
   * ProxyEntry/ServerDef). Written to the reserved `logging.logs.default` entry. Reuses
   * AccessLogConfig's shape since the JSON writer/level/rotation fields are identical.
   */
  runtimeLog?: import("./types").AccessLogConfig;
  /** Trusted proxy ranges / client IP header config (#153) — see TrustedProxiesConfig. */
  trustedProxies?: import("./types").TrustedProxiesConfig;
  /** Accept the PROXY protocol on incoming connections (#157) — see ProxyProtocolConfig. */
  proxyProtocol?: import("./types").ProxyProtocolConfig;
  /** `auto_https`: `off`, `disable_redirects`, `disable_certs` or `ignore_loaded_certs` (#329). */
  autoHttps?: string;
  /** `local_certs`: issue every certificate from Caddy's own CA (#329). */
  localCerts?: boolean;
  /** `default_sni`: the server name used when a client sends none (#329). */
  defaultSni?: string;
  /** `key_type`: `ed25519`, `p256`, `p384`, `rsa2048` or `rsa4096` (#329). */
  keyType?: string;
  /** `ocsp_stapling off` (#329). */
  ocspStaplingOff?: boolean;
  /** `preferred_chains` for ACME issuers: `smallest`, or chains by root or any common name (#329). */
  preferredChains?: PreferredChains;
  /** `cert_issuer <name and arguments>`; a body, when it has one, is kept as written (#329). */
  certIssuer?: string;
  certIssuerBody?: string[];
  /** `default_bind`: the addresses sites bind to when they name none (#329). */
  defaultBind?: string[];
  /** The `admin` option (#330): `admin off`, or the address as written (`localhost:2019`, `"unix//run/caddy/admin.socket"`). */
  adminOff?: boolean;
  adminAddress?: string;
  adminOrigins?: string[];
  adminEnforceOrigin?: boolean;
}

export type PreferredChains =
  | { mode: "smallest" }
  | { mode: "root_common_name" | "any_common_name"; names: string[] };


/**
 * Directive keywords recognized by parseOptionLines/buildGlobalOptionsLines.
 * Used to strip pre-existing top-level directives before inserting the managed
 * section for the first time, so a save never produces duplicate directives.
 */
export const KNOWN_GLOBAL_OPTION_KEYS = new Set([
  "http_port", "https_port", "debug", "grace_period", "shutdown_delay",
  "email", "acme_ca", "acme_ca_root", "acme_eab", "acme_dns", "on_demand_tls",
  "renewal_window_ratio", "storage", "metrics", "log",
  "auto_https", "local_certs", "default_sni", "key_type", "ocsp_stapling", "preferred_chains", "cert_issuer", "default_bind", "admin",
]);


/**
 * Comment marker for the shared hostless-proxy cert lifetime. This is deliberately
 * NOT a real Caddy directive (unlike the rest of GlobalOptions): Caddy's Caddyfile
 * adapter forces every hostless site's own `tls internal` onto the same catch-all
 * automation policy object as a global `cert_issuer` option, then rejects the config
 * if that site's (freshly-parsed, lifetime-less) issuer doesn't exactly equal the
 * global one — unconditionally, even for a bare `tls internal` with no lifetime of
 * its own ("automation policy from site block is also default/catch-all policy...
 * in conflict"). The only way to share one lifetime across hostless proxies without
 * hitting that is to stamp the *identical* `tls { issuer internal { lifetime } } }`
 * onto every hostless proxy/server's own block — this comment is just where that
 * shared value is stored so it can be applied uniformly (see applyHostlessLifetime).
 */
export const INTERNAL_LIFETIME_MARKER = "# cockpit-caddy:internal-cert-lifetime";


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


/** Splits `a "b c" d` into `a`, `b c`, `d`. */
function splitTokens(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|(\S+)/g)].map(m => m[1] ?? m[2]);
}


/** Parse the recognized global option directives out of a block of Caddyfile lines. */
export function parseOptionLines(lines: string[]): GlobalOptions {
  const opts: GlobalOptions = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    const m = line.match(/^(\S+)(?:\s+(.+))?$/);
    if (!m) { i++; continue; }
    const [, key, val] = m;
    if (key === "http_port" && val) opts.httpPort = parseInt(val, 10);
    else if (key === "https_port" && val) opts.httpsPort = parseInt(val, 10);
    else if (key === "debug") opts.debug = true;
    else if (key === "grace_period" && val) opts.gracePeriod = val;
    else if (key === "shutdown_delay" && val) opts.shutdownDelay = val;
    else if (key === "email" && val) opts.email = val;
    else if (key === "acme_ca" && val) opts.acmeCA = val;
    else if (key === "acme_ca_root" && val) opts.acmeCARoot = val;
    else if (key === "acme_eab" && line.endsWith("{")) {
      i++;
      while (i < lines.length) {
        const inner = lines[i].trim();
        if (inner === "}") break;
        const im = inner.match(/^(\S+)\s+(.+)$/);
        if (im) {
          if (im[1] === "key_id") opts.acmeEabKeyId = im[2];
          else if (im[1] === "mac_key") opts.acmeEabMacKey = im[2];
        }
        i++;
      }
    } else if (key === "acme_dns" && val) {
      const { config, next } = parseDnsProviderDirective(val, lines, i);
      if (config) opts.acmeDns = config;
      i = next;
      continue;
    } else if (key === "on_demand_tls" && line.endsWith("{")) {
      opts.onDemandEnabled = true;
      i++;
      while (i < lines.length) {
        const inner = lines[i].trim();
        if (inner === "}") break;
        const im = inner.match(/^(\S+)\s+(.+)$/);
        if (im) {
          if (im[1] === "ask") opts.onDemandAsk = im[2];
          else if (im[1] === "interval") opts.onDemandInterval = im[2];
          else if (im[1] === "burst") opts.onDemandBurst = parseInt(im[2], 10);
        }
        i++;
      }
    } else if (key === "auto_https" && val) {
      opts.autoHttps = val.trim();
    } else if (key === "local_certs") {
      opts.localCerts = true;
    } else if (key === "default_sni" && val) {
      opts.defaultSni = val.trim();
    } else if (key === "key_type" && val) {
      opts.keyType = val.trim();
    } else if (key === "ocsp_stapling" && val?.trim() === "off") {
      opts.ocspStaplingOff = true;
    } else if (key === "default_bind" && val) {
      opts.defaultBind = val.trim().split(/\s+/);
    } else if (key === "preferred_chains" && val) {
      if (val.trim() === "smallest") opts.preferredChains = { mode: "smallest" };
      else if (line.endsWith("{")) {
        i++;
        while (i < lines.length && lines[i].trim() !== "}") {
          const im = lines[i].trim().match(/^(root_common_name|any_common_name)\s+(.+)$/);
          if (im) opts.preferredChains = { mode: im[1] as "root_common_name" | "any_common_name", names: splitTokens(im[2]) };
          i++;
        }
      }
    } else if (key === "cert_issuer" && val) {
      opts.certIssuer = val.replace(/\s*\{$/, "").trim();
      if (line.endsWith("{")) {
        const body: string[] = [];
        let depth = 1;
        i++;
        while (i < lines.length) {
          const inner = lines[i].trim();
          depth += (inner.match(/\{/g) ?? []).length - (inner.match(/\}/g) ?? []).length;
          if (depth <= 0) break;
          body.push(inner);
          i++;
        }
        opts.certIssuerBody = body;
      }
    } else if (key === "admin") {
      const head = (val ?? "").replace(/\s*\{$/, "").trim();
      if (head === "off") opts.adminOff = true;
      else if (head) opts.adminAddress = head;
      if (line.endsWith("{")) {
        i++;
        while (i < lines.length && lines[i].trim() !== "}") {
          const im = lines[i].trim().match(/^(\S+)(?:\s+(.*))?$/);
          if (im?.[1] === "origins" && im[2]) opts.adminOrigins = im[2].trim().split(/\s+/);
          else if (im?.[1] === "enforce_origin") opts.adminEnforceOrigin = true;
          i++;
        }
      }
    } else if (line.startsWith(INTERNAL_LIFETIME_MARKER)) {
      const marked = line.slice(INTERNAL_LIFETIME_MARKER.length).trim();
      if (marked) opts.internalCertLifetime = marked;
    } else if (key === "renewal_window_ratio" && val) {
      opts.renewalWindowRatio = parseFloat(val);
    } else if (key === "storage" && val?.startsWith("file_system") && line.endsWith("{")) {
      i++;
      while (i < lines.length) {
        const inner = lines[i].trim();
        if (inner === "}") break;
        const im = inner.match(/^(\S+)\s+(.+)$/);
        if (im && im[1] === "root") opts.storagePath = im[2];
        i++;
      }
    } else if (key === "metrics") {
      opts.metricsEnabled = true;
      if (line.endsWith("{")) {
        i++;
        while (i < lines.length && lines[i].trim() !== "}") {
          if (lines[i].trim() === "per_host") opts.metricsPerHost = true;
          i++;
        }
      }
    } else if (key === "log" && line.endsWith("{")) {
      // #158 — Caddy's own runtime/error logger (the *unnamed* `log` global option),
      // distinct from a per-site access log. Same writer/level/rotation shape.
      const runtimeLog: import("./types").AccessLogConfig = { output: "stderr" };
      i++;
      let depth = 1;
      while (i < lines.length) {
        const inner = lines[i].trim();
        depth += (inner.match(/\{/g) ?? []).length - (inner.match(/\}/g) ?? []).length;
        if (depth <= 0) break;
        if (inner === "}") { i++; continue; }
        if (inner === "roll_uncompressed") { runtimeLog.rollCompress = false; i++; continue; }
        const im = inner.match(/^(\S+)(?:\s+(.*))?$/);
        if (im) {
          const [, ik, iv] = im;
          if (ik === "output") {
            if (iv?.startsWith("file ")) {
              runtimeLog.output = "file";
              runtimeLog.filePath = iv.slice(5).replace(/\s*\{$/, "").trim();
            } else if (iv) {
              runtimeLog.output = iv.trim() as import("./types").AccessLogOutput;
            }
          } else if (ik === "level" && iv) {
            runtimeLog.level = iv.trim() as import("./types").AccessLogLevel;
          } else if (ik === "format" && iv) {
            runtimeLog.format = iv.trim() as import("./types").AccessLogFormat;
          } else if (ik === "roll_size" && iv) {
            const mb = iv.trim().match(/^(\d+(?:\.\d+)?)MiB$/i);
            if (mb) runtimeLog.rollSizeMb = Math.round(parseFloat(mb[1]));
          } else if (ik === "roll_keep" && iv) {
            runtimeLog.rollKeepCount = parseInt(iv.trim(), 10);
          } else if (ik === "roll_keep_for" && iv) {
            const hrs = iv.trim().match(/^(\d+(?:\.\d+)?)h$/);
            if (hrs) runtimeLog.rollKeepDays = Math.round(parseFloat(hrs[1]) / 24);
          }
        }
        i++;
      }
      opts.runtimeLog = runtimeLog;
    } else if (line === "servers {") {
      // #153/#157 — the bare (portless) global `servers { trusted_proxies ...
      // listener_wrappers { proxy_protocol { ... } } }` block. Matched on the exact trimmed
      // line (not just `key === "servers"`) so a per-port `servers :PORT { ... }` block (a
      // *different* feature — #51's timeouts/protocols, its own separate managed section)
      // is left alone here, not misparsed as this one.
      const tp: import("./types").TrustedProxiesConfig = { ranges: [] };
      let pp: import("./types").ProxyProtocolConfig | undefined;
      i++;
      let depth = 1;
      let inListenerWrappers = false;
      let inProxyProtocol = false;
      while (i < lines.length) {
        const inner = lines[i].trim();
        depth += (inner.match(/\{/g) ?? []).length - (inner.match(/\}/g) ?? []).length;
        if (depth <= 0) break;

        if (inProxyProtocol) {
          if (inner === "}") { inProxyProtocol = false; i++; continue; }
          const pm = inner.match(/^(\S+)(?:\s+(.*))?$/);
          if (pm) {
            const [, pk, pv] = pm;
            if (pk === "timeout" && pv) pp!.timeout = pv.trim();
            else if (pk === "allow" && pv) pp!.allow = pv.trim().split(/\s+/);
          }
          i++;
          continue;
        }
        if (inListenerWrappers) {
          if (inner === "}") { inListenerWrappers = false; i++; continue; }
          if (inner === "proxy_protocol" || inner === "proxy_protocol {") {
            pp = pp ?? {};
            if (inner === "proxy_protocol {") inProxyProtocol = true;
          }
          i++;
          continue;
        }
        if (inner === "}") { i++; continue; }
        if (inner === "listener_wrappers {") { inListenerWrappers = true; i++; continue; }
        if (inner === "trusted_proxies_strict") { tp.strict = true; i++; continue; }
        const im = inner.match(/^(\S+)(?:\s+(.*))?$/);
        if (im) {
          const [, ik, iv] = im;
          if (ik === "trusted_proxies" && iv?.startsWith("static ")) {
            tp.ranges = iv.slice(7).trim().split(/\s+/);
          } else if (ik === "client_ip_headers" && iv) {
            tp.headers = iv.trim().split(/\s+/);
          }
        }
        i++;
      }
      if (tp.ranges.length) opts.trustedProxies = tp;
      if (pp) opts.proxyProtocol = pp;
    }
    i++;
  }
  return opts;
}


const ABSORBED_FIELDS: ReadonlySet<string> = new Set([
  "autoHttps", "localCerts", "defaultSni", "keyType", "ocspStaplingOff", "preferredChains", "certIssuer", "certIssuerBody",
  "defaultBind", "adminOff", "adminAddress", "adminOrigins", "adminEnforceOrigin",
]);

function isAbsorbedField(k: string): boolean {
  return ABSORBED_FIELDS.has(k);
}


/**
 * Parse global options from a Caddyfile string. Prefers the cockpit-caddy:opts
 * managed section; if absent, falls back to scanning the real top-level global
 * options block so pre-existing/hand-written directives (or directives from a
 * Caddyfile that predates the plugin) are still reflected instead of showing
 * as blank.
 */
export function parseGlobalOptions(content: string): GlobalOptions {
  const bi = content.indexOf(GLOBAL_OPTS_BEGIN);
  const ei = content.indexOf(GLOBAL_OPTS_END);
  if (bi !== -1 && ei !== -1) {
    const section = content.slice(bi + GLOBAL_OPTS_BEGIN.length, ei);
    const opts = parseOptionLines(section.split("\n"));
    const outsideText = globalLinesOutsideSection(content);
    const keep = absorbableKeys(outsideText);
    const outside = parseOptionLines(stripKnownGlobalOptionLines(outsideText, new Set([...ABSORBED_GLOBAL_OPTION_KEYS].filter(k => !keep.has(k)))).split("\n"));
    for (const k of Object.keys(outside) as Array<keyof GlobalOptions>) {
      if (opts[k] === undefined && isAbsorbedField(k)) (opts as Record<string, unknown>)[k] = outside[k];
    }
    return opts;
  }
  const gb = findGlobalBlock(content);
  if (!gb) return {};
  return parseOptionLines(content.slice(gb.open + 1, gb.close).split("\n"));
}


/**
 * Options added after the managed section existed (#329, #330). A Caddyfile that has the
 * section may still carry them as hand-written lines outside it (the stock one has `admin`),
 * so reading looks there too and a save moves them into the section instead of duplicating them.
 */
export const ABSORBED_GLOBAL_OPTION_KEYS = new Set([
  "auto_https", "local_certs", "default_sni", "key_type", "ocsp_stapling", "preferred_chains", "cert_issuer", "default_bind", "admin",
]);


/**
 * The absorbed keys a hand-written block outside the section can be moved into it without
 * losing anything: an `admin` block with only `origins` / `enforce_origin`, one `cert_issuer`
 * line, a `preferred_chains` with one line. Others stay where they are, untouched.
 */
function absorbableKeys(outside: string): ReadonlySet<string> {
  const keys = new Set(ABSORBED_GLOBAL_OPTION_KEYS);
  const lines = outside.split("\n").map(l => l.trim());
  const seen = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const key = lines[i].split(/\s+/)[0];
    if (!keys.has(key)) continue;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (!lines[i].endsWith("{")) continue;
    const body: string[] = [];
    let depth = 1;
    for (i++; i < lines.length; i++) {
      depth += (lines[i].match(/\{/g) ?? []).length - (lines[i].match(/\}/g) ?? []).length;
      if (depth <= 0) break;
      body.push(lines[i]);
    }
    if (key === "admin" && body.some(b => !/^(origins\s|enforce_origin$)/.test(b))) keys.delete(key);
    if (key === "preferred_chains" && body.length > 1) keys.delete(key);
  }
  for (const [k, n] of seen) if (n > 1) keys.delete(k);
  return keys;
}


/** The global block's lines outside the managed opts section, or "" without one. */
function globalLinesOutsideSection(content: string): string {
  const gb = findGlobalBlock(content);
  if (!gb) return "";
  const inner = content.slice(gb.open + 1, gb.close);
  const bi = inner.indexOf(GLOBAL_OPTS_BEGIN);
  const ei = inner.indexOf(GLOBAL_OPTS_END);
  return bi !== -1 && ei !== -1 ? inner.slice(0, bi) + inner.slice(ei + GLOBAL_OPTS_END.length) : inner;
}


/**
 * Removes any top-level directives matching KNOWN_GLOBAL_OPTION_KEYS (single-line
 * or brace-delimited) from a global options block's inner content. Used before
 * inserting the managed opts section for the first time, so directives that
 * already exist outside the markers aren't duplicated (which `caddy validate`
 * would reject).
 */
export function stripKnownGlobalOptionLines(blockInner: string, keys: ReadonlySet<string> = KNOWN_GLOBAL_OPTION_KEYS): string {
  const lines = blockInner.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    const key = trimmed.split(/\s+/)[0];
    if (keys.has(key)) {
      if (trimmed.endsWith("{")) {
        let depth = 1;
        i++;
        while (i < lines.length && depth > 0) {
          const t = lines[i].trim();
          depth += (t.match(/\{/g) ?? []).length - (t.match(/\}/g) ?? []).length;
          i++;
        }
      } else {
        i++;
      }
      continue;
    }
    out.push(lines[i]);
    i++;
  }
  return out.join("\n");
}


export function buildGlobalOptionsLines(opts: GlobalOptions): string {
  const lines: string[] = [];
  if (opts.httpPort) lines.push(`\thttp_port ${opts.httpPort}`);
  if (opts.httpsPort) lines.push(`\thttps_port ${opts.httpsPort}`);
  if (opts.debug) lines.push("\tdebug");
  if (opts.gracePeriod) lines.push(`\tgrace_period ${opts.gracePeriod}`);
  if (opts.shutdownDelay) lines.push(`\tshutdown_delay ${opts.shutdownDelay}`);
  if (opts.email) lines.push(`\temail ${opts.email}`);
  if (opts.acmeCA) lines.push(`\tacme_ca ${opts.acmeCA}`);
  if (opts.acmeCARoot) lines.push(`\tacme_ca_root ${opts.acmeCARoot}`);
  if (opts.acmeEabKeyId && opts.acmeEabMacKey) {
    lines.push("\tacme_eab {");
    lines.push(`\t\tkey_id ${opts.acmeEabKeyId}`);
    lines.push(`\t\tmac_key ${opts.acmeEabMacKey}`);
    lines.push("\t}");
  }
  if (opts.acmeDns?.provider) lines.push(...dnsProviderLines("acme_dns", opts.acmeDns, "\t"));
  if (opts.onDemandEnabled) {
    lines.push("\ton_demand_tls {");
    if (opts.onDemandAsk) lines.push(`\t\task ${opts.onDemandAsk}`);
    if (opts.onDemandInterval) lines.push(`\t\tinterval ${opts.onDemandInterval}`);
    if (opts.onDemandBurst) lines.push(`\t\tburst ${opts.onDemandBurst}`);
    lines.push("\t}");
  }
  if (opts.internalCertLifetime) {
    lines.push(`\t${INTERNAL_LIFETIME_MARKER} ${opts.internalCertLifetime}`);
  }
  if (opts.renewalWindowRatio !== undefined) lines.push(`\trenewal_window_ratio ${opts.renewalWindowRatio}`);
  if (opts.storagePath) {
    lines.push("\tstorage file_system {");
    lines.push(`\t\troot ${opts.storagePath}`);
    lines.push("\t}");
  }
  // #329 — TLS and listener defaults. `local_certs` is itself a kind of issuer, which Caddy
  // rejects next to `cert_issuer` ("global options are ambiguous"), so the explicit issuer wins.
  if (opts.autoHttps) lines.push(`\tauto_https ${opts.autoHttps}`);
  if (opts.localCerts && !opts.certIssuer) lines.push("\tlocal_certs");
  if (opts.defaultSni) lines.push(`\tdefault_sni ${opts.defaultSni}`);
  if (opts.keyType) lines.push(`\tkey_type ${opts.keyType}`);
  if (opts.ocspStaplingOff) lines.push("\tocsp_stapling off");
  if (opts.preferredChains?.mode === "smallest") lines.push("\tpreferred_chains smallest");
  else if (opts.preferredChains?.names.length) {
    lines.push("\tpreferred_chains {", `\t\t${opts.preferredChains.mode} ${opts.preferredChains.names.map(v => caddyQuote(v)).join(" ")}`, "\t}");
  }
  if (opts.certIssuer) {
    if (opts.certIssuerBody?.length) lines.push(`\tcert_issuer ${opts.certIssuer} {`, ...opts.certIssuerBody.map(l => `\t\t${l}`), "\t}");
    else lines.push(`\tcert_issuer ${opts.certIssuer}`);
  }
  if (opts.defaultBind?.length) lines.push(`\tdefault_bind ${opts.defaultBind.join(" ")}`);
  // #330 — Caddy's own admin endpoint.
  if (opts.adminOff) lines.push("\tadmin off");
  else if (opts.adminAddress || opts.adminOrigins?.length || opts.adminEnforceOrigin) {
    const head = `\tadmin${opts.adminAddress ? ` ${opts.adminAddress}` : ""}`;
    const inner: string[] = [];
    if (opts.adminOrigins?.length) inner.push(`\t\torigins ${opts.adminOrigins.join(" ")}`);
    if (opts.adminEnforceOrigin) inner.push("\t\tenforce_origin");
    lines.push(...(inner.length ? [`${head} {`, ...inner, "\t}"] : [head]));
  }
  // Turns on request-level `caddy_http_*` instrumentation across every server — the
  // dedicated site block that actually exposes /metrics is written separately into
  // conf.d (see buildMetricsSiteBlock), since a bare global option can't also declare
  // a listener. observe_catchall_hosts and otlp are not exposed here.
  if (opts.metricsEnabled) lines.push(...(opts.metricsPerHost ? ["\tmetrics {", "\t\tper_host", "\t}"] : ["\tmetrics"]));
  // #158 — Caddy's own runtime/error logger. buildLogCaddyLines already emits exactly the
  // one-tab-indented `log { ... }` shape this global-options block needs.
  if (opts.runtimeLog) lines.push(buildLogCaddyLines(opts.runtimeLog).join("\n"));
  // #153/#157 — global (portless) `servers { }` block: trusted_proxies and/or
  // listener_wrappers/proxy_protocol. Also merged into every per-port managed servers block
  // by buildManagedServersBlocks, since a port with its own HTTP/3/timeout override would
  // otherwise silently lose these (see buildTrustedProxiesLines/buildProxyProtocolLines).
  const serversLines: string[] = [];
  if (opts.proxyProtocol) serversLines.push(...buildProxyProtocolLines(opts.proxyProtocol, "\t\t"));
  if (opts.trustedProxies?.ranges.length) serversLines.push(...buildTrustedProxiesLines(opts.trustedProxies, "\t\t"));
  if (serversLines.length) {
    lines.push(["\tservers {", ...serversLines, "\t}"].join("\n"));
  }
  return lines.join("\n");
}


/**
 * Writes global Caddy options into the main Caddyfile's managed opts section,
 * validates, and restores on failure. Throws CaddyfileError on validation failure.
 */
/**
 * Pure function: computes the patched main Caddyfile content for the given
 * global options. If the managed section doesn't exist yet, pre-existing
 * top-level directives for the same keys are stripped first, so the first
 * save doesn't produce duplicate global options (which caddy validate rejects).
 */
export function buildGlobalOptionsPatch(diskContent: string, opts: GlobalOptions): string {
  const body = buildGlobalOptionsLines(opts);
  let base = diskContent;
  const hasMarkers = diskContent.includes(GLOBAL_OPTS_BEGIN) && diskContent.includes(GLOBAL_OPTS_END);
  if (hasMarkers) {
    const gb = findGlobalBlock(diskContent);
    const inner = gb ? diskContent.slice(gb.open + 1, gb.close) : "";
    const bi = inner.indexOf(GLOBAL_OPTS_BEGIN);
    const end = inner.indexOf(GLOBAL_OPTS_END);
    if (gb && bi !== -1 && end !== -1) {
      // The section is rewritten from what parseGlobalOptions read, which included these.
      const ei = end + GLOBAL_OPTS_END.length;
      const keys = absorbableKeys(inner.slice(0, bi) + inner.slice(ei));
      const stripped = stripKnownGlobalOptionLines(inner.slice(0, bi), keys)
        + inner.slice(bi, ei)
        + stripKnownGlobalOptionLines(inner.slice(ei), keys);
      base = diskContent.slice(0, gb.open + 1) + stripped + diskContent.slice(gb.close);
    }
  } else {
    const gb = findGlobalBlock(diskContent);
    if (gb) {
      const inner = stripKnownGlobalOptionLines(diskContent.slice(gb.open + 1, gb.close));
      base = diskContent.slice(0, gb.open + 1) + inner + diskContent.slice(gb.close);
    }
  }
  return patchManagedSection(base, GLOBAL_OPTS_BEGIN, GLOBAL_OPTS_END, body);
}


export const METRICS_SITE_BEGIN = "# cockpit-caddy:metrics:begin";

export const METRICS_SITE_END = "# cockpit-caddy:metrics:end";


/**
 * Builds the dedicated site block that exposes the Prometheus metrics endpoint (#43).
 * A bare `metrics` directive with no path matcher matches *every* path on that listener
 * (verified against a live instance — it's the sole unmatched route on the block), so the
 * path is always written explicitly to keep the endpoint scoped to just that one path.
 */
export function buildMetricsSiteBlock(opts: GlobalOptions): string {
  if (!opts.metricsEnabled || !opts.metricsListenAddress) return "";
  const path = opts.metricsPath || "/metrics";
  const lines = [`${opts.metricsListenAddress} {`];
  if (opts.metricsPlainFormat) {
    lines.push(`\tmetrics ${path} {`, "\t\tdisable_openmetrics", "\t}");
  } else {
    lines.push(`\tmetrics ${path}`);
  }
  lines.push("}");
  return lines.join("\n");
}


/** Reads the metrics site block's listen address/path/format back out of conf.d content. */
export function parseMetricsSiteBlock(content: string): Pick<GlobalOptions, "metricsListenAddress" | "metricsPath" | "metricsPlainFormat"> {
  const bi = content.indexOf(METRICS_SITE_BEGIN);
  const ei = content.indexOf(METRICS_SITE_END);
  if (bi === -1 || ei === -1) return {};
  const lines = content.slice(bi + METRICS_SITE_BEGIN.length, ei).split("\n").map(l => l.trim()).filter(Boolean);
  const headerLine = lines.find(l => l.endsWith("{") && !l.startsWith("metrics"));
  if (!headerLine) return {};
  const metricsLine = lines.find(l => l.startsWith("metrics "));
  if (!metricsLine) return { metricsListenAddress: headerLine.slice(0, -1).trim() };
  const path = metricsLine.replace(/^metrics\s+/, "").replace(/\s*\{$/, "").trim();
  return {
    metricsListenAddress: headerLine.slice(0, -1).trim(),
    metricsPath: path,
    metricsPlainFormat: lines.includes("disable_openmetrics") || undefined,
  };
}
