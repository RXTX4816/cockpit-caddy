export interface CaddyUpstream {
  dial: string;
}

export interface CaddyHttpTransport {
  protocol?: string;
  tls?: {
    insecure_skip_verify?: boolean;
    [key: string]: unknown;
  };
  dial_timeout?: string;
  response_header_timeout?: string;
  [key: string]: unknown;
}

export interface CaddyReverseProxyHandler {
  handler: "reverse_proxy";
  upstreams: CaddyUpstream[];
  transport?: CaddyHttpTransport;
  [key: string]: unknown;
}

export type CaddyHandler = CaddyReverseProxyHandler | { handler: string; [key: string]: unknown };

export interface CaddyRoute {
  match?: Array<Record<string, unknown>>;
  handle: CaddyHandler[];
  terminal?: boolean;
  [key: string]: unknown;
}

export interface CaddyTLSClientAuthentication {
  mode?: string;
  /** The trust pool (`trust_pool` in the Caddyfile); the plugin writes the `file` provider. */
  ca?: { provider?: string; pem_files?: string[]; [key: string]: unknown };
  /** Deprecated form, still read so configs pushed by older plugin versions open. */
  trusted_ca_certs_pem_files?: string[];
}

export interface CaddyTLSConnectionPolicy {
  certificate_selection?: {
    any_tag?: string[];
  };
  protocol_min?: string;
  protocol_max?: string;
  cipher_suites?: string[];
  curves?: string[];
  client_authentication?: CaddyTLSClientAuthentication;
  [key: string]: unknown;
}

export type TlsProtocolVersion = "tls1.2" | "tls1.3";
export type MtlsMode = "request" | "require" | "verify_if_given" | "require_and_verify";

// ---------------------------------------------------------------------------
// Route Matchers — #48
// ---------------------------------------------------------------------------

/** Request matcher conditions for a route. Multiple keys = AND logic. */
export interface RouteMatch {
  path?: string[];
  host?: string[];
  method?: string[];
  /** Header name → list of value patterns (empty list = header must be present). */
  header?: Record<string, string[]>;
  /** Query param name → list of value patterns. */
  query?: Record<string, string[]>;
  /** The TCP peer address. Behind a proxy that is the proxy, not the visitor. */
  remote_ip?: { ranges: string[] };
  /** The real client IP (#286): honours trusted_proxies, else the same as remote_ip. */
  client_ip?: { ranges: string[] };
  /** Exclude group (#287): the route matches only when these fields do NOT all match. */
  not?: RouteMatchFields;
  /** CEL expression (#287), as written in a Caddyfile (placeholder shorthands like `{path}`). */
  expression?: string;
}

/** The plain matcher fields, without the `not` group and the expression. */
export type RouteMatchFields = Omit<RouteMatch, "not" | "expression">;

// ---------------------------------------------------------------------------
// Named Server — #49
// ---------------------------------------------------------------------------

/** A user-defined Caddy server with explicit listen addresses and multiple routes. */
/** `basic_auth [<algorithm> [<realm>]]`: unset means Caddy's bcrypt and its default realm. */
export interface BasicAuthOptions {
  realm?: string;
  algorithm?: "bcrypt" | "argon2id";
}

/** What `encode` is told besides turning compression on (#335). Unset is `encode gzip zstd`. */
export interface EncodeOptions {
  /** The algorithms in order of preference. */
  algorithms?: Array<"gzip" | "zstd">;
  /** `minimum_length`: responses with fewer bytes are sent as they are. */
  minimumLength?: number;
  /** `match { status }`: status codes or classes such as `2xx`. */
  matchStatus?: string[];
  /** `match { header }`: a response header and a value that may use wildcards. */
  matchHeaders?: Array<{ name: string; value: string }>;
}

