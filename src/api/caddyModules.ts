/**
 * Which modules the installed Caddy has (#343). A stock build lacks the DNS providers, layer4,
 * rate limiting and caddy-security, so what needs one of them can say so instead of failing at
 * the next reload.
 *
 * A local Caddy is asked with `caddy list-modules`, which lists every module. A Caddy in Docker
 * or elsewhere is only reachable over the Admin API, which has no list of modules: there each
 * module is probed by adapting a tiny Caddyfile that needs it. A probe that fails for another
 * reason (Caddy not reachable) leaves the module unknown, never missing.
 */

import { getHost } from "@rxtx4816/cockpit-plugin-base-react/host";
import { parseDnsProviders, DNS_PROVIDER_PRESETS } from "./dnsChallenge";
import { adaptCaddyfileViaApi, CaddyfileError, isCaddyManaged } from "./caddy";

export type CapabilityKey = "dns" | "layer4" | "rate_limit" | "security";

export interface CaddyModules {
  /** Every module id, sorted; only the ones a probe found when they came from the Admin API. */
  all: string[];
  /** The `dns.providers.*` ones, by provider name. */
  dnsProviders: string[];
  /** How many modules are not part of Caddy itself, when the output says (`Non-standard modules: N`). */
  nonStandard?: number;
  /** Where they came from: `caddy list-modules` is complete, the Admin API probes are not. */
  source: "list-modules" | "admin-api";
  /** What the probes found, by capability; a capability that is not here is unknown. */
  probed?: Partial<Record<CapabilityKey, boolean>>;
}

/** Modules the plugin's options may need, which a stock Caddy build does not have. */
export interface ModuleCapability {
  key: CapabilityKey;
  /** What makes the module count as present in a full list. */
  test: (modules: CaddyModules) => boolean;
  /** A Caddyfile that only adapts when the module is there, for the Admin API probe. */
  probe?: string;
  /** Where to read about it or get it. */
  docs: string;
}

export const MODULE_CAPABILITIES: ModuleCapability[] = [
  { key: "dns", test: m => m.dnsProviders.length > 0, docs: "https://caddyserver.com/docs/automatic-https#dns-challenge" },
  { key: "layer4", test: m => m.all.some(id => id === "layer4" || id.startsWith("layer4.")), probe: "{\n\tlayer4 {\n\t}\n}\n", docs: "https://github.com/mholt/caddy-l4" },
  { key: "rate_limit", test: m => m.all.includes("http.handlers.rate_limit"), probe: ":1 {\n\troute {\n\t\trate_limit {\n\t\t}\n\t}\n}\n", docs: "https://github.com/mholt/caddy-ratelimit" },
  { key: "security", test: m => m.all.includes("security") || m.all.includes("http.handlers.authenticator"), probe: "{\n\tsecurity {\n\t}\n}\n", docs: "https://github.com/greenpau/caddy-security" },
];

/** DNS providers the Admin API probe asks about: it can't list them, only test names. */
export const PROBED_DNS_PROVIDERS = [...new Set([
  ...Object.keys(DNS_PROVIDER_PRESETS),
  "route53", "digitalocean", "porkbun", "ovh", "gandi", "namecheap", "godaddy", "netcup", "ionos", "linode", "vultr", "googleclouddns", "azure", "acmedns", "rfc2136", "powerdns", "dnspod", "alidns", "tencentcloud", "bunny", "dynv6", "inwx", "infomaniak", "njalla", "transip", "namesilo", "mijnhost",
])].sort();

/** Reads `caddy list-modules` output: the module ids, and the count of non-standard ones from its footer. */
export function parseCaddyModules(output: string): CaddyModules {
  const all = [...new Set(output.split("\n").map(l => l.trim()).filter(l => /^[A-Za-z0-9_.-]+$/.test(l)))].sort();
  const nonStandard = output.match(/Non-standard modules:\s*(\d+)/i)?.[1];
  return {
    all,
    dnsProviders: parseDnsProviders(output),
    ...(nonStandard !== undefined ? { nonStandard: parseInt(nonStandard, 10) } : {}),
    source: "list-modules",
  };
}

/** The local Caddy's modules from `caddy list-modules`; undefined when it can't be asked. */
async function runListModules(): Promise<CaddyModules | undefined> {
  try {
    const modules = parseCaddyModules(await getHost().run(["caddy", "list-modules"], { superuser: "try", stderr: "ignore" }));
    return modules.all.length ? modules : undefined;
  } catch {
    return undefined;
  }
}

