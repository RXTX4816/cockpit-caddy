export interface CaddyUpstream {
  dial: string;
}

export interface CaddyHttpTransport {
  protocol?: string;
  tls?: {
    insecure_skip_verify?: boolean;
    [key: string]: unknown;
  };
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

export interface ProxyEntry {
  id: string;
  externalPort: number;
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
}

export type { ServiceStatus } from "@rxtx4816/cockpit-plugin-base-react/systemd";