export interface ServerDef {
  key: string;
  name: string;
  listenAddresses: string[];
  tls: boolean;
  tlsAdvanced?: TlsAdvancedConfig;
  mtls?: MtlsConfig;
  serverReadTimeout?: string;
  serverReadHeaderTimeout?: string;
  serverWriteTimeout?: string;
  serverIdleTimeout?: string;
  maxHeaderBytes?: number;
  accessLog?: AccessLogConfig;
  errorHandlers?: ErrorHandlerConfig[];
  /** Route display labels keyed by route id. */
  routeLabels?: Record<string, string>;
  /** When true, explicitly restricts this server to HTTP/1.1 and HTTP/2 (writes
   *  `protocols h1 h2`), opting out of Caddy's default HTTP/3 (QUIC) support (#51). */
  disableHttp3?: boolean;
}

export interface TlsAdvancedConfig {
  protocolMin?: TlsProtocolVersion;
  protocolMax?: TlsProtocolVersion;
  cipherSuites?: string[];
  curves?: string[];
  /** Validity duration for internal-issuer leaf certificates, e.g. "90d", "2160h" (Caddy duration string) */
  certLifetime?: string;
  /** Fraction (0-1) of certificate lifetime remaining before Caddy attempts renewal */
  renewalWindowRatio?: number;
}

export interface MtlsConfig {
  mode: MtlsMode;
  /** Path to a PEM file containing the trusted CA certificate(s) */
  trustedCaFile?: string;
}

/** Bring-your-own TLS certificate (#152) — points at existing PEM files on disk instead
 *  of Caddy issuing one itself (ACME or internal CA). */
export interface CustomTlsConfig {
  /** Path to the certificate PEM file (should contain the full chain — leaf + any
   *  intermediates — since Caddy has no separate slot for a CA bundle on a manually
   *  loaded certificate). */
  certFile: string;
  /** Path to the private key PEM file. */
  keyFile: string;
  /** Optional CA bundle / intermediate chain file path — validated for existence and
   *  readability and shown for reference (subject/expiry) in the UI, but not written into
   *  Caddy's config: Caddy has no field for it on a manually-loaded certificate, so any
   *  intermediates must already be concatenated into certFile itself. Persisted via a
   *  Caddyfile comment (like route labels) since it's not part of Caddy's own JSON model. */
  caFile?: string;
}

export interface CaddyServer {
  listen: string[];
  routes: CaddyRoute[];
  tls_connection_policies?: CaddyTLSConnectionPolicy[];
  /** Hosts Caddy's Caddyfile adapter explicitly excludes from automatic HTTPS (#141) —
   *  e.g. a site whose address used an explicit `http://` scheme. */
  automatic_https?: { skip?: string[]; skip_certificates?: string[] };
  /** HTTP protocol versions this server accepts. Omit for Caddy's default (h1, h2, h3);
   *  `["h1", "h2"]` opts out of HTTP/3 (#51). */
  protocols?: string[];
  [key: string]: unknown;
}

export interface CaddyLogWriter {
  output: string;
  filename?: string;
  /** Log rotation (#155) — only meaningful when output === "file". */
  roll_size_mb?: number;
  roll_keep?: number;
  roll_keep_days?: number;
  /** Caddy compresses rolled files by default; false means `roll_uncompressed` was set. */
  roll_gzip?: boolean;
}

export interface CaddyLogEncoder {
  format: string;
}

export interface CaddyLoggerConfig {
  writer?: CaddyLogWriter;
  encoder?: CaddyLogEncoder;
  level?: string;
  include?: string[];
  exclude?: string[];
}

export interface CaddyAutomationPolicy {
  /** Hostnames this policy applies to. Omit for the shared catch-all policy (only one may lack subjects). */
  subjects?: string[];
  /** `lifetime` may come back as a number (nanoseconds) after a Caddyfile reload rather than the original duration string. */
  issuers?: Array<{ module: string; lifetime?: string | number; [key: string]: unknown }>;
  renewal_window_ratio?: number;
}

export interface CaddyCertLoadFile {
  certificate: string;
  key: string;
  tags?: string[];
}