/** What one probe says: true when it adapted, false when Caddy says the module is not there. */
async function probe(adapt: (caddyfile: string) => Promise<void>, caddyfile: string): Promise<boolean | undefined> {
  try {
    await adapt(caddyfile);
    return true;
  } catch (e) {
    if (!(e instanceof CaddyfileError)) return undefined;
    // The adapter answered: a missing module is named as such; any other complaint (a bad
    // argument to the module) means the module is there.
    return !/module not registered|unrecognized (global option|directive)/i.test(e.message);
  }
}

/**
 * The modules a Caddy has, found through the Admin API's `/adapt` (#343). Undefined when nothing
 * could be learned, e.g. the Admin API is not reachable.
 */
export async function probeCaddyModules(adapt: (caddyfile: string) => Promise<void> = adaptCaddyfileViaApi): Promise<CaddyModules | undefined> {
  // A few at a time: each probe is a curl process on the host.
  const dnsResults: Array<readonly [string, boolean | undefined]> = [];
  for (let i = 0; i < PROBED_DNS_PROVIDERS.length; i += PROBE_BATCH) {
    dnsResults.push(...await Promise.all(PROBED_DNS_PROVIDERS.slice(i, i + PROBE_BATCH).map(async name => [name, await probe(adapt, `{\n\tacme_dns ${name} x\n}\n`)] as const)));
    // Nothing answers: the Admin API isn't there, so the rest would fail the same way.
    if (i === 0 && dnsResults.every(([, found]) => found === undefined)) break;
  }
  const probed: Partial<Record<CapabilityKey, boolean>> = {};
  for (const c of MODULE_CAPABILITIES) {
    if (!c.probe) continue;
    const found = await probe(adapt, c.probe);
    if (found !== undefined) probed[c.key] = found;
  }
  const dnsProviders = dnsResults.filter(([, found]) => found).map(([name]) => name);
  // A provider the probe did not ask about may still be there, so no provider found is unknown.
  if (dnsProviders.length) probed.dns = true;
  if (dnsResults.every(([, found]) => found === undefined) && !Object.keys(probed).length) return undefined;
  const all = [
    ...dnsProviders.map(n => `dns.providers.${n}`),
    ...(probed.layer4 ? ["layer4"] : []),
    ...(probed.rate_limit ? ["http.handlers.rate_limit"] : []),
    ...(probed.security ? ["security"] : []),
  ].sort();
  return { all, dnsProviders, source: "admin-api", probed };
}

const PROBE_BATCH = 6;
/** How long a failed lookup is kept before a screen asks again. */
const RETRY_AFTER_MS = 60_000;

let cached: Promise<CaddyModules | undefined> | undefined;

/**
 * The installed Caddy's modules, asked once per page and shared by every screen that needs them:
 * `caddy list-modules` for a local Caddy, else the Admin API probes. `refresh` asks again, e.g.
 * after Caddy was restarted with another build.
 */
export function listCaddyModules(opts: { refresh?: boolean } = {}): Promise<CaddyModules | undefined> {
  if (!cached || opts.refresh) {
    cached = (async () => (isCaddyManaged() ? await runListModules() : undefined) ?? await probeCaddyModules())();
    // A failed lookup is kept for a minute, so screens opened meanwhile don't each ask again.
    const mine = cached;
    void mine.then(m => { if (!m) setTimeout(() => { if (cached === mine) cached = undefined; }, RETRY_AFTER_MS); });
  }
  return cached;
}

/**
 * The DNS provider modules the installed Caddy has: empty when it has none, null when that is
 * not known (Caddy can't be asked, or only probed).
 * They come from the same lookup as the Settings list (#361), so the page asks Caddy once.
 */
export async function listDnsProviders(opts: { refresh?: boolean } = {}): Promise<string[] | null> {
  const modules = await listCaddyModules(opts);
  // The probes can't list every provider: none found is not the same as none installed.
  if (!modules || (!modules.dnsProviders.length && hasCapability(modules, "dns") === undefined)) return null;
  return modules.dnsProviders;
}

/** Forgets the modules asked for before (tests). */
export function resetCaddyModulesCache(): void {
  cached = undefined;
}

/**
 * Each capability with whether the Caddy at hand has it: true or false from a full list or a
 * probe that answered, undefined when the probes could not tell.
 */
export function moduleCapabilities(modules: CaddyModules): Array<ModuleCapability & { available: boolean | undefined }> {
  return MODULE_CAPABILITIES.map(c => ({
    ...c,
    available: modules.source === "list-modules" ? c.test(modules) : modules.probed?.[c.key],
  }));
}

/** Whether the Caddy has a capability: true, false, or undefined when it is not known. */
export function hasCapability(modules: CaddyModules | undefined, key: CapabilityKey): boolean | undefined {
  return modules ? moduleCapabilities(modules).find(c => c.key === key)?.available : undefined;
}
