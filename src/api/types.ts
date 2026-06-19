export interface CaddyUpstream {
  dial: string;
}

export interface CaddyReverseProxyHandler {
  handler: "reverse_proxy";
  upstreams: CaddyUpstream[];
}

export type CaddyHandler = CaddyReverseProxyHandler | { handler: string };

export interface CaddyRoute {
  handle: CaddyHandler[];
  terminal?: boolean;
}

export interface CaddyTLSConnectionPolicy {
  certificate_selection?: {
    any_tag?: string[];
  };
}

export interface CaddyServer {
  listen: string[];
  routes: CaddyRoute[];
  tls_connection_policies?: CaddyTLSConnectionPolicy[];
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
  };
}

export interface ProxyEntry {
  id: string;
  externalPort: number;
  targetHost: string;
  targetPort: number;
  tls: boolean;
  label?: string;
  serverKey: string;
}

export type ServiceStatus = "active" | "inactive" | "failed" | "unknown" | "not-installed";