export interface CaddyTlsApp {
  automation?: {
    policies?: CaddyAutomationPolicy[];
  };
  /** Manually-loaded (bring-your-own) certificates (#152), referenced from a connection
   *  policy's `certificate_selection.any_tag` — distinct from `automation`, which is only
   *  for certs Caddy itself issues (ACME/internal). */
  certificates?: {
    load_files?: CaddyCertLoadFile[];
  };
}

export interface CaddyConfig {
  apps?: {
    http?: {
      servers?: Record<string, CaddyServer>;
    };
    tls?: CaddyTlsApp;
    [key: string]: unknown;
  };
  logging?: {
    logs?: Record<string, CaddyLoggerConfig>;
  };
  [key: string]: unknown;
}

export type AccessLogOutput = "stderr" | "stdout" | "file" | "discard";
export type AccessLogFormat = "json" | "console";
export type AccessLogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export interface AccessLogConfig {
  output: AccessLogOutput;
  filePath?: string;
  format?: AccessLogFormat;
  level?: AccessLogLevel;
  /** Log rotation (#155) — only applicable when output === "file". Max size in MiB
   *  before rolling to a new file. */
  rollSizeMb?: number;
  /** Number of rolled (old) files to keep. */
  rollKeepCount?: number;
  /** Max age of rolled files, in days. */
  rollKeepDays?: number;
  /** Compress rolled files with gzip. Caddy's own default is true when rotation is
   *  configured at all; only written as `roll_uncompressed` when explicitly false. */
  rollCompress?: boolean;
}

/** Trusted proxy CIDR ranges + client-IP header config (#153) — global (applies to every
 *  server), since Caddy's per-port `servers :PORT { }` block fully replaces (doesn't merge
 *  with) the global `servers { }` block's settings for that port, verified against a live
 *  instance. Written into every per-port managed servers block too, not just the global
 *  one, so a port with its own HTTP/3/timeout override doesn't silently lose this. */
export interface TrustedProxiesConfig {
  /** CIDR ranges, or the "private_ranges" keyword Caddy expands to all private IPv4/IPv6
   *  ranges. Space-separated tokens, written as-is into the Caddyfile. */
  ranges: string[];
  /** Parses IP headers right-to-left instead of the default left-to-right — needed when
   *  the header may contain untrusted, attacker-supplied entries before the trusted ones. */
  strict?: boolean;
  /** Which header(s) to read the client IP from, checked in order. Caddy's own default is
   *  just X-Forwarded-For when this is unset. */
  headers?: string[];
}

/** Accept the PROXY protocol on incoming connections (#157) — global, like
 *  TrustedProxiesConfig, for the same per-port-block-replaces-global-block reason. Written
 *  as a `listener_wrappers { proxy_protocol { ... } }` entry in the `servers { }` block. */
export interface ProxyProtocolConfig {
  /** Max time to wait for the PROXY protocol header before giving up (Go duration, e.g. "2s"). */
  timeout?: string;
  /** CIDR ranges allowed to send PROXY protocol headers — restrict to trusted upstream
   *  load balancers only, to prevent client IP spoofing. Unset means any source is trusted,
   *  matching Caddy's own default. */
  allow?: string[];
}

export interface HeaderOperation {
  op: "set" | "add" | "delete";
  name: string;
  value?: string;
}

export type RewriteConfig =
  | { type: "strip_prefix"; value: string }
  | { type: "add_prefix"; value: string }
  | { type: "regex"; find: string; replace: string };

export interface RedirectConfig {
  to: string;
  code: 301 | 302 | 307 | 308;
  /** `redir <to> html`: answer with a page that redirects in the browser instead of a status code (#338). */
  html?: boolean;
}

