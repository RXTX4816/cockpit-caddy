/**
 * Which modules the installed Caddy binary has (#343): the ids `caddy list-modules` prints. A
 * stock build lacks the DNS providers, layer4, rate limiting and caddy-security, so what needs
 * one of them can say so instead of failing at the next reload.
 */

import { getHost } from "@rxtx4816/cockpit-plugin-base-react/host";
import { parseDnsProviders } from "./dnsChallenge";

export interface CaddyModules {
  /** Every module id, sorted. */
  all: string[];
  /** The `dns.providers.*` ones, by provider name. */
  dnsProviders: string[];
  /** How many modules are not part of Caddy itself, when the output says (`Non-standard modules: N`). */
  nonStandard?: number;
}

/** Modules the plugin's options may need, which a stock Caddy build does not have. */
export interface ModuleCapability {
  key: "dns" | "layer4" | "rate_limit" | "security";
  /** What makes the module count as present. */
  test: (modules: CaddyModules) => boolean;
  /** Where to read about it or get it. */
  docs: string;
}

export const MODULE_CAPABILITIES: ModuleCapability[] = [
  { key: "dns", test: m => m.dnsProviders.length > 0, docs: "https://caddyserver.com/docs/automatic-https#dns-challenge" },
  { key: "layer4", test: m => m.all.some(id => id === "layer4" || id.startsWith("layer4.")), docs: "https://github.com/mholt/caddy-l4" },
  { key: "rate_limit", test: m => m.all.includes("http.handlers.rate_limit"), docs: "https://github.com/mholt/caddy-ratelimit" },
  { key: "security", test: m => m.all.includes("security") || m.all.includes("http.handlers.authenticator"), docs: "https://github.com/greenpau/caddy-security" },
];

/** Reads `caddy list-modules` output: the module ids, and the count of non-standard ones from its footer. */
export function parseCaddyModules(output: string): CaddyModules {
  const all = [...new Set(output.split("\n").map(l => l.trim()).filter(l => /^[A-Za-z0-9_.-]+$/.test(l)))].sort();
  const nonStandard = output.match(/Non-standard modules:\s*(\d+)/i)?.[1];
  return {
    all,
    dnsProviders: parseDnsProviders(output),
    ...(nonStandard !== undefined ? { nonStandard: parseInt(nonStandard, 10) } : {}),
  };
}

/** The installed Caddy's modules; undefined when it can't be asked (no binary, no permission). */
export async function listCaddyModules(): Promise<CaddyModules | undefined> {
  try {
    const modules = parseCaddyModules(await getHost().run(["caddy", "list-modules"], { superuser: "try", stderr: "ignore" }));
    return modules.all.length ? modules : undefined;
  } catch {
    return undefined;
  }
}

/** Each capability with whether the Caddy at hand has it. */
export function moduleCapabilities(modules: CaddyModules): Array<ModuleCapability & { available: boolean }> {
  return MODULE_CAPABILITIES.map(c => ({ ...c, available: c.test(modules) }));
}
