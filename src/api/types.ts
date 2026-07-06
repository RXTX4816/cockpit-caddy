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
  remote_ip?: { ranges: string[] };
}

// ---------------------------------------------------------------------------
// Named Server — #49
// ---------------------------------------------------------------------------

/** A user-defined Caddy server with explicit listen addresses and multiple routes. */
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

export interface CaddyTlsApp {
  automation?: {
    policies?: CaddyAutomationPolicy[];
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
}

export interface FileServerConfig {
  root: string;
  browse?: boolean;
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
}

export interface StaticResponseConfig {
  statusCode: number;
  body?: string;
  close?: boolean;
}

export type LbPolicy = "round_robin" | "random" | "least_conn" | "first";

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
  /** Optional hostname/IP for the external listener; omit to bind all interfaces */
  externalHost?: string;
  targetHost: string;
  targetPort: number;
  /** Scheme used when connecting to the upstream */
  targetScheme: "http" | "https";
  /** Enable TLS (internal CA) on the incoming listener */
  tls: boolean;
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
  dialTimeout?: string;
  responseHeaderTimeout?: string;
  basicAuth?: { username: string; passwordHash: string }[];
  /** Additional upstreams beyond the primary targetHost:targetPort */
  extraUpstreams?: Array<{ host: string; port: number }>;
  /** Load-balancing policy when multiple upstreams are configured */
  lbPolicy?: LbPolicy;
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
  /** Per-server access log configuration */
  accessLog?: AccessLogConfig;
  /** Per-server error handlers (server.errors.routes) */
  errorHandlers?: ErrorHandlerConfig[];
  /** Forward authentication handler (delegates auth to an external service) */
  forwardAuth?: ForwardAuthConfig;
  /** Advanced TLS connection policy settings (protocol versions, cipher suites, curves) */
  tlsAdvanced?: TlsAdvancedConfig;
  /** Mutual TLS / client certificate authentication */
  mtls?: MtlsConfig;
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
}

export type { ServiceStatus } from "@rxtx4816/cockpit-plugin-base-react/systemd";

export interface UpstreamStatus {
  address: string;
  num_requests: number;
  fails: number;
}
