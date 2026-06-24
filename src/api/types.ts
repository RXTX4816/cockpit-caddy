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
  handle: CaddyHandler[];
  terminal?: boolean;
  [key: string]: unknown;
}

export interface CaddyTLSConnectionPolicy {
  certificate_selection?: {
    any_tag?: string[];
  };
  [key: string]: unknown;
}

export interface CaddyServer {
  listen: string[];
  routes: CaddyRoute[];
  tls_connection_policies?: CaddyTLSConnectionPolicy[];
  [key: string]: unknown;
}

export interface CaddyConfig {
  apps?: {
    http?: {
      servers?: Record<string, CaddyServer>;
    };
    tls?: {
      automation?: {
        policies?: Array<{
          subjects?: string[];
          issuers?: Array<{ module: string }>;
          tags?: string[];
        }>;
      };
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
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
  rewrite?: RewriteConfig;
  requestHeaders?: HeaderOperation[];
  responseHeaders?: HeaderOperation[];
  compress?: boolean;
  dialTimeout?: string;
  responseHeaderTimeout?: string;
  basicAuth?: { username: string; passwordHash: string }[];
}

export type { ServiceStatus } from "@rxtx4816/cockpit-plugin-base-react/systemd";

export interface UpstreamStatus {
  address: string;
  num_requests: number;
  fails: number;
}
