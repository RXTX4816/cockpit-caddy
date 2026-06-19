import type { CaddyConfig, ProxyEntry, CaddyServer } from "./types";

const CADDY_PORT = 2019;

function client(): CockpitHttpClient {
  return cockpit.http({ port: CADDY_PORT, address: "localhost" });
}

export async function fetchCaddyConfig(): Promise<CaddyConfig> {
  const c = client();
  try {
    const data = await c.get("/config/");
    return (JSON.parse(data) as CaddyConfig) ?? {};
  } finally {
    c.close();
  }
}

export async function pushCaddyConfig(config: CaddyConfig): Promise<void> {
  const c = client();
  try {
    await c.request({
      method: "POST",
      path: "/config/",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
  } finally {
    c.close();
  }
}

export function parseProxies(config: CaddyConfig): ProxyEntry[] {
  const servers = config.apps?.http?.servers ?? {};
  const proxies: ProxyEntry[] = [];

  for (const [key, server] of Object.entries(servers)) {
    const listenPort = server.listen?.[0]?.replace(/^:/, "");
    if (!listenPort) continue;

    const externalPort = parseInt(listenPort, 10);
    if (isNaN(externalPort)) continue;

    const reverseProxyHandle = server.routes?.[0]?.handle?.find(
      (h): h is import("./types").CaddyReverseProxyHandler =>
        (h as import("./types").CaddyHandler & { handler: string }).handler === "reverse_proxy",
    );
    if (!reverseProxyHandle) continue;

    const dial = reverseProxyHandle.upstreams?.[0]?.dial ?? "";
    const lastColon = dial.lastIndexOf(":");
    const targetHost = lastColon > 0 ? dial.slice(0, lastColon) : dial;
    const targetPort = lastColon > 0 ? parseInt(dial.slice(lastColon + 1), 10) : 80;

    const tls = Array.isArray(server.tls_connection_policies) && server.tls_connection_policies.length > 0;

    proxies.push({
      id: String(externalPort),
      externalPort,
      targetHost: targetHost || "localhost",
      targetPort: isNaN(targetPort) ? 80 : targetPort,
      tls,
      serverKey: key,
    });
  }

  return proxies.sort((a, b) => a.externalPort - b.externalPort);
}

export function buildServerEntry(proxy: Omit<ProxyEntry, "id" | "serverKey">): CaddyServer {
  const server: CaddyServer = {
    listen: [`:${proxy.externalPort}`],
    routes: [
      {
        handle: [
          {
            handler: "reverse_proxy",
            upstreams: [{ dial: `${proxy.targetHost}:${proxy.targetPort}` }],
          },
        ],
        terminal: true,
      },
    ],
  };

  if (proxy.tls) {
    server.tls_connection_policies = [{}];
  }

  return server;
}

export function mergeProxy(config: CaddyConfig, proxy: ProxyEntry): CaddyConfig {
  const servers = { ...(config.apps?.http?.servers ?? {}) };
  servers[proxy.serverKey] = buildServerEntry(proxy);

  const hasTls = Object.values(servers).some(
    s => Array.isArray(s.tls_connection_policies) && s.tls_connection_policies.length > 0,
  );

  return {
    ...config,
    apps: {
      ...config.apps,
      http: { ...config.apps?.http, servers },
      tls: hasTls
        ? {
            automation: {
              policies: [{ issuers: [{ module: "internal" }] }],
            },
          }
        : config.apps?.tls,
    },
  };
}

export function removeProxy(config: CaddyConfig, serverKey: string): CaddyConfig {
  const servers = { ...(config.apps?.http?.servers ?? {}) };
  delete servers[serverKey];

  const hasTls = Object.values(servers).some(
    s => Array.isArray(s.tls_connection_policies) && s.tls_connection_policies.length > 0,
  );

  return {
    ...config,
    apps: {
      ...config.apps,
      http: { ...config.apps?.http, servers },
      tls: hasTls ? config.apps?.tls : undefined,
    },
  };
}