export interface FileServerConfig {
  root: string;
  browse?: boolean;
  /** SPA mode (#262): `try_files {path} /index.html`, so deep links get the app's index.html. */
  spa?: boolean;
  /** `file_server { index … }`: index file names. Omit for Caddy's default (index.html, index.txt). */
  index?: string[];
  /** `file_server { hide … }`: files or patterns never served. */
  hide?: string[];
  /** `file_server { precompressed … }`: encodings of precompressed sidecar files, in order. */
  precompressed?: string[];
  /** `file_server { disable_canonical_uris }`: no redirects to add or drop a trailing slash (#340). */
  disableCanonicalUris?: boolean;
  /** `file_server { status <code> }`: answer every file with this status code (#340). */
  status?: number;
  /** `file_server { browse <template_file> }`: a template for the directory listing; needs `browse` (#340). */
  browseTemplate?: string;
}

export interface PhpFastcgiConfig {
  /** FastCGI upstream: a Unix socket ("unix//run/php-fpm.sock") or "host:port" */
  upstream: string;
  /** Root directory PHP files are served from */
  root: string;
  /** Directory index filename. Omit for Caddy's own default ("index.php"). */
  index?: string;
  /** Extensions used to split the URI into script path + path info (Caddy's `split` sub-directive).
   *  Omit for Caddy's own default ([".php"]). */
  splitPath?: string[];
  /** Extra environment variables passed to the FastCGI process. */
  env?: Record<string, string>;
  /** `try_files` before php_fastcgi (#262), e.g. `{path} {path}/ /index.php?{query}`. */
  tryFiles?: string;
  /** Write the FastCGI process's stderr to Caddy's log (#340). */
  captureStderr?: boolean;
  /** Resolve symlinks in `root` before building SCRIPT_FILENAME (#340). */
  resolveRootSymlink?: boolean;
  /** Timeouts of the FastCGI connection, Go durations (#340). */
  dialTimeout?: string;
  readTimeout?: string;
  writeTimeout?: string;
}

export interface StaticResponseConfig {
  statusCode: number;
  body?: string;
  close?: boolean;
}

export type LbPolicy =
  | "round_robin" | "random" | "least_conn" | "first"
  | "ip_hash" | "client_ip_hash" | "uri_hash"
  | "header" | "cookie" | "weighted_round_robin" | "random_choose";

/** Arguments of the load-balancing policies that take some (#285). */
export interface LbPolicyArgs {
  /** `header <field>`: the request header whose value picks the upstream. */
  headerField?: string;
  /** `cookie [<name> [<secret>]]`: sticky sessions. Caddy's default name is `lb`. */
  cookieName?: string;
  cookieSecret?: string;
  /** `weighted_round_robin`: one weight per upstream, the main target first. */
  weights?: number[];
  /** `random_choose <n>`. */
  chooseCount?: number;
}

/** reverse_proxy retry/failover tuning (#156) — how many times, for how long, and how
 *  often to retry a different upstream after a failed connection, plus passive and active
 *  health checks (#252) that take failing upstreams out of rotation. Retries apply even with
 *  a single upstream (they just re-dial it) — not gated on multiple upstreams like lb_policy. */
export interface LbRetryConfig {
  /** Max number of retries across all upstreams. */
  retries?: number;
  /** Total time budget across all retries (Go duration, e.g. "5s"). */
  tryDuration?: string;
  /** Wait time between retry attempts (Go duration, e.g. "250ms"). */
  tryInterval?: string;
  /** Passive health checks (#252): how long a failed request counts against an upstream.
   *  Caddy keeps passive checks off without it, so unhealthyStatus/maxFails need it. */
  failDuration?: string;
  /** Passive: failures within failDuration after which an upstream is marked down (Caddy: 1). */
  maxFails?: number;
  /** Passive: upstream response codes that count as a failure (only with failDuration). */
  unhealthyStatus?: number[];
  /** Active health checks (#252): path Caddy requests on each upstream; empty = off. */
  healthUri?: string;
  /** Active: time between checks (Caddy: 30s). */
  healthInterval?: string;
  /** Active: how long to wait for a check's reply (Caddy: 5s). */
  healthTimeout?: string;
  /** Active: expected status, an exact code ("204") or a class ("2xx"). Caddy: any 2xx. */
  healthStatus?: string;
}

export type ErrorMatchType = "specific" | "4xx" | "5xx" | "all";
export type ErrorHandlerType = "respond" | "redirect" | "static";

export interface ErrorHandlerConfig {
  matchType: ErrorMatchType;
  /** Status codes to match; only used when matchType === "specific". */
  codes?: number[];
  type: ErrorHandlerType;
  /** respond: inline response body */
  body?: string;
  /** respond: HTTP status code to send (defaults to the error code) */
  statusCode?: number;
  /** redirect: URL to redirect to */
  redirectTo?: string;
  /** redirect: redirect status code */
  redirectCode?: 301 | 302 | 307 | 308;
  /** static: root directory; expects {code}.html files inside */
  filePath?: string;
}

export interface ForwardAuthConfig {
  /** Auth service URL, e.g. "http://localhost:9091" */
  upstreamUrl: string;
  /** Path to request on the auth service, e.g. "/api/authz/forward-auth" */
  uri?: string;
  /** Response header names to copy from auth service to the upstream request */
  copyHeaders: string[];
}

export interface ProxyEntry {
  id: string;
  externalPort: number;
  /** Optional protocol for the external listener (e.g. "http", "https", "h2c") */
  externalScheme?: string;
  /** Optional hostname/IP for the external listener; omit to bind all interfaces.
   *  Several names (#208) are joined by ", " (e.g. "example.com, www.example.com"),
   *  written as one site block with every name; see externalHosts.ts. */
  externalHost?: string;
  targetHost: string;
  targetPort: number;
  /** Scheme used when connecting to the upstream */
  targetScheme: "http" | "https";
  /** Enable TLS on the incoming listener; tlsIssuer says where the certificate comes from */
  tls: boolean;
  /** Who issues the certificate when tls is on and no customTls is set (#246): "acme" is
   *  Caddy's automatic HTTPS (Let's Encrypt/ZeroSSL, no `tls` line, needs a public name),
   *  "internal" is Caddy's local CA (`tls internal`). Undefined means "internal". */
  tlsIssuer?: "acme" | "internal";
  /** On-demand TLS for this site (#253): get the certificate at the first TLS handshake
   *  (`tls { on_demand }`). The global `on_demand_tls` option only configures the ask
   *  endpoint; it doesn't turn this on. */
  tlsOnDemand?: boolean;
  /** Per-site DNS challenge (#289), only for automatic HTTPS: when set, the site uses this
   *  provider (`tls { dns <provider> … }`) instead of the global `acme_dns` one. Unset means
   *  it inherits the global provider, or the HTTP challenge when none is set. Credentials are
   *  env variable names; the values live in the root-only env file. */
  dnsChallenge?: DnsChallengeConfig;
  /** Skip TLS verification when connecting to an https upstream */
  tlsSkipVerify: boolean;
  label?: string;
  serverKey: string;
  redirect?: RedirectConfig;
  fileServer?: FileServerConfig;
  staticResponse?: StaticResponseConfig;
  phpFastcgi?: PhpFastcgiConfig;
  rewrite?: RewriteConfig;
  requestHeaders?: HeaderOperation[];
  responseHeaders?: HeaderOperation[];
  compress?: boolean;
  /** How `compress` encodes (#335); only used while `compress` is on. */
  encodeOptions?: EncodeOptions;
  dialTimeout?: string;
  responseHeaderTimeout?: string;
  basicAuth?: { username: string; passwordHash: string }[];
  /** The realm and hash algorithm of `basic_auth` (#337). */
  basicAuthOptions?: BasicAuthOptions;
  /** Additional upstreams beyond the primary targetHost:targetPort */
  extraUpstreams?: Array<{ host: string; port: number }>;
  /** Load-balancing policy when multiple upstreams are configured */
  lbPolicy?: LbPolicy;
  /** Arguments of lbPolicy, when it takes any (#285). */
  lbPolicyArgs?: LbPolicyArgs;
  /** Retry/failover tuning (#156) — applies even with a single upstream. */
  lbRetry?: LbRetryConfig;
  /** Incoming connection timeouts (Go duration strings e.g. "30s", "5m") */
  serverReadTimeout?: string;
  serverReadHeaderTimeout?: string;
  serverWriteTimeout?: string;
  serverIdleTimeout?: string;
  /** Maximum size of incoming request headers in bytes */
  maxHeaderBytes?: number;
  /** When true, explicitly restricts this server to HTTP/1.1 and HTTP/2 (writes
   *  `protocols h1 h2`), opting out of Caddy's default HTTP/3 (QUIC) support (#51). */
  disableHttp3?: boolean;
  /** Maximum allowed request body size for this route in bytes (#154) — same
   *  bytes-not-human-string convention as maxHeaderBytes. Requests over this size are
   *  rejected before reaching the upstream/handler. Not applicable to redirect/
   *  staticResponse routes, which never read the request body. */
  requestBodyMaxSize?: number;
  /** Per-server access log configuration */
  accessLog?: AccessLogConfig;
  /** Per-server error handlers (server.errors.routes) */
  errorHandlers?: ErrorHandlerConfig[];
  /**
   * The error handlers also replace the upstream app's own error responses (#255): the
   * reverse_proxy re-raises upstream 4xx/5xx through `handle_response`. Off for new handlers;
   * an existing config with that interception reads back as on.
   */
  replaceUpstreamErrors?: boolean;
  /** Forward authentication handler (delegates auth to an external service) */
  forwardAuth?: ForwardAuthConfig;
  /** Advanced TLS connection policy settings (protocol versions, cipher suites, curves) */
  tlsAdvanced?: TlsAdvancedConfig;
  /** Mutual TLS / client certificate authentication */
  mtls?: MtlsConfig;
  /** Bring-your-own TLS certificate (#152) — when set (and tls is true), Caddy loads this
   *  certificate/key pair directly instead of issuing one itself (ACME or internal CA). */
  customTls?: CustomTlsConfig;
  // ---------------------------------------------------------------------------
  // Routing extensions (#48, #49, #50)
  // ---------------------------------------------------------------------------
  /** Route matchers (#48). When set, only matching requests are handled by this route. */
  matchers?: RouteMatch;
  /** Use handle_path semantics: strip the matched path prefix before forwarding (#50). */
  handlePath?: boolean;
  /** Register this route as a named/reusable route via invoke (#50). */
  isNamedRoute?: boolean;
  /** The name for the named route (required when isNamedRoute is true) (#50). */
  namedRouteName?: string;
  /** When set, this route belongs to the named ServerDef with this key (#49). */
  namedServerKey?: string;
  /** Snippets imported at the top of the site block (#288), read from the conf.d text. */
  imports?: string[];
  /** Snippets that supplied settings the dialog doesn't show as the site's own (#288). Read-only. */
  snippetSettings?: string[];
}

export type { ServiceStatus } from "@rxtx4816/cockpit-plugin-base-react/systemd";

export interface UpstreamStatus {
  address: string;
  num_requests: number;
  fails: number;
}

/**
 * The ACME DNS challenge provider (#261, global `acme_dns`; #289 per site `tls { dns }`).
 * Credentials never sit in the model as values: `credentials` maps each provider option to the
 * name of an environment variable in the root-only env file, written as `{env.NAME}`.
 */
export interface DnsChallengeConfig {
  /** The provider module name, e.g. "cloudflare" for dns.providers.cloudflare. */
  provider: string;
  /** Provider option → environment variable name. */
  credentials: Record<string, string>;
  /**
   * Options a hand-written config sets to a literal value. Kept as written when saved back
   * unchanged, never shown. The key "" holds arguments written inline after the provider.
   */
  literal?: Record<string, string>;
}

